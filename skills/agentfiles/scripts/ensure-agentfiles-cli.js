#!/usr/bin/env node

import { resolveAgentfilesInvocation } from "./resolve-agentfiles.js";

const asJson = process.argv.includes("--json");

try {
  const invocation = resolveAgentfilesInvocation();
  const result = {
    source: invocation.source,
    command: invocation.command,
    args: invocation.args,
    display: invocation.display,
  };

  if (asJson) {
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  }

  console.log(`Resolved AgentFiles CLI: ${result.display}`);
  console.log(`Source: ${result.source}`);
  console.log(`Executable: ${result.command}`);
  if (result.args.length > 0) {
    console.log(`Prefix args: ${result.args.join(" ")}`);
  }
  if (result.source === "npx" || result.source === "npm-exec") {
    console.log(
      "Note: the npm-backed fallback may need network access the first time it fetches agentfiles-cli.",
    );
  }
} catch (error) {
  console.error("Error:", error instanceof Error ? error.message : String(error));
  process.exit(1);
}
