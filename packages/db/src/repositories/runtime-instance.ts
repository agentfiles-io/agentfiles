import type { Database as DatabaseType } from "better-sqlite3";
import { generateId, nowISO, type RuntimeKind } from "@attach/shared";

export interface RuntimeInstanceRow {
  id: string;
  principal_id: string;
  owner_principal_id: string;
  namespace_id: string;
  display_name: string;
  runtime_kind: string;
  status: string;
  connect_session_id: string | null;
  connected_at: string;
  last_seen_at: string;
  last_activity_at: string | null;
  visibility: string;
  metadata_json: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreateRuntimeInstanceInput {
  principalId: string;
  ownerPrincipalId: string;
  namespaceId: string;
  displayName: string;
  runtimeKind: RuntimeKind;
  connectSessionId?: string;
  metadata?: Record<string, unknown>;
}

export class RuntimeInstanceRepository {
  constructor(private db: DatabaseType) {}

  /**
   * Create a runtime instance. Idempotent around principal_id:
   * if an instance already exists for this principal, return the existing one.
   */
  create(input: CreateRuntimeInstanceInput): RuntimeInstanceRow {
    // Dedup: one instance per agent principal
    const existing = this.getByPrincipalId(input.principalId);
    if (existing) {
      return existing;
    }

    const id = generateId();
    const now = nowISO();

    this.db
      .prepare(
        `INSERT INTO runtime_instances (
          id, principal_id, owner_principal_id, namespace_id,
          display_name, runtime_kind, status, connect_session_id,
          connected_at, last_seen_at, visibility, metadata_json,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, 'private', ?, ?, ?)`
      )
      .run(
        id,
        input.principalId,
        input.ownerPrincipalId,
        input.namespaceId,
        input.displayName,
        input.runtimeKind,
        input.connectSessionId ?? null,
        now,
        now,
        input.metadata ? JSON.stringify(input.metadata) : null,
        now,
        now
      );

    return this.getById(id)!;
  }

  getById(id: string): RuntimeInstanceRow | null {
    return (
      (this.db
        .prepare(`SELECT * FROM runtime_instances WHERE id = ?`)
        .get(id) as RuntimeInstanceRow | undefined) ?? null
    );
  }

  getByPrincipalId(principalId: string): RuntimeInstanceRow | null {
    return (
      (this.db
        .prepare(`SELECT * FROM runtime_instances WHERE principal_id = ?`)
        .get(principalId) as RuntimeInstanceRow | undefined) ?? null
    );
  }

  getByConnectSessionId(connectSessionId: string): RuntimeInstanceRow | null {
    return (
      (this.db
        .prepare(`SELECT * FROM runtime_instances WHERE connect_session_id = ?`)
        .get(connectSessionId) as RuntimeInstanceRow | undefined) ?? null
    );
  }

  listByOwner(ownerPrincipalId: string): RuntimeInstanceRow[] {
    return this.db
      .prepare(
        `SELECT * FROM runtime_instances WHERE owner_principal_id = ? ORDER BY connected_at DESC`
      )
      .all(ownerPrincipalId) as RuntimeInstanceRow[];
  }

  listByNamespace(namespaceId: string): RuntimeInstanceRow[] {
    return this.db
      .prepare(
        `SELECT * FROM runtime_instances WHERE namespace_id = ? ORDER BY connected_at DESC`
      )
      .all(namespaceId) as RuntimeInstanceRow[];
  }

  updateLastSeen(id: string): void {
    const now = nowISO();
    this.db
      .prepare(
        `UPDATE runtime_instances SET last_seen_at = ?, updated_at = ? WHERE id = ?`
      )
      .run(now, now, id);
  }

  updateLastActivity(id: string): void {
    const now = nowISO();
    this.db
      .prepare(
        `UPDATE runtime_instances SET last_activity_at = ?, last_seen_at = ?, updated_at = ? WHERE id = ?`
      )
      .run(now, now, now, id);
  }

  updateStatus(id: string, status: "active" | "inactive" | "revoked"): RuntimeInstanceRow | null {
    const now = nowISO();
    const result = this.db
      .prepare(
        `UPDATE runtime_instances SET status = ?, updated_at = ? WHERE id = ?`
      )
      .run(status, now, id);
    if (result.changes === 0) return null;
    return this.getById(id);
  }

  countByOwner(ownerPrincipalId: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) as count FROM runtime_instances WHERE owner_principal_id = ?`
      )
      .get(ownerPrincipalId) as { count: number };
    return row.count;
  }

  countAll(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) as count FROM runtime_instances`)
      .get() as { count: number };
    return row.count;
  }
}
