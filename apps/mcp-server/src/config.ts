import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface AttachCliConfig {
  api_key: string;
  api_url: string;
  default_namespace?: string;
}

export interface ResolvedMcpConfig {
  apiKey: string;
  baseUrl: string;
  configPath: string | undefined;
  shareBaseUrl: string;
  defaultNamespace: string | undefined;
}

function sanitizePublicBaseUrl(value: string, envName: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${envName} must use http:// or https://.`);
  }
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error(`${envName} must not include a path, query, or hash.`);
  }
  return parsed.origin;
}

export function getLocalConfigPath(homeDir = homedir()): string {
  return join(homeDir, ".attach", "config.json");
}

export function loadLocalConfig(homeDir = homedir()): AttachCliConfig | null {
  const configPath = getLocalConfigPath(homeDir);
  if (!existsSync(configPath)) {
    return null;
  }

  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf-8")) as Partial<AttachCliConfig>;
    if (typeof parsed.api_key !== "string" || typeof parsed.api_url !== "string") {
      return null;
    }

    const result: AttachCliConfig = {
      api_key: parsed.api_key,
      api_url: parsed.api_url,
    };
    if (typeof parsed.default_namespace === "string") {
      result.default_namespace = parsed.default_namespace;
    }
    return result;
  } catch {
    return null;
  }
}

export function resolveMcpConfig(
  env = process.env,
  homeDir = homedir(),
): ResolvedMcpConfig {
  const localConfig = loadLocalConfig(homeDir);
  const configPath = localConfig ? getLocalConfigPath(homeDir) : undefined;
  const apiKey = env["ATTACH_API_KEY"] ?? localConfig?.api_key ?? "";
  const baseUrl = (env["ATTACH_API_URL"] ?? localConfig?.api_url ?? "http://localhost:3000")
    .replace(/\/$/, "");

  if (!apiKey) {
    throw new Error(
      "ATTACH_API_KEY is required. Set ATTACH_API_KEY/ATTACH_API_URL or run `agentfiles setup` to create ~/.attach/config.json.",
    );
  }

  const shareBaseUrl = env["PUBLIC_APP_URL"]?.trim()
    ? sanitizePublicBaseUrl(env["PUBLIC_APP_URL"], "PUBLIC_APP_URL")
    : env["PUBLIC_BASE_URL"]?.trim()
      ? sanitizePublicBaseUrl(env["PUBLIC_BASE_URL"], "PUBLIC_BASE_URL")
      : new URL(baseUrl).origin;

  const defaultNamespace = env["ATTACH_DEFAULT_NAMESPACE"] ?? localConfig?.default_namespace;

  return {
    apiKey,
    baseUrl,
    configPath,
    shareBaseUrl,
    defaultNamespace,
  };
}
