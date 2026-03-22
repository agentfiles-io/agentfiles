import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArtifactListItem } from "./client.js";
import {
  WATCH_CHILD_KILL_GRACE_MS,
  WATCH_SEEN_KEYS_MAX,
  clampWatchLimit,
  collectWatchEvents,
  createWatchState,
  formatWatchEventJson,
  pruneSeenKeys,
  runExecForEvent,
  spawnExecForEvent,
  terminateChildProcess,
  watchNamespace,
} from "./watch.js";

function createArtifact(
  overrides: Partial<ArtifactListItem> = {}
): ArtifactListItem {
  return {
    id: "art_1",
    slug: "sample-artifact",
    title: "Sample Artifact",
    description: "A sample artifact",
    content_type: "text/plain",
    current_version: 1,
    visibility: "private",
    created_at: "2026-03-15T07:00:00.000Z",
    updated_at: "2026-03-15T07:00:00.000Z",
    ...overrides,
  };
}

function createChildProcessStub(): ChildProcess {
  return Object.assign(new EventEmitter(), {
    kill: vi.fn().mockReturnValue(true),
    exitCode: null,
    signalCode: null,
    stdin: null,
    stdout: null,
    stderr: null,
  }) as unknown as ChildProcess;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("watch state", () => {
  it("since=now seeds state and suppresses first-pass events", () => {
    const state = createWatchState();
    const artifacts = [
      createArtifact({ id: "art_1", current_version: 1 }),
      createArtifact({ id: "art_2", current_version: 2 }),
    ];

    const events = collectWatchEvents(state, artifacts, {
      namespace: "default",
      since: "now",
      timestamp: "2026-03-15T07:10:00.000Z",
    });

    expect(events).toEqual([]);
    expect([...state.seenKeys]).toEqual(["art_1:1", "art_2:2"]);
  });

  it("since=all emits first-pass events oldest to newest", () => {
    const state = createWatchState();
    const artifacts = [
      createArtifact({
        id: "art_newer",
        title: "Newer",
        updated_at: "2026-03-15T07:05:00.000Z",
      }),
      createArtifact({
        id: "art_older",
        title: "Older",
        updated_at: "2026-03-15T07:00:00.000Z",
      }),
    ];

    const events = collectWatchEvents(state, artifacts, {
      namespace: "default",
      since: "all",
      timestamp: "2026-03-15T07:10:00.000Z",
    });

    expect(events.map((event) => event.artifact.id)).toEqual([
      "art_older",
      "art_newer",
    ]);
    expect(events.map((event) => event.event)).toEqual([
      "artifact.created",
      "artifact.created",
    ]);
  });

  it("new version of an existing artifact emits artifact.updated", () => {
    const state = createWatchState();

    collectWatchEvents(state, [createArtifact({ id: "art_1", current_version: 1 })], {
      namespace: "default",
      since: "now",
      timestamp: "2026-03-15T07:10:00.000Z",
    });

    const events = collectWatchEvents(
      state,
      [createArtifact({ id: "art_1", current_version: 2 })],
      {
        namespace: "default",
        since: "now",
        timestamp: "2026-03-15T07:15:00.000Z",
      }
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      event: "artifact.updated",
      artifact: {
        id: "art_1",
        version: 2,
      },
    });
  });

  it("duplicate polls do not re-emit the same artifact/version", () => {
    const state = createWatchState();
    const artifacts = [createArtifact({ id: "art_1", current_version: 3 })];

    const first = collectWatchEvents(state, artifacts, {
      namespace: "default",
      since: "all",
      timestamp: "2026-03-15T07:10:00.000Z",
    });
    const second = collectWatchEvents(state, artifacts, {
      namespace: "default",
      since: "all",
      timestamp: "2026-03-15T07:15:00.000Z",
    });

    expect(first).toHaveLength(1);
    expect(second).toEqual([]);
  });

  it("prunes oldest seen keys when exceeding max", () => {
    const state = createWatchState();

    for (let i = 0; i < WATCH_SEEN_KEYS_MAX + 50; i++) {
      state.seenKeys.add(`art_${i}:1`);
    }

    expect(state.seenKeys.size).toBe(WATCH_SEEN_KEYS_MAX + 50);

    pruneSeenKeys(state);

    expect(state.seenKeys.size).toBe(WATCH_SEEN_KEYS_MAX);
    // Oldest keys should be removed, newest retained
    expect(state.seenKeys.has("art_0:1")).toBe(false);
    expect(state.seenKeys.has("art_49:1")).toBe(false);
    expect(state.seenKeys.has(`art_${WATCH_SEEN_KEYS_MAX + 49}:1`)).toBe(true);
  });
});

