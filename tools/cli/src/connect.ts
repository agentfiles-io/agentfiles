import type { Command } from "commander";
import { type ConnectClientKind } from "@attach/shared";
import {
  loadConfig,
  saveConfig,
  getConfigPath,
  writePrivateFile,
} from "./config.js";
import {
  type RedeemResponse,
  resolveApiUrl,
  runBrowserConnectFlow,
  toAttachConfig,
} from "./connect-flow.js";
import {
  type McpConfigResult,
  configureMcpServer,
} from "./runtime-config.js";

export { configureMcpServer } from "./runtime-config.js";

const VALID_CLIENT_KINDS = [
  "openclaw",
  "claude_code",
  "codex",
  "mcp",
  "generic",
] as const satisfies readonly ConnectClientKind[];

type ConnectOutputMode = "config" | "json" | "env";

interface ConnectRunResult {
  clientKind: ConnectClientKind;
  configPath: string | undefined;
  credentials: RedeemResponse;
  mcpConfig: McpConfigResult;
  outputMode: ConnectOutputMode;
}

interface ConnectCommandOptions {
  displayName?: string;
  apiUrl?: string;
  json?: boolean;
  configPath?: string;
  writeEnv?: string;
}

function validateClientKind(value: string): ConnectClientKind {
  if ((VALID_CLIENT_KINDS as readonly string[]).includes(value)) {
    return value as ConnectClientKind;
  }

  throw new Error(
    `client_kind must be one of: ${VALID_CLIENT_KINDS.join(", ")}`,
  );
}

function saveConnectionOutput(
  credentials: RedeemResponse,
  options: ConnectCommandOptions,
): { outputMode: ConnectOutputMode; configPath: string | undefined } {
  if (options.json) {
    console.log(JSON.stringify(credentials, null, 2));
    return { outputMode: "json", configPath: undefined };
  }

  if (options.writeEnv) {
    const envContent = `ATTACH_API_URL=${credentials.api_base_url}\nATTACH_API_KEY=${credentials.api_key}\n`;
    writePrivateFile(options.writeEnv, envContent);
    return { outputMode: "env", configPath: options.writeEnv };
  }

  const configToSave = toAttachConfig(credentials);
  if (options.configPath) {
    writePrivateFile(options.configPath, JSON.stringify(configToSave, null, 2));
    return { outputMode: "config", configPath: options.configPath };
  }

  saveConfig(configToSave);
  return { outputMode: "config", configPath: getConfigPath() };
}

function describeDefaultConfigReadiness(
  result: ConnectRunResult,
  consumerName: string,
): string {
  const defaultConfigPath = getConfigPath();

  if (result.outputMode === "config" && result.configPath === defaultConfigPath) {
    return `This run saved ${defaultConfigPath}, so ${consumerName} can read it directly.`;
  }

  if (result.outputMode === "config" && result.configPath) {
    return `This run wrote config to ${result.configPath}. ${consumerName} only auto-reads ${defaultConfigPath}, so either copy that file there or export ATTACH_API_URL / ATTACH_API_KEY before you start it.`;
  }

  if (result.outputMode === "env" && result.configPath) {
    return `This run wrote ATTACH_API_URL / ATTACH_API_KEY to ${result.configPath}. Export or source that file before you start ${consumerName}.`;
  }

  return `This run emitted credentials as JSON only. Export ATTACH_API_URL / ATTACH_API_KEY or write ${defaultConfigPath} before you start ${consumerName}.`;
}

function manualNextStepsForClient(result: ConnectRunResult): string[] {
  const defaultConfigPath = getConfigPath();

  if (result.clientKind === "openclaw") {
    if (result.outputMode === "config" && result.configPath === defaultConfigPath) {
      return [
        "OpenClaw uses the AgentFiles skill adapter in V1.",
        "Install `skills/agentfiles`, then run `scripts/run-agentfiles.js whoami` on the OpenClaw host to verify the shared local config.",
      ];
    }

    let credentialNote: string;
    if (result.outputMode === "config" && result.configPath) {
      credentialNote = `This run wrote config to ${result.configPath}. Copy that file to ${defaultConfigPath} on the OpenClaw host before using the skill.`;
    } else if (result.outputMode === "env" && result.configPath) {
      credentialNote = `This run wrote ATTACH_API_URL / ATTACH_API_KEY to ${result.configPath}. The skill reads ${defaultConfigPath}, not env files, so initialize the local CLI config on the OpenClaw host before using it.`;
    } else {
      credentialNote = `This run emitted credentials as JSON only. Write ${defaultConfigPath} on the OpenClaw host before using the skill.`;
    }

    return [
      "OpenClaw uses the AgentFiles skill adapter in V1.",
      `Install \`skills/agentfiles\`. ${credentialNote}`,
      "Then run `scripts/run-agentfiles.js whoami` on the OpenClaw host before using publish/get/search/list/share/watch commands.",
    ];
  }

  if (result.clientKind === "mcp") {
    return [
      "Manual MCP client path:",
      "Run `npx -y --package agentfiles-mcp@latest agentfiles-mcp-http --port 8787`.",
      describeDefaultConfigReadiness(result, "`agentfiles-mcp-http`"),
      "Then expose `https://<your-host>/mcp` and configure your remote/manual client with `Authorization: Bearer <your AgentFiles API key>`.",
    ];
  }

  if (result.clientKind === "generic") {
    return [
      "No runtime auto-configuration was attempted.",
      "Use the saved AgentFiles config directly, or connect a specific runtime later with `agentfiles connect <runtime>`.",
    ];
  }

  return [];
}

