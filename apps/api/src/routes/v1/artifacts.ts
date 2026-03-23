import { Hono } from "hono";
import {
  requireAuth,
  requirePermission,
  shareTokenCanReadArtifact,
  hasPermission,
  hasNamespaceAccess,
} from "../../middleware/auth.js";
import { generateId, getExtensionForContentType, nowISO, computeContentHash, type Provenance } from "@attach/shared";
import type { GrantRow } from "@attach/db";
import { validateArtifactPathSegment, computeLineDiff } from "@attach/db";
import type { AuthContext, ShareTokenContext } from "../../middleware/auth.js";
import { buildStorageQuotaExceededBody, enforceStorageQuota } from "../../middleware/quota.js";
import { safeJsonParse } from "../../utils/json.js";

const artifacts = new Hono();


// Allowed content types for V1 (text-only)
const ALLOWED_CONTENT_TYPES = [
  "text/plain",
  "text/markdown",
  "application/json",
];

// Max content size (10MB)
const MAX_CONTENT_SIZE = 10 * 1024 * 1024;

function hasReadPermission(grant: GrantRow): boolean {
  return safeJsonParse<string[]>(grant.permissions, []).includes("read");
}

function isGrantNotExpired(grant: GrantRow, now: string): boolean {
  return !grant.expires_at || grant.expires_at > now;
}

function hasPublicReadGrant(
  db: {
    grants: {
      getByArtifact(artifactId: string): GrantRow[];
      getByNamespace(namespaceId: string): GrantRow[];
    };
  },
  artifactId: string,
  namespaceId: string
): boolean {
  const now = nowISO();

  for (const grant of db.grants.getByArtifact(artifactId)) {
    if (grant.grantee_type !== "public") {
      continue;
    }
    if (grant.namespace_id !== namespaceId) {
      continue;
    }
    if (!isGrantNotExpired(grant, now)) {
      continue;
    }
    if (hasReadPermission(grant)) {
      return true;
    }
  }

  for (const grant of db.grants.getByNamespace(namespaceId)) {
    if (grant.grantee_type !== "public") {
      continue;
    }
    if (grant.artifact_id !== null) {
      continue;
    }
    if (!isGrantNotExpired(grant, now)) {
      continue;
    }
    if (hasReadPermission(grant)) {
      return true;
    }
  }

  return false;
}

/**
 * POST /v1/artifacts
 * Create a new artifact.
 *
 * Consistency model: preflight checks → git commit → SQLite insert.
 * If SQLite fails after git commit, the namespace lock ensures we can
 * safely roll back git (resetToCommit or resetToEmpty) before releasing.
 */
