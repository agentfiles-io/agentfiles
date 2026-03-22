import type { Database as DatabaseType } from "better-sqlite3";
import { generateId, nowISO, type Provenance } from "@attach/shared";

export interface ArtifactRow {
  id: string;
  namespace_id: string;
  slug: string | null;
  title: string;
  description: string | null;
  content_type: string;
  current_version: number;
  current_version_id: string | null;
  visibility: "private" | "public";
  metadata: string | null;
  created_at: string;
  updated_at: string;
  created_by: string;
  archived_at: string | null;
  archived_by: string | null;
  archive_reason: string | null;
}

export interface ArtifactVersionRow {
  id: string;
  artifact_id: string;
  version: number;
  content_hash: string;
  content_size: number;
  storage_key: string;
  searchable_text: string | null;
  message: string | null;
  provenance: string;
  created_at: string;
  created_by: string;
  git_commit_sha: string | null;
  git_path: string | null;
}

export interface CreateArtifactInput {
  namespaceId: string;
  slug?: string;
  title: string;
  description?: string;
  contentType: string;
  visibility?: "private" | "public";
  metadata?: Record<string, unknown>;
  createdBy: string;
  // First version data
  contentHash: string;
  contentSize: number;
  storageKey: string;
  searchableText?: string;
  message?: string;
  provenance: Provenance;
  // Git storage metadata (optional — null means legacy blob-backed)
  gitCommitSha?: string;
  gitPath?: string;
}

export interface UpdateArtifactInput {
  // New version data
  contentHash: string;
  contentSize: number;
  storageKey: string;
  searchableText?: string;
  message?: string;
  provenance: Provenance;
  updatedBy: string;
  // Optional metadata updates
  title?: string;
  description?: string;
  metadata?: Record<string, unknown>;
  // Git storage metadata (optional — null means legacy blob-backed)
  gitCommitSha?: string;
  gitPath?: string;
}

export interface ListArtifactsOptions {
  namespaceId: string;
  includeArchived?: boolean;
  contentType?: string;
  limit?: number;
  offset?: number;
}

export interface SearchArtifactsOptions {
  namespaceId: string;
  query: string;
  limit?: number;
}

export class ArtifactRepository {
  constructor(private db: DatabaseType) {}

  create(input: CreateArtifactInput): { artifact: ArtifactRow; version: ArtifactVersionRow } {
    const artifactId = generateId();
    const versionId = generateId();
    const now = nowISO();

    // Build searchable text: title + description + content (for text types)
    const searchableText =
      input.searchableText ??
      [input.title, input.description].filter(Boolean).join("\n");

    // Wrap in transaction to ensure atomicity of artifact + version + FK update
    const txn = this.db.transaction(() => {
      // Insert artifact first (without current_version_id to avoid FK issue)
      this.db
        .prepare(
          `INSERT INTO artifacts (id, namespace_id, slug, title, description, content_type, current_version, visibility, metadata, created_at, updated_at, created_by)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`
        )
        .run(
          artifactId,
          input.namespaceId,
          input.slug ?? null,
          input.title,
          input.description ?? null,
          input.contentType,
          input.visibility ?? "private",
          input.metadata ? JSON.stringify(input.metadata) : null,
          now,
          now,
          input.createdBy
        );

      // Insert first version
      this.db
        .prepare(
          `INSERT INTO artifact_versions (id, artifact_id, version, content_hash, content_size, storage_key, searchable_text, message, provenance, created_at, created_by, git_commit_sha, git_path)
           VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          versionId,
          artifactId,
          input.contentHash,
          input.contentSize,
          input.storageKey,
          searchableText,
          input.message ?? null,
          JSON.stringify(input.provenance),
          now,
          input.createdBy,
          input.gitCommitSha ?? null,
          input.gitPath ?? null
        );

      // Now update artifact with current_version_id (triggers FTS insert)
      this.db
        .prepare(`UPDATE artifacts SET current_version_id = ? WHERE id = ?`)
        .run(versionId, artifactId);
    });

    txn();

    return {
      artifact: this.getById(artifactId)!,
      version: this.getVersion(versionId)!,
    };
  }

  /**
   * Create an artifact with a pre-generated ID.
   * Used when the caller needs the ID before creation (e.g., to derive git path).
   */
  createWithId(id: string, input: CreateArtifactInput): { artifact: ArtifactRow; version: ArtifactVersionRow } {
    const versionId = generateId();
    const now = nowISO();

    const searchableText =
      input.searchableText ??
      [input.title, input.description].filter(Boolean).join("\n");

    // Wrap in transaction to ensure atomicity of artifact + version + FK update
    const txn = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO artifacts (id, namespace_id, slug, title, description, content_type, current_version, visibility, metadata, created_at, updated_at, created_by)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          input.namespaceId,
          input.slug ?? null,
          input.title,
          input.description ?? null,
          input.contentType,
          input.visibility ?? "private",
          input.metadata ? JSON.stringify(input.metadata) : null,
          now,
          now,
          input.createdBy
        );

      this.db
        .prepare(
          `INSERT INTO artifact_versions (id, artifact_id, version, content_hash, content_size, storage_key, searchable_text, message, provenance, created_at, created_by, git_commit_sha, git_path)
           VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          versionId,
          id,
          input.contentHash,
          input.contentSize,
          input.storageKey,
          searchableText,
          input.message ?? null,
          JSON.stringify(input.provenance),
          now,
          input.createdBy,
          input.gitCommitSha ?? null,
          input.gitPath ?? null
        );

      this.db
        .prepare(`UPDATE artifacts SET current_version_id = ? WHERE id = ?`)
        .run(versionId, id);
    });

    txn();

    return {
      artifact: this.getById(id)!,
      version: this.getVersion(versionId)!,
    };
  }

