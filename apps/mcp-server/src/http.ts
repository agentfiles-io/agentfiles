import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { resolveMcpConfig } from "./config.js";
import { createMcpHttpServer, parseHttpServerOptions } from "./http-server.js";
import { initServer, server } from "./server.js";

async function main() {
  const config = resolveMcpConfig();
  initServer(config);
  const { host, mcpPath, port } = parseHttpServerOptions();
  // StreamableHTTPServerTransport requires sessionIdGenerator but accepts undefined
  // to disable session tracking. The SDK types don't reflect this, so we cast.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  } as unknown as ConstructorParameters<typeof StreamableHTTPServerTransport>[0]);

  await server.connect(transport as Parameters<typeof server.connect>[0]);

  const httpServer = createMcpHttpServer(transport, {
    authToken: config.apiKey,
    mcpPath,
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, () => {
      httpServer.off("error", reject);
      resolve();
    });
  });

  console.error(`AgentFiles MCP HTTP server listening on http://${host}:${port}${mcpPath}`);
  console.error(`Health check: http://${host}:${port}/health`);
  if (config.configPath) {
    console.error(`Loaded AgentFiles credentials from ${config.configPath}`);
  }

  const shutdown = () => {
    httpServer.close(() => {
      void transport.close().finally(() => {
        process.exit(0);
      });
    });
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
