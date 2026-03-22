import { Hono } from "hono";
import type { NamespaceRow } from "@attach/db";
import {
  requireAuth,
  requirePermission,
  hasNamespaceAccess,
} from "../../middleware/auth.js";
import { safeJsonParse } from "../../utils/json.js";

const namespaces = new Hono();

// Require authentication for all routes
namespaces.use("*", requireAuth);

/**
 * POST /v1/namespaces
 * Create a new namespace
 */
namespaces.post("/", requirePermission("namespaces:write"), async (c) => {
  const auth = c.get("auth")!;
  const db = c.get("db");

  // Only users can create namespaces
  if (auth.principal.type !== "user") {
    return c.json(
      { error: "forbidden", message: "Only users can create namespaces" },
      403
    );
  }

  // Namespace-scoped API keys cannot create new namespaces outside their bound set.
  if (
    auth.credential.type === "api_key" &&
    auth.credential.scope?.namespaces &&
    auth.credential.scope.namespaces.length > 0
  ) {
    return c.json(
      {
        error: "forbidden",
        message: "Namespace-scoped API keys cannot create namespaces",
      },
      403
    );
  }

  const body = await c.req.json<{
    slug: string;
    name: string;
    description?: string;
    visibility?: "private" | "public";
  }>();

  // Validate slug format
  if (!/^[a-z0-9-]+$/.test(body.slug)) {
    return c.json(
      {
        error: "invalid_slug",
        message: "Slug must be lowercase alphanumeric with hyphens only",
      },
      400
    );
  }

  // Check if slug exists
  if (db.namespaces.slugExists(body.slug)) {
    return c.json(
      { error: "slug_taken", message: "This slug is already in use" },
      409
    );
  }

  // Create namespace (private by default per security guidelines)
  const namespace = db.namespaces.create({
    slug: body.slug,
    name: body.name,
    description: body.description,
    ownerId: auth.principal.id,
    visibility: body.visibility ?? "private",
  });

  // Log audit event
  db.audit.create({
    principalId: auth.principal.id,
    principalType: auth.principal.type,
    credentialId: auth.credential.id,
    action: "namespace.create",
    resourceType: "namespace",
    resourceId: namespace.id,
    namespaceId: namespace.id,
  });

  return c.json(
    {
      id: namespace.id,
      slug: namespace.slug,
      name: namespace.name,
      description: namespace.description,
      visibility: namespace.visibility,
      settings: safeJsonParse<Record<string, unknown> | null>(namespace.settings, null),
      created_at: namespace.created_at,
    },
    201
  );
});

/**
 * GET /v1/namespaces
 * List namespaces the current principal can access
 */
namespaces.get("/", requirePermission("namespaces:read"), async (c) => {
  const auth = c.get("auth")!;
  const db = c.get("db");

  let nsList: NamespaceRow[] = [];

  if (auth.principal.type === "user") {
    // Users see namespaces they own
    nsList = db.namespaces
      .getByOwner(auth.principal.id)
      .filter((ns) => hasNamespaceAccess(auth, ns.id));
  } else if (auth.principal.namespace_id) {
    // Service/agent/gateway principals see their bound namespace
    const ns = db.namespaces.getById(auth.principal.namespace_id);
    nsList = ns && hasNamespaceAccess(auth, ns.id) ? [ns] : [];
  } else {
    nsList = [];
  }

  return c.json({
    namespaces: nsList.map((ns) => ({
      id: ns.id,
      slug: ns.slug,
      name: ns.name,
      description: ns.description,
      visibility: ns.visibility,
      created_at: ns.created_at,
    })),
  });
});

/**
 * GET /v1/namespaces/:slug
 * Get a namespace by slug
 */
namespaces.get("/:slug", requirePermission("namespaces:read"), async (c) => {
  const auth = c.get("auth")!;
  const db = c.get("db");
  const slug = c.req.param("slug");
  if (!slug) {
    return c.json({ error: "bad_request", message: "Namespace slug is required" }, 400);
  }

  const namespace = db.namespaces.getBySlug(slug);
  if (!namespace) {
    return c.json({ error: "not_found", message: "Namespace not found" }, 404);
  }

  // Check access
  const canAccess =
    hasNamespaceAccess(auth, namespace.id) &&
    (namespace.visibility === "public" ||
      namespace.owner_id === auth.principal.id ||
      auth.principal.namespace_id === namespace.id);

  if (!canAccess) {
    return c.json({ error: "forbidden", message: "Access denied" }, 403);
  }

  return c.json({
    id: namespace.id,
    slug: namespace.slug,
    name: namespace.name,
    description: namespace.description,
    visibility: namespace.visibility,
    settings: safeJsonParse<Record<string, unknown> | null>(namespace.settings, null),
    git_mirror: safeJsonParse<Record<string, unknown> | null>(namespace.git_mirror, null),
    created_at: namespace.created_at,
    updated_at: namespace.updated_at,
  });
});

/**
 * PATCH /v1/namespaces/:slug
 * Update a namespace
 */
