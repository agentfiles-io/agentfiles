import { posix } from "node:path";
import { Hono } from "hono";
import {
  requireAuth,
  requirePermission,
  hasPermission,
  hasNamespaceAccess,
} from "../../middleware/auth.js";
import { generateId, getExtensionForContentType, computeContentHash, type Provenance } from "@attach/shared";
import { validateArtifactPathSegment } from "@attach/db";
import type { AuthContext } from "../../middleware/auth.js";
import { buildStorageQuotaExceededBody, enforceStorageQuota } from "../../middleware/quota.js";

const git = new Hono();

// Allowed content types for V1 (text-only)
const ALLOWED_CONTENT_TYPES = [
  "text/plain",
  "text/markdown",
  "application/json",
];

// Max content size (10MB)
const MAX_CONTENT_SIZE = 10 * 1024 * 1024;

/** Validate a git branch name: allow slashes for hierarchical refs, reject traversal and control chars. */
function isValidBranchName(branch: string): boolean {
  // Reject empty, leading/trailing slash, consecutive slashes, ".." segments, leading dots per segment
  if (!branch || branch.startsWith("/") || branch.endsWith("/") || branch.includes("//")) return false;
  const segments = branch.split("/");
  return segments.every((s) => s.length > 0 && !s.startsWith(".") && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(s));
}

/**
 * Parse a git URL and extract components
 * Supports: github.com, gitlab.com, bitbucket.org
 */
