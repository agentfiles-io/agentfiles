import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getLocalConfigPath, loadLocalConfig, resolveMcpConfig } from "./config.js";

describe("resolveMcpConfig", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        rmSync(dir, { force: true, recursive: true });
      }
    }
  });

  function createTempHome(): string {
    const dir = mkdtempSync(join(tmpdir(), "agentfiles-mcp-config-"));
    tempDirs.push(dir);
    return dir;
  }

  it("loads credentials from local AgentFiles config when env vars are absent", () => {
    const homeDir = createTempHome();
    const configPath = getLocalConfigPath(homeDir);
    mkdirSync(join(homeDir, ".attach"), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        api_key: "cfg-key",
        api_url: "https://api.example.com/",
      }),
    );

    expect(loadLocalConfig(homeDir)).toEqual({
      api_key: "cfg-key",
      api_url: "https://api.example.com/",
      default_namespace: undefined,
    });
    expect(resolveMcpConfig({}, homeDir)).toEqual({
      apiKey: "cfg-key",
      baseUrl: "https://api.example.com",
      configPath,
      shareBaseUrl: "https://api.example.com",
      defaultNamespace: undefined,
    });
  });

  it("prefers explicit env vars over local config", () => {
    const homeDir = createTempHome();
    const configPath = getLocalConfigPath(homeDir);
    mkdirSync(join(homeDir, ".attach"), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({
        api_key: "cfg-key",
        api_url: "https://api.example.com",
      }),
    );

    expect(
      resolveMcpConfig(
        {
          ATTACH_API_KEY: "env-key",
          ATTACH_API_URL: "https://env.example.com/",
        },
        homeDir,
      ),
    ).toEqual({
      apiKey: "env-key",
      baseUrl: "https://env.example.com",
      configPath,
      shareBaseUrl: "https://env.example.com",
      defaultNamespace: undefined,
    });
  });

  it("prefers PUBLIC_APP_URL for share links when configured", () => {
    const homeDir = createTempHome();

    expect(
      resolveMcpConfig(
        {
          ATTACH_API_KEY: "env-key",
          ATTACH_API_URL: "https://api.example.com",
          PUBLIC_APP_URL: "https://app.example.com",
        },
        homeDir,
      ),
    ).toEqual({
      apiKey: "env-key",
      baseUrl: "https://api.example.com",
      configPath: undefined,
      shareBaseUrl: "https://app.example.com",
      defaultNamespace: undefined,
    });
  });
});
