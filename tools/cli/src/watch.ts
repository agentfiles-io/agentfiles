import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import type { Command } from "commander";
import { AttachClient, type ArtifactListItem, type ListArtifactsOptions } from "./client.js";
import { requireConfig } from "./config.js";

export type WatchSinceMode = "now" | "all";
export type WatchEventType = "artifact.created" | "artifact.updated";

export interface WatchEvent {
  eventVersion: 1;
  event: WatchEventType;
  timestamp: string;
  artifact: {
    id: string;
    title: string;
    namespace: string;
    version: number;
    content_type: string;
    updated_at: string;
    slug: string | null;
  };
}

export interface WatchState {
  initialized: boolean;
  seenKeys: Set<string>;
}

export interface CollectWatchEventsOptions {
  namespace: string;
  since: WatchSinceMode;
  timestamp: string;
}

export interface WatchNamespaceOptions {
  namespace: string;
  intervalMs: number;
  limit: number;
  since: WatchSinceMode;
  json: boolean;
  once: boolean;
  execPath?: string;
  now?: () => Date;
  writeLine?: (line: string) => void;
  writeError?: (line: string) => void;
  spawnCommand?: SpawnCommand;
  signal?: AbortSignal;
}

type WatchClient = {
  listArtifacts(namespaceSlug: string, options?: ListArtifactsOptions): Promise<{
    artifacts: ArtifactListItem[];
  }>;
};
type SpawnCommand = typeof spawn;
type WatchExecSpawnOptions = {
  baseEnv?: NodeJS.ProcessEnv;
  reserveStdout?: boolean;
  spawnCommand?: SpawnCommand;
};

export const WATCH_CHILD_KILL_GRACE_MS = 1000;
export const WATCH_SEEN_KEYS_MAX = 500;

export function clampWatchLimit(value: number): number {
  if (!Number.isFinite(value)) {
    return 20;
  }

  return Math.min(100, Math.max(1, Math.trunc(value)));
}

export function createWatchState(): WatchState {
  return {
    initialized: false,
    seenKeys: new Set<string>(),
  };
}

export function getArtifactVersionKey(artifact: ArtifactListItem): string {
  return `${artifact.id}:${artifact.current_version}`;
}

export function createWatchEvent(
  artifact: ArtifactListItem,
  namespace: string,
  timestamp: string
): WatchEvent {
  return {
    eventVersion: 1,
    event: artifact.current_version === 1 ? "artifact.created" : "artifact.updated",
    timestamp,
    artifact: {
      id: artifact.id,
      title: artifact.title,
      namespace,
      version: artifact.current_version,
      content_type: artifact.content_type,
      updated_at: artifact.updated_at,
      slug: artifact.slug,
    },
  };
}

export function collectWatchEvents(
  state: WatchState,
  artifacts: ArtifactListItem[],
  options: CollectWatchEventsOptions
): WatchEvent[] {
  const sortedArtifacts = [...artifacts].sort(compareArtifactsForEmission);

  if (!state.initialized) {
    state.initialized = true;

    if (options.since === "now") {
      for (const artifact of sortedArtifacts) {
        state.seenKeys.add(getArtifactVersionKey(artifact));
      }
      return [];
    }
  }

  const events: WatchEvent[] = [];

  for (const artifact of sortedArtifacts) {
    const key = getArtifactVersionKey(artifact);
    if (state.seenKeys.has(key)) {
      continue;
    }

    state.seenKeys.add(key);
    events.push(createWatchEvent(artifact, options.namespace, options.timestamp));
  }

  pruneSeenKeys(state);

  return events;
}

export function formatWatchEventText(event: WatchEvent): string {
  return `[${event.event}] ${event.artifact.id} v${event.artifact.version} ${event.artifact.title}`;
}

export function formatWatchEventJson(event: WatchEvent): string {
  return JSON.stringify(event);
}

export function buildWatchExecEnv(
  event: WatchEvent,
  baseEnv: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    AGENTFILES_EVENT: event.event,
    AGENTFILES_ARTIFACT_ID: event.artifact.id,
    AGENTFILES_ARTIFACT_TITLE: event.artifact.title,
    AGENTFILES_NAMESPACE: event.artifact.namespace,
    AGENTFILES_VERSION: String(event.artifact.version),
    AGENTFILES_UPDATED_AT: event.artifact.updated_at,
  };
}