artifacts.post("/", requireAuth, requirePermission("artifacts:write"), async (c) => {
  const auth = c.get("auth")!;
  const db = c.get("db");
  const blob = c.get("blob");
  const gitStore = c.get("gitStore");
  const storageLimitBytes = c.get("storageLimitBytes");

  const body = await c.req.json<{
    namespace_id: string;
    slug?: string;
    title: string;
    description?: string;
    content_type: string;
    content: string;
    visibility?: "private" | "public";
    metadata?: Record<string, unknown>;
    message?: string;
    provenance?: Partial<Provenance>;
  }>();

  // --- Preflight checks (catch deterministic failures before git commit) ---

  // Validate namespace access
  const namespace = db.namespaces.getById(body.namespace_id);
  if (!namespace) {
    return c.json({ error: "not_found", message: "Namespace not found" }, 404);
  }

  const canWrite =
    (namespace.owner_id === auth.principal.id ||
      auth.principal.namespace_id === namespace.id) &&
    hasNamespaceAccess(auth, namespace.id);

  if (!canWrite) {
    return c.json({ error: "forbidden", message: "Write access denied" }, 403);
  }

  // Validate content type
  if (!ALLOWED_CONTENT_TYPES.includes(body.content_type)) {
    return c.json(
      {
        error: "invalid_content_type",
        message: `Content type must be one of: ${ALLOWED_CONTENT_TYPES.join(", ")}`,
      },
      400
    );
  }

  const content = Buffer.from(body.content, "utf-8");

  if (content.length > MAX_CONTENT_SIZE) {
    return c.json(
      {
        error: "content_too_large",
        message: `Content exceeds maximum size of ${MAX_CONTENT_SIZE / 1024 / 1024}MB`,
      },
      400
    );
  }

  // --- Validate slug as git path segment ---
  const pathSegment = body.slug ?? null;
  if (pathSegment) {
    const segmentError = validateArtifactPathSegment(pathSegment);
    if (segmentError) {
      return c.json({ error: "invalid_slug", message: segmentError }, 400);
    }
  }

  // --- Generate ID, compute hash, derive git path ---
  const artifactId = generateId();
  const contentHash = computeContentHash(content);
  const storageKey = contentHash;
  const ext = getExtensionForContentType(body.content_type);
  const gitPath = `${body.slug ?? artifactId}/content.${ext}`;

  // Build searchable text
  const handoffParts: string[] = [];
  if (body.provenance?.senderRuntime) handoffParts.push(`FROM: ${body.provenance.senderRuntime}`);
  if (body.provenance?.recipient) handoffParts.push(`TO: ${body.provenance.recipient}`);
  if (body.provenance?.threadId) handoffParts.push(`THREAD: ${body.provenance.threadId}`);
  if (body.provenance?.handoffKind) handoffParts.push(`KIND: ${body.provenance.handoffKind}`);

  const searchableText = [body.title, body.description, content.toString("utf-8"), ...handoffParts]
    .filter(Boolean)
    .join("\n");

  const provenance: Provenance = {
    source: "api",
    ...body.provenance,
  };

  // --- Critical section: hold namespace lock across git commit + DB write ---
  const release = await gitStore.acquireNamespaceLock(body.namespace_id);
  let result;
  try {
    // Check slug uniqueness inside lock to prevent TOCTOU race
    if (body.slug && db.artifacts.getBySlug(body.namespace_id, body.slug)) {
      return c.json(
        { error: "slug_taken", message: "An artifact with this slug already exists in the namespace" },
        409
      );
    }

    const quota = await enforceStorageQuota(gitStore, body.namespace_id, content.length, storageLimitBytes);
    if (!quota.allowed) {
      return c.json(
        buildStorageQuotaExceededBody(
          quota.repoSizeBytes,
          storageLimitBytes,
          quota.estimatedGrowthBytes,
          quota.estimatedUsageBytes
        ),
        413
      );
    }

    const headBefore = await gitStore.getHead(body.namespace_id);
    const commitMessage = body.message ?? `Create ${body.title}`;
    const gitCommitSha = await gitStore.commitArtifact(
      body.namespace_id,
      gitPath,
      content,
      commitMessage,
      auth.principal.id
    );

    try {
      result = db.artifacts.createWithId(artifactId, {
        namespaceId: body.namespace_id,
        slug: body.slug,
        title: body.title,
        description: body.description,
        contentType: body.content_type,
        visibility: body.visibility ?? "private",
        metadata: body.metadata,
        createdBy: auth.principal.id,
        contentHash,
        contentSize: content.length,
        storageKey,
        searchableText,
        message: body.message,
        provenance,
        gitCommitSha,
        gitPath,
      });
    } catch (dbError) {
      // Rollback git: restore prior HEAD or reset to empty for first-write failures
      try {
        if (headBefore) {
          await gitStore.resetToCommit(body.namespace_id, headBefore);
        } else {
          await gitStore.resetToEmpty(body.namespace_id);
        }
      } catch (rollbackError) {
        console.error("Git rollback failed after DB error:", rollbackError);
      }
      throw dbError;
    }
  } finally {
    release();
  }

  try {
    blob.put(content);
  } catch (error) {
    console.error("Blob fallback write failed after artifact create:", error);
  }

  db.audit.create({
    principalId: auth.principal.id,
    principalType: auth.principal.type,
    credentialId: auth.credential.id,
    action: "artifact.create",
    resourceType: "artifact",
    resourceId: result.artifact.id,
    namespaceId: body.namespace_id,
  });

  return c.json(
    {
      id: result.artifact.id,
      slug: result.artifact.slug,
      title: result.artifact.title,
      description: result.artifact.description,
      content_type: result.artifact.content_type,
      current_version: result.artifact.current_version,
      visibility: result.artifact.visibility,
      metadata: safeJsonParse(result.artifact.metadata, null),
      version: {
        id: result.version.id,
        version: result.version.version,
        content_hash: result.version.content_hash,
        content_size: result.version.content_size,
        created_at: result.version.created_at,
      },
      created_at: result.artifact.created_at,
    },
    201
  );
});

