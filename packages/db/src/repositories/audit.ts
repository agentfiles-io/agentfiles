import type { Database as DatabaseType } from "better-sqlite3";
import { generateId, nowISO, type PrincipalType } from "@attach/shared";

export interface AuditEventRow {
  id: string;
  timestamp: string;
  principal_id: string;
  principal_type: string;
  credential_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string;
  namespace_id: string | null;
  details: string | null;
  client_ip: string | null;
  user_agent: string | null;
  success: number;
  error_message: string | null;
}

export type AuditAction =
  | "artifact.create"
  | "artifact.update"
  | "artifact.archive"
  | "artifact.unarchive"
  | "artifact.read"
  | "namespace.create"
  | "namespace.update"
  | "grant.create"
  | "grant.revoke"
  | "principal.create"
  | "principal.update"
  | "api_key.create"
  | "api_key.revoke"
  | "auth.login"
  | "auth.logout"
  | "auth.failure"
  | "auth.account_linked"
  | "git.import"
  | "git.sync"
  | "webhook.trigger"
  | "connect_session.create"
  | "connect_session.view"
  | "connect_session.approve"
  | "connect_session.deny"
  | "connect_session.redeem"
  | "connect_session.cancel"
  | "connect_session.expire"
  | "runtime_instance.create"
  | "runtime_instance.update_status";

export interface CreateAuditEventInput {
  principalId: string;
  principalType: PrincipalType | "system";
  credentialId?: string;
  action: AuditAction;
  resourceType: string;
  resourceId: string;
  namespaceId?: string;
  details?: Record<string, unknown>;
  clientIp?: string;
  userAgent?: string;
  success?: boolean;
  errorMessage?: string;
}

export interface ListAuditEventsOptions {
  principalId?: string;
  resourceType?: string;
  resourceId?: string;
  namespaceId?: string;
  action?: AuditAction;
  since?: string;
  until?: string;
  limit?: number;
  offset?: number;
}

export class AuditRepository {
  constructor(private db: DatabaseType) {}

  create(input: CreateAuditEventInput): AuditEventRow {
    const id = generateId();
    const now = nowISO();

    this.db
      .prepare(
        `INSERT INTO audit_events (id, timestamp, principal_id, principal_type, credential_id, action, resource_type, resource_id, namespace_id, details, client_ip, user_agent, success, error_message)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        now,
        input.principalId,
        input.principalType,
        input.credentialId ?? null,
        input.action,
        input.resourceType,
        input.resourceId,
        input.namespaceId ?? null,
        input.details ? JSON.stringify(input.details) : null,
        input.clientIp ?? null,
        input.userAgent ?? null,
        input.success === false ? 0 : 1,
        input.errorMessage ?? null
      );

    return this.getById(id)!;
  }

  getById(id: string): AuditEventRow | null {
    return (
      (this.db
        .prepare(`SELECT * FROM audit_events WHERE id = ?`)
        .get(id) as AuditEventRow | undefined) ?? null
    );
  }

  list(options: ListAuditEventsOptions): AuditEventRow[] {
    let sql = `SELECT * FROM audit_events WHERE 1=1`;
    const params: (string | number)[] = [];

    if (options.principalId) {
      sql += ` AND principal_id = ?`;
      params.push(options.principalId);
    }

    if (options.resourceType) {
      sql += ` AND resource_type = ?`;
      params.push(options.resourceType);
    }

    if (options.resourceId) {
      sql += ` AND resource_id = ?`;
      params.push(options.resourceId);
    }

    if (options.namespaceId) {
      sql += ` AND namespace_id = ?`;
      params.push(options.namespaceId);
    }

    if (options.action) {
      sql += ` AND action = ?`;
      params.push(options.action);
    }

    if (options.since) {
      sql += ` AND timestamp >= ?`;
      params.push(options.since);
    }

    if (options.until) {
      sql += ` AND timestamp <= ?`;
      params.push(options.until);
    }

    sql += ` ORDER BY timestamp DESC`;

    if (options.limit) {
      sql += ` LIMIT ?`;
      params.push(options.limit);
    }

    if (options.offset) {
      sql += ` OFFSET ?`;
      params.push(options.offset);
    }

    return this.db.prepare(sql).all(...params) as AuditEventRow[];
  }

  parseDetails(row: AuditEventRow): Record<string, unknown> | null {
    if (!row.details) return null;
    try {
      return JSON.parse(row.details) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
}
