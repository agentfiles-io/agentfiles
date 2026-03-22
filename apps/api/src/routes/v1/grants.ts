import { Hono } from "hono";
import {
  requireAuth,
  requirePermission,
  hasNamespaceAccess,
} from "../../middleware/auth.js";
import { safeJsonParse } from "../../utils/json.js";

const grants = new Hono();

// Require authentication for all routes
grants.use("*", requireAuth);

/**
 * POST /v1/grants
 * Create a new grant (share link)
 */
grants.post("/", requirePermission("grants:write"), async (c) => {
  const auth = c.get("auth")!;
  const db = c.get("db");

  const body = await c.req.json<{
    namespace_id: string;
    artifact_id?: string;
    grantee_type: "token" | "public";
    permissions?: string[];
    expires_at?: string;
  }>();

  // Validate namespace access
  const namespace = db.namespaces.getById(body.namespace_id);
  if (!namespace) {
    return c.json({ error: "not_found", message: "Namespace not found" }, 404);
  }

  if (!hasNamespaceAccess(auth, namespace.id)) {
    return c.json({ error: "forbidden", message: "Namespace not in API key scope" }, 403);
  }

  // Only owner can create grants
  if (namespace.owner_id !== auth.principal.id) {
    return c.json(
      { error: "forbidden", message: "Only namespace owner can create grants" },
      403
    );
  }

  // If artifact_id provided, validate it belongs to namespace
  if (body.artifact_id) {
    const artifact = db.artifacts.getById(body.artifact_id);
    if (!artifact || artifact.namespace_id !== namespace.id) {
      return c.json({ error: "not_found", message: "Artifact not found" }, 404);
    }
  }

  // Validate grantee_type (only token and public for now)
  if (!["token", "public"].includes(body.grantee_type)) {
    return c.json(
      { error: "invalid_grantee_type", message: "Grantee type must be 'token' or 'public'" },
      400
    );
  }

  // Validate permissions against allowed set
  const ALLOWED_PERMISSIONS = ["read"];
  const permissions = body.permissions ?? ["read"];
  const invalidPerms = permissions.filter((p) => !ALLOWED_PERMISSIONS.includes(p));
  if (invalidPerms.length > 0) {
    return c.json(
      {
        error: "invalid_permissions",
        message: `Invalid permissions: ${invalidPerms.join(", ")}. Allowed: ${ALLOWED_PERMISSIONS.join(", ")}`,
      },
      400
    );
  }

  // Create grant
  const result = db.grants.create({
    namespaceId: body.namespace_id,
    artifactId: body.artifact_id,
    granteeType: body.grantee_type,
    permissions,
    expiresAt: body.expires_at,
    createdBy: auth.principal.id,
  });

  // Log audit event
  db.audit.create({
    principalId: auth.principal.id,
    principalType: auth.principal.type,
    credentialId: auth.credential.id,
    action: "grant.create",
    resourceType: "grant",
    resourceId: result.row.id,
    namespaceId: body.namespace_id,
    details: {
      artifact_id: body.artifact_id,
      grantee_type: body.grantee_type,
      permissions,
    },
  });

  return c.json(
    {
      id: result.row.id,
      namespace_id: result.row.namespace_id,
      artifact_id: result.row.artifact_id,
      grantee_type: result.row.grantee_type,
      token: result.token, // Only returned at creation time!
      token_prefix: result.row.token_prefix,
      permissions: safeJsonParse<string[]>(result.row.permissions, []),
      expires_at: result.row.expires_at,
      created_at: result.row.created_at,
    },
    201
  );
});

/**
 * GET /v1/grants
 * List grants for a namespace
 */
grants.get("/", requirePermission("grants:read"), async (c) => {
  const auth = c.get("auth")!;
  const db = c.get("db");
  const namespaceId = c.req.query("namespace_id");

  if (!namespaceId) {
    return c.json(
      { error: "missing_parameter", message: "namespace_id is required" },
      400
    );
  }

  // Validate namespace access
  const namespace = db.namespaces.getById(namespaceId);
  if (!namespace) {
    return c.json({ error: "not_found", message: "Namespace not found" }, 404);
  }

  if (!hasNamespaceAccess(auth, namespace.id)) {
    return c.json({ error: "forbidden", message: "Namespace not in API key scope" }, 403);
  }

  // Only owner can list grants
  if (namespace.owner_id !== auth.principal.id) {
    return c.json(
      { error: "forbidden", message: "Only namespace owner can list grants" },
      403
    );
  }

  const grantsList = db.grants.getByNamespace(namespaceId);

  return c.json({
    grants: grantsList.map((g) => ({
      id: g.id,
      namespace_id: g.namespace_id,
      artifact_id: g.artifact_id,
      grantee_type: g.grantee_type,
      token_prefix: g.token_prefix, // Never expose full token or hash
      permissions: safeJsonParse<string[]>(g.permissions, []),
      expires_at: g.expires_at,
      created_at: g.created_at,
      revoked_at: g.revoked_at,
    })),
  });
});

/**
 * POST /v1/grants/:id/revoke
 * Revoke a grant
 */
grants.post("/:id/revoke", requirePermission("grants:write"), async (c) => {
  const auth = c.get("auth")!;
  const db = c.get("db");
  const id = c.req.param("id");
  if (!id) {
    return c.json({ error: "bad_request", message: "Grant ID is required" }, 400);
  }

  const grant = db.grants.getById(id);
  if (!grant) {
    return c.json({ error: "not_found", message: "Grant not found" }, 404);
  }

  // Validate namespace ownership
  const namespace = db.namespaces.getById(grant.namespace_id);
  if (!namespace || namespace.owner_id !== auth.principal.id) {
    return c.json(
      { error: "forbidden", message: "Only namespace owner can revoke grants" },
      403
    );
  }

  if (!hasNamespaceAccess(auth, namespace.id)) {
    return c.json({ error: "forbidden", message: "Namespace not in API key scope" }, 403);
  }

  // Check if already revoked
  if (grant.revoked_at) {
    return c.json(
      { error: "already_revoked", message: "Grant already revoked" },
      400
    );
  }

  // Revoke
  db.grants.revoke(id);

  // Log audit event
  db.audit.create({
    principalId: auth.principal.id,
    principalType: auth.principal.type,
    credentialId: auth.credential.id,
    action: "grant.revoke",
    resourceType: "grant",
    resourceId: id,
    namespaceId: grant.namespace_id,
  });

  return c.json({ message: "Grant revoked" });
});

export { grants };
