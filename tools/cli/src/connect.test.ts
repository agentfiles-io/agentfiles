import type { SpawnSyncReturns } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildConnectSummary, configureMcpServer } from "./connect.js";

function createSpawnResult(
  overrides: Partial<SpawnSyncReturns<string>> = {},
): SpawnSyncReturns<string> {
  return {
    output: [],
    pid: 0,
    signal: null,
    status: 0,
    stdout: "",
    stderr: "",
    ...overrides,
  } as SpawnSyncReturns<string>;
}

describe("configureMcpServer", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    vi.restoreAllMocks();
  });

  function createTempHome(): string {
    const dir = mkdtempSync(join(tmpdir(), "agentfiles-connect-"));
    tempDirs.push(dir);
    return dir;
  }

  it("writes the AgentFiles MCP server into Claude Code config", () => {
    const homeDir = createTempHome();
    const configPath = join(homeDir, ".claude.json");
    writeFileSync(configPath, JSON.stringify({ theme: "dark" }, null, 2));

    const result = configureMcpServer(
      "claude_code",
      "http://localhost:3000",
      "test-key",
      { homeDir },
    );

    expect(result).toMatchObject({
      configured: true,
      clientLabel: "Claude Code",
    });

    const config = JSON.parse(readFileSync(configPath, "utf-8")) as {
      theme: string;
      mcpServers: {
        agentfiles: {
          type: string;
          command: string;
          args: string[];
          env: Record<string, string>;
        };
      };
    };

    expect(config.theme).toBe("dark");
    expect(config.mcpServers.agentfiles).toEqual({
      type: "stdio",
      command: "npx",
      args: ["-y", "agentfiles-mcp"],
      env: {
        ATTACH_API_URL: "http://localhost:3000",
        ATTACH_API_KEY: "test-key",
        ATTACH_RUNTIME_KIND: "claude_code",
      },
    });
    expect(statSync(configPath).mode & 0o777).toBe(0o600);

    // Verify /handoff skill was installed
    const skillPath = join(homeDir, ".claude", "skills", "agentfiles-handoff", "SKILL.md");
    expect(existsSync(skillPath)).toBe(true);
    const skillContent = readFileSync(skillPath, "utf-8");
    expect(skillContent).toContain("name: handoff");
    expect(skillContent).toContain("artifact_publish");
  });

  it("warns instead of overwriting invalid Claude Code config", () => {
    const homeDir = createTempHome();
    const configPath = join(homeDir, ".claude.json");
    writeFileSync(configPath, "{ invalid json");

    const result = configureMcpServer(
      "claude_code",
      "http://localhost:3000",
      "test-key",
      { homeDir },
    );

    expect(result).toEqual({
      configured: false,
      clientLabel: "Claude Code",
      warning: `Could not auto-configure because ${configPath} contains invalid JSON.`,
    });
    expect(readFileSync(configPath, "utf-8")).toBe("{ invalid json");
  });

  it("writes the AgentFiles MCP server into Codex config.toml", () => {
    const homeDir = createTempHome();
    const codexConfigPath = join(homeDir, ".codex", "config.toml");
    mkdirSync(join(homeDir, ".codex"), { recursive: true });
    writeFileSync(
      codexConfigPath,
      [
        'model = "gpt-5"',
        "",
        "[mcp_servers.agentfiles]",
        'command = "old"',
        "",
        "[mcp_servers.agentfiles.env]",
        'ATTACH_API_KEY = "old-key"',
        "",
        "[mcp_servers.other]",
        'command = "other"',
        "",
      ].join("\n"),
    );
    const commandRunner = vi.fn().mockReturnValueOnce(
      createSpawnResult({
        status: 0,
        stdout: "codex 0.0.0\n",
      }),
    );

    const result = configureMcpServer(
      "codex",
      "http://localhost:3000",
      "test-key",
      { commandRunner, homeDir },
    );

    expect(result).toMatchObject({
      configured: true,
      clientLabel: "Codex",
    });
    expect(commandRunner).toHaveBeenCalledTimes(1);
    expect(commandRunner).toHaveBeenCalledWith(
      "codex",
      ["--version"],
      expect.objectContaining({ encoding: "utf-8" }),
    );

    const codexConfig = readFileSync(codexConfigPath, "utf-8");
    expect(codexConfig).toContain('model = "gpt-5"');
    expect(codexConfig).toContain("[mcp_servers.other]");
    expect(codexConfig).toContain("[mcp_servers.agentfiles]");
    expect(codexConfig).toContain('command = "npx"');
    expect(codexConfig).toContain('args = ["-y", "agentfiles-mcp"]');
    expect(codexConfig).toContain('ATTACH_API_KEY = "test-key"');
    expect(codexConfig).toContain('ATTACH_API_URL = "http://localhost:3000"');
    expect(codexConfig).not.toContain('ATTACH_API_KEY = "old-key"');
    expect(statSync(codexConfigPath).mode & 0o777).toBe(0o600);
  });

  it("creates a named MCP entry when instanceName is provided (Claude Code)", () => {
    const homeDir = createTempHome();
    const configPath = join(homeDir, ".claude.json");
    // Pre-populate with the default agentfiles entry
    writeFileSync(configPath, JSON.stringify({
      mcpServers: {
        agentfiles: { type: "stdio", command: "npx", args: ["-y", "agentfiles-mcp"], env: { ATTACH_RUNTIME_KIND: "claude_code" } },
      },
    }, null, 2));

    const result = configureMcpServer(
      "claude_code",
      "http://localhost:3000",
      "test-key-2",
      { homeDir, instanceName: "Claude PR Bot" },
    );

    expect(result).toMatchObject({
      configured: true,
      clientLabel: "Claude Code (claude-pr-bot)",
    });

    const config = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>;
    const mcpServers = config["mcpServers"] as Record<string, Record<string, unknown>>;

    // Original entry preserved
    expect(mcpServers["agentfiles"]).toBeDefined();
    expect((mcpServers["agentfiles"]!["env"] as Record<string, string>)["ATTACH_RUNTIME_KIND"]).toBe("claude_code");

    // Named entry added alongside
    expect(mcpServers["agentfiles-claude-pr-bot"]).toBeDefined();
    const namedEnv = (mcpServers["agentfiles-claude-pr-bot"]!["env"] as Record<string, string>);
    expect(namedEnv["ATTACH_RUNTIME_KIND"]).toBe("claude-pr-bot");
    expect(namedEnv["ATTACH_API_KEY"]).toBe("test-key-2");
  });

  it("creates a named MCP entry when instanceName is provided (Codex)", () => {
    const homeDir = createTempHome();
    const codexConfigPath = join(homeDir, ".codex", "config.toml");
    mkdirSync(join(homeDir, ".codex"), { recursive: true });
    // Pre-populate with the default agentfiles entry
    writeFileSync(codexConfigPath, [
      "[mcp_servers.agentfiles]",
      'command = "npx"',
      "",
      "[mcp_servers.agentfiles.env]",
      'ATTACH_RUNTIME_KIND = "codex"',
      "",
    ].join("\n"));

    const commandRunner = vi.fn().mockReturnValueOnce(
      createSpawnResult({ status: 0, stdout: "codex 0.0.0\n" }),
    );

    const result = configureMcpServer(
      "codex",
      "http://localhost:3000",
      "test-key-2",
      { commandRunner, homeDir, instanceName: "codex-pr-bot" },
    );

    expect(result).toMatchObject({
      configured: true,
      clientLabel: "Codex (codex-pr-bot)",
    });

    const codexConfig = readFileSync(codexConfigPath, "utf-8");
    // Original entry preserved
    expect(codexConfig).toContain("[mcp_servers.agentfiles]");
    expect(codexConfig).toContain('ATTACH_RUNTIME_KIND = "codex"');
    // Named entry added alongside
    expect(codexConfig).toContain("[mcp_servers.agentfiles-codex-pr-bot]");
    expect(codexConfig).toContain('ATTACH_RUNTIME_KIND = "codex-pr-bot"');
    expect(codexConfig).toContain('ATTACH_API_KEY = "test-key-2"');
  });

  it("returns a warning when Codex is not installed", () => {
    const enoent = Object.assign(new Error("spawnSync codex ENOENT"), {
      code: "ENOENT",
    });
    const commandRunner = vi.fn().mockReturnValueOnce(
      createSpawnResult({
        status: null,
        error: enoent,
      }),
    );

    const result = configureMcpServer(
      "codex",
      "http://localhost:3000",
      "test-key",
      { commandRunner },
    );

    expect(result).toMatchObject({
      configured: false,
      clientLabel: "Codex",
      warning: "Could not auto-configure Codex because the `codex` command was not found.",
    });
    expect(commandRunner).toHaveBeenCalledTimes(1);
  });
});

