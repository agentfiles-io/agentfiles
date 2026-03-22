import type { Database as DatabaseType } from "better-sqlite3";
import { generateId, nowISO } from "@attach/shared";

export interface NamespaceRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  owner_id: string;
  visibility: "private" | "public";
  settings: string | null;
  git_mirror: string | null;
  created_at: string;
  updated_at: string;
}

export interface NamespaceSettings {
  default_visibility?: "private" | "public";
  require_labels?: boolean;
  max_artifact_size_mb?: number;
  publish_confirmation?: boolean;
  allowed_content_types?: string[];
}

export interface GitMirrorConfig {
  enabled: boolean;
  repo_url: string;
  branch: string;
  path_prefix?: string;
  auto_push?: boolean;
  last_sync_at?: string;
  last_commit_sha?: string;
}

export interface CreateNamespaceInput {
  slug: string;
  name: string;
  description?: string;
  ownerId: string;
  visibility?: "private" | "public";
  settings?: NamespaceSettings;
}

export interface UpdateNamespaceInput {
  name?: string;
  description?: string;
  visibility?: "private" | "public";
  settings?: NamespaceSettings;
  gitMirror?: GitMirrorConfig;
}

export class NamespaceRepository {
  constructor(private db: DatabaseType) {}

  create(input: CreateNamespaceInput): NamespaceRow {
    const id = generateId();
    const now = nowISO();

    // Default settings: private visibility, 10MB max size, text-only
    const defaultSettings: NamespaceSettings = {
      default_visibility: "private",
      require_labels: false,
      max_artifact_size_mb: 10,
      publish_confirmation: false,
      allowed_content_types: [
        "text/plain",
        "text/markdown",
        "application/json",
      ],
    };

    const settings = { ...defaultSettings, ...input.settings };

    this.db
      .prepare(
        `INSERT INTO namespaces (id, slug, name, description, owner_id, visibility, settings, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.slug,
        input.name,
        input.description ?? null,
        input.ownerId,
        input.visibility ?? "private",
        JSON.stringify(settings),
        now,
        now
      );

    return this.getById(id)!;
  }

  getById(id: string): NamespaceRow | null {
    return (
      (this.db
        .prepare(`SELECT * FROM namespaces WHERE id = ?`)
        .get(id) as NamespaceRow | undefined) ?? null
    );
  }

  getBySlug(slug: string): NamespaceRow | null {
    return (
      (this.db
        .prepare(`SELECT * FROM namespaces WHERE slug = ?`)
        .get(slug) as NamespaceRow | undefined) ?? null
    );
  }

  getByOwner(ownerId: string): NamespaceRow[] {
    return this.db
      .prepare(
        `SELECT * FROM namespaces WHERE owner_id = ? ORDER BY created_at DESC`
      )
      .all(ownerId) as NamespaceRow[];
  }

  update(id: string, input: UpdateNamespaceInput): NamespaceRow | null {
    const existing = this.getById(id);
    if (!existing) return null;

    const now = nowISO();

    // Merge settings
    let settings: NamespaceSettings = {};
    if (existing.settings) {
      try { settings = JSON.parse(existing.settings) as NamespaceSettings; } catch { /* use empty */ }
    }
    if (input.settings) {
      settings = { ...settings, ...input.settings };
    }

    // Merge git mirror
    let gitMirror: GitMirrorConfig | null = null;
    if (existing.git_mirror) {
      try { gitMirror = JSON.parse(existing.git_mirror) as GitMirrorConfig; } catch { /* use null */ }
    }
    if (input.gitMirror) {
      gitMirror = input.gitMirror;
    }

    this.db
      .prepare(
        `UPDATE namespaces
         SET name = ?, description = ?, visibility = ?, settings = ?, git_mirror = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(
        input.name ?? existing.name,
        input.description ?? existing.description,
        input.visibility ?? existing.visibility,
        JSON.stringify(settings),
        gitMirror ? JSON.stringify(gitMirror) : null,
        now,
        id
      );

    return this.getById(id);
  }

  slugExists(slug: string): boolean {
    const row = this.db
      .prepare(`SELECT 1 FROM namespaces WHERE slug = ?`)
      .get(slug);
    return !!row;
  }

  parseSettings(row: NamespaceRow): NamespaceSettings {
    if (!row.settings) {
      return {};
    }
    try {
      return JSON.parse(row.settings) as NamespaceSettings;
    } catch {
      return {};
    }
  }

  parseGitMirror(row: NamespaceRow): GitMirrorConfig | null {
    if (!row.git_mirror) {
      return null;
    }
    try {
      return JSON.parse(row.git_mirror) as GitMirrorConfig;
    } catch {
      return null;
    }
  }

  countAll(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) as count FROM namespaces`)
      .get() as { count: number };
    return row.count;
  }
}
