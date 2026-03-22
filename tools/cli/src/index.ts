import { Command } from "commander";
import {
  loadConfig,
  saveConfig,
  getConfigPath,
  requireConfig,
} from "./config.js";
import { AttachClient } from "./client.js";
import { registerConnectCommand } from "./connect.js";
import { buildArtifactShareUrl } from "./share-url.js";
import { registerSetupCommand } from "./setup.js";
import { registerWatchCommand } from "./watch.js";
import { publishArtifact } from "./publish-core.js";

const program = new Command();

program
  .name("agentfiles")
  .description("AgentFiles CLI — Share files and artifacts between AI agents")
  .version("0.1.0");

// Config command
program
  .command("config")
  .description("Configure the CLI")
  .option("--api-url <url>", "API URL", "http://localhost:3000")
  .option("--api-key <key>", "API key")
  .option("--default-namespace <slug>", "Default namespace slug")
  .option("--show", "Show current configuration")
  .action(async (options) => {
    if (options.show) {
      const config = loadConfig();
      if (config) {
        console.log("Current configuration:");
        console.log(`  API URL: ${config.api_url}`);
        console.log(`  API Key: ${config.api_key ? config.api_key.slice(0, 16) + "..." : "(not set)"}`);
        console.log(`  Default Namespace: ${config.default_namespace ?? "(not set)"}`);
        console.log(`\nConfig file: ${getConfigPath()}`);
      } else {
        console.log("Not configured. Run 'agentfiles setup' or 'agentfiles config --api-key <key>'.");
      }
      return;
    }

    const existing = loadConfig() ?? {
      api_url: "http://localhost:3000",
      api_key: "",
    };

    const newConfig = {
      api_url: options.apiUrl ?? existing.api_url,
      api_key: options.apiKey ?? existing.api_key,
      default_namespace: options.defaultNamespace ?? existing.default_namespace,
    };

    if (!newConfig.api_key) {
      console.error("Error: API key is required. Use --api-key <key>");
      process.exit(1);
    }

    saveConfig(newConfig);
    console.log("Configuration saved to", getConfigPath());

    // Verify the key works
    try {
      const client = new AttachClient({
        apiUrl: newConfig.api_url,
        apiKey: newConfig.api_key,
      });
      const me = await client.getMe();
      console.log(`Authenticated as: ${me.principal.name} (${me.principal.type})`);
      if (me.namespaces.length > 0) {
        console.log(`Available namespaces: ${me.namespaces.map((n) => n.slug).join(", ")}`);
      }
    } catch (error) {
      console.error("Warning: Could not verify API key:", error instanceof Error ? error.message : error);
    }
  });

