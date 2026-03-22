import { describe, expect, it } from "vitest";
import { buildArtifactShareUrl, resolveShareBaseUrl } from "./share-url.js";

describe("resolveShareBaseUrl", () => {
  it("prefers PUBLIC_APP_URL when configured", () => {
    expect(
      resolveShareBaseUrl("https://api.example.com", {
        PUBLIC_APP_URL: "https://app.example.com",
      }),
    ).toBe("https://app.example.com");
  });

  it("falls back to PUBLIC_BASE_URL when app URL is not configured", () => {
    expect(
      resolveShareBaseUrl("https://api.example.com", {
        PUBLIC_BASE_URL: "https://public.example.com",
      }),
    ).toBe("https://public.example.com");
  });

  it("falls back to the API origin instead of rewriting localhost ports", () => {
    expect(resolveShareBaseUrl("https://api.example.com/v1")).toBe("https://api.example.com");
  });

  it("rejects PUBLIC_APP_URL values that include a path", () => {
    expect(() =>
      resolveShareBaseUrl("https://api.example.com", {
        PUBLIC_APP_URL: "https://app.example.com/path",
      }),
    ).toThrow("PUBLIC_APP_URL must not include a path, query, or hash.");
  });
});

describe("buildArtifactShareUrl", () => {
  it("builds preview links from the resolved public base URL", () => {
    expect(
      buildArtifactShareUrl("https://api.example.com", "art_123", {
        PUBLIC_APP_URL: "https://app.example.com",
      }),
    ).toBe("https://app.example.com/a/art_123");
  });
});
