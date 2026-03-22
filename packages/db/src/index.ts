import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";

export type { DatabaseType };

export interface DbConfig {
  path: string;
  readonly?: boolean;
}

let db: DatabaseType | null = null;

export function initDb(config: DbConfig): DatabaseType {
  if (db) {
    return db;
  }

  db = new Database(config.path, {
    readonly: config.readonly ?? false,
  });

  // Enable WAL mode for better concurrency
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  return db;
}

export function getDb(): DatabaseType {
  if (!db) {
    throw new Error("Database not initialized. Call initDb() first.");
  }
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

// Re-export Database class
export { Database };

// Re-export migrations
export { migrate, getMigrationStatus } from "./migrate.js";

// Re-export blob storage
export { FileBlobStore, type BlobStore } from "./blob.js";

// Re-export git artifact store
export {
  IsomorphicGitArtifactStore,
  validateArtifactPathSegment,
  computeLineDiff,
  type GitArtifactStore,
} from "./git-artifact-store.js";

// Re-export repositories
export {
  PrincipalRepository,
  type PrincipalRow,
  type CreatePrincipalInput,
  type UpdatePrincipalInput,
} from "./repositories/principal.js";

export {
  IdentityRepository,
  type IdentityRow,
  type CreateIdentityInput,
} from "./repositories/identity.js";

export {
  ApiKeyRepository,
  setHmacSecret,
  type ApiKeyRow,
  type CreateApiKeyInput,
  type CreateApiKeyResult,
  type ApiKeyScope,
} from "./repositories/api-key.js";

export {
  SessionRepository,
  type SessionRow,
  type CreateSessionInput,
} from "./repositories/session.js";

export {
  NamespaceRepository,
  type NamespaceRow,
  type NamespaceSettings,
  type GitMirrorConfig,
  type CreateNamespaceInput,
  type UpdateNamespaceInput,
} from "./repositories/namespace.js";

export {
  ArtifactRepository,
  type ArtifactRow,
  type ArtifactVersionRow,
  type CreateArtifactInput,
  type UpdateArtifactInput,
  type ListArtifactsOptions,
  type SearchArtifactsOptions,
} from "./repositories/artifact.js";

export {
  AuditRepository,
  type AuditEventRow,
  type AuditAction,
  type CreateAuditEventInput,
  type ListAuditEventsOptions,
} from "./repositories/audit.js";

export {
  GrantRepository,
  setGrantHmacSecret,
  type GrantRow,
  type CreateGrantInput,
  type CreateGrantResult,
} from "./repositories/grant.js";

export {
  ConnectSessionRepository,
  type ConnectSessionRow,
  type CreateConnectSessionInput,
  type ApproveConnectSessionInput,
} from "./repositories/connect-session.js";

export {
  RuntimeInstanceRepository,
  type RuntimeInstanceRow,
  type CreateRuntimeInstanceInput,
} from "./repositories/runtime-instance.js";