export function spawnExecForEvent(
  executablePath: string,
  event: WatchEvent,
  execOptions: WatchExecSpawnOptions = {}
): ChildProcess {
  const spawnOptions: SpawnOptions = {
    env: buildWatchExecEnv(event, execOptions.baseEnv),
    shell: false,
    stdio: getWatchExecStdio(Boolean(execOptions.reserveStdout)),
  };

  return (execOptions.spawnCommand ?? spawn)(
    executablePath,
    [event.artifact.id],
    spawnOptions
  );
}

export async function waitForChildProcess(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const handleError = (error: Error): void => {
      cleanup();
      reject(error);
    };

    const handleClose = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup();

      if (code === 0) {
        resolve();
        return;
      }

      if (signal) {
        reject(new Error(`Command exited with signal ${signal}`));
        return;
      }

      reject(new Error(`Command exited with code ${code ?? "unknown"}`));
    };

    const cleanup = (): void => {
      child.off("error", handleError);
      child.off("close", handleClose);
    };

    child.on("error", handleError);
    child.on("close", handleClose);
  });
}

export async function runExecForEvent(
  executablePath: string,
  event: WatchEvent,
  options: WatchExecSpawnOptions = {}
): Promise<void> {
  const child = spawnExecForEvent(executablePath, event, options);
  await waitForChildProcess(child);
}