describe("buildConnectSummary", () => {
  it("describes the OpenClaw skill path truthfully", () => {
    const summary = buildConnectSummary({
      clientKind: "openclaw",
      configPath: "/tmp/config.json",
      credentials: {
        api_base_url: "http://localhost:3000",
        api_key: "test-key",
        principal: { id: "prn_123", type: "agent" },
        namespace: { id: "ns_123", slug: "default" },
        scope: { permissions: ["artifacts:read", "artifacts:write"] },
        suggested_env: {
          ATTACH_API_KEY: "test-key",
          ATTACH_API_URL: "http://localhost:3000",
        },
      },
      mcpConfig: { configured: false },
      outputMode: "config",
    });

    expect(summary.join("\n")).toContain("OpenClaw uses the AgentFiles skill adapter in V1.");
    expect(summary.join("\n")).toContain("skills/agentfiles");
  });

  it("describes the manual MCP path for remote clients", () => {
    const summary = buildConnectSummary({
      clientKind: "mcp",
      configPath: undefined,
      credentials: {
        api_base_url: "http://localhost:3000",
        api_key: "test-key",
        principal: { id: "prn_123", type: "agent" },
        namespace: null,
        scope: { permissions: ["artifacts:read"] },
        suggested_env: {
          ATTACH_API_KEY: "test-key",
          ATTACH_API_URL: "http://localhost:3000",
        },
      },
      mcpConfig: { configured: false },
      outputMode: "json",
    });

    expect(summary.join("\n")).toContain("Manual MCP client path:");
    expect(summary.join("\n")).toContain("agentfiles-mcp-http");
    expect(summary.join("\n")).toContain("emitted credentials as JSON only");
    expect(summary.join("\n")).toContain("Authorization: Bearer");
  });

  it("describes how MCP users should reuse a written env file", () => {
    const summary = buildConnectSummary({
      clientKind: "mcp",
      configPath: "/tmp/agentfiles.env",
      credentials: {
        api_base_url: "http://localhost:3000",
        api_key: "test-key",
        principal: { id: "prn_123", type: "agent" },
        namespace: null,
        scope: { permissions: ["artifacts:read"] },
        suggested_env: {
          ATTACH_API_KEY: "test-key",
          ATTACH_API_URL: "http://localhost:3000",
        },
      },
      mcpConfig: { configured: false },
      outputMode: "env",
    });

    expect(summary.join("\n")).toContain("wrote ATTACH_API_URL / ATTACH_API_KEY to /tmp/agentfiles.env");
    expect(summary.join("\n")).toContain("Export or source that file");
  });
});
