import { timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";

export interface McpHttpServerOptions {
  authToken: string;
  mcpPath?: string;
}

export interface McpHttpTransport {
  handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void>;
}

interface ParsedHttpServerOptions {
  host: string;
  mcpPath: string;
  port: number;
}

function writeJson(
  res: ServerResponse,
  statusCode: number,
  payload: Record<string, unknown>,
): void {
  if (res.headersSent) {
    return;
  }

  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function tryParseRequestUrl(req: IncomingMessage): URL | null {
  try {
    return new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
  } catch {
    return null;
  }
}

function hasValidBearerToken(
  authorizationHeader: string | undefined,
  expectedToken: string,
): boolean {
  const expected = `Bearer ${expectedToken}`;
  if (!authorizationHeader || authorizationHeader.length !== expected.length) {
    return false;
  }

  return timingSafeEqual(Buffer.from(authorizationHeader), Buffer.from(expected));
}

export function parseHttpServerOptions(
  argv = process.argv.slice(2),
  env = process.env,
): ParsedHttpServerOptions {
  let host = env["AGENTFILES_MCP_HOST"] ?? "127.0.0.1";
  let port = Number.parseInt(env["AGENTFILES_MCP_PORT"] ?? "8787", 10);
  let mcpPath = env["AGENTFILES_MCP_PATH"] ?? "/mcp";

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === "--host" && next) {
      host = next;
      index += 1;
      continue;
    }

    if (arg === "--port" && next) {
      port = Number.parseInt(next, 10);
      index += 1;
      continue;
    }

    if (arg === "--path" && next) {
      mcpPath = next;
      index += 1;
      continue;
    }
  }

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Invalid port. Use a value between 1 and 65535.");
  }

  if (!mcpPath.startsWith("/")) {
    throw new Error("Invalid path. MCP path must start with '/'.");
  }

  return {
    host,
    mcpPath,
    port,
  };
}

export function createMcpHttpRequestHandler(
  transport: McpHttpTransport,
  options: McpHttpServerOptions,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const mcpPath = options.mcpPath ?? "/mcp";

  return async (req: IncomingMessage, res: ServerResponse) => {
    const url = tryParseRequestUrl(req);
    if (!url) {
      writeJson(res, 400, {
        error: "bad_request",
        message: "Invalid request URL.",
      });
      return;
    }

    if (url.pathname === "/health") {
      writeJson(res, 200, {
        path: mcpPath,
        status: "ok",
        transport: "streamable_http",
      });
      return;
    }

    if (url.pathname !== mcpPath) {
      writeJson(res, 404, {
        error: "not_found",
        message: "Not found",
      });
      return;
    }

    if (!hasValidBearerToken(req.headers.authorization, options.authToken)) {
      writeJson(res, 401, {
        error: "unauthorized",
        message: "Provide Authorization: Bearer <ATTACH_API_KEY>.",
      });
      return;
    }

    try {
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error("MCP transport error:", error);
      writeJson(res, 500, {
        error: "internal_error",
        message: "An unexpected error occurred.",
      });
    }
  };
}

export function createMcpHttpServer(
  transport: McpHttpTransport,
  options: McpHttpServerOptions,
): HttpServer {
  const handler = createMcpHttpRequestHandler(transport, options);
  return createServer((req, res) => {
    void handler(req, res).catch((error) => {
      console.error("MCP HTTP handler error:", error);
      writeJson(res, 500, {
        error: "internal_error",
        message: "An unexpected error occurred.",
      });
    });
  });
}