/**
 * GET /v1/artifacts/:id
 * Get an artifact by ID
 * Supports both authenticated access and share token access
 */
artifacts.get("/:id", async (c) => {
  const auth = c.get("auth") as AuthContext | null;
  const shareToken = c.get("shareToken") as ShareTokenContext | null;
  const db = c.get("db");
  const id = c.req.param("id");
  if (!id) {
    return c.json({ error: "bad_request", message: "Artifact ID is required" }, 400);
  }

  const artifact = db.artifacts.getById(id);
  if (!artifact) {
    return c.json({ error: "not_found", message: "Artifact not found" }, 404);
  }

  // Get namespace for access check
  const namespace = db.namespaces.getById(artifact.namespace_id);
  if (!namespace) {
    return c.json({ error: "not_found", message: "Namespace not found" }, 404);
  }

  // Check read access via authentication
  let canRead = false;
  if (auth) {
    canRead =
      hasPermission(auth, "artifacts:read") &&
      hasNamespaceAccess(auth, namespace.id) &&
      (artifact.visibility === "public" ||
        namespace.owner_id === auth.principal.id ||
        auth.principal.namespace_id === namespace.id);
  }

  // Check read access via share token
  if (!canRead && shareTokenCanReadArtifact(shareToken, id, artifact.namespace_id)) {
    canRead = true;
  }

  // Check read access via public grant
  if (!canRead && hasPublicReadGrant(db, id, artifact.namespace_id)) {
    canRead = true;
  }

  if (!canRead) {
    return c.json({ error: "forbidden", message: "Access denied" }, 403);
  }

  // Log read event (only for authenticated access)
  if (auth) {
    db.audit.create({
      principalId: auth.principal.id,
      principalType: auth.principal.type,
      credentialId: auth.credential.id,
      action: "artifact.read",
      resourceType: "artifact",
      resourceId: id,
      namespaceId: artifact.namespace_id,
    });
  }

  // Get creator info from runtime instances
  const creatorInstance = db.runtimeInstances.getByPrincipalId(artifact.created_by);

  // Get last version's creator
  const currentVersion = db.artifacts.getCurrentVersion(artifact.id);
  const lastUpdaterInstance = currentVersion
    ? db.runtimeInstances.getByPrincipalId(currentVersion.created_by)
    : null;

  return c.json({
    id: artifact.id,
    namespace_id: artifact.namespace_id,
    slug: artifact.slug,
    title: artifact.title,
    description: artifact.description,
    content_type: artifact.content_type,
    current_version: artifact.current_version,
    visibility: artifact.visibility,
    metadata: safeJsonParse(artifact.metadata, null),
    created_at: artifact.created_at,
    updated_at: artifact.updated_at,
    archived_at: artifact.archived_at,
    created_by: {
      instance_name: creatorInstance?.display_name ?? null,
      runtime_kind: creatorInstance?.runtime_kind ?? null,
    },
    last_updated_by: {
      instance_name: lastUpdaterInstance?.display_name ?? null,
      runtime_kind: lastUpdaterInstance?.runtime_kind ?? null,
    },
  });
});

/**
 * GET /v1/artifacts/:id/content
 * Get artifact content (raw)
 * Supports both authenticated access and share token access.
 * Reads from git store if version has git metadata, otherwise falls back to blob store.
 */
