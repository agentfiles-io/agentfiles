import { createHash, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  Database,
  type DatabaseType,
  migrate,
  PrincipalRepository,
  NamespaceRepository,
  setHmacSecret,
  ConnectSessionRepository,
} from "@attach/db";

import {
  computeApprovedScope,
  normalizeRequestedScope,
  CONNECT_SCOPE_PRESETS,
} from "../../utils/scope.js";

describe("Connect session scope utilities", () => {
  it("computeApprovedScope uses preset when no request", () => {
    const scope = computeApprovedScope("openclaw", undefined, "ns_123");
    expect(scope.permissions).toEqual(CONNECT_SCOPE_PRESETS["openclaw"]);
    expect(scope.namespaces).toEqual(["ns_123"]);
  });

  it("computeApprovedScope intersects requested with preset", () => {
    const scope = computeApprovedScope(
      "openclaw",
      { permissions: ["artifacts:read", "namespaces:write"] },
      "ns_123"
    );
    // namespaces:write is blocked
    expect(scope.permissions).toEqual(["artifacts:read"]);
    expect(scope.namespaces).toEqual(["ns_123"]);
  });

  it("computeApprovedScope blocks dangerous permissions", () => {
    const scope = computeApprovedScope(
      "generic",
      { permissions: ["api_keys:write", "principals:write", "artifacts:read"] },
      "ns_123"
    );
    expect(scope.permissions).toEqual(["artifacts:read"]);
  });

  it("computeApprovedScope falls back to preset when intersection is empty", () => {
    const scope = computeApprovedScope(
      "generic",
      { permissions: ["api_keys:write"] },
      "ns_123"
    );
    expect(scope.permissions).toEqual(CONNECT_SCOPE_PRESETS["generic"]);
  });

  it("generic preset is read-only", () => {
    expect(CONNECT_SCOPE_PRESETS["generic"]).toEqual([
      "artifacts:read",
      "namespaces:read",
    ]);
  });

  it("setup preset keeps write access without representing a concrete runtime", () => {
    expect(CONNECT_SCOPE_PRESETS["setup"]).toEqual([
      "artifacts:read",
      "artifacts:write",
      "namespaces:read",
    ]);
  });
});

describe("normalizeRequestedScope", () => {
  it("trims whitespace from permissions", () => {
    const result = normalizeRequestedScope({
      permissions: [" artifacts:read ", "  namespaces:read"],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.scope?.permissions).toEqual([
        "artifacts:read",
        "namespaces:read",
      ]);
    }
  });

  it("deduplicates permissions", () => {
    const result = normalizeRequestedScope({
      permissions: ["artifacts:read", "artifacts:read", "namespaces:read"],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.scope?.permissions).toEqual([
        "artifacts:read",
        "namespaces:read",
      ]);
    }
  });

  it("rejects non-object scope", () => {
    expect(normalizeRequestedScope("bad").ok).toBe(false);
    expect(normalizeRequestedScope(42).ok).toBe(false);
    expect(normalizeRequestedScope([]).ok).toBe(false);
  });

  it("rejects permissions with invalid entries", () => {
    const result = normalizeRequestedScope({
      permissions: ["artifacts:read", "not_a_real_permission"],
    });
    expect(result.ok).toBe(false);
  });

  it("rejects empty permissions array", () => {
    const result = normalizeRequestedScope({ permissions: [] });
    expect(result.ok).toBe(false);
  });

  it("rejects scope with only namespaces and no permissions", () => {
    const result = normalizeRequestedScope({ namespaces: ["ns_123"] });
    expect(result.ok).toBe(false);
  });
});

describe("normalizeRequestedScope + computeApprovedScope integration", () => {
  it("trimmed permissions match correctly during scope computation", () => {
    // Simulate: client sends whitespace-padded permissions
    const normalizeResult = normalizeRequestedScope({
      permissions: [" artifacts:read ", " artifacts:write "],
    });
    expect(normalizeResult.ok).toBe(true);
    if (!normalizeResult.ok) return;

    // The normalized scope should produce correct intersection
    const approved = computeApprovedScope(
      "openclaw",
      normalizeResult.scope,
      "ns_123"
    );
    expect(approved.permissions).toEqual(["artifacts:read", "artifacts:write"]);
  });

  it("raw untrimmed permissions would fail intersection without normalization", () => {
    // Without normalization, padded strings don't match preset entries
    const approved = computeApprovedScope(
      "openclaw",
      { permissions: [" artifacts:read "] },
      "ns_123"
    );
    // Falls back to full preset because intersection is empty
    expect(approved.permissions).toEqual(CONNECT_SCOPE_PRESETS["openclaw"]);
  });
});

