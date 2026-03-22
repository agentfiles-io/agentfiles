import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it, vi } from "vitest";
import {
  createMcpHttpRequestHandler,
  parseHttpServerOptions,
} from "./http-server.js";

function createMockResponse(): {
  response: ServerResponse;
  state: {
    body: string;
    headers: Record<string, string>;
    headersSent: boolean;
    statusCode: number;
  };
} {
  const state = {
    body: "",
    headers: {} as Record<string, string>,
    headersSent: false,
    statusCode: 200,
  };

  const response = {
    get headersSent() {
      return state.headersSent;
    },
    writeHead(statusCode: number, headers?: Record<string, string>) {
      state.statusCode = statusCode;
      state.headers = headers ?? {};
      state.headersSent = true;
      return this;
    },
    end(chunk?: string) {
      if (chunk) {
        state.body += chunk;
      }
      state.headersSent = true;
      return this;
    },
  } as unknown as ServerResponse;

  return {
    response,
    state,
  };
}

describe("createMcpHttpRequestHandler", () => {
  it("requires bearer auth for the MCP endpoint", async () => {
    const transport = {
      handleRequest: vi.fn(async () => undefined),
    };
    const handler = createMcpHttpRequestHandler(transport, { authToken: "secret" });
    const { response, state } = createMockResponse();

    await handler(
      {
        headers: {},
        url: "/mcp",
      } as IncomingMessage,
      response,
    );

    expect(state.statusCode).toBe(401);
    expect(JSON.parse(state.body)).toEqual({
      error: "unauthorized",
      message: "Provide Authorization: Bearer <ATTACH_API_KEY>.",
    });
    expect(transport.handleRequest).not.toHaveBeenCalled();
  });

  it("passes authorized requests through to the transport", async () => {
    const transport = {
      handleRequest: vi.fn(async (_req, res) => {
        res.writeHead(204);
        res.end();
      }),
    };
    const handler = createMcpHttpRequestHandler(transport, { authToken: "secret" });
    const { response, state } = createMockResponse();

    const request = {
      headers: {
        authorization: "Bearer secret",
      },
      url: "/mcp",
    } as IncomingMessage;

    await handler(request, response);

    expect(transport.handleRequest).toHaveBeenCalledWith(request, response);
    expect(state.statusCode).toBe(204);
  });

  it("rejects malformed request URLs before reaching the transport", async () => {
    const transport = {
      handleRequest: vi.fn(async () => undefined),
    };
    const handler = createMcpHttpRequestHandler(transport, { authToken: "secret" });
    const { response, state } = createMockResponse();

    await handler(
      {
        headers: {
          host: "[",
        },
        url: "/mcp",
      } as IncomingMessage,
      response,
    );

    expect(state.statusCode).toBe(400);
    expect(JSON.parse(state.body)).toEqual({
      error: "bad_request",
      message: "Invalid request URL.",
    });
    expect(transport.handleRequest).not.toHaveBeenCalled();
  });

  it("serves a health endpoint without auth", async () => {
    const transport = {
      handleRequest: vi.fn(async () => undefined),
    };
    const handler = createMcpHttpRequestHandler(transport, { authToken: "secret" });
    const { response, state } = createMockResponse();

    await handler(
      {
        headers: {},
        url: "/health",
      } as IncomingMessage,
      response,
    );

    expect(state.statusCode).toBe(200);
    expect(JSON.parse(state.body)).toEqual({
      path: "/mcp",
      status: "ok",
      transport: "streamable_http",
    });
  });
});

describe("parseHttpServerOptions", () => {
  it("parses host, port, and path overrides", () => {
    expect(
      parseHttpServerOptions(
        ["--host", "0.0.0.0", "--port", "9999", "--path", "/agentfiles"],
        {},
      ),
    ).toEqual({
      host: "0.0.0.0",
      mcpPath: "/agentfiles",
      port: 9999,
    });
  });
});