artifacts.get("/:id/content", async (c) => {
  const auth = c.get("auth") as AuthContext | null;
  const shareToken = c.get("shareToken") as ShareTokenContext | null;
  const db = c.get("db");
  const blob = c.get("blob");
  const gitStore = c.get("gitStore");
  const id = c.req.param("id");
  const versionParam = c.req.query("version");
  if (!id) {
    return c.json({ error: "bad_request", message: "Artifact ID is required" }, 400);
  }

  const artifact = db.artifacts.getById(id);
  if (!artifact) {
    return c.json({ error: "not_found", message: "Artifact not found" }, 404);
  }

  const namespace = db.namespaces.getById(artifact.namespace_id);
  if (!namespace) {
    return c.json({ error: "not_found", message: "Namespace not found" }, 404);
  }

  let canRead = false;
  if (auth) {
    canRead =
      hasPermission(auth, "artifacts:read") &&
      hasNamespaceAccess(auth, namespace.id) &&
      (artifact.visibility === "public" ||
        namespace.owner_id === auth.principal.id ||
        auth.principal.namespace_id === namespace.id);
  }

  if (!canRead && shareTokenCanReadArtifact(shareToken, id, artifact.namespace_id)) {
    canRead = true;
  }

  if (!canRead && hasPublicReadGrant(db, id, artifact.namespace_id)) {
    canRead = true;
  }

  if (!canRead) {
    return c.json({ error: "forbidden", message: "Access denied" }, 403);
  }

  let version;
  if (versionParam) {
    const versionNum = Number(versionParam);
    if (!Number.isInteger(versionNum)) {
      return c.json(
        { error: "bad_request", message: "version must be an integer" },
        400
      );
    }
    version = db.artifacts.getVersionByNumber(id, versionNum);
  } else {
    version = db.artifacts.getCurrentVersion(id);
  }

  if (!version) {
    return c.json({ error: "not_found", message: "Version not found" }, 404);
  }

  // Git-backed read if version has git metadata, otherwise fallback to blob store
  let content: Buffer | null = null;
  if (version.git_commit_sha && version.git_path) {
    content = await gitStore.readAtCommit(
      artifact.namespace_id,
      version.git_path,
      version.git_commit_sha
    );
  }
  if (!content) {
    content = blob.get(version.storage_key);
  }
  if (!content) {
    return c.json({ error: "not_found", message: "Content not found" }, 404);
  }

  return new Response(content, {
    headers: {
      "Content-Type": artifact.content_type,
      "Content-Length": content.length.toString(),
      "X-Artifact-Version": version.version.toString(),
      "X-Content-Hash": version.content_hash,
    },
  });
});

/**
 * PUT /v1/artifacts/:id
 * Update an artifact (creates new version).
 *
 * Consistency model: preflight checks → git commit → SQLite insert.
 * If SQLite fails after git commit, the orphaned commit is harmless.
 */
