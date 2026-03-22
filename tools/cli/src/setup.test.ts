import { describe, expect, it, vi } from "vitest";
import { getConfigPath } from "./config.js";
import { buildSetupSummary, runSetup } from "./setup.js";

describe("runSetup", () => {
  it("uses one shared connect flow and configures supported runtimes", async () => {
    const connectFlow = vi.fn().mockResolvedValue({
      api_base_url: "http://localhost:3000",
      api_key: "test-key",
      principal: { id: "prn_123", type: "agent" },
      namespace: { id: "ns_123", slug: "default" },
      scope: { permissions: ["artifacts:read", "artifacts:write"] },
      suggested_env: {
        ATTACH_API_KEY: "test-key",
        ATTACH_API_URL: "http://localhost:3000",
      },
    });
    const saveConfigImpl = vi.fn();
    const configureSupportedLocalRuntimesImpl = vi.fn().mockReturnValue([
      {
        configured: true,
        clientLabel: "Claude Code",
        detail: "Updated ~/.claude.json.",
      },
      {
        configured: false,
        clientLabel: "Codex",
        warning: "Could not auto-configure Codex because the `codex` command was not found.",
      },
    ]);

    const result = await runSetup(
      {
        apiUrl: "http://localhost:3000",
      },
      {
        connectFlow,
        saveConfigImpl,
        configureSupportedLocalRuntimesImpl,
        report: vi.fn(),
      },
    );

    expect(connectFlow).toHaveBeenCalledWith(
      {
        apiUrl: "http://localhost:3000",
        clientKind: "setup",
        displayName: "AgentFiles Setup",
      },
      expect.any(Object),
    );
    expect(saveConfigImpl).toHaveBeenCalledWith({
      api_url: "http://localhost:3000",
      api_key: "test-key",
      default_namespace: "default",
    });
    expect(configureSupportedLocalRuntimesImpl).toHaveBeenCalledWith(
      "http://localhost:3000",
      "test-key",
    );
    expect(result.configPath).toBe(getConfigPath());
  });
});

describe("buildSetupSummary", () => {
  it("lists automatic and manual next steps", () => {
    const summary = buildSetupSummary({
      configPath: "/tmp/agentfiles-config.json",
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
      runtimeResults: [
        {
          configured: true,
          clientLabel: "Claude Code",
          detail: "Updated ~/.claude.json.",
        },
        {
          configured: false,
          clientLabel: "Codex",
          warning: "Could not auto-configure Codex because the `codex` command was not found.",
        },
      ],
    });

    expect(summary.join("\n")).toContain("Configured automatically:");
    expect(summary.join("\n")).toContain("Claude Code");
    expect(summary.join("\n")).toContain("Manual next steps:");
    expect(summary.join("\n")).toContain("OpenClaw");
    expect(summary.join("\n")).toContain("ChatGPT app/web");
  });
});