export function buildConnectSummary(result: ConnectRunResult): string[] {
  const lines = [
    "",
    "Connected successfully!",
    `  Principal: ${result.credentials.principal.id} (${result.credentials.principal.type})`,
  ];

  if (result.outputMode === "json") {
    lines.push("  Output: credentials emitted as JSON on stdout");
  }

  if (result.configPath && result.outputMode === "config") {
    lines.push(`  Config: ${result.configPath}`);
  }

  if (result.configPath && result.outputMode === "env") {
    lines.push(`  Env file: ${result.configPath}`);
  }

  if (result.credentials.namespace?.slug) {
    lines.push(`  Namespace: ${result.credentials.namespace.slug}`);
  }

  if (result.credentials.scope.permissions) {
    lines.push(`  Permissions: ${result.credentials.scope.permissions.join(", ")}`);
  }

  if (result.mcpConfig.configured && result.mcpConfig.clientLabel) {
    lines.push("", `Runtime setup: ${result.mcpConfig.detail ?? `${result.mcpConfig.clientLabel} configured.`}`);
  } else if (result.mcpConfig.warning) {
    lines.push("", `Runtime setup warning: ${result.mcpConfig.warning}`);
  }

  const manualSteps = manualNextStepsForClient(result);
  if (manualSteps.length > 0) {
    lines.push("", ...manualSteps);
  }

  return lines;
}

async function runConnectCommand(
  clientKind: ConnectClientKind,
  options: ConnectCommandOptions,
): Promise<ConnectRunResult> {
  const existingConfig = loadConfig();
  const apiUrl = resolveApiUrl(options.apiUrl, existingConfig);
  const displayName = options.displayName ?? `${clientKind} Agent`;

  const credentials = await runBrowserConnectFlow(
    {
      apiUrl,
      clientKind,
      displayName,
    },
    { report: (message) => console.error(message) },
  );

  const { outputMode, configPath } = saveConnectionOutput(credentials, options);

  // If user provided a custom display name, use it as the instance name
  // so it gets a distinct MCP entry and ATTACH_RUNTIME_KIND
  const defaultName = `${clientKind} Agent`;
  const instanceName = options.displayName && options.displayName !== defaultName
    ? options.displayName
    : undefined;

  const mcpConfig = configureMcpServer(
    clientKind,
    credentials.api_base_url,
    credentials.api_key,
    instanceName ? { instanceName } : {},
  );

  return {
    clientKind,
    configPath,
    credentials,
    mcpConfig,
    outputMode,
  };
}

export function registerConnectCommand(program: Command): void {
  program
    .command("connect")
    .description("Connect an agent to AgentFiles via browser approval")
    .argument("<client_kind>", "Agent type (openclaw, claude_code, codex, mcp, generic)")
    .option("--display-name <name>", "Agent display name")
    .option("--api-url <url>", "API URL")
    .option("--json", "Output credentials as JSON to stdout")
    .option("--config-path <path>", "Write config to a custom path")
    .option("--write-env <path>", "Write env file with ATTACH_API_URL and ATTACH_API_KEY")
    .action(async (clientKind: string, options: ConnectCommandOptions) => {
      try {
        const normalizedClientKind = validateClientKind(clientKind);

        const outputModes = [options.json, options.configPath, options.writeEnv].filter(Boolean);
        if (outputModes.length > 1) {
          throw new Error("--json, --config-path, and --write-env are mutually exclusive");
        }

        const result = await runConnectCommand(normalizedClientKind, options);
        for (const line of buildConnectSummary(result)) {
          console.error(line);
        }
      } catch (error) {
        console.error("Error:", error instanceof Error ? error.message : error);
        process.exit(1);
      }
    });
}