artifacts.put("/:id", requireAuth, requirePermission("artifacts:write"), async (c) => {
  const auth = c.get("auth")!;
  const db = c.get("db");
  const blob = c.get("blob");
  const gitStore = c.get("gitStore");
  const storageLimitBytes = c.get("storageLimitBytes");
  const id = c.req.param("id");
  if (!id) {
    return c.json({ error: "bad_request", message: "Artifact ID is required" }, 400);
  }

  const artifact = db.artifacts.getById(id);
  if (!artifact) {
    return c.json({ error: "not_found", message: "Artifact not found" }, 404);
  }

  const namespace = db.namespaces.getById(artifact.namespace_id);
  if (!namespace) {
    return c.json({ error: "not_found", message: "Namespace not found" }, 404);
  }

  const canWrite =
    (namespace.owner_id === auth.principal.id ||
      auth.principal.namespace_id === namespace.id) &&
    hasNamespaceAccess(auth, namespace.id);

  if (!canWrite) {
    return c.json({ error: "forbidden", message: "Write access denied" }, 403);
  }

  if (artifact.archived_at) {
    return c.json(
      { error: "archived", message: "Cannot update archived artifact" },
      400
    );
  }

  const body = await c.req.json<{
    content: string;
    title?: string;
    description?: string;
    metadata?: Record<string, unknown>;
    message?: string;
    provenance?: Partial<Provenance>;
  }>();

  const content = Buffer.from(body.content, "utf-8");

  if (content.length > MAX_CONTENT_SIZE) {
    return c.json(
      {
        error: "content_too_large",
        message: `Content exceeds maximum size of ${MAX_CONTENT_SIZE / 1024 / 1024}MB`,
      },
      400
    );
  }

  // Compute content hash from raw bytes
  const contentHash = computeContentHash(content);
  const storageKey = contentHash;

  // Derive git path — reuse existing path from current version if available, otherwise derive
  const currentVersion = db.artifacts.getCurrentVersion(id);
  let gitPath: string;
  if (currentVersion?.git_path) {
    gitPath = currentVersion.git_path;
  } else {
    const ext = getExtensionForContentType(artifact.content_type);
    const pathSegment = artifact.slug ?? id;
    if (artifact.slug) {
      const segmentError = validateArtifactPathSegment(artifact.slug);
      if (segmentError) {
        return c.json({ error: "invalid_slug", message: segmentError }, 400);
      }
    }
    gitPath = `${pathSegment}/content.${ext}`;
  }

  const title = body.title ?? artifact.title;
  const description = body.description ?? artifact.description;

  const handoffParts: string[] = [];
  if (body.provenance?.senderRuntime) handoffParts.push(`FROM: ${body.provenance.senderRuntime}`);
  if (body.provenance?.recipient) handoffParts.push(`TO: ${body.provenance.recipient}`);
  if (body.provenance?.threadId) handoffParts.push(`THREAD: ${body.provenance.threadId}`);
  if (body.provenance?.handoffKind) handoffParts.push(`KIND: ${body.provenance.handoffKind}`);

  const searchableText = [title, description, content.toString("utf-8"), ...handoffParts]
    .filter(Boolean)
    .join("\n");

  const provenance: Provenance = {
    source: "api",
    ...body.provenance,
  };

  // --- Critical section: hold namespace lock across git commit + DB write ---
  const release = await gitStore.acquireNamespaceLock(artifact.namespace_id);
  let result;
  try {
    const quota = await enforceStorageQuota(gitStore, artifact.namespace_id, content.length, storageLimitBytes);
    if (!quota.allowed) {
      return c.json(
        buildStorageQuotaExceededBody(
          quota.repoSizeBytes,
          storageLimitBytes,
          quota.estimatedGrowthBytes,
          quota.estimatedUsageBytes
        ),
        413
      );
    }

    const headBefore = await gitStore.getHead(artifact.namespace_id);
    const commitMessage = body.message ?? `Update ${artifact.title}`;
    const gitCommitSha = await gitStore.commitArtifact(
      artifact.namespace_id,
      gitPath,
      content,
      commitMessage,
      auth.principal.id
    );

    try {
      result = db.artifacts.update(id, {
        contentHash,
        contentSize: content.length,
        storageKey,
        searchableText,
        message: body.message,
        provenance,
        updatedBy: auth.principal.id,
        title: body.title,
        description: body.description,
        metadata: body.metadata,
        gitCommitSha,
        gitPath,
      });
    } catch (dbError) {
      try {
        if (headBefore) {
          await gitStore.resetToCommit(artifact.namespace_id, headBefore);
        } else {
          await gitStore.resetToEmpty(artifact.namespace_id);
        }
      } catch (rollbackError) {
        console.error("Git rollback failed after DB error:", rollbackError);
      }
      throw dbError;
    }
  } finally {
    release();
  }

  try {
    blob.put(content);
  } catch (error) {
    console.error("Blob fallback write failed after artifact update:", error);
  }

  db.audit.create({
    principalId: auth.principal.id,
    principalType: auth.principal.type,
    credentialId: auth.credential.id,
    action: "artifact.update",
    resourceType: "artifact",
    resourceId: id,
    namespaceId: artifact.namespace_id,
    details: {
      new_version: result!.version.version,
    },
  });

  return c.json({
    id: result!.artifact.id,
    current_version: result!.artifact.current_version,
    version: {
      id: result!.version.id,
      version: result!.version.version,
      content_hash: result!.version.content_hash,
      content_size: result!.version.content_size,
      created_at: result!.version.created_at,
    },
    updated_at: result!.artifact.updated_at,
  });
});

/**
 * POST /v1/artifacts/:id/archive
 * Archive an artifact
 */