describe("Connect session loopback URI validation", () => {
  function validateLoopbackUri(uri: string): boolean {
    try {
      const parsed = new URL(uri);
      if (parsed.protocol !== "http:") return false;
      const host = parsed.hostname;
      if (
        host !== "localhost" &&
        host !== "127.0.0.1" &&
        host !== "[::1]" &&
        host !== "::1"
      ) {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  it("accepts valid localhost URIs", () => {
    expect(validateLoopbackUri("http://localhost:9999/callback")).toBe(true);
    expect(validateLoopbackUri("http://127.0.0.1:8080/callback")).toBe(true);
  });

  it("rejects non-localhost URIs", () => {
    expect(validateLoopbackUri("http://example.com/callback")).toBe(false);
    expect(validateLoopbackUri("https://localhost:9999/callback")).toBe(false);
  });

  it("rejects invalid URIs", () => {
    expect(validateLoopbackUri("not-a-url")).toBe(false);
  });
});

describe("ConnectSessionRepository PKCE verification", () => {
  let db: DatabaseType;
  let repo: ConnectSessionRepository;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db);
    repo = new ConnectSessionRepository(db);
    setHmacSecret("a".repeat(64));
  });

  afterEach(() => {
    db.close();
  });

  function makeCodeVerifier(): { verifier: string; challenge: string } {
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    return { verifier, challenge };
  }

  it("rejects wrong code_verifier", () => {
    const { challenge } = makeCodeVerifier();
    const session = repo.create({
      clientKind: "openclaw",
      completionMode: "loopback",
      displayName: "Test",
      codeChallenge: challenge,
      loopbackRedirectUri: "http://localhost:9999/callback",
    });

    expect(
      ConnectSessionRepository.verifyCodeVerifier(session, "totally_wrong")
    ).toBe(false);
  });

  it("accepts codex as a valid connect client kind", () => {
    const { challenge } = makeCodeVerifier();

    const session = repo.create({
      clientKind: "codex",
      completionMode: "poll",
      displayName: "Codex Runtime",
      codeChallenge: challenge,
    });

    expect(session.client_kind).toBe("codex");
  });

  it("accepts setup as a valid connect client kind", () => {
    const { challenge } = makeCodeVerifier();

    const session = repo.create({
      clientKind: "setup",
      completionMode: "loopback",
      displayName: "Setup Agent",
      codeChallenge: challenge,
      loopbackRedirectUri: "http://localhost:9999/callback",
    });

    expect(session.client_kind).toBe("setup");
  });

  it("rejects wrong auth code", () => {
    const { challenge } = makeCodeVerifier();
    const principals = new PrincipalRepository(db);
    const namespaces = new NamespaceRepository(db);

    const user = principals.create({ type: "user", name: "User" });
    const ns = namespaces.create({ slug: "ns", name: "NS", ownerId: user.id });
    const agent = principals.create({
      type: "agent",
      name: "Agent",
      namespaceId: ns.id,
    });

    const authCode = randomBytes(32).toString("hex");
    const authCodeHash = ConnectSessionRepository.hashAuthCode(authCode);

    const session = repo.create({
      clientKind: "openclaw",
      completionMode: "loopback",
      displayName: "Test",
      codeChallenge: challenge,
      loopbackRedirectUri: "http://localhost:9999/callback",
    });

    repo.approve(session.id, {
      approvedBy: user.id,
      selectedNamespaceId: ns.id,
      approvedScopeJson: JSON.stringify({ permissions: ["artifacts:read"] }),
      provisionedPrincipalId: agent.id,
      oneTimeAuthCodeHash: authCodeHash,
      oneTimeAuthCodeExpiresAt: new Date(Date.now() + 60000).toISOString(),
    });

    const approved = repo.getById(session.id)!;
    expect(
      ConnectSessionRepository.verifyAuthCode(approved, "wrong_auth_code")
    ).toBe(false);
    expect(ConnectSessionRepository.verifyAuthCode(approved, authCode)).toBe(
      true
    );
  });

  it("double-redeem fails", () => {
    const { challenge } = makeCodeVerifier();
    const principals = new PrincipalRepository(db);
    const namespaces = new NamespaceRepository(db);

    const user = principals.create({ type: "user", name: "User" });
    const ns = namespaces.create({
      slug: "ns2",
      name: "NS2",
      ownerId: user.id,
    });
    const agent = principals.create({
      type: "agent",
      name: "Agent",
      namespaceId: ns.id,
    });

    const session = repo.create({
      clientKind: "generic",
      completionMode: "poll",
      displayName: "Test",
      codeChallenge: challenge,
    });

    repo.approve(session.id, {
      approvedBy: user.id,
      selectedNamespaceId: ns.id,
      approvedScopeJson: JSON.stringify({ permissions: ["artifacts:read"] }),
      provisionedPrincipalId: agent.id,
    });

    const redeemed = repo.redeem(session.id);
    expect(redeemed).not.toBeNull();
    expect(redeemed!.status).toBe("redeemed");

    const doubleRedeem = repo.redeem(session.id);
    expect(doubleRedeem).toBeNull();
  });

  it("expired session returns expired status", () => {
    const { challenge } = makeCodeVerifier();
    const session = repo.create({
      clientKind: "generic",
      completionMode: "poll",
      displayName: "Test",
      codeChallenge: challenge,
    });

    db.prepare(`UPDATE connect_sessions SET expires_at = ? WHERE id = ?`).run(
      "2000-01-01T00:00:00Z",
      session.id
    );

    const result = repo.getValidById(session.id);
    expect(result!.status).toBe("expired");
  });
});
