import type { Command } from "commander";
import { loadConfig, saveConfig, getConfigPath } from "./config.js";
import {
  type RedeemResponse,
  resolveApiUrl,
  runBrowserConnectFlow,
  toAttachConfig,
} from "./connect-flow.js";
import {
  type McpConfigResult,
  configureSupportedLocalRuntimes,
} from "./runtime-config.js";

interface SetupRunOptions {
  apiUrl?: string;
  displayName?: string;
}

interface SetupRunDependencies {
  connectFlow?: typeof runBrowserConnectFlow;
  saveConfigImpl?: typeof saveConfig;
  configureSupportedLocalRuntimesImpl?: typeof configureSupportedLocalRuntimes;
  report?: (message: string) => void;
}

export interface SetupRunResult {
  configPath: string;
  credentials: RedeemResponse;
  runtimeResults: McpConfigResult[];
}

function formatSharedCredentialNote(configPath: string): string {
  return `Saved one shared local AgentFiles credential set in ${configPath}. \`agentfiles connect <runtime>\` mints a runtime-specific credential, but it replaces this local config unless you use \`--config-path\`, \`--write-env\`, or \`--json\`.`;
}

export function buildSetupSummary(result: SetupRunResult): string[] {
  const lines = [
    "",
    "Setup complete.",
    `  Config: ${result.configPath}`,
    `  Principal: ${result.credentials.principal.id} (${result.credentials.principal.type})`,
    formatSharedCredentialNote(result.configPath),
  ];

  if (result.credentials.namespace?.slug) {
    lines.push(`  Namespace: ${result.credentials.namespace.slug}`);
  }

  if (result.credentials.scope.permissions) {
    lines.push(`  Permissions: ${result.credentials.scope.permissions.join(", ")}`);
  }

  const configured = result.runtimeResults.filter((runtimeResult) => runtimeResult.configured);
  if (configured.length > 0) {
    lines.push("", "Configured automatically:");
    for (const runtimeResult of configured) {
      lines.push(`  - ${runtimeResult.clientLabel}: ${runtimeResult.detail ?? "Configured."}`);
    }
  }

  const warnings = result.runtimeResults.filter((runtimeResult) => runtimeResult.warning);
  if (warnings.length > 0) {
    lines.push("", "Automatic setup skipped:");
    for (const runtimeResult of warnings) {
      lines.push(`  - ${runtimeResult.clientLabel}: ${runtimeResult.warning}`);
    }
  }

  lines.push(
    "",
    "Manual next steps:",
    "  - OpenClaw: install the AgentFiles skill from `skills/agentfiles`, then run `scripts/run-agentfiles.js whoami` inside that environment. The skill reads the config saved above.",
    "  - ChatGPT app/web: run `npx -y --package agentfiles-mcp@latest agentfiles-mcp-http --port 8787`. It will read the local AgentFiles config by default, or ATTACH_API_URL / ATTACH_API_KEY if you export them. Then expose `https://<your-host>/mcp` and configure the connector with `Authorization: Bearer <your AgentFiles API key>`.",
  );

  return lines;
}

export async function runSetup(
  options: SetupRunOptions,
  dependencies: SetupRunDependencies = {},
): Promise<SetupRunResult> {
  const connectFlow = dependencies.connectFlow ?? runBrowserConnectFlow;
  const saveConfigImpl = dependencies.saveConfigImpl ?? saveConfig;
  const configureSupportedLocalRuntimesImpl =
    dependencies.configureSupportedLocalRuntimesImpl ?? configureSupportedLocalRuntimes;
  const report = dependencies.report ?? ((message: string) => console.error(message));

  const existingConfig = loadConfig();
  const apiUrl = resolveApiUrl(options.apiUrl, existingConfig);
  const displayName = options.displayName ?? "AgentFiles Setup";

  const credentials = await connectFlow(
    {
      apiUrl,
      clientKind: "setup",
      displayName,
    },
    { report },
  );

  saveConfigImpl(toAttachConfig(credentials));
  const configPath = getConfigPath();
  report(`Config saved to: ${configPath}`);

  report("Configuring supported local runtimes...");
  const runtimeResults = configureSupportedLocalRuntimesImpl(
    credentials.api_base_url,
    credentials.api_key,
  );

  return {
    configPath,
    credentials,
    runtimeResults,
  };
}

export function registerSetupCommand(program: Command): void {
  program
    .command("setup")
    .description("Run one approval flow and configure supported local runtimes")
    .option("--display-name <name>", "Agent display name")
    .option("--api-url <url>", "API URL")
    .action(async (options: SetupRunOptions) => {
      try {
        const result = await runSetup(options);
        for (const line of buildSetupSummary(result)) {
          console.error(line);
        }
      } catch (error) {
        console.error("Error:", error instanceof Error ? error.message : error);
        process.exit(1);
      }
    });
}
