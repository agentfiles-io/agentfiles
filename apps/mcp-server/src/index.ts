import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { resolveMcpConfig } from "./config.js";
import { initServer, server } from "./server.js";

async function main() {
  initServer(resolveMcpConfig());
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("AgentFiles MCP server started");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
