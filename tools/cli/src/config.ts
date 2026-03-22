import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface AttachConfig {
  api_url: string;
  api_key: string;
  default_namespace?: string;
}

const CONFIG_DIR = join(homedir(), ".attach");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  } else {
    chmodSync(CONFIG_DIR, 0o700);
  }
}

export function loadConfig(): AttachConfig | null {
  if (!existsSync(CONFIG_FILE)) {
    return null;
  }

  try {
    const content = readFileSync(CONFIG_FILE, "utf-8");
    return JSON.parse(content) as AttachConfig;
  } catch {
    return null;
  }
}

export function writePrivateFile(filePath: string, content: string): void {
  writeFileSync(filePath, content, { mode: 0o600 });
  chmodSync(filePath, 0o600);
}

export function saveConfig(config: AttachConfig): void {
  ensureConfigDir();
  writePrivateFile(CONFIG_FILE, JSON.stringify(config, null, 2));
}

export function getConfigPath(): string {
  return CONFIG_FILE;
}

export function requireConfig(): AttachConfig {
  const config = loadConfig();
  if (!config || !config.api_key) {
    console.error("Error: Not configured. Run 'agentfiles setup' or 'agentfiles config' first.");
    process.exit(1);
  }
  return config;
}
