import { describe, expect, it } from "vitest";

import {
  hasNamespaceAccess,
  hasPermission,
  shareTokenCanReadArtifact,
  type AuthContext,
  type ShareTokenContext,
} from "./auth.js";

function makeAuthContext(overrides?: Partial<AuthContext>): AuthContext {
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
    credential: {
      ...base.credential,
      ...(overrides?.credential ?? {}),
    },
    principal: {
      ...base.principal,
      ...(overrides?.principal ?? {}),
    },
  };
}

function makeShareTokenContext(overrides?: {
  permissions?: string[];
  grant?: Partial<ShareTokenContext["grant"]>;
}): ShareTokenContext {
  const base: ShareTokenContext = {
    grant: {
      id: "grant_test",
      namespace_id: "ns_test",
      artifact_id: "art_test",
      grantee_type: "token",
      grantee_id: null,
      token_prefix: "arun_share_",
      token_hash: "abc123",
      permissions: JSON.stringify(["read"]),
      expires_at: null,
      created_at: "2026-03-12T00:00:00Z",
      created_by: "prin_test",
      revoked_at: null,
    },
    permissions: ["read"],
  };

  return {
    ...base,
    ...overrides,
    grant: {
      ...base.grant,
      ...(overrides?.grant ?? {}),
    },
  };
}

describe("hasPermission", () => {
  it("grants all permissions to session credentials", () => {
    const auth = makeAuthContext({
      credential: { type: "session", id: "sess_test", scope: null },
    });

    expect(hasPermission(auth, "artifacts:write")).toBe(true);
  });

  it("grants minimal read permissions to API keys without scope", () => {
    const auth = makeAuthContext({
      credential: { type: "api_key", id: "key_test", scope: null },
    });

    expect(hasPermission(auth, "artifacts:read")).toBe(true);
    expect(hasPermission(auth, "namespaces:read")).toBe(true);
    expect(hasPermission(auth, "grants:write")).toBe(false);
  });

  it("enforces scoped API key permissions", () => {
    const auth = makeAuthContext({
      credential: {
        type: "api_key",
        id: "key_test",
        scope: { permissions: ["artifacts:read"] },
      },
    });

    expect(hasPermission(auth, "artifacts:read")).toBe(true);
    expect(hasPermission(auth, "artifacts:write")).toBe(false);
  });

  it("does not apply unscoped defaults when a scoped key omits permissions", () => {
    const auth = makeAuthContext({
      credential: {
        type: "api_key",
        id: "key_test",
        scope: { namespaces: ["ns_any"] },
      },
    });

    expect(hasPermission(auth, "artifacts:read")).toBe(false);
  });
});

describe("hasNamespaceAccess", () => {
  it("grants all namespace access to session credentials", () => {
    const auth = makeAuthContext({
      credential: { type: "session", id: "sess_test", scope: null },
    });

    expect(hasNamespaceAccess(auth, "ns_any")).toBe(true);
  });

  it("allows namespace access for owner user API keys without namespace scope", () => {
    const auth = makeAuthContext({
      credential: {
        type: "api_key",
        id: "key_test",
        scope: { permissions: ["artifacts:read"] },
      },
    });

    expect(hasNamespaceAccess(auth, "ns_any")).toBe(true);
  });

  it("limits namespace access to bound namespace for namespace-bound principals", () => {
    const auth = makeAuthContext({
      principal: {
        id: "prin_test",
        type: "user",
        name: "Test User",
        namespace_id: "ns_bound",
        metadata: null,
        created_at: "2026-03-12T00:00:00Z",
        updated_at: "2026-03-12T00:00:00Z",
      },
      credential: {
        type: "api_key",
        id: "key_test",
        scope: { permissions: ["artifacts:read"] },
      },
    });

    expect(hasNamespaceAccess(auth, "ns_bound")).toBe(true);
    expect(hasNamespaceAccess(auth, "ns_other")).toBe(false);
  });

  it("enforces scoped API key namespace access", () => {
    const auth = makeAuthContext({
      credential: {
        type: "api_key",
        id: "key_test",
        scope: {
          permissions: ["artifacts:read"],
          namespaces: ["ns_allowed"],
        },
      },
    });

    expect(hasNamespaceAccess(auth, "ns_allowed")).toBe(true);
    expect(hasNamespaceAccess(auth, "ns_denied")).toBe(false);
  });
});

describe("shareTokenCanReadArtifact", () => {
  it("returns false when no share token is provided", () => {
    expect(shareTokenCanReadArtifact(null, "art_test", "ns_test")).toBe(false);
  });

  it("returns false without read permission", () => {
    const shareToken = makeShareTokenContext({ permissions: ["write"] });
    expect(shareTokenCanReadArtifact(shareToken, "art_test", "ns_test")).toBe(false);
  });

  it("returns false for namespace mismatch", () => {
    const shareToken = makeShareTokenContext({
      grant: { namespace_id: "ns_other" },
    });
    expect(shareTokenCanReadArtifact(shareToken, "art_test", "ns_test")).toBe(false);
  });

  it("returns false for artifact mismatch on artifact-scoped grants", () => {
    const shareToken = makeShareTokenContext({
      grant: { artifact_id: "art_other" },
    });
    expect(shareTokenCanReadArtifact(shareToken, "art_test", "ns_test")).toBe(false);
  });

  it("returns true when scope matches namespace and artifact", () => {
    const shareToken = makeShareTokenContext();
    expect(shareTokenCanReadArtifact(shareToken, "art_test", "ns_test")).toBe(true);
  });
});