artifacts.post("/:id/archive", requireAuth, requirePermission("artifacts:write"), async (c) => {
  const auth = c.get("auth")!;
  const db = c.get("db");
  const id = c.req.param("id");
  if (!id) {
    return c.json({ error: "bad_request", message: "Artifact ID is required" }, 400);
  }

  const artifact = db.artifacts.getById(id);
  if (!artifact) {
    return c.json({ error: "not_found", message: "Artifact not found" }, 404);
  }

  // Get namespace for access check
  const namespace = db.namespaces.getById(artifact.namespace_id);
  if (!namespace) {
    return c.json({ error: "not_found", message: "Namespace not found" }, 404);
  }

  // Check write access
  const canWrite =
    (namespace.owner_id === auth.principal.id ||
      auth.principal.namespace_id === namespace.id) &&
    hasNamespaceAccess(auth, namespace.id);

  if (!canWrite) {
    return c.json({ error: "forbidden", message: "Write access denied" }, 403);
  }

  const body = await c
    .req
    .json<{ reason?: string }>()
    .catch((): { reason?: string } => ({}));

  const archived = db.artifacts.archive(id, auth.principal.id, body.reason);

  // Log audit event
  db.audit.create({
    principalId: auth.principal.id,
    principalType: auth.principal.type,
    credentialId: auth.credential.id,
    action: "artifact.archive",
    resourceType: "artifact",
    resourceId: id,
    namespaceId: artifact.namespace_id,
    details: { reason: body.reason },
  });

  return c.json({
    id: archived!.id,
    archived_at: archived!.archived_at,
    archived_by: archived!.archived_by,
    archive_reason: archived!.archive_reason,
  });
});

/**
 * POST /v1/artifacts/:id/unarchive
 * Unarchive an artifact
 */
artifacts.post("/:id/unarchive", requireAuth, requirePermission("artifacts:write"), async (c) => {
  const auth = c.get("auth")!;
  const db = c.get("db");
  const id = c.req.param("id");
  if (!id) {
    return c.json({ error: "bad_request", message: "Artifact ID is required" }, 400);
  }

  const artifact = db.artifacts.getById(id);
  if (!artifact) {
    return c.json({ error: "not_found", message: "Artifact not found" }, 404);
  }

  // Get namespace for access check
  const namespace = db.namespaces.getById(artifact.namespace_id);
  if (!namespace) {
    return c.json({ error: "not_found", message: "Namespace not found" }, 404);
  }

  // Check write access (same as archive)
  const canWrite =
    (namespace.owner_id === auth.principal.id ||
      auth.principal.namespace_id === namespace.id) &&
    hasNamespaceAccess(auth, namespace.id);

  if (!canWrite) {
    return c.json({ error: "forbidden", message: "Write access denied" }, 403);
  }

  const unarchived = db.artifacts.unarchive(id);

  // Log audit event
  db.audit.create({
    principalId: auth.principal.id,
    principalType: auth.principal.type,
    credentialId: auth.credential.id,
    action: "artifact.unarchive",
    resourceType: "artifact",
    resourceId: id,
    namespaceId: artifact.namespace_id,
  });

  return c.json({
    id: unarchived!.id,
    archived_at: unarchived!.archived_at,
  });
});

/**
 * GET /v1/artifacts/:id/versions
 * List all versions of an artifact
 * Supports both authenticated access and share token access
 */
artifacts.get("/:id/versions", async (c) => {
  const auth = c.get("auth") as AuthContext | null;
  const shareToken = c.get("shareToken") as ShareTokenContext | null;
  const db = c.get("db");
  const id = c.req.param("id");
  if (!id) {
    return c.json({ error: "bad_request", message: "Artifact ID is required" }, 400);
  }

  const artifact = db.artifacts.getById(id);
  if (!artifact) {
    return c.json({ error: "not_found", message: "Artifact not found" }, 404);
  }

  // Get namespace for access check
  const namespace = db.namespaces.getById(artifact.namespace_id);
  if (!namespace) {
    return c.json({ error: "not_found", message: "Namespace not found" }, 404);
  }

  // Check read access via authentication
  let canRead = false;
  if (auth) {
    canRead =
      hasPermission(auth, "artifacts:read") &&
      hasNamespaceAccess(auth, namespace.id) &&
      (artifact.visibility === "public" ||
        namespace.owner_id === auth.principal.id ||
        auth.principal.namespace_id === namespace.id);
  }

  // Check read access via share token
  if (!canRead && shareTokenCanReadArtifact(shareToken, id, artifact.namespace_id)) {
    canRead = true;
  }

  // Check read access via public grant
  if (!canRead && hasPublicReadGrant(db, id, artifact.namespace_id)) {
    canRead = true;
  }

  if (!canRead) {
    return c.json({ error: "forbidden", message: "Access denied" }, 403);
  }

  const versions = db.artifacts.listVersions(id);

  return c.json({
    versions: versions.map((v) => ({
      id: v.id,
      version: v.version,
      content_hash: v.content_hash,
      content_size: v.content_size,
      message: v.message,
      provenance: safeJsonParse(v.provenance, null),
      git_commit_sha: v.git_commit_sha ?? null,
      git_path: v.git_path ?? null,
      created_at: v.created_at,
      created_by: v.created_by,
    })),
  });
});