export async function watchNamespace(
  client: WatchClient,
  options: WatchNamespaceOptions
): Promise<void> {
  const state = createWatchState();
  const now = options.now ?? (() => new Date());
  const writeLine = options.writeLine ?? ((line: string) => console.log(line));
  const writeError = options.writeError ?? ((line: string) => console.error(line));
  const controller = new AbortController();
  let activeChild: ChildProcess | null = null;
  let activeChildTerminationCleanup: (() => void) | null = null;
  let externalSignalCleanup: (() => void) | null = null;

  const abortWatch = (): void => {
    controller.abort();

    if (activeChild) {
      activeChildTerminationCleanup ??= terminateChildProcess(activeChild);
    }
  };

  if (options.signal) {
    if (options.signal.aborted) {
      abortWatch();
    } else {
      const handleExternalAbort = (): void => {
        abortWatch();
      };
      options.signal.addEventListener("abort", handleExternalAbort);
      externalSignalCleanup = () => {
        options.signal?.removeEventListener("abort", handleExternalAbort);
      };
    }
  }

  const handleSignal = (): void => {
    abortWatch();
  };

  process.on("SIGINT", handleSignal);
  process.on("SIGTERM", handleSignal);

  try {
    while (!controller.signal.aborted) {
      const timestamp = now().toISOString();
      let artifacts: ArtifactListItem[];

      try {
        const result = await client.listArtifacts(options.namespace, {
          limit: options.limit,
          signal: controller.signal,
        });
        artifacts = result.artifacts;
      } catch (error) {
        if (controller.signal.aborted || isAbortError(error)) {
          break;
        }

        if (options.once) {
          throw error;
        }

        writeError(`Watch error: ${error instanceof Error ? error.message : String(error)}`);

        try {
          await sleep(options.intervalMs, undefined, { signal: controller.signal });
        } catch (sleepError) {
          if (isAbortError(sleepError)) {
            break;
          }
          throw sleepError;
        }

        continue;
      }

      const events = collectWatchEvents(state, artifacts, {
        namespace: options.namespace,
        since: options.since,
        timestamp,
      });

      for (const event of events) {
        writeLine(options.json ? formatWatchEventJson(event) : formatWatchEventText(event));

        if (!options.execPath) {
          continue;
        }

        const execOptions: WatchExecSpawnOptions = {
          reserveStdout: options.json,
        };
        if (options.spawnCommand) {
          execOptions.spawnCommand = options.spawnCommand;
        }

        activeChild = spawnExecForEvent(
          options.execPath,
          event,
          execOptions
        );

        try {
          await waitForChildProcess(activeChild);
        } catch (error) {
          if (controller.signal.aborted) {
            break;
          }

          writeError(`Watch exec error: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          runCleanup(activeChildTerminationCleanup);
          activeChildTerminationCleanup = null;
          activeChild = null;
        }
      }

      if (options.once || controller.signal.aborted) {
        break;
      }

      try {
        await sleep(options.intervalMs, undefined, { signal: controller.signal });
      } catch (error) {
        if (isAbortError(error)) {
          break;
        }
        throw error;
      }
    }
  } finally {
    process.off("SIGINT", handleSignal);
    process.off("SIGTERM", handleSignal);
    externalSignalCleanup?.();

    if (activeChild) {
      activeChildTerminationCleanup ??= terminateChildProcess(activeChild);
      try {
        await waitForChildProcess(activeChild);
      } catch {
        // Exit path; the child has already been signaled for shutdown.
      } finally {
        activeChildTerminationCleanup();
      }
    }
  }
}

export function registerWatchCommand(program: Command): void {
  program
    .command("watch")
    .description("Watch for newly created or updated artifacts in a namespace")
    .option("-n, --namespace <slug>", "Namespace slug")
    .option("--interval <seconds>", "Polling interval in seconds", "5")
    .option("-l, --limit <num>", "Max artifacts to fetch per poll", "20")
    .option("--since <mode>", "Seed mode: now or all", "now")
    .option("--json", "Emit newline-delimited JSON events")
    .option("--once", "Do one polling pass and exit")
    .option("--exec <path>", "Executable path only to run once per emitted event")
    .addHelpText(
      "after",
      [
        "",
        "V1 caveats:",
        "  This is best-effort polling against the namespace list endpoint.",
        "  High churn beyond the fetch window may miss older updates.",
        "  Seen state is kept in memory only and is not persisted across restarts.",
      ].join("\n")
    )
    .action(async (rawOptions) => {
      const config = requireConfig();
      const namespaceSlug = rawOptions.namespace ?? config.default_namespace;
      if (!namespaceSlug) {
        console.error("Error: Namespace is required. Use --namespace <slug>");
        process.exit(1);
      }

      try {
        const client = new AttachClient({
          apiUrl: config.api_url,
          apiKey: config.api_key,
        });
        const intervalSeconds = parsePositiveInteger(rawOptions.interval, "--interval");
        const limit = clampWatchLimit(parseInteger(rawOptions.limit, "--limit"));
        const since = parseSinceMode(rawOptions.since);

        await watchNamespace(client, {
          namespace: namespaceSlug,
          intervalMs: intervalSeconds * 1000,
          limit,
          since,
          json: Boolean(rawOptions.json),
          once: Boolean(rawOptions.once),
          execPath: rawOptions.exec,
        });
      } catch (error) {
        console.error("Error:", error instanceof Error ? error.message : error);
        process.exit(1);
      }
    });
}

function compareArtifactsForEmission(a: ArtifactListItem, b: ArtifactListItem): number {
  const timeDifference = Date.parse(a.updated_at) - Date.parse(b.updated_at);
  if (!Number.isNaN(timeDifference) && timeDifference !== 0) {
    return timeDifference;
  }

  if (a.updated_at !== b.updated_at) {
    return a.updated_at.localeCompare(b.updated_at);
  }

  return a.id.localeCompare(b.id);
}

function parseInteger(value: string, optionName: string): number {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`${optionName} must be an integer`);
  }
  return parsed;
}

function parsePositiveInteger(value: string, optionName: string): number {
  const parsed = parseInteger(value, optionName);
  if (parsed <= 0) {
    throw new Error(`${optionName} must be greater than 0`);
  }
  return parsed;
}

function parseSinceMode(value: string): WatchSinceMode {
  if (value === "now" || value === "all") {
    return value;
  }

  throw new Error("--since must be either 'now' or 'all'");
}

export function pruneSeenKeys(state: WatchState): void {
  if (state.seenKeys.size <= WATCH_SEEN_KEYS_MAX) {
    return;
  }

  const excess = state.seenKeys.size - WATCH_SEEN_KEYS_MAX;
  let removed = 0;
  for (const key of state.seenKeys) {
    if (removed >= excess) break;
    state.seenKeys.delete(key);
    removed++;
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function runCleanup(cleanup: (() => void) | null): void {
  if (cleanup) {
    cleanup();
  }
}

function getWatchExecStdio(reserveStdout: boolean): SpawnOptions["stdio"] {
  if (reserveStdout) {
    return ["ignore", process.stderr, process.stderr];
  }

  return ["ignore", "inherit", "inherit"];
}

export function terminateChildProcess(
  child: ChildProcess,
  forceAfterMs = WATCH_CHILD_KILL_GRACE_MS
): () => void {
  if (child.exitCode !== null) {
    return () => {};
  }

  const forceKillTimer = setTimeout(() => {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
    }
  }, forceAfterMs);

  const cleanup = (): void => {
    clearTimeout(forceKillTimer);
    child.off("close", cleanup);
    child.off("error", cleanup);
  };

  child.on("close", cleanup);
  child.on("error", cleanup);
  child.kill("SIGTERM");

  return cleanup;
}
