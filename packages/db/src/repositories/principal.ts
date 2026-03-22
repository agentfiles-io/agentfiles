import type { Database as DatabaseType } from "better-sqlite3";
import { generateId, nowISO, type PrincipalType } from "@attach/shared";

export interface PrincipalRow {
  id: string;
  type: PrincipalType;
  name: string;
  namespace_id: string | null;
  metadata: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreatePrincipalInput {
  type: PrincipalType;
  name: string;
  namespaceId?: string;
  metadata?: Record<string, unknown>;
}

export interface UpdatePrincipalInput {
  name?: string;
  metadata?: Record<string, unknown>;
}

export class PrincipalRepository {
  constructor(private db: DatabaseType) {}

  create(input: CreatePrincipalInput): PrincipalRow {
    const id = generateId();
    const now = nowISO();

    this.db
      .prepare(
        `INSERT INTO principals (id, type, name, namespace_id, metadata, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.type,
        input.name,
        input.namespaceId ?? null,
        input.metadata ? JSON.stringify(input.metadata) : null,
        now,
        now
      );

    return this.getById(id)!;
  }

  getById(id: string): PrincipalRow | null {
    return (
      (this.db
        .prepare(`SELECT * FROM principals WHERE id = ?`)
        .get(id) as PrincipalRow | undefined) ?? null
    );
  }

  getByNamespace(namespaceId: string): PrincipalRow[] {
    return this.db
      .prepare(`SELECT * FROM principals WHERE namespace_id = ?`)
      .all(namespaceId) as PrincipalRow[];
  }

  update(id: string, input: UpdatePrincipalInput): PrincipalRow | null {
    const existing = this.getById(id);
    if (!existing) return null;

    const now = nowISO();

    this.db
      .prepare(
        `UPDATE principals SET name = ?, metadata = ?, updated_at = ? WHERE id = ?`
      )
      .run(
        input.name ?? existing.name,
        input.metadata ? JSON.stringify(input.metadata) : existing.metadata,
        now,
        id
      );

    return this.getById(id);
  }

  listByType(type: PrincipalType): PrincipalRow[] {
    return this.db
      .prepare(`SELECT * FROM principals WHERE type = ? ORDER BY created_at DESC`)
      .all(type) as PrincipalRow[];
  }

  delete(id: string): boolean {
    const result = this.db
      .prepare(`DELETE FROM principals WHERE id = ?`)
      .run(id);
    return result.changes > 0;
  }

  countByType(type: PrincipalType): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) as count FROM principals WHERE type = ?`)
      .get(type) as { count: number };
    return row.count;
  }

  countAll(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) as count FROM principals`)
      .get() as { count: number };
    return row.count;
  }
}