describe("watch formatting and exec", () => {
  it("formats stable NDJSON output", () => {
    const state = createWatchState();
    const [event] = collectWatchEvents(
      state,
      [createArtifact({ id: "art_1", current_version: 2 })],
      {
        namespace: "default",
        since: "all",
        timestamp: "2026-03-15T07:10:00.000Z",
      }
    );
    expect(event).toBeDefined();
    if (!event) {
      throw new Error("Expected watch event");
    }

    expect(JSON.parse(formatWatchEventJson(event))).toEqual({
      eventVersion: 1,
      event: "artifact.updated",
      timestamp: "2026-03-15T07:10:00.000Z",
      artifact: {
        id: "art_1",
        title: "Sample Artifact",
        namespace: "default",
        version: 2,
        content_type: "text/plain",
        updated_at: "2026-03-15T07:00:00.000Z",
        slug: "sample-artifact",
      },
    });
  });

  it("runs exec safely with expected args and env", async () => {
    const state = createWatchState();
    const [event] = collectWatchEvents(
      state,
      [createArtifact({ id: "art_exec", current_version: 1 })],
      {
        namespace: "my-namespace",
        since: "all",
        timestamp: "2026-03-15T07:10:00.000Z",
      }
    );
    expect(event).toBeDefined();
    if (!event) {
      throw new Error("Expected watch event");
    }

    const child = createChildProcessStub();
    const spawnCommand = vi.fn().mockReturnValue(child);

    const promise = runExecForEvent("./scripts/on-artifact.sh", event, {
      spawnCommand,
      baseEnv: { PATH: "/usr/bin" },
    });

    child.emit("close", 0, null);
    await promise;

    expect(spawnCommand).toHaveBeenCalledWith(
      "./scripts/on-artifact.sh",
      ["art_exec"],
      expect.objectContaining({
        shell: false,
        stdio: ["ignore", "inherit", "inherit"],
      })
    );

    const env = spawnCommand.mock.calls[0]?.[2].env as NodeJS.ProcessEnv;
    expect(env).toMatchObject({
      PATH: "/usr/bin",
      AGENTFILES_EVENT: "artifact.created",
      AGENTFILES_ARTIFACT_ID: "art_exec",
      AGENTFILES_ARTIFACT_TITLE: "Sample Artifact",
      AGENTFILES_NAMESPACE: "my-namespace",
      AGENTFILES_VERSION: "1",
      AGENTFILES_UPDATED_AT: "2026-03-15T07:00:00.000Z",
    });
  });

  it("clamps watch limit to the API window", () => {
    expect(clampWatchLimit(0)).toBe(1);
    expect(clampWatchLimit(20)).toBe(20);
    expect(clampWatchLimit(999)).toBe(100);
  });

  it("reserves stdout for NDJSON mode when exec is enabled", () => {
    const state = createWatchState();
    const [event] = collectWatchEvents(
      state,
      [createArtifact({ id: "art_json", current_version: 1 })],
      {
        namespace: "default",
        since: "all",
        timestamp: "2026-03-15T07:10:00.000Z",
      }
    );
    expect(event).toBeDefined();
    if (!event) {
      throw new Error("Expected watch event");
    }

    const child = createChildProcessStub();
    const spawnCommand = vi.fn().mockReturnValue(child);

    spawnExecForEvent("./scripts/on-artifact.sh", event, {
      reserveStdout: true,
      spawnCommand,
    });

    expect(spawnCommand).toHaveBeenCalledWith(
      "./scripts/on-artifact.sh",
      ["art_json"],
      expect.objectContaining({
        shell: false,
        stdio: ["ignore", process.stderr, process.stderr],
      })
    );
  });

  it("force-kills a stuck child after the shutdown grace period", () => {
    vi.useFakeTimers();

    const child = createChildProcessStub();
    const cleanup = terminateChildProcess(child);

    expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");

    vi.advanceTimersByTime(WATCH_CHILD_KILL_GRACE_MS - 1);
    expect(child.kill).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1);
    expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");

    cleanup();
  });

  it("aborts an in-flight poll cleanly", async () => {
    const abortController = new AbortController();
    const writeError = vi.fn();
    const listArtifacts = vi.fn((_namespace: string, options?: { signal?: AbortSignal }) => {
      return new Promise<{ artifacts: ArtifactListItem[] }>((_resolve, reject) => {
        expect(options?.signal).toBeInstanceOf(AbortSignal);

        options?.signal?.addEventListener(
          "abort",
          () => {
            const error = new Error("Aborted");
            error.name = "AbortError";
            reject(error);
          },
          { once: true }
        );
      });
    });

    const watchPromise = watchNamespace(
      {
        listArtifacts,
      },
      {
        namespace: "default",
        intervalMs: 10_000,
        limit: 20,
        since: "now",
        json: false,
        once: false,
        signal: abortController.signal,
        writeError,
      }
    );

    await Promise.resolve();
    abortController.abort();

    await expect(watchPromise).resolves.toBeUndefined();
    expect(listArtifacts).toHaveBeenCalledTimes(1);
    expect(writeError).not.toHaveBeenCalled();
  });

  it("terminates an active exec child when externally aborted", async () => {
    const abortController = new AbortController();
    const child = createChildProcessStub();
    const spawnCommand = vi.fn().mockReturnValue(child);
    const listArtifacts = vi
      .fn()
      .mockResolvedValueOnce({
        artifacts: [createArtifact({ id: "art_exec_running", current_version: 1 })],
      })
      .mockImplementation(() => {
        return Promise.resolve({ artifacts: [] });
      });

    const watchPromise = watchNamespace(
      {
        listArtifacts,
      },
      {
        namespace: "default",
        intervalMs: 10_000,
        limit: 20,
        since: "all",
        json: false,
        once: false,
        execPath: "./scripts/on-artifact.sh",
        signal: abortController.signal,
        spawnCommand,
      }
    );

    await Promise.resolve();
    abortController.abort();

    expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
    child.emit("close", null, "SIGTERM");

    await expect(watchPromise).resolves.toBeUndefined();
  });
});
