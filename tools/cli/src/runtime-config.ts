import {
  spawnSync,
  type SpawnSyncOptionsWithStringEncoding,
  type SpawnSyncReturns,
} from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { writePrivateFile } from "./config.js";

const HANDOFF_SKILL_MD = `---
name: handoff
description: Hand off work to another AI agent (Codex, Claude Code, etc.) via AgentFiles. Use when the user wants to send context, files, or instructions to another runtime.
argument-hint: <recipient> [what to send]
disable-model-invocation: true
---

# Handoff

Hand off work to another agent via the AgentFiles MCP server.

## Arguments

\\\`$0\\\` is the recipient runtime (e.g. \\\`codex\\\`, \\\`claude_code\\\`).
Everything after the recipient is a natural-language description of what to hand off.

## What to do

1. Identify the recipient from \\\`$0\\\`.
2. Figure out what content to send:
   - If the user described specific content after the recipient (e.g. \\\`/handoff codex send the API design above\\\`), gather that content from the conversation.
   - If the user just said \\\`/handoff codex\\\`, send a summary of the current task state: what was done, what's next, key decisions made, and any relevant code or file paths.
   - If the conversation produced a plan, code, review, or other concrete output, include it verbatim.
3. Call the \\\`artifact_publish\\\` MCP tool with:
   - \\\`title\\\`: a short descriptive title (e.g. "API design for review", "Code review feedback")
   - \\\`content\\\`: the gathered content, formatted as markdown
   - \\\`content_type\\\`: \\\`"text/markdown"\\\`
   - \\\`to\\\`: the recipient from \\\`$0\\\`
   - \\\`thread\\\`: a descriptive thread ID if one makes sense (e.g. \\\`pr-7-review\\\`, \\\`api-redesign\\\`), or omit to let the server auto-generate one
   - \\\`message\\\`: a one-line version message (e.g. "Initial handoff", "Review feedback")
4. After publishing, tell the user:
   - The artifact ID
   - The recipient
   - The thread ID (so the other agent can search for it)
   - A suggestion like: "Tell $0 to search for thread '<thread>' in AgentFiles"

## Rules

- Always use the \\\`artifact_publish\\\` MCP tool. Do not shell out to the CLI.
- Do not ask for confirmation before publishing unless the content is ambiguous.
- Keep the content focused and actionable. The recipient agent should be able to pick up the work without extra context.
- If no namespace is configured, the MCP server will use the default. Do not ask the user for a namespace unless the publish fails.
`;

export interface McpConfigResult {
  configured: boolean;
  clientLabel?: string;
  detail?: string;
  warning?: string;
}

type CommandRunner = (
  command: string,
  args: string[],
  options: SpawnSyncOptionsWithStringEncoding,
) => SpawnSyncReturns<string>;

export interface ConfigureMcpServerOptions {
  homeDir?: string;
  commandRunner?: CommandRunner;
  /** Custom instance name for the agent (e.g. "codex-pr-bot"). Creates a distinct MCP entry. */
  instanceName?: string;
}

function formatCommandFailure(
  result: SpawnSyncReturns<string>,
  fallback: string,
): string {
  return result.stderr.trim() || result.stdout.trim() || fallback;
}

function ensurePrivateDir(dirPath: string): void {
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true, mode: 0o700 });
    return;
  }

  chmodSync(dirPath, 0o700);
}

function toTomlString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"")}"`;
}

/**
 * Slugify an instance name for use as an MCP server key.
 * Lowercases, replaces non-alphanumeric with hyphens, collapses runs.
 */
function slugifyInstanceName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Derive the MCP server key and ATTACH_RUNTIME_KIND for a given client kind + optional instance name.
 */
function deriveMcpIdentity(
  clientKind: string,
  instanceName: string | undefined,
): { serverKey: string; runtimeKind: string } {
  if (instanceName) {
    const slug = slugifyInstanceName(instanceName);
    if (slug) {
      return {
        serverKey: `agentfiles-${slug}`,
        runtimeKind: slug,
      };
    }
    // Slug is empty (e.g. "!!!") — fall through to default
  }
  return {
    serverKey: "agentfiles",
    runtimeKind: clientKind,
  };
}

