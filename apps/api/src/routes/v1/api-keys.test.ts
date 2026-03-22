import { describe, expect, it } from "vitest";

import type { AuthContext } from "../../middleware/auth.js";
import { isRequestedScopeAllowed, normalizeRequestedScope } from "../../utils/scope.js";

function makeAuth(overrides?: Partial<AuthContext>): AuthContext {
  const base: AuthContext = {
    principal: {
      id: "prin_test",
      type: "user",
      name: "Test User",
      namespace_id: null,
      metadata: null,
      created_at: "2026-03-12T00:00:00Z",
      updated_at: "2026-03-12T00:00:00Z",
    },
    credential: {
      type: "api_key",
      id: "key_test",
      scope: null,
    },
  };

  return {
    ...base,
    ...overrides,
    principal: {
      ...base.principal,
      ...(overrides?.principal ?? {}),
    },
    credential: {
      ...base.credential,
      ...(overrides?.credential ?? {}),
    },
  };
}

describe("isRequestedScopeAllowed", () => {
  it("allows all scopes for session auth", () => {
    const auth = makeAuth({
      credential: {
        type: "session",
        id: "sess_test",
        scope: null,
      },
    });

    expect(
      isRequestedScopeAllowed(auth, {
        permissions: ["api_keys:write", "artifacts:write"],
      })
    ).toBe(true);
  });

  it("allows all scopes for unscoped API keys", () => {
    const auth = makeAuth({
      credential: {
        type: "api_key",
        id: "key_test",
        scope: null,
      },
    });

    expect(isRequestedScopeAllowed(auth, undefined)).toBe(true);
  });

  it("rejects creating unscoped keys from scoped API keys", () => {
    const auth = makeAuth({
      credential: {
        type: "api_key",
        id: "key_test",
        scope: { permissions: ["api_keys:write", "artifacts:read"] },
      },
    });

    expect(isRequestedScopeAllowed(auth, undefined)).toBe(false);
  });

  it("rejects permissions outside caller scope", () => {
    const auth = makeAuth({
      credential: {
        type: "api_key",
        id: "key_test",
        scope: { permissions: ["api_keys:write", "artifacts:read"] },
      },
    });

    expect(
      isRequestedScopeAllowed(auth, {
        permissions: ["api_keys:write", "artifacts:write"],
      })
    ).toBe(false);
  });

  it("rejects namespaces outside caller scope", () => {
    const auth = makeAuth({
      credential: {
        type: "api_key",
        id: "key_test",
        scope: {
          permissions: ["api_keys:write"],
          namespaces: ["ns_allowed"],
        },
      },
    });

    expect(
      isRequestedScopeAllowed(auth, {
        permissions: ["api_keys:write"],
        namespaces: ["ns_allowed", "ns_other"],
      })
    ).toBe(false);
  });

  it("allows equal or narrower scoped keys", () => {
    const auth = makeAuth({
      credential: {
        type: "api_key",
        id: "key_test",
        scope: {
          permissions: ["api_keys:write", "artifacts:read"],
          namespaces: ["ns_allowed", "ns_another"],
        },
      },
    });

    expect(
      isRequestedScopeAllowed(auth, {
        permissions: ["api_keys:write"],
        namespaces: ["ns_allowed"],
      })
    ).toBe(true);
  });
});

describe("normalizeRequestedScope", () => {
  it("accepts undefined scope", () => {
    expect(normalizeRequestedScope(undefined)).toEqual({
      ok: true,
      scope: undefined,
    });
  });

  it("rejects non-object scope values", () => {
    const normalized = normalizeRequestedScope("artifacts:read");
    expect(normalized.ok).toBe(false);
    if (normalized.ok) {
      throw new Error("Expected normalization to fail");
    }
    expect(normalized.message).toContain("scope must be an object");
  });

  it("rejects scoped input without permissions", () => {
    const normalized = normalizeRequestedScope({
      namespaces: ["ns_1"],
    });
    expect(normalized.ok).toBe(false);
    if (normalized.ok) {
      throw new Error("Expected normalization to fail");
    }
    expect(normalized.message).toContain("scope.permissions is required");
  });

  it("rejects invalid permission identifiers", () => {
    const normalized = normalizeRequestedScope({
      permissions: ["artifacts:read", "admin:all"],
    });
    expect(normalized.ok).toBe(false);
    if (normalized.ok) {
      throw new Error("Expected normalization to fail");
    }
    expect(normalized.message).toContain("Invalid scope permission");
  });

  it("normalizes and deduplicates valid scope arrays", () => {
    const normalized = normalizeRequestedScope({
      permissions: ["artifacts:read", "artifacts:read", "namespaces:read"],
      namespaces: ["ns_1", "ns_1", "ns_2"],
    });

    expect(normalized.ok).toBe(true);
    if (!normalized.ok) {
      throw new Error("Expected normalization to pass");
    }
    expect(normalized.scope).toEqual({
      permissions: ["artifacts:read", "namespaces:read"],
      namespaces: ["ns_1", "ns_2"],
    });
  });
});
