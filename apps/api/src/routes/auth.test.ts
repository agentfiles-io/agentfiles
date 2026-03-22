import { describe, expect, it } from "vitest";

import {
  buildDefaultNamespaceSlug,
  decodeAuthFlowState,
  encodeAuthFlowState,
  sanitizeReturnTo,
} from "./auth.js";

describe("sanitizeReturnTo", () => {
  it("defaults to dashboard for empty values", () => {
    expect(sanitizeReturnTo(undefined)).toBe("/dashboard");
    expect(sanitizeReturnTo("")).toBe("/dashboard");
  });

  it("rejects absolute URLs", () => {
    expect(sanitizeReturnTo("https://evil.example/steal")).toBe("/dashboard");
    expect(sanitizeReturnTo("http://evil.example/steal")).toBe("/dashboard");
  });

  it("rejects protocol-relative URLs", () => {
    expect(sanitizeReturnTo("//evil.example/steal")).toBe("/dashboard");
  });

  it("rejects non-absolute relative paths", () => {
    expect(sanitizeReturnTo("dashboard")).toBe("/dashboard");
  });

  it("allows safe app-local paths", () => {
    expect(sanitizeReturnTo("/dashboard")).toBe("/dashboard");
    expect(sanitizeReturnTo("/settings?tab=profile")).toBe("/settings?tab=profile");
  });
});

describe("buildDefaultNamespaceSlug", () => {
  it("uses normalized email local-part when available", () => {
    const slug = buildDefaultNamespaceSlug(
      "Alice.Example+dev@company.test",
      "01HXYZABCDEFGHIJKLMNOPQRSTUV",
      () => false
    );
    expect(slug).toBe("alice-example-dev");
  });

  it("falls back to principal-based slug when email local-part is unusable", () => {
    const principalId = "01HXYZABCDEFGHIJKLMNOPQRSTUV";
    const slug = buildDefaultNamespaceSlug("!!!@company.test", principalId, () => false);
    expect(slug).toBe(`user-${principalId.slice(-8).toLowerCase()}`);
  });

  it("returns a collision-safe candidate when base slug is already taken", () => {
    const principalId = "01HXYZABCDEFGHIJKLMNOPQRSTUV";
    const taken = new Set(["alice", `alice-${principalId.slice(-6).toLowerCase()}`]);
    const slug = buildDefaultNamespaceSlug("alice@example.test", principalId, (candidate) =>
      taken.has(candidate)
    );

    expect(slug).toBe("alice-2");
  });
});

describe("auth flow state", () => {
  it("round-trips state and return_to", () => {
    const encoded = encodeAuthFlowState({
      state: "state_123",
      return_to: "/connect/abc",
    });

    const decoded = decodeAuthFlowState(encoded);
    expect(decoded).toEqual({
      state: "state_123",
      return_to: "/connect/abc",
    });
  });

  it("sanitizes return_to when decoding", () => {
    const encoded = encodeAuthFlowState({
      state: "state_123",
      return_to: "https://evil.example/steal",
    });

    const decoded = decodeAuthFlowState(encoded);
    expect(decoded).toEqual({
      state: "state_123",
      return_to: "/dashboard",
    });
  });

  it("returns null for malformed cookie payloads", () => {
    expect(decodeAuthFlowState(undefined)).toBeNull();
    expect(decodeAuthFlowState("not-base64")).toBeNull();

    const badShape = Buffer.from(JSON.stringify({ state: 123 }), "utf-8").toString("base64url");
    expect(decodeAuthFlowState(badShape)).toBeNull();
  });
});
