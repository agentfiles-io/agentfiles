import { createHash, timingSafeEqual } from "node:crypto";
import type { Database as DatabaseType } from "better-sqlite3";
import {
  generateId,
  nowISO,
  type ConnectClientKind,
  type ConnectCompletionMode,
} from "@attach/shared";

export interface ConnectSessionRow {
  id: string;
  status: string;
  client_kind: string;
  completion_mode: string;
  display_name: string;
  code_challenge: string;
  code_challenge_method: string;
  requested_scope_json: string | null;
  requested_namespace_id: string | null;
  selected_namespace_id: string | null;
  approved_by: string | null;
  approved_at: string | null;
  approved_scope_json: string | null;
  provisioned_principal_id: string | null;
  one_time_auth_code_hash: string | null;
  one_time_auth_code_expires_at: string | null;
  loopback_redirect_uri: string | null;
  client_ip: string | null;
  user_agent: string | null;
  metadata_json: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string;
  redeemed_at: string | null;
  cancelled_at: string | null;
  failed_at: string | null;
  failure_reason: string | null;
}

export interface CreateConnectSessionInput {
  clientKind: ConnectClientKind;
  completionMode: ConnectCompletionMode;
  displayName: string;
  codeChallenge: string;
  requestedScopeJson?: string;
  requestedNamespaceId?: string;
  loopbackRedirectUri?: string;
  clientIp?: string;
  userAgent?: string;
  metadataJson?: string;
  ttlMinutes?: number;
}

export interface ApproveConnectSessionInput {
  approvedBy: string;
  selectedNamespaceId: string;
  approvedScopeJson: string;
  provisionedPrincipalId: string;
  oneTimeAuthCodeHash?: string;
  oneTimeAuthCodeExpiresAt?: string;
}

const DEFAULT_TTL_MINUTES = 15;

export class ConnectSessionRepository {
  constructor(private db: DatabaseType) {}

  withTransaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  create(input: CreateConnectSessionInput): ConnectSessionRow {
    const id = generateId();
    const now = nowISO();
    const ttl = input.ttlMinutes ?? DEFAULT_TTL_MINUTES;
    const expiresAt = new Date(Date.now() + ttl * 60 * 1000).toISOString();

    this.db
      .prepare(
        `INSERT INTO connect_sessions (
          id, status, client_kind, completion_mode, display_name,
          code_challenge, code_challenge_method,
          requested_scope_json, requested_namespace_id,
          loopback_redirect_uri, client_ip, user_agent, metadata_json,
          created_at, updated_at, expires_at
        ) VALUES (?, 'pending', ?, ?, ?, ?, 'S256', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.clientKind,
        input.completionMode,
        input.displayName,
        input.codeChallenge,
        input.requestedScopeJson ?? null,
        input.requestedNamespaceId ?? null,
        input.loopbackRedirectUri ?? null,
        input.clientIp ?? null,
        input.userAgent ?? null,
        input.metadataJson ?? null,
        now,
        now,
        expiresAt
      );

    return this.getById(id)!;
  }

  getById(id: string): ConnectSessionRow | null {
    return (
      (this.db
        .prepare(`SELECT * FROM connect_sessions WHERE id = ?`)
        .get(id) as ConnectSessionRow | undefined) ?? null
    );
  }

  getValidById(id: string): ConnectSessionRow | null {
    const session = this.getById(id);
    if (!session) return null;

    // Auto-expire if past TTL and still in a non-terminal state
    if (session.status === "pending" || session.status === "approved") {
      if (new Date(session.expires_at) < new Date()) {
        const now = nowISO();
        this.db
          .prepare(
            `UPDATE connect_sessions
             SET status = 'expired', updated_at = ?
             WHERE id = ?
             AND status IN ('pending', 'approved')
             AND expires_at <= ?`
          )
          .run(now, id, now);
        return this.getById(id);
      }
    }

    return session;
  }

  expireActive(): number {
    const now = nowISO();
    const result = this.db
      .prepare(
        `UPDATE connect_sessions
         SET status = 'expired', updated_at = ?
         WHERE status IN ('pending', 'approved')
         AND expires_at <= ?`
      )
      .run(now, now);

    return result.changes;
  }

  approve(id: string, input: ApproveConnectSessionInput): ConnectSessionRow | null {
    const now = nowISO();
    const result = this.db
      .prepare(
        `UPDATE connect_sessions
         SET status = 'approved',
             approved_by = ?,
             approved_at = ?,
             selected_namespace_id = ?,
             approved_scope_json = ?,
             provisioned_principal_id = ?,
             one_time_auth_code_hash = ?,
             one_time_auth_code_expires_at = ?,
             updated_at = ?
         WHERE id = ? AND status = 'pending'`
      )
      .run(
        input.approvedBy,
        now,
        input.selectedNamespaceId,
        input.approvedScopeJson,
        input.provisionedPrincipalId,
        input.oneTimeAuthCodeHash ?? null,
        input.oneTimeAuthCodeExpiresAt ?? null,
        now,
        id
      );

    if (result.changes === 0) return null;
    return this.getById(id);
  }

  redeem(id: string): ConnectSessionRow | null {
    const now = nowISO();
    const result = this.db
      .prepare(
        `UPDATE connect_sessions
         SET status = 'redeemed', redeemed_at = ?, updated_at = ?
         WHERE id = ? AND status = 'approved'`
      )
      .run(now, now, id);

    if (result.changes === 0) return null;
    return this.getById(id);
  }

  cancel(id: string): ConnectSessionRow | null {
    const now = nowISO();
    const result = this.db
      .prepare(
        `UPDATE connect_sessions
         SET status = 'cancelled', cancelled_at = ?, updated_at = ?
         WHERE id = ? AND status IN ('pending', 'approved')`
      )
      .run(now, now, id);

    if (result.changes === 0) return null;
    return this.getById(id);
  }

  cleanupExpired(): number {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const condition = `
      (status IN ('expired', 'cancelled', 'failed', 'redeemed') AND updated_at < ?)
      OR (status IN ('pending', 'approved') AND expires_at < ?)
    `;

    // Nullify FK references in runtime_instances before deleting
    this.db
      .prepare(
        `UPDATE runtime_instances SET connect_session_id = NULL
         WHERE connect_session_id IN (SELECT id FROM connect_sessions WHERE ${condition})`
      )
      .run(cutoff, cutoff);

    const result = this.db
      .prepare(`DELETE FROM connect_sessions WHERE ${condition}`)
      .run(cutoff, cutoff);

    return result.changes;
  }

  static verifyCodeVerifier(
    session: ConnectSessionRow,
    codeVerifier: string
  ): boolean {
    const expectedChallenge = createHash("sha256")
      .update(codeVerifier)
      .digest("base64url");

    const expectedBuffer = Buffer.from(expectedChallenge, "utf-8");
    const actualBuffer = Buffer.from(session.code_challenge, "utf-8");

    if (expectedBuffer.length !== actualBuffer.length) {
      return false;
    }

    return timingSafeEqual(expectedBuffer, actualBuffer);
  }

  static hashAuthCode(code: string): string {
    return createHash("sha256").update(code).digest("hex");
  }

  static verifyAuthCode(
    session: ConnectSessionRow,
    code: string
  ): boolean {
    if (!session.one_time_auth_code_hash) return false;

    // Check expiry
    if (
      session.one_time_auth_code_expires_at &&
      new Date(session.one_time_auth_code_expires_at) < new Date()
    ) {
      return false;
    }

    const codeHash = ConnectSessionRepository.hashAuthCode(code);
    const expectedBuffer = Buffer.from(
      session.one_time_auth_code_hash,
      "hex"
    );
    const actualBuffer = Buffer.from(codeHash, "hex");

    if (expectedBuffer.length !== actualBuffer.length) {
      return false;
    }

    return timingSafeEqual(expectedBuffer, actualBuffer);
  }
}
