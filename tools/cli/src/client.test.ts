import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AttachClient } from "./client.js";

describe("AttachClient", () => {
  const client = new AttachClient({
    apiUrl: "http://localhost:3000",
    apiKey: "arun_usr_test",
  });

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("surfaces structured API errors from JSON responses", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "forbidden", message: "No access" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      })
    );

    await expect(client.getMe()).rejects.toThrow("API Error: No access (forbidden)");
  });

  it("falls back to status text on non-JSON error responses", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response("oops", {
        status: 500,
        statusText: "Internal Server Error",
      })
    );

    await expect(client.getMe()).rejects.toThrow(
      "API Error: Internal Server Error (unknown)"
    );
  });

  it("returns plain-text content for content endpoints", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response("# hello", {
        status: 200,
        headers: { "Content-Type": "text/markdown" },
      })
    );

    await expect(client.getArtifactContent("art_123")).resolves.toBe("# hello");
  });
});