  getById(id: string): ArtifactRow | null {
    return (
      (this.db
        .prepare(`SELECT * FROM artifacts WHERE id = ?`)
        .get(id) as ArtifactRow | undefined) ?? null
    );
  }

  getBySlug(namespaceId: string, slug: string): ArtifactRow | null {
    return (
      (this.db
        .prepare(`SELECT * FROM artifacts WHERE namespace_id = ? AND slug = ?`)
        .get(namespaceId, slug) as ArtifactRow | undefined) ?? null
    );
  }

  list(options: ListArtifactsOptions): ArtifactRow[] {
    let sql = `SELECT * FROM artifacts WHERE namespace_id = ?`;
    const params: (string | number)[] = [options.namespaceId];

    if (!options.includeArchived) {
      sql += ` AND archived_at IS NULL`;
    }

    if (options.contentType) {
      sql += ` AND content_type = ?`;
      params.push(options.contentType);
    }

    sql += ` ORDER BY updated_at DESC`;

    if (options.limit) {
      sql += ` LIMIT ?`;
      params.push(options.limit);
    }

    if (options.offset) {
      sql += ` OFFSET ?`;
      params.push(options.offset);
    }

    return this.db.prepare(sql).all(...params) as ArtifactRow[];
  }

  /**
   * Full-text search on current version content.
   */
  search(options: SearchArtifactsOptions): Array<ArtifactRow & { score: number }> {
    const sql = `
      SELECT a.*, bm25(artifacts_fts) AS score
      FROM artifacts a
      JOIN artifacts_fts fts ON a.id = fts.artifact_id
      WHERE artifacts_fts MATCH ?
        AND a.namespace_id = ?
        AND a.archived_at IS NULL
      ORDER BY score
      LIMIT ?
    `;

    return this.db
      .prepare(sql)
      .all(options.query, options.namespaceId, options.limit ?? 20) as Array<
      ArtifactRow & { score: number }
    >;
  }