namespaces.patch("/:slug", requirePermission("namespaces:write"), async (c) => {
  const auth = c.get("auth")!;
  const db = c.get("db");
  const slug = c.req.param("slug");
  if (!slug) {
    return c.json({ error: "bad_request", message: "Namespace slug is required" }, 400);
  }

  const namespace = db.namespaces.getBySlug(slug);
  if (!namespace) {
    return c.json({ error: "not_found", message: "Namespace not found" }, 404);
  }

  if (!hasNamespaceAccess(auth, namespace.id)) {
    return c.json({ error: "forbidden", message: "Namespace not in API key scope" }, 403);
  }

  // Only owner can update
  if (namespace.owner_id !== auth.principal.id) {
    return c.json({ error: "forbidden", message: "Only the owner can update" }, 403);
  }

  const body = await c.req.json<{
    name?: string;
    description?: string;
    visibility?: "private" | "public";
    settings?: Record<string, unknown>;
  }>();

  const updated = db.namespaces.update(namespace.id, {
    name: body.name,
    description: body.description,
    visibility: body.visibility,
    settings: body.settings,
  });

  // Log audit event
  db.audit.create({
    principalId: auth.principal.id,
    principalType: auth.principal.type,
    credentialId: auth.credential.id,
    action: "namespace.update",
    resourceType: "namespace",
    resourceId: namespace.id,
    namespaceId: namespace.id,
  });

  return c.json({
    id: updated!.id,
    slug: updated!.slug,
    name: updated!.name,
    description: updated!.description,
    visibility: updated!.visibility,
    settings: safeJsonParse<Record<string, unknown> | null>(updated!.settings, null),
    updated_at: updated!.updated_at,
  });
});

/**
 * GET /v1/namespaces/:slug/search
 * Full-text search artifacts in a namespace
 */
namespaces.get("/:slug/search", requirePermission("artifacts:read"), async (c) => {
  const auth = c.get("auth")!;
  const db = c.get("db");
  const slug = c.req.param("slug");
  if (!slug) {
    return c.json({ error: "bad_request", message: "Namespace slug is required" }, 400);
  }

  const query = c.req.query("q")?.trim() ?? "";
  if (!query) {
    return c.json({ error: "bad_request", message: "q query parameter is required" }, 400);
  }

  const namespace = db.namespaces.getBySlug(slug);
  if (!namespace) {
    return c.json({ error: "not_found", message: "Namespace not found" }, 404);
  }

  // Check access
  const canAccess =
    hasNamespaceAccess(auth, namespace.id) &&
    (namespace.visibility === "public" ||
      namespace.owner_id === auth.principal.id ||
      auth.principal.namespace_id === namespace.id);

  if (!canAccess) {
    return c.json({ error: "forbidden", message: "Access denied" }, 403);
  }

  const limitRaw = parseInt(c.req.query("limit") ?? "20", 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 20;

  let results;
  try {
    results = db.artifacts.search({
      namespaceId: namespace.id,
      query,
      limit,
    });
  } catch {
    return c.json({ error: "bad_request", message: "Invalid search query" }, 400);
  }

  return c.json({
    artifacts: results.map((a) => ({
      id: a.id,
      namespace_id: a.namespace_id,
      slug: a.slug,
      title: a.title,
      description: a.description,
      content_type: a.content_type,
      current_version: a.current_version,
      visibility: a.visibility,
      created_at: a.created_at,
      updated_at: a.updated_at,
      archived_at: a.archived_at,
      score: a.score,
    })),
  });
});

/**
 * GET /v1/namespaces/:slug/artifacts
 * List artifacts in a namespace
 */
namespaces.get("/:slug/artifacts", requirePermission("artifacts:read"), async (c) => {
  const auth = c.get("auth")!;
  const db = c.get("db");
  const slug = c.req.param("slug");
  if (!slug) {
    return c.json({ error: "bad_request", message: "Namespace slug is required" }, 400);
  }

  const namespace = db.namespaces.getBySlug(slug);
  if (!namespace) {
    return c.json({ error: "not_found", message: "Namespace not found" }, 404);
  }

  // Check access
  const canAccess =
    hasNamespaceAccess(auth, namespace.id) &&
    (namespace.visibility === "public" ||
      namespace.owner_id === auth.principal.id ||
      auth.principal.namespace_id === namespace.id);

  if (!canAccess) {
    return c.json({ error: "forbidden", message: "Access denied" }, 403);
  }

  const limit = parseInt(c.req.query("limit") ?? "50", 10);
  const offset = parseInt(c.req.query("offset") ?? "0", 10);
  const contentType = c.req.query("content_type");

  const artifacts = db.artifacts.listWithInstanceContext(namespace.id);

  // Apply filters that listWithInstanceContext doesn't support
  let filtered = artifacts;
  if (contentType) {
    filtered = filtered.filter((a) => a.content_type === contentType);
  }
  filtered = filtered.slice(offset, offset + Math.min(limit, 100));

  return c.json({
    artifacts: filtered.map((a) => ({
      id: a.id,
      slug: a.slug,
      title: a.title,
      description: a.description,
      content_type: a.content_type,
      current_version: a.current_version,
      visibility: a.visibility,
      created_at: a.created_at,
      updated_at: a.updated_at,
      created_by: {
        instance_name: a.created_by_instance_name,
        runtime_kind: a.created_by_runtime_kind,
      },
      last_updated_by: {
        instance_name: a.last_updated_by_instance_name,
        runtime_kind: a.last_updated_by_runtime_kind,
      },
      is_handoff: a.distinct_creator_count > 1,
    })),
  });
});

export { namespaces };
