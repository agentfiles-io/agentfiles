import { afterEach, describe, expect, it, vi } from "vitest";
import { runBrowserConnectFlow } from "./connect-flow.js";

describe("runBrowserConnectFlow", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("creates a session, waits for approval, and redeems credentials", async () => {
    const close = vi.fn();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "cs_123",
            approval_url: "https://example.com/approve",
            expires_at: "2026-03-18T00:00:00.000Z",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            api_base_url: "https://api.example.com",
            api_key: "test-key",
            principal: { id: "prn_123", type: "agent" },
            namespace: { id: "ns_123", slug: "default" },
            scope: { permissions: ["artifacts:read"] },
            suggested_env: {
              ATTACH_API_URL: "https://api.example.com",
              ATTACH_API_KEY: "test-key",
            },
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );

    const result = await runBrowserConnectFlow(
      {
        apiUrl: "https://api.example.com",
        clientKind: "setup",
        displayName: "AgentFiles Setup",
      },
      {
        fetchImpl,
        openBrowserImpl: vi.fn().mockResolvedValue(true),
        startLoopbackServerImpl: async () => ({
          port: 43123,
          waitForCallback: async () => ({
            connectionId: "cs_123",
            code: "one-time-code",
          }),
          close,
        }),
      },
    );

    expect(result.api_key).toBe("test-key");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("times out when approval never completes", async () => {
    vi.useFakeTimers();
    const close = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          id: "cs_123",
          approval_url: "https://example.com/approve",
          expires_at: "2026-03-18T00:00:00.000Z",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    const promise = runBrowserConnectFlow(
      {
        apiUrl: "https://api.example.com",
        clientKind: "setup",
        displayName: "AgentFiles Setup",
      },
      {
        approvalTimeoutMs: 25,
        fetchImpl,
        openBrowserImpl: vi.fn().mockResolvedValue(true),
        startLoopbackServerImpl: async () => ({
          port: 43123,
          waitForCallback: async () => new Promise(() => undefined),
          close,
        }),
      },
    );
    const rejection = expect(promise).rejects.toThrow(
      "Timed out waiting for browser approval.",
    );

    await vi.advanceTimersByTimeAsync(25);

    await rejection;
    expect(close).toHaveBeenCalledTimes(1);
  });
});
