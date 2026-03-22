import { createHash, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";

import { migrate } from "../migrate.js";
import { ConnectSessionRepository } from "./connect-session.js";
import { PrincipalRepository } from "./principal.js";
import { NamespaceRepository } from "./namespace.js";

describe("ConnectSessionRepository", () => {
  let db: DatabaseType;
  let repo: ConnectSessionRepository;
  let principals: PrincipalRepository;
  let namespaces: NamespaceRepository;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db);
    repo = new ConnectSessionRepository(db);
    principals = new PrincipalRepository(db);
    namespaces = new NamespaceRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  function makeCodeVerifier(): { verifier: string; challenge: string } {
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    return { verifier, challenge };
  }

  it("create() sets correct defaults and expiry", () => {
    const { challenge } = makeCodeVerifier();
    const session = repo.create({
      clientKind: "openclaw",
      completionMode: "loopback",
      displayName: "Test Agent",
      codeChallenge: challenge,
      loopbackRedirectUri: "http://localhost:9999/callback",
    });

    expect(session.id).toBeTruthy();
    expect(session.status).toBe("pending");
    expect(session.client_kind).toBe("openclaw");
    expect(session.completion_mode).toBe("loopback");
    expect(session.display_name).toBe("Test Agent");
    expect(session.code_challenge).toBe(challenge);
    expect(session.code_challenge_method).toBe("S256");
    expect(session.expires_at).toBeTruthy();
    expect(new Date(session.expires_at).getTime()).toBeGreaterThan(Date.now());
  });

  it("accepts setup as a neutral connect session kind", () => {
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

  it("getValidById() auto-expires past TTL", () => {
    const { challenge } = makeCodeVerifier();
    const session = repo.create({
      clientKind: "generic",
      completionMode: "poll",
      displayName: "Expiring Agent",
      codeChallenge: challenge,
      ttlMinutes: 0, // Expire immediately
    });

    // Force the expires_at to the past
    db.prepare(`UPDATE connect_sessions SET expires_at = ? WHERE id = ?`).run(
      "2000-01-01T00:00:00Z",
      session.id
    );

    const result = repo.getValidById(session.id);
    expect(result).not.toBeNull();
    expect(result!.status).toBe("expired");
  });

  it("approve() sets fields and rejects non-pending", () => {
    const { challenge } = makeCodeVerifier();
    const user = principals.create({ type: "user", name: "Approver" });
    const ns = namespaces.create({
      slug: "test-ns",
      name: "Test",
      ownerId: user.id,
    });
    const agent = principals.create({
      type: "agent",
      name: "Agent",
      namespaceId: ns.id,
    });

    const session = repo.create({
      clientKind: "openclaw",
      completionMode: "loopback",
      displayName: "Test Agent",
      codeChallenge: challenge,
      loopbackRedirectUri: "http://localhost:9999/callback",
    });

    const approved = repo.approve(session.id, {
      approvedBy: user.id,
      selectedNamespaceId: ns.id,
      approvedScopeJson: JSON.stringify({ permissions: ["artifacts:read"] }),
      provisionedPrincipalId: agent.id,
      oneTimeAuthCodeHash: "abc123",
      oneTimeAuthCodeExpiresAt: new Date(Date.now() + 60000).toISOString(),
    });

    expect(approved).not.toBeNull();
    expect(approved!.status).toBe("approved");
    expect(approved!.approved_by).toBe(user.id);
    expect(approved!.selected_namespace_id).toBe(ns.id);
    expect(approved!.provisioned_principal_id).toBe(agent.id);

    // Cannot approve again
    const doubleApprove = repo.approve(session.id, {
      approvedBy: user.id,
      selectedNamespaceId: ns.id,
      approvedScopeJson: JSON.stringify({ permissions: ["artifacts:read"] }),
      provisionedPrincipalId: agent.id,
    });
    expect(doubleApprove).toBeNull();
  });

  it("redeem() is atomic and rejects non-approved", () => {
    const { challenge } = makeCodeVerifier();
    const session = repo.create({
      clientKind: "generic",
      completionMode: "poll",
      displayName: "Test Agent",
      codeChallenge: challenge,
    });

    // Cannot redeem pending session
    expect(repo.redeem(session.id)).toBeNull();

    // Approve first
    const user = principals.create({ type: "user", name: "User" });
    const ns = namespaces.create({
      slug: "ns",
      name: "NS",
      ownerId: user.id,
    });
    const agent = principals.create({
      type: "agent",
      name: "Agent",
      namespaceId: ns.id,
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
    expect(redeemed!.redeemed_at).toBeTruthy();

    // Double redeem fails
    expect(repo.redeem(session.id)).toBeNull();
  });

  it("cancel() sets cancelled status", () => {
    const { challenge } = makeCodeVerifier();
    const session = repo.create({
      clientKind: "generic",
      completionMode: "poll",
      displayName: "Test Agent",
      codeChallenge: challenge,
    });

    const cancelled = repo.cancel(session.id);
    expect(cancelled).not.toBeNull();
    expect(cancelled!.status).toBe("cancelled");
    expect(cancelled!.cancelled_at).toBeTruthy();
  });

  it("verifyCodeVerifier() validates correct verifier", () => {
    const { verifier, challenge } = makeCodeVerifier();
    const session = repo.create({
      clientKind: "generic",
      completionMode: "poll",
      displayName: "Test Agent",
      codeChallenge: challenge,
    });

    expect(ConnectSessionRepository.verifyCodeVerifier(session, verifier)).toBe(true);
    expect(ConnectSessionRepository.verifyCodeVerifier(session, "wrong_verifier")).toBe(false);
  });

  it("verifyAuthCode() validates correct code", () => {
    const { challenge } = makeCodeVerifier();
    const authCode = randomBytes(32).toString("hex");
    const authCodeHash = ConnectSessionRepository.hashAuthCode(authCode);

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
      clientKind: "openclaw",
      completionMode: "loopback",
      displayName: "Test Agent",
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
    expect(ConnectSessionRepository.verifyAuthCode(approved, authCode)).toBe(true);
    expect(ConnectSessionRepository.verifyAuthCode(approved, "wrong_code")).toBe(false);
  });

  it("cleanupExpired() removes old terminal sessions", () => {
    const { challenge } = makeCodeVerifier();
    const session = repo.create({
      clientKind: "generic",
      completionMode: "poll",
      displayName: "Test Agent",
      codeChallenge: challenge,
    });

    // Force to expired status and old timestamp
    db.prepare(
      `UPDATE connect_sessions SET status = 'expired', updated_at = ? WHERE id = ?`
    ).run("2020-01-01T00:00:00Z", session.id);

    const deleted = repo.cleanupExpired();
    expect(deleted).toBe(1);
    expect(repo.getById(session.id)).toBeNull();
  });

  it("expireActive() marks expired pending and approved sessions", () => {
    const { challenge } = makeCodeVerifier();
    const user = principals.create({ type: "user", name: "User" });
    const ns = namespaces.create({
      slug: "expire-active-ns",
      name: "Expire Active",
      ownerId: user.id,
    });
    const agent = principals.create({
      type: "agent",
      name: "Agent",
      namespaceId: ns.id,
    });

    const pending = repo.create({
      clientKind: "generic",
      completionMode: "poll",
      displayName: "Pending Session",
      codeChallenge: challenge,
    });
    db.prepare(`UPDATE connect_sessions SET expires_at = ? WHERE id = ?`).run(
      "2000-01-01T00:00:00Z",
      pending.id
    );

    const approved = repo.create({
      clientKind: "openclaw",
      completionMode: "loopback",
      displayName: "Approved Session",
      codeChallenge: challenge,
      loopbackRedirectUri: "http://localhost:9999/callback",
    });
    repo.approve(approved.id, {
      approvedBy: user.id,
      selectedNamespaceId: ns.id,
      approvedScopeJson: JSON.stringify({ permissions: ["artifacts:read"] }),
      provisionedPrincipalId: agent.id,
    });
    db.prepare(`UPDATE connect_sessions SET expires_at = ? WHERE id = ?`).run(
      "2000-01-01T00:00:00Z",
      approved.id
    );

    const expiredCount = repo.expireActive();
    expect(expiredCount).toBe(2);
    expect(repo.getById(pending.id)?.status).toBe("expired");
    expect(repo.getById(approved.id)?.status).toBe("expired");
  });

  it("cleanupExpired() removes stale untransitioned pending sessions", () => {
    const { challenge } = makeCodeVerifier();
    const session = repo.create({
      clientKind: "generic",
      completionMode: "poll",
      displayName: "Old Pending",
      codeChallenge: challenge,
    });

    db.prepare(
      `UPDATE connect_sessions
       SET status = 'pending', expires_at = ?, updated_at = ?
       WHERE id = ?`
    ).run("2000-01-01T00:00:00Z", "2000-01-01T00:00:00Z", session.id);

    const deleted = repo.cleanupExpired();
    expect(deleted).toBe(1);
    expect(repo.getById(session.id)).toBeNull();
  });

  it("withTransaction() rolls back on failure", () => {
    const { challenge } = makeCodeVerifier();
    const session = repo.create({
      clientKind: "generic",
      completionMode: "poll",
      displayName: "Rollback Session",
      codeChallenge: challenge,
    });

    expect(() =>
      repo.withTransaction(() => {
        db.prepare(
          `UPDATE connect_sessions
           SET status = 'cancelled', updated_at = ?
           WHERE id = ?`
        ).run(new Date().toISOString(), session.id);
        throw new Error("boom");
      })
    ).toThrow("boom");

    expect(repo.getById(session.id)?.status).toBe("pending");
  });
});
