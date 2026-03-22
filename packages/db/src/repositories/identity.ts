import type { Database as DatabaseType } from "better-sqlite3";
import { generateId, nowISO, type IdentityProvider } from "@attach/shared";

export interface IdentityRow {
  id: string;
  principal_id: string;
  provider: IdentityProvider;
  external_subject: string;
  email: string | null;
  metadata: string | null;
  created_at: string;
  last_login_at: string | null;
}

export interface CreateIdentityInput {
  principalId: string;
  provider: IdentityProvider;
  externalSubject: string;
  email?: string;
  metadata?: Record<string, unknown>;
}

export class IdentityRepository {
  constructor(private db: DatabaseType) {}

  create(input: CreateIdentityInput): IdentityRow {
    const id = generateId();
    const now = nowISO();

    this.db
      .prepare(
        `INSERT INTO identities (id, principal_id, provider, external_subject, email, metadata, created_at, last_login_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.principalId,
        input.provider,
        input.externalSubject,
        input.email ?? null,
        input.metadata ? JSON.stringify(input.metadata) : null,
        now,
        now
      );

    return this.getById(id)!;
  }

  getById(id: string): IdentityRow | null {
    return (
      (this.db
        .prepare(`SELECT * FROM identities WHERE id = ?`)
        .get(id) as IdentityRow | undefined) ?? null
    );
  }

  getByProviderSubject(
    provider: IdentityProvider,
    externalSubject: string
  ): IdentityRow | null {
    return (
      (this.db
        .prepare(
          `SELECT * FROM identities WHERE provider = ? AND external_subject = ?`
        )
        .get(provider, externalSubject) as IdentityRow | undefined) ?? null
    );
  }

  getByPrincipal(principalId: string): IdentityRow[] {
    return this.db
      .prepare(`SELECT * FROM identities WHERE principal_id = ?`)
      .all(principalId) as IdentityRow[];
  }

  getByEmail(email: string): IdentityRow[] {
    return this.db
      .prepare(`SELECT * FROM identities WHERE email = ? ORDER BY created_at ASC`)
      .all(email) as IdentityRow[];
  }

  updateLastLogin(id: string): void {
    this.db
      .prepare(`UPDATE identities SET last_login_at = ? WHERE id = ?`)
      .run(nowISO(), id);
  }

  updateMetadata(id: string, metadata: Record<string, unknown>): void {
    this.db
      .prepare(`UPDATE identities SET metadata = ? WHERE id = ?`)
      .run(JSON.stringify(metadata), id);
  }
}