function parseGitUrl(url: string): {
  provider: "github" | "gitlab" | "bitbucket" | "unknown";
  owner: string;
  repo: string;
  rawUrlBase: string;
} | null {
  try {
    const parsed = new URL(url);
    const pathParts = parsed.pathname.replace(/^\//, "").replace(/\.git$/, "").split("/");

    if (pathParts.length < 2) return null;

    const owner = pathParts[0];
    const repo = pathParts[1];
    if (!owner || !repo) return null;

    if (parsed.host === "github.com") {
      return {
        provider: "github",
        owner,
        repo,
        rawUrlBase: `https://raw.githubusercontent.com/${owner}/${repo}`,
      };
    } else if (parsed.host === "gitlab.com") {
      return {
        provider: "gitlab",
        owner,
        repo,
        rawUrlBase: `https://gitlab.com/${owner}/${repo}/-/raw`,
      };
    } else if (parsed.host === "bitbucket.org") {
      return {
        provider: "bitbucket",
        owner,
        repo,
        rawUrlBase: `https://bitbucket.org/${owner}/${repo}/raw`,
      };
    }

    return {
      provider: "unknown",
      owner,
      repo,
      rawUrlBase: url,
    };
  } catch {
    return null;
  }
}

/**
 * Build a raw content URL for fetching a file from a git repo
 */
function buildRawUrl(
  repoInfo: ReturnType<typeof parseGitUrl>,
  branch: string,
  path: string
): string | null {
  if (!repoInfo) return null;

  const cleanPath = path.replace(/^\//, "");

  switch (repoInfo.provider) {
    case "github":
      return `${repoInfo.rawUrlBase}/${branch}/${cleanPath}`;
    case "gitlab":
      return `${repoInfo.rawUrlBase}/${branch}/${cleanPath}`;
    case "bitbucket":
      return `${repoInfo.rawUrlBase}/${branch}/${cleanPath}`;
    default:
      return null;
  }
}

/**
 * Detect content type from file extension
 */
function detectContentType(path: string): string {
  const ext = path.toLowerCase().split(".").pop();
  switch (ext) {
    case "md":
    case "markdown":
      return "text/markdown";
    case "json":
      return "application/json";
    default:
      return "text/plain";
  }
}

/**
 * POST /v1/git/import
 * Import a file from a git repository
 */
git.post("/import", requireAuth, requirePermission("artifacts:write"), async (c) => {
  const auth = c.get("auth") as AuthContext;
  const db = c.get("db");
  const blob = c.get("blob");
  const storageLimitBytes = c.get("storageLimitBytes");

  const body = await c.req.json<{
    repo_url: string;
    path: string;
    branch?: string;
    namespace_id: string;
    title?: string;
    description?: string;
    slug?: string;
    content_type?: string;
  }>();

  // Validate required fields
  if (!body.repo_url || !body.path || !body.namespace_id) {
    return c.json(
      { error: "bad_request", message: "repo_url, path, and namespace_id are required" },
      400
    );
  }

  // Validate branch parameter: allow slashes for hierarchical refs (feature/foo),
  // but reject traversal (..), leading dots, and control characters.
  if (body.branch && !isValidBranchName(body.branch)) {
    return c.json(
      { error: "bad_request", message: "Invalid branch name" },
      400
    );
  }

  // Validate path parameter - normalize then reject traversal
  const normalizedPath = posix.normalize(body.path);
  if (normalizedPath.startsWith("..") || normalizedPath.startsWith("/") || normalizedPath.includes("\0")) {
    return c.json(
      { error: "bad_request", message: "Path must not escape the repository root" },
      400
    );
  }
  body.path = normalizedPath;

  // Parse git URL
  const repoInfo = parseGitUrl(body.repo_url);
  if (!repoInfo || repoInfo.provider === "unknown") {
    return c.json(
      { error: "unsupported_provider", message: "Only GitHub, GitLab, and Bitbucket are supported" },
      400
    );
  }

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

  // Build raw URL
  const branch = body.branch ?? "main";
  const rawUrl = buildRawUrl(repoInfo, branch, body.path);

  if (!rawUrl) {
    return c.json(
      { error: "bad_request", message: "Could not build raw URL for this repository" },
      400
    );
  }

  // Fetch content from git with size-limited streaming
  let content: string;
  try {
    const controller = new AbortController();
    const response = await fetch(rawUrl, {
      headers: {
        "User-Agent": "AgentFiles/1.0",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      if (response.status === 404) {
        return c.json(
          { error: "not_found", message: `File not found: ${body.path} on branch ${branch}` },
          404
        );
      }
      return c.json(
        { error: "fetch_failed", message: `Failed to fetch file: ${response.statusText}` },
        502
      );
    }

    // Check Content-Length header first to reject obviously oversized responses
    const contentLength = response.headers.get("content-length");
    if (contentLength && parseInt(contentLength, 10) > MAX_CONTENT_SIZE) {
      controller.abort();
      return c.json(
        { error: "content_too_large", message: `Remote file exceeds maximum size of ${MAX_CONTENT_SIZE / 1024 / 1024}MB` },
        400
      );
    }

    // Stream with size limit to prevent unbounded memory usage
    const reader = response.body?.getReader();
    if (!reader) {
      return c.json({ error: "fetch_failed", message: "No response body" }, 502);
    }

    const chunks: Uint8Array[] = [];
    let totalSize = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalSize += value.byteLength;
      if (totalSize > MAX_CONTENT_SIZE) {
        controller.abort();
        return c.json(
          { error: "content_too_large", message: `Remote file exceeds maximum size of ${MAX_CONTENT_SIZE / 1024 / 1024}MB` },
          400
        );
      }
      chunks.push(value);
    }

    const combined = Buffer.concat(chunks);
    content = combined.toString("utf-8");
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return c.json({ error: "content_too_large", message: `Remote file exceeds maximum size of ${MAX_CONTENT_SIZE / 1024 / 1024}MB` }, 400);
    }
    return c.json(
      { error: "fetch_failed", message: `Failed to fetch file: ${error instanceof Error ? error.message : "unknown error"}` },
      502
    );
  }

  // Validate size (should already be within limit from streaming, but double-check)
  const contentBuffer = Buffer.from(content, "utf-8");
  if (contentBuffer.length > MAX_CONTENT_SIZE) {
    return c.json(
      {
        error: "content_too_large",
        message: `Content exceeds maximum size of ${MAX_CONTENT_SIZE / 1024 / 1024}MB`,
      },
      400
    );
  }

  // Determine content type
  const contentType = body.content_type ?? detectContentType(body.path);
  if (!ALLOWED_CONTENT_TYPES.includes(contentType)) {
    return c.json(
      {
        error: "invalid_content_type",
        message: `Content type must be one of: ${ALLOWED_CONTENT_TYPES.join(", ")}`,
      },
      400
    );
  }

  // Build title from path if not provided
  const fileName = body.path.split("/").pop() ?? body.path;
  const title = body.title ?? fileName.replace(/\.[^/.]+$/, "");

  // Validate slug as git path segment
  if (body.slug) {
    const segmentError = validateArtifactPathSegment(body.slug);
    if (segmentError) {
      return c.json({ error: "invalid_slug", message: segmentError }, 400);
    }
  }

  // Compute content hash
  const contentHash = computeContentHash(contentBuffer);
  const storageKey = contentHash;

  // Generate artifact ID and derive local git path
  const artifactId = generateId();
  const ext = getExtensionForContentType(contentType);
  const localGitPath = `${body.slug ?? artifactId}/content.${ext}`;

  // Build searchable text
  const searchableText = [title, body.description, content]
    .filter(Boolean)
    .join("\n");

  // Build provenance — gitPath here records the remote source path
  const provenance: Provenance = {
    source: "git_import",
    gitRepoUrl: body.repo_url,
    gitRef: branch,
    gitPath: body.path,
  };

  // --- Critical section: hold namespace lock across git commit + DB write ---
  const gitStore = c.get("gitStore");
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

    const quota = await enforceStorageQuota(
      gitStore,
      body.namespace_id,
      contentBuffer.length,
      storageLimitBytes
    );
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
    const gitCommitSha = await gitStore.commitArtifact(
      body.namespace_id,
      localGitPath,
      contentBuffer,
      `Imported from ${repoInfo.provider}: ${body.path}`,
      auth.principal.id
    );

    try {
      result = db.artifacts.createWithId(artifactId, {
        namespaceId: body.namespace_id,
        slug: body.slug,
        title,
        description: body.description,
        contentType,
        visibility: "private",
        createdBy: auth.principal.id,
        contentHash,
        contentSize: contentBuffer.length,
        storageKey,
        searchableText,
        message: `Imported from ${repoInfo.provider}: ${body.path}`,
        provenance,
        gitCommitSha,
        gitPath: localGitPath,
      });
    } catch (dbError) {
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
    blob.put(contentBuffer);
  } catch (error) {
    console.error("Blob fallback write failed after git import:", error);
  }

  // Log audit event
  db.audit.create({
    principalId: auth.principal.id,
    principalType: auth.principal.type,
    credentialId: auth.credential.id,
    action: "artifact.create",
    resourceType: "artifact",
    resourceId: result.artifact.id,
    namespaceId: body.namespace_id,
    details: {
      source: "git_import",
      repo_url: body.repo_url,
      path: body.path,
      branch,
    },
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
      provenance: {
        source: provenance.source,
        gitRepoUrl: provenance.gitRepoUrl,
        gitRef: provenance.gitRef,
        gitPath: provenance.gitPath,
      },
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
 * POST /v1/git/sync
 * Sync an artifact with its git source (create new version if changed)
 */
git.post("/sync/:id", requireAuth, requirePermission("artifacts:write"), async (c) => {
  const auth = c.get("auth") as AuthContext;
  const db = c.get("db");
  const blob = c.get("blob");
  const storageLimitBytes = c.get("storageLimitBytes");
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

  if (artifact.archived_at) {
    return c.json({ error: "archived", message: "Cannot sync archived artifact" }, 400);
  }

  // Get current version to check provenance
  const currentVersion = db.artifacts.getCurrentVersion(id);
  if (!currentVersion) {
    return c.json({ error: "not_found", message: "Version not found" }, 404);
  }

  let provenance: Provenance;
  try {
    provenance = JSON.parse(currentVersion.provenance);
  } catch {
    return c.json(
      { error: "invalid_data", message: "Could not parse provenance data" },
      500
    );
  }

  if (!provenance.gitRepoUrl || !provenance.gitPath) {
    return c.json(
      { error: "no_git_source", message: "Artifact was not imported from git" },
      400
    );
  }

  // Parse git URL
  const repoInfo = parseGitUrl(provenance.gitRepoUrl);
  if (!repoInfo || repoInfo.provider === "unknown") {
    return c.json(
      { error: "unsupported_provider", message: "Only GitHub, GitLab, and Bitbucket are supported" },
      400
    );
  }

  // Validate and build raw URL
  const branch = provenance.gitRef ?? "main";
  if (!isValidBranchName(branch)) {
    return c.json(
      { error: "bad_request", message: "Invalid branch name in provenance" },
      400
    );
  }
  const rawUrl = buildRawUrl(repoInfo, branch, provenance.gitPath);

  if (!rawUrl) {
    return c.json(
      { error: "bad_request", message: "Could not build raw URL for this repository" },
      400
    );
  }

  // Fetch content from git with size-limited streaming
  let content: string;
  try {
    const controller = new AbortController();
    const response = await fetch(rawUrl, {
      headers: {
        "User-Agent": "AgentFiles/1.0",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      if (response.status === 404) {
        return c.json(
          { error: "not_found", message: `File not found: ${provenance.gitPath} on branch ${branch}` },
          404
        );
      }
      return c.json(
        { error: "fetch_failed", message: `Failed to fetch file: ${response.statusText}` },
        502
      );
    }

    // Check Content-Length header first to reject obviously oversized responses
    const contentLength = response.headers.get("content-length");
    if (contentLength && parseInt(contentLength, 10) > MAX_CONTENT_SIZE) {
      controller.abort();
      return c.json(
        { error: "content_too_large", message: `Remote file exceeds maximum size of ${MAX_CONTENT_SIZE / 1024 / 1024}MB` },
        400
      );
    }

    // Stream with size limit to prevent unbounded memory usage
    const reader = response.body?.getReader();
    if (!reader) {
      return c.json({ error: "fetch_failed", message: "No response body" }, 502);
    }

    const chunks: Uint8Array[] = [];
    let totalSize = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalSize += value.byteLength;
      if (totalSize > MAX_CONTENT_SIZE) {
        controller.abort();
        return c.json(
          { error: "content_too_large", message: `Remote file exceeds maximum size of ${MAX_CONTENT_SIZE / 1024 / 1024}MB` },
          400
        );
      }
      chunks.push(value);
    }

    const combined = Buffer.concat(chunks);
    content = combined.toString("utf-8");
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return c.json({ error: "content_too_large", message: `Remote file exceeds maximum size of ${MAX_CONTENT_SIZE / 1024 / 1024}MB` }, 400);
    }
    return c.json(
      { error: "fetch_failed", message: `Failed to fetch file: ${error instanceof Error ? error.message : "unknown error"}` },
      502
    );
  }

  // Compute hash and validate size before acquiring lock
  const contentBuffer = Buffer.from(content, "utf-8");
  const contentHash = computeContentHash(contentBuffer);

  if (contentBuffer.length > MAX_CONTENT_SIZE) {
    return c.json(
      {
        error: "content_too_large",
        message: `Content exceeds maximum size of ${MAX_CONTENT_SIZE / 1024 / 1024}MB`,
      },
      400
    );
  }

  // Derive local git path — reuse from current version or derive fresh
  let localGitPath: string;
  if (currentVersion.git_path) {
    localGitPath = currentVersion.git_path;
  } else {
    const ext = getExtensionForContentType(artifact.content_type);
    const pathSegment = artifact.slug ?? id;
    if (artifact.slug) {
      const segmentError = validateArtifactPathSegment(artifact.slug);
      if (segmentError) {
        return c.json({ error: "invalid_slug", message: segmentError }, 400);
      }
    }
    localGitPath = `${pathSegment}/content.${ext}`;
  }

  // Build searchable text
  const searchableText = [artifact.title, artifact.description, content]
    .filter(Boolean)
    .join("\n");

  // Build new provenance
  const newProvenance: Provenance = {
    ...provenance,
    source: "git_sync",
  };

  // --- Critical section: hold namespace lock across content-change check + git commit + DB write ---
  const gitStore = c.get("gitStore");
  const release = await gitStore.acquireNamespaceLock(artifact.namespace_id);
  let result;
  try {
    // Re-read current version inside lock to avoid TOCTOU race
    const latestVersion = db.artifacts.getCurrentVersion(id);
    if (latestVersion && contentHash === latestVersion.content_hash) {
      return c.json({
        synced: false,
        message: "Content unchanged",
        current_version: latestVersion.version,
      });
    }

    const quota = await enforceStorageQuota(
      gitStore,
      artifact.namespace_id,
      contentBuffer.length,
      storageLimitBytes
    );
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
    const gitCommitSha = await gitStore.commitArtifact(
      artifact.namespace_id,
      localGitPath,
      contentBuffer,
      `Synced from git: ${provenance.gitPath}`,
      auth.principal.id
    );

    try {
      result = db.artifacts.update(id, {
        contentHash,
        contentSize: contentBuffer.length,
        storageKey: contentHash,
        searchableText,
        message: `Synced from git: ${provenance.gitPath}`,
        provenance: newProvenance,
        updatedBy: auth.principal.id,
        gitCommitSha,
        gitPath: localGitPath,
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
    blob.put(contentBuffer);
  } catch (error) {
    console.error("Blob fallback write failed after git sync:", error);
  }

  // Log audit event
  db.audit.create({
    principalId: auth.principal.id,
    principalType: auth.principal.type,
    credentialId: auth.credential.id,
    action: "artifact.update",
    resourceType: "artifact",
    resourceId: id,
    namespaceId: artifact.namespace_id,
    details: {
      source: "git_sync",
      new_version: result!.version.version,
    },
  });

  return c.json({
    synced: true,
    message: "Content updated from git",
    previous_version: artifact.current_version,
    new_version: result!.version.version,
    version: {
      id: result!.version.id,
      version: result!.version.version,
      content_hash: result!.version.content_hash,
      content_size: result!.version.content_size,
      created_at: result!.version.created_at,
    },
  });
});

/**
 * GET /v1/git/export/:id
 * Export an artifact in a git-friendly format with provenance metadata
 */
git.get("/export/:id", async (c) => {
  const auth = c.get("auth") as AuthContext | null;
  const db = c.get("db");
  const blob = c.get("blob");
  const id = c.req.param("id");
  if (!id) {
    return c.json({ error: "bad_request", message: "Artifact ID is required" }, 400);
  }
  const format = c.req.query("format") ?? "raw"; // raw, frontmatter, json
  const versionParam = c.req.query("version");

  const artifact = db.artifacts.getById(id);
  if (!artifact) {
    return c.json({ error: "not_found", message: "Artifact not found" }, 404);
  }

  // Get namespace for access check
  const namespace = db.namespaces.getById(artifact.namespace_id);
  if (!namespace) {
    return c.json({ error: "not_found", message: "Namespace not found" }, 404);
  }

  // Check read access (requires authentication for now)
  if (!auth) {
    return c.json({ error: "unauthorized", message: "Authentication required" }, 401);
  }

  const canRead =
    hasPermission(auth, "artifacts:read") &&
    hasNamespaceAccess(auth, namespace.id) &&
    (artifact.visibility === "public" ||
      namespace.owner_id === auth.principal.id ||
      auth.principal.namespace_id === namespace.id);

  if (!canRead) {
    return c.json({ error: "forbidden", message: "Access denied" }, 403);
  }

  // Get version
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

  // Get content — git-backed first, fallback to blob store
  const gitStore = c.get("gitStore");
  let content: Buffer | null = null;
  if (version.git_commit_sha && version.git_path) {
    content = await gitStore.readAtCommit(artifact.namespace_id, version.git_path, version.git_commit_sha);
  }
  if (!content) {
    content = blob.get(version.storage_key);
  }
  if (!content) {
    return c.json({ error: "not_found", message: "Content not found" }, 404);
  }

  let provenance: Provenance;
  try {
    provenance = JSON.parse(version.provenance);
  } catch {
    provenance = { source: "api" };
  }
  const contentStr = content.toString("utf-8");

  switch (format) {
    case "json": {
      // Return full metadata + content as JSON
      // Use version.git_commit_sha for the local commit SHA (not provenance.gitCommitSha which is the remote source)
      return c.json({
        id: artifact.id,
        slug: artifact.slug,
        title: artifact.title,
        description: artifact.description,
        content_type: artifact.content_type,
        version: version.version,
        content_hash: version.content_hash,
        content_size: version.content_size,
        git_commit_sha: version.git_commit_sha ?? null,
        git_path: version.git_path ?? null,
        provenance,
        content: contentStr,
        namespace_slug: namespace.slug,
        created_at: artifact.created_at,
        updated_at: artifact.updated_at,
      });
    }

    case "frontmatter": {
      // Add YAML front matter for markdown files
      // Local git commit SHA from version metadata; remote source from provenance
      const localGitCommit = version.git_commit_sha;
      const frontMatter = [
        "---",
        `title: "${artifact.title.replace(/[\r\n]/g, "").replace(/"/g, '\\"')}"`,
        artifact.description ? `description: "${artifact.description.replace(/[\r\n]/g, "").replace(/"/g, '\\"')}"` : null,
        `artifact_id: "${artifact.id}"`,
        `version: ${version.version}`,
        `content_hash: "${version.content_hash}"`,
        localGitCommit ? `local_git_commit: "${localGitCommit}"` : null,
        provenance.gitRepoUrl ? `git_repo: "${provenance.gitRepoUrl}"` : null,
        provenance.gitRef ? `git_branch: "${provenance.gitRef}"` : null,
        provenance.gitPath ? `git_path: "${provenance.gitPath}"` : null,
        provenance.gitCommitSha ? `git_commit: "${provenance.gitCommitSha}"` : null,
        `updated_at: "${artifact.updated_at}"`,
        "---",
        "",
      ]
        .filter(Boolean)
        .join("\n");

      return new Response(frontMatter + contentStr, {
        headers: {
          "Content-Type": artifact.content_type,
          "Content-Disposition": `attachment; filename="${artifact.slug ?? artifact.id}.${getExtensionForContentType(artifact.content_type)}"`,
          "X-Artifact-Version": version.version.toString(),
          "X-Content-Hash": version.content_hash,
          ...(version.git_commit_sha ? { "X-Local-Git-Commit": version.git_commit_sha } : {}),
        },
      });
    }

    case "raw":
    default: {
      // Return raw content with metadata in headers
      return new Response(content, {
        headers: {
          "Content-Type": artifact.content_type,
          "Content-Disposition": `attachment; filename="${artifact.slug ?? artifact.id}.${getExtensionForContentType(artifact.content_type)}"`,
          "Content-Length": content.length.toString(),
          "X-Artifact-ID": artifact.id,
          "X-Artifact-Title": encodeURIComponent(artifact.title.replace(/[\r\n]/g, "")),
          "X-Artifact-Version": version.version.toString(),
          "X-Content-Hash": version.content_hash,
          ...(version.git_commit_sha ? { "X-Local-Git-Commit": version.git_commit_sha } : {}),
          ...(provenance.gitRepoUrl ? { "X-Git-Repo": provenance.gitRepoUrl } : {}),
          ...(provenance.gitRef ? { "X-Git-Branch": provenance.gitRef } : {}),
          ...(provenance.gitPath ? { "X-Git-Path": provenance.gitPath } : {}),
          ...(provenance.gitCommitSha ? { "X-Git-Commit": provenance.gitCommitSha } : {}),
        },
      });
    }
  }
});


export { git };
