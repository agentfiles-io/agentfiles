import { randomBytes } from "node:crypto";
import type { Database as DatabaseType } from "better-sqlite3";
import { nowISO } from "@attach/shared";

export interface SessionRow {
  id: string;
  principal_id: string;
  identity_id: string;
  user_agent: string | null;
  ip_address: string | null;
  created_at: string;
  expires_at: string;
  last_active_at: string;
}

export interface CreateSessionInput {
  principalId: string;
  identityId: string;
  userAgent?: string;
  ipAddress?: string;
  expiresInMs?: number; // Default: 7 days
}

const DEFAULT_SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function generateSessionId(): string {
  return randomBytes(32).toString("hex");
}

export class SessionRepository {
  constructor(private db: DatabaseType) {}

  create(input: CreateSessionInput): SessionRow {
    const id = generateSessionId();
    const now = nowISO();
    const expiresAt = new Date(
      Date.now() + (input.expiresInMs ?? DEFAULT_SESSION_DURATION_MS)
    ).toISOString();

    this.db
      .prepare(
        `INSERT INTO browser_sessions (id, principal_id, identity_id, user_agent, ip_address, created_at, expires_at, last_active_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.principalId,
        input.identityId,
        input.userAgent ?? null,
        input.ipAddress ?? null,
        now,
        expiresAt,
        now
      );

    return this.getById(id)!;
  }

  getById(id: string): SessionRow | null {
    return (
      (this.db
        .prepare(`SELECT * FROM browser_sessions WHERE id = ?`)
        .get(id) as SessionRow | undefined) ?? null
    );
  }

  /**
   * Validate a session and return it if valid (not expired).
   */
  validate(id: string): SessionRow | null {
    const now = nowISO();
    const session = this.db
      .prepare(
        `SELECT * FROM browser_sessions WHERE id = ? AND expires_at > ?`
      )
      .get(id, now) as SessionRow | undefined;

    if (session) {
      // Update last_active_at
      this.updateLastActive(id);
      return session;
    }

    return null;
  }

  getByPrincipal(principalId: string): SessionRow[] {
    return this.db
      .prepare(
        `SELECT * FROM browser_sessions WHERE principal_id = ? ORDER BY created_at DESC`
      )
      .all(principalId) as SessionRow[];
  }

  updateLastActive(id: string): void {
    this.db
      .prepare(`UPDATE browser_sessions SET last_active_at = ? WHERE id = ?`)
      .run(nowISO(), id);
  }

  delete(id: string): void {
    this.db.prepare(`DELETE FROM browser_sessions WHERE id = ?`).run(id);
  }

  deleteByPrincipal(principalId: string): void {
    this.db
      .prepare(`DELETE FROM browser_sessions WHERE principal_id = ?`)
      .run(principalId);
  }

  /**
   * Clean up expired sessions.
   */
  cleanupExpired(): number {
    const result = this.db
      .prepare(`DELETE FROM browser_sessions WHERE expires_at < ?`)
      .run(nowISO());
    return result.changes;
  }
}