// Publish command
program
  .command("publish")
  .description("Publish an artifact")
  .argument("[file]", "File to publish (or use --content)")
  .option("-n, --namespace <slug>", "Namespace slug")
  .option("-t, --title <title>", "Artifact title")
  .option("-d, --description <desc>", "Description")
  .option("-s, --slug <slug>", "Artifact slug (URL-friendly identifier)")
  .option("-m, --message <msg>", "Version message")
  .option("--content <text>", "Content to publish (instead of file)")
  .option("--content-type <type>", "Content type (auto-detected from file extension)")
  .option("--update <id>", "Update existing artifact by ID")
  .option("--no-git", "Don't capture git provenance")
  .action(async (file, options) => {
    try {
      const result = await publishArtifact(file, {
        namespace: options.namespace,
        title: options.title,
        description: options.description,
        slug: options.slug,
        message: options.message,
        content: options.content,
        contentType: options.contentType,
        update: options.update,
        git: options.git,
      });

      const { artifact, provenance, isUpdate } = result;
      console.log(`${isUpdate ? "Updated" : "Created"} artifact: ${artifact.id}`);
      console.log(`  Title: ${artifact.title}`);
      console.log(`  Version: ${artifact.current_version}`);
      console.log(`  Content-Type: ${artifact.content_type}`);

      if (provenance["gitRepoUrl"]) {
        console.log(`  Git: ${provenance["gitRepoUrl"]}`);
        if (provenance["gitRef"]) console.log(`  Branch: ${provenance["gitRef"]}`);
        if (provenance["gitCommitSha"]) console.log(`  Commit: ${String(provenance["gitCommitSha"]).slice(0, 8)}`);
      }
    } catch (error) {
      console.error("Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// Handoff command
program
  .command("handoff")
  .description("Publish an artifact addressed to another runtime")
  .argument("<recipient>", "Target runtime (e.g. codex, claude_code)")
  .argument("[file]", "File to hand off")
  .option("--content <text>", "Inline content")
  .option("--thread <thread-id>", "Thread ID for grouping")
  .option("--reply-to-artifact-id <id>", "Reply to an existing handoff artifact")
  .option("-n, --namespace <slug>", "Namespace slug")
  .option("-t, --title <title>", "Override auto-derived title")
  .option("--no-git", "Skip git provenance capture")
  .action(async (recipient, file, options) => {
    try {
      const result = await publishArtifact(
        file,
        {
          namespace: options.namespace,
          title: options.title,
          content: options.content,
          git: options.git,
        },
        {
          recipient,
          threadId: options.thread,
          replyToArtifactId: options.replyToArtifactId,
        },
      );

      const { artifact, provenance } = result;
      console.log(`Handed off artifact: ${artifact.id}`);
      console.log(`  Title: ${artifact.title}`);
      console.log(`  Recipient: ${recipient}`);
      console.log(`  Thread: ${provenance["threadId"] as string}`);
      console.log(`  Version: ${artifact.current_version}`);
      console.log(`  Content-Type: ${artifact.content_type}`);
      console.log(`  Hint: tell ${recipient} to fetch artifact ${artifact.id}`);
      console.log(`  Hint: or search "${provenance["threadId"] as string}" in the namespace`);
    } catch (error) {
      console.error("Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// Get command
program
  .command("get")
  .description("Get an artifact")
  .argument("<id>", "Artifact ID")
  .option("-v, --version <num>", "Specific version number")
  .option("--meta", "Show metadata only (no content)")
  .option("-o, --output <file>", "Write content to file")
  .action(async (id, options) => {
    const config = requireConfig();
    const client = new AttachClient({
      apiUrl: config.api_url,
      apiKey: config.api_key,
    });

    try {
      const artifact = await client.getArtifact(id);

      if (options.meta) {
        console.log(JSON.stringify(artifact, null, 2));
      } else {
        const content = await client.getArtifactContent(
          id,
          options.version ? parseInt(options.version, 10) : undefined
        );

        if (options.output) {
          const { writeFileSync } = await import("node:fs");
          writeFileSync(options.output, content);
          console.log(`Written to ${options.output}`);
        } else {
          console.log(content);
        }
      }
    } catch (error) {
      console.error("Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// Search command
program
  .command("search")
  .description("Search for artifacts")
  .argument("<query>", "Search query")
  .option("-n, --namespace <slug>", "Namespace slug")
  .option("-l, --limit <num>", "Max results", "10")
  .action(async (query, options) => {
    const config = requireConfig();
    const client = new AttachClient({
      apiUrl: config.api_url,
      apiKey: config.api_key,
    });

    const namespaceSlug = options.namespace ?? config.default_namespace;
    if (!namespaceSlug) {
      console.error("Error: Namespace is required. Use --namespace <slug>");
      process.exit(1);
    }

    try {
      const result = await client.searchArtifacts(
        namespaceSlug,
        query,
        parseInt(options.limit, 10)
      );

      if (result.artifacts.length === 0) {
        console.log("No artifacts found.");
        return;
      }

      for (const artifact of result.artifacts) {
        console.log(`${artifact.id}  ${artifact.title}`);
        if (artifact.description) {
          console.log(`    ${artifact.description}`);
        }
      }
    } catch (error) {
      console.error("Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// Share command
program
  .command("share")
  .description("Generate a share link for an artifact")
  .argument("<id>", "Artifact ID")
  .option("-e, --expires <days>", "Days until expiry", "7")
  .action(async (id, options) => {
    const config = requireConfig();
    const client = new AttachClient({
      apiUrl: config.api_url,
      apiKey: config.api_key,
    });

    try {
      const artifact = await client.getArtifact(id);

      const expiresAt = new Date(
        Date.now() + parseInt(options.expires, 10) * 24 * 60 * 60 * 1000
      ).toISOString();

      const grant = await client.createGrant({
        namespace_id: artifact.namespace_id,
        artifact_id: id,
        permissions: ["read"],
        expires_at: expiresAt,
      });

      const shareUrl = buildArtifactShareUrl(config.api_url, id);

      console.log("Share link created:");
      console.log(`  URL: ${shareUrl}`);
      console.log(`  Share Token (send as X-Share-Token): ${grant.token}`);
      console.log(`  Expires: ${expiresAt}`);
    } catch (error) {
      console.error("Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// List command
program
  .command("list")
  .description("List recent artifacts")
  .option("-n, --namespace <slug>", "Namespace slug")
  .option("-l, --limit <num>", "Max results", "20")
  .action(async (options) => {
    const config = requireConfig();
    const client = new AttachClient({
      apiUrl: config.api_url,
      apiKey: config.api_key,
    });

    const namespaceSlug = options.namespace ?? config.default_namespace;
    if (!namespaceSlug) {
      console.error("Error: Namespace is required. Use --namespace <slug>");
      process.exit(1);
    }

    try {
      const result = await client.listArtifacts(namespaceSlug, {
        limit: parseInt(options.limit, 10),
      });

      if (result.artifacts.length === 0) {
        console.log("No artifacts found.");
        return;
      }

      for (const artifact of result.artifacts) {
        const date = new Date(artifact.updated_at).toLocaleDateString();
        console.log(`${artifact.id}  v${artifact.current_version}  ${date}  ${artifact.title}`);
      }
    } catch (error) {
      console.error("Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

// Whoami command
program
  .command("whoami")
  .description("Show current user info")
  .action(async () => {
    const config = requireConfig();
    const client = new AttachClient({
      apiUrl: config.api_url,
      apiKey: config.api_key,
    });

    try {
      const me = await client.getMe();
      console.log(`Principal: ${me.principal.name}`);
      console.log(`Type: ${me.principal.type}`);
      console.log(`ID: ${me.principal.id}`);
      if (me.namespaces.length > 0) {
        console.log(`\nNamespaces:`);
        for (const ns of me.namespaces) {
          console.log(`  ${ns.slug} - ${ns.name}`);
        }
      }
    } catch (error) {
      console.error("Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program
  .command("stats")
  .description("Show account stats")
  .option("--admin", "Show global platform stats")
  .option("--json", "Output as JSON")
  .action(async (options: { admin?: boolean; json?: boolean }) => {
    const config = requireConfig();
    const client = new AttachClient({
      apiUrl: config.api_url,
      apiKey: config.api_key,
    });

    try {
      if (options.admin) {
        const stats = await client.getAdminStats();
        if (options.json) {
          console.log(JSON.stringify(stats, null, 2));
        } else {
          console.log("Platform Stats");
          console.log("──────────────");
          console.log(`Users:      ${stats.users}`);
          console.log(`Agents:     ${stats.agents}`);
          console.log(`Artifacts:  ${stats.artifacts}`);
          console.log(`Versions:   ${stats.versions}`);
          console.log(`Namespaces: ${stats.namespaces}`);
          console.log(`API Keys:   ${stats.api_keys}`);
          console.log(`Instances:  ${stats.instances}`);
        }
      } else {
        const stats = await client.getStats();
        if (options.json) {
          console.log(JSON.stringify(stats, null, 2));
        } else {
          console.log("Account Stats");
          console.log("─────────────");
          console.log(`Artifacts:  ${stats.artifacts}`);
          console.log(`API Keys:   ${stats.api_keys}`);
          console.log(`Instances:  ${stats.instances}`);
          console.log(`Namespaces: ${stats.namespaces}`);
        }
      }
    } catch (error) {
      console.error("Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

registerSetupCommand(program);
registerConnectCommand(program);
registerWatchCommand(program);

program.parse();