  /**
   * Create a new version of an artifact.
   */
  update(
    id: string,
    input: UpdateArtifactInput
  ): { artifact: ArtifactRow; version: ArtifactVersionRow } | null {
    const existing = this.getById(id);
    if (!existing) return null;

    const versionId = generateId();
    const now = nowISO();
    const newVersion = existing.current_version + 1;

    // Build searchable text
    const title = input.title ?? existing.title;
    const description = input.description ?? existing.description;
    const searchableText =
      input.searchableText ?? [title, description].filter(Boolean).join("\n");

    // Wrap in transaction to ensure atomicity of version insert + artifact update
    const txn = this.db.transaction(() => {
      // Insert new version
      this.db
        .prepare(
          `INSERT INTO artifact_versions (id, artifact_id, version, content_hash, content_size, storage_key, searchable_text, message, provenance, created_at, created_by, git_commit_sha, git_path)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          versionId,
          id,
          newVersion,
          input.contentHash,
          input.contentSize,
          input.storageKey,
          searchableText,
          input.message ?? null,
          JSON.stringify(input.provenance),
          now,
          input.updatedBy,
          input.gitCommitSha ?? null,
          input.gitPath ?? null
        );

      // Update artifact (triggers FTS update)
      this.db
        .prepare(
          `UPDATE artifacts
           SET title = ?, description = ?, metadata = ?, current_version = ?, current_version_id = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(
          title,
          description,
          input.metadata ? JSON.stringify(input.metadata) : existing.metadata,
          newVersion,
          versionId,
          now,
          id
        );
    });

    txn();

    return {
      artifact: this.getById(id)!,
      version: this.getVersion(versionId)!,
    };
  }

  archive(id: string, archivedBy: string, reason?: string): ArtifactRow | null {
    const existing = this.getById(id);
    if (!existing || existing.archived_at) return null;

    const now = nowISO();

    this.db
      .prepare(
        `UPDATE artifacts SET archived_at = ?, archived_by = ?, archive_reason = ?, updated_at = ? WHERE id = ?`
      )
      .run(now, archivedBy, reason ?? null, now, id);

    return this.getById(id);
  }

  unarchive(id: string): ArtifactRow | null {
    const existing = this.getById(id);
    if (!existing || !existing.archived_at) return null;

    const now = nowISO();

    this.db
      .prepare(
        `UPDATE artifacts SET archived_at = NULL, archived_by = NULL, archive_reason = NULL, updated_at = ? WHERE id = ?`
      )
      .run(now, id);

    return this.getById(id);
  }

  // Version methods

  getVersion(id: string): ArtifactVersionRow | null {
    return (
      (this.db
        .prepare(`SELECT * FROM artifact_versions WHERE id = ?`)
        .get(id) as ArtifactVersionRow | undefined) ?? null
    );
  }

  getVersionByNumber(artifactId: string, version: number): ArtifactVersionRow | null {
    return (
      (this.db
        .prepare(
          `SELECT * FROM artifact_versions WHERE artifact_id = ? AND version = ?`
        )
        .get(artifactId, version) as ArtifactVersionRow | undefined) ?? null
    );
  }

  listVersions(artifactId: string): ArtifactVersionRow[] {
    return this.db
      .prepare(
        `SELECT * FROM artifact_versions WHERE artifact_id = ? ORDER BY version DESC`
      )
      .all(artifactId) as ArtifactVersionRow[];
  }

  getCurrentVersion(artifactId: string): ArtifactVersionRow | null {
    const artifact = this.getById(artifactId);
    if (!artifact?.current_version_id) return null;
    return this.getVersion(artifact.current_version_id);
  }

  parseProvenance(row: ArtifactVersionRow): Provenance {
    try {
      return JSON.parse(row.provenance) as Provenance;
    } catch {
      return {} as Provenance;
    }
  }

  parseMetadata(row: ArtifactRow): Record<string, unknown> | null {
    if (!row.metadata) return null;
    try {
      return JSON.parse(row.metadata) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  /**
   * List artifacts created by a specific principal.
   */
  listByCreator(principalId: string): ArtifactRow[] {
    return this.db
      .prepare(
        `SELECT * FROM artifacts WHERE created_by = ? AND archived_at IS NULL ORDER BY created_at DESC`
      )
      .all(principalId) as ArtifactRow[];
  }

  /**
   * List artifacts that have versions created by a specific principal
   * (but the artifact itself may have been created by someone else).
   */
  listUpdatedByCreator(principalId: string): ArtifactRow[] {
    return this.db
      .prepare(
        `SELECT DISTINCT a.* FROM artifacts a
         JOIN artifact_versions av ON a.id = av.artifact_id
         WHERE av.created_by = ? AND a.created_by != ? AND a.archived_at IS NULL
         ORDER BY a.updated_at DESC`
      )
      .all(principalId, principalId) as ArtifactRow[];
  }

  /**
   * Get all versions of an artifact joined with runtime instance and principal info.
   * Returns the lineage chain for one artifact. Includes principal name/type
   * so consumers can distinguish user vs agent creators.
   */
  getVersionsWithCreators(artifactId: string): Array<ArtifactVersionRow & {
    creator_name: string | null;
    creator_runtime_kind: string | null;
    creator_instance_id: string | null;
    creator_principal_name: string | null;
    creator_principal_type: string | null;
  }> {
    return this.db
      .prepare(
        `SELECT av.*,
                ri.display_name as creator_name,
                ri.runtime_kind as creator_runtime_kind,
                ri.id as creator_instance_id,
                p.name as creator_principal_name,
                p.type as creator_principal_type
         FROM artifact_versions av
         LEFT JOIN runtime_instances ri ON ri.principal_id = av.created_by
         LEFT JOIN principals p ON p.id = av.created_by
         WHERE av.artifact_id = ?
         ORDER BY av.version ASC`
      )
      .all(artifactId) as Array<ArtifactVersionRow & {
        creator_name: string | null;
        creator_runtime_kind: string | null;
        creator_instance_id: string | null;
        creator_principal_name: string | null;
        creator_principal_type: string | null;
      }>;
  }

  /**
   * List artifacts enriched with instance context for a namespace.
   * Includes created_by and last_updated_by instance names, plus handoff indicator.
   * distinct_creator_count counts ALL distinct principals (users + agents), not just runtime instances.
   */
  listWithInstanceContext(namespaceId: string): Array<ArtifactRow & {
    created_by_instance_name: string | null;
    created_by_runtime_kind: string | null;
    last_updated_by_instance_name: string | null;
    last_updated_by_runtime_kind: string | null;
    distinct_creator_count: number;
  }> {
    return this.db
      .prepare(
        `SELECT a.*,
                ri_creator.display_name as created_by_instance_name,
                ri_creator.runtime_kind as created_by_runtime_kind,
                ri_updater.display_name as last_updated_by_instance_name,
                ri_updater.runtime_kind as last_updated_by_runtime_kind,
                COALESCE(dc.distinct_creator_count, 1) as distinct_creator_count
         FROM artifacts a
         LEFT JOIN runtime_instances ri_creator ON ri_creator.principal_id = a.created_by
         LEFT JOIN (
           SELECT artifact_id, created_by
           FROM artifact_versions
           WHERE (artifact_id, version) IN (
             SELECT artifact_id, MAX(version)
             FROM artifact_versions
             GROUP BY artifact_id
           )
         ) latest_ver ON latest_ver.artifact_id = a.id
         LEFT JOIN runtime_instances ri_updater ON ri_updater.principal_id = latest_ver.created_by
         LEFT JOIN (
           SELECT artifact_id, COUNT(DISTINCT created_by) as distinct_creator_count
           FROM artifact_versions
           GROUP BY artifact_id
         ) dc ON dc.artifact_id = a.id
         WHERE a.namespace_id = ? AND a.archived_at IS NULL
         ORDER BY a.updated_at DESC`
      )
      .all(namespaceId) as Array<ArtifactRow & {
        created_by_instance_name: string | null;
        created_by_runtime_kind: string | null;
        last_updated_by_instance_name: string | null;
        last_updated_by_runtime_kind: string | null;
        distinct_creator_count: number;
      }>;
  }

  countByNamespaces(namespaceIds: string[]): number {
    if (namespaceIds.length === 0) return 0;
    const placeholders = namespaceIds.map(() => "?").join(",");
    const row = this.db
      .prepare(`SELECT COUNT(*) as count FROM artifacts WHERE namespace_id IN (${placeholders}) AND archived_at IS NULL`)
      .get(...namespaceIds) as { count: number };
    return row.count;
  }

  countAll(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) as count FROM artifacts WHERE archived_at IS NULL`)
      .get() as { count: number };
    return row.count;
  }

  countVersionsAll(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) as count FROM artifact_versions`)
      .get() as { count: number };
    return row.count;
  }
}