function stripCodexSection(content: string, serverKey: string): string {
  const lines = content.split(/\r?\n/);
  const kept: string[] = [];
  let skipping = false;

  const sectionPattern = new RegExp(
    `^\\[mcp_servers\\.${serverKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\.env)?\\]$`,
  );

  for (const line of lines) {
    const trimmed = line.trim();

    if (sectionPattern.test(trimmed)) {
      skipping = true;
      continue;
    }

    if (skipping && trimmed.startsWith("[")) {
      skipping = false;
    }

    if (!skipping) {
      kept.push(line);
    }
  }

  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function buildCodexAgentfilesSection(
  apiUrl: string,
  apiKey: string,
  serverKey: string,
  runtimeKind: string,
): string {
  return [
    `[mcp_servers.${serverKey}]`,
    'command = "npx"',
    'args = ["-y", "agentfiles-mcp"]',
    "",
    `[mcp_servers.${serverKey}.env]`,
    `ATTACH_API_KEY = ${toTomlString(apiKey)}`,
    `ATTACH_API_URL = ${toTomlString(apiUrl)}`,
    `ATTACH_RUNTIME_KIND = ${toTomlString(runtimeKind)}`,
  ].join("\n");
}

function installClaudeSkills(homeDir: string): string | null {
  try {
    const skillDir = join(homeDir, ".claude", "skills", "agentfiles-handoff");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), HANDOFF_SKILL_MD, "utf-8");
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function configureClaudeMcpServer(
  apiUrl: string,
  apiKey: string,
  homeDir: string,
  serverKey: string,
  runtimeKind: string,
): McpConfigResult {
  const claudeConfigPath = join(homeDir, ".claude.json");
  const label = serverKey === "agentfiles" ? "Claude Code" : `Claude Code (${runtimeKind})`;

  try {
    let config: Record<string, unknown> = {};
    if (existsSync(claudeConfigPath)) {
      try {
        config = JSON.parse(readFileSync(claudeConfigPath, "utf-8")) as Record<string, unknown>;
      } catch {
        return {
          configured: false,
          clientLabel: label,
          warning: `Could not auto-configure because ${claudeConfigPath} contains invalid JSON.`,
        };
      }
    }

    if (!config["mcpServers"] || typeof config["mcpServers"] !== "object") {
      config["mcpServers"] = {};
    }

    const mcpServers = config["mcpServers"] as Record<string, unknown>;
    mcpServers[serverKey] = {
      type: "stdio",
      command: "npx",
      args: ["-y", "agentfiles-mcp"],
      env: {
        ATTACH_API_URL: apiUrl,
        ATTACH_API_KEY: apiKey,
        ATTACH_RUNTIME_KIND: runtimeKind,
      },
    };

    writePrivateFile(claudeConfigPath, JSON.stringify(config, null, 2));

    // Install /handoff skill (once, regardless of instance)
    const skillError = installClaudeSkills(homeDir);
    const skillNote = skillError
      ? ` (skill install failed: ${skillError})`
      : " Installed /handoff command.";

    return {
      configured: true,
      clientLabel: label,
      detail: `Updated ${claudeConfigPath} (server: ${serverKey}).${skillNote} Restart Claude Code to load.`,
      ...(skillError ? { warning: `Skill install failed: ${skillError}. The /handoff command will not be available.` } : {}),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      configured: false,
      clientLabel: label,
      warning: `Could not auto-configure: ${message}`,
    };
  }
}

function configureCodexMcpServer(
  apiUrl: string,
  apiKey: string,
  homeDir: string,
  commandRunner: CommandRunner,
  serverKey: string,
  runtimeKind: string,
): McpConfigResult {
  const label = serverKey === "agentfiles" ? "Codex" : `Codex (${runtimeKind})`;
  const commandOptions: SpawnSyncOptionsWithStringEncoding = {
    encoding: "utf-8",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  };

  const versionResult = commandRunner("codex", ["--version"], commandOptions);
  if (versionResult.error) {
    const err = versionResult.error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      return {
        configured: false,
        clientLabel: label,
        warning: "Could not auto-configure Codex because the `codex` command was not found.",
      };
    }

    return {
      configured: false,
      clientLabel: label,
      warning: `Could not auto-configure Codex: ${err.message}`,
    };
  }

  if (versionResult.status !== 0) {
    return {
      configured: false,
      clientLabel: label,
      warning: `Could not auto-configure Codex: ${formatCommandFailure(
        versionResult,
        "codex --version failed",
      )}`,
    };
  }

  const codexConfigDir = join(homeDir, ".codex");
  const codexConfigPath = join(codexConfigDir, "config.toml");

  try {
    ensurePrivateDir(codexConfigDir);
    const existingConfig = existsSync(codexConfigPath)
      ? readFileSync(codexConfigPath, "utf-8")
      : "";
    const preservedConfig = stripCodexSection(existingConfig, serverKey);
    const agentfilesSection = buildCodexAgentfilesSection(apiUrl, apiKey, serverKey, runtimeKind);
    const mergedConfig = preservedConfig
      ? `${preservedConfig}\n\n${agentfilesSection}\n`
      : `${agentfilesSection}\n`;

    writePrivateFile(codexConfigPath, mergedConfig);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      configured: false,
      clientLabel: label,
      warning: `Could not auto-configure Codex: ${message}`,
    };
  }

  return {
    configured: true,
    clientLabel: label,
    detail: `Updated ${codexConfigPath} (server: ${serverKey}). Restart Codex to load.`,
  };
}

export function configureMcpServer(
  clientKind: string,
  apiUrl: string,
  apiKey: string,
  options: ConfigureMcpServerOptions = {},
): McpConfigResult {
  const homeDir = options.homeDir ?? homedir();
  const commandRunner = options.commandRunner ?? spawnSync;
  const { serverKey, runtimeKind } = deriveMcpIdentity(clientKind, options.instanceName);

  if (clientKind === "claude_code") {
    return configureClaudeMcpServer(apiUrl, apiKey, homeDir, serverKey, runtimeKind);
  }

  if (clientKind === "codex") {
    return configureCodexMcpServer(apiUrl, apiKey, homeDir, commandRunner, serverKey, runtimeKind);
  }

  return { configured: false };
}

export function configureSupportedLocalRuntimes(
  apiUrl: string,
  apiKey: string,
  options: ConfigureMcpServerOptions = {},
): McpConfigResult[] {
  return [
    configureMcpServer("claude_code", apiUrl, apiKey, options),
    configureMcpServer("codex", apiUrl, apiKey, options),
  ];
}