/**
 * GET /v1/artifacts/:id/diff
 * Path-scoped git diff between two versions.
 * Falls back to line-by-line diff via blob store for legacy versions.
 */
artifacts.get("/:id/diff", async (c) => {
  const auth = c.get("auth") as AuthContext | null;
  const shareToken = c.get("shareToken") as ShareTokenContext | null;
  const db = c.get("db");
  const blob = c.get("blob");
  const gitStore = c.get("gitStore");
  const id = c.req.param("id");
  const versionAParam = c.req.query("version_a");
  const versionBParam = c.req.query("version_b");

  if (!id) {
    return c.json({ error: "bad_request", message: "Artifact ID is required" }, 400);
  }
  if (!versionAParam || !versionBParam) {
    return c.json(
      { error: "bad_request", message: "version_a and version_b query params are required" },
      400
    );
  }

  const artifact = db.artifacts.getById(id);
  if (!artifact) {
    return c.json({ error: "not_found", message: "Artifact not found" }, 404);
  }

  const namespace = db.namespaces.getById(artifact.namespace_id);
  if (!namespace) {
    return c.json({ error: "not_found", message: "Namespace not found" }, 404);
  }

  // Check read access
  let canRead = false;
  if (auth) {
    canRead =
      hasPermission(auth, "artifacts:read") &&
      hasNamespaceAccess(auth, namespace.id) &&
      (artifact.visibility === "public" ||
        namespace.owner_id === auth.principal.id ||
        auth.principal.namespace_id === namespace.id);
  }
  if (!canRead && shareTokenCanReadArtifact(shareToken, id, artifact.namespace_id)) {
    canRead = true;
  }
  if (!canRead && hasPublicReadGrant(db, id, artifact.namespace_id)) {
    canRead = true;
  }
  if (!canRead) {
    return c.json({ error: "forbidden", message: "Access denied" }, 403);
  }

  const versionANum = Number(versionAParam);
  const versionBNum = Number(versionBParam);
  if (!Number.isInteger(versionANum) || !Number.isInteger(versionBNum)) {
    return c.json(
      { error: "bad_request", message: "version_a and version_b must be integers" },
      400
    );
  }

  const versionA = db.artifacts.getVersionByNumber(id, versionANum);
  const versionB = db.artifacts.getVersionByNumber(id, versionBNum);

  if (!versionA || !versionB) {
    return c.json({ error: "not_found", message: "Version not found" }, 404);
  }

  // If both versions are git-backed with the same path, use git diff (path-scoped)
  if (
    versionA.git_commit_sha &&
    versionA.git_path &&
    versionB.git_commit_sha &&
    versionB.git_path &&
    versionA.git_path === versionB.git_path
  ) {
    const diff = await gitStore.diffArtifact(
      artifact.namespace_id,
      versionA.git_path,
      versionA.git_commit_sha,
      versionB.git_commit_sha
    );
    return c.text(diff);
  }

  // Fallback: read content from storage and do line-by-line diff
  let contentA: Buffer | null = null;
  let contentB: Buffer | null = null;

  if (versionA.git_commit_sha && versionA.git_path) {
    contentA = await gitStore.readAtCommit(artifact.namespace_id, versionA.git_path, versionA.git_commit_sha);
  }
  if (!contentA) {
    contentA = blob.get(versionA.storage_key);
  }

  if (versionB.git_commit_sha && versionB.git_path) {
    contentB = await gitStore.readAtCommit(artifact.namespace_id, versionB.git_path, versionB.git_commit_sha);
  }
  if (!contentB) {
    contentB = blob.get(versionB.storage_key);
  }

  const linesA = (contentA?.toString("utf-8") ?? "").split("\n");
  const linesB = (contentB?.toString("utf-8") ?? "").split("\n");

  const diff = computeLineDiff(linesA, linesB, `Version ${versionA.version}`, `Version ${versionB.version}`);
  return c.text(diff);
});

export { artifacts };
