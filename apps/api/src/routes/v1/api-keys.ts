import { Hono } from "hono";
import { requireAuth, requirePermission, hasNamespaceAccess } from "../../middleware/auth.js";
import { safeJsonParse } from "../../utils/json.js";
import {
  normalizeRequestedScope,
  isRequestedScopeAllowed,
  type RequestedScope,
} from "../../utils/scope.js";

const apiKeys = new Hono();

// Require authentication for all /api-keys routes
apiKeys.use("*", requireAuth);
apiKeys.use("*", requirePermission("api_keys:write"));

/**
 * POST /v1/api-keys
 * Create a new API key for the current principal
 */
apiKeys.post("/", async (c) => {
  const auth = c.get("auth")!;
  const db = c.get("db");

  const body = await c.req.json<{
    name?: string;
    scope?: unknown;
    expires_at?: string;
  }>();

  const normalizedScopeResult = normalizeRequestedScope(body.scope);
  if (!normalizedScopeResult.ok) {
    return c.json(
      {
        error: "bad_request",
        message: normalizedScopeResult.message,
      },
      400
    );
  }
  const normalizedScope = normalizedScopeResult.scope;

  if (!isRequestedScopeAllowed(auth, normalizedScope)) {
    return c.json(
      {
        error: "forbidden",
        message: "Scoped API keys can only create keys with an equal or narrower scope",
      },
      403
    );
  }

  // If explicit namespace scope is requested, ensure those namespaces are valid
  // for the current principal (owned by user or principal-bound namespace).
  if (normalizedScope?.namespaces && normalizedScope.namespaces.length > 0) {
    const missingNamespaces: string[] = [];
    const unauthorizedNamespaces: string[] = [];

    for (const namespaceId of normalizedScope.namespaces) {
      const namespace = db.namespaces.getById(namespaceId);
      if (!namespace) {
        missingNamespaces.push(namespaceId);
        continue;
      }

      const ownsNamespace = namespace.owner_id === auth.principal.id;
      const isPrincipalBoundNamespace =
        !!auth.principal.namespace_id && auth.principal.namespace_id === namespace.id;

      if (
        !hasNamespaceAccess(auth, namespace.id) ||
        (!ownsNamespace && !isPrincipalBoundNamespace)
      ) {
        unauthorizedNamespaces.push(namespaceId);
      }
    }

    if (missingNamespaces.length > 0) {
      return c.json(
        {
          error: "not_found",
          message: `Namespace not found: ${missingNamespaces.join(", ")}`,
        },
        404
      );
    }

    if (unauthorizedNamespaces.length > 0) {
      return c.json(
        {
          error: "forbidden",
          message: `Cannot scope API key to namespaces you do not control: ${unauthorizedNamespaces.join(", ")}`,
        },
        403
      );
    }
  }

  // Create the API key
  const result = db.apiKeys.create({
    principalId: auth.principal.id,
    principalType: auth.principal.type,
    name: body.name,
    scope: normalizedScope,
    expiresAt: body.expires_at,
  });

  // Log audit event
  db.audit.create({
    principalId: auth.principal.id,
    principalType: auth.principal.type,
    credentialId: auth.credential.id,
    action: "api_key.create",
    resourceType: "api_key",
    resourceId: result.row.id,
  });

  return c.json(
    {
      id: result.row.id,
      key: result.plaintext, // Only returned at creation time!
      name: result.row.name,
      key_prefix: result.row.key_prefix,
      scope: safeJsonParse<RequestedScope | null>(result.row.scope, null),
      expires_at: result.row.expires_at,
      created_at: result.row.created_at,
    },
    201
  );
});

/**
 * GET /v1/api-keys
 * List API keys for the current principal
 */
apiKeys.get("/", async (c) => {
  const auth = c.get("auth")!;
  const db = c.get("db");

  const keys = db.apiKeys.getByPrincipal(auth.principal.id);

  return c.json({
    api_keys: keys.map((key) => ({
      id: key.id,
      name: key.name,
      key_prefix: key.key_prefix,
      scope: safeJsonParse<RequestedScope | null>(key.scope, null),
      expires_at: key.expires_at,
      last_used_at: key.last_used_at,
      created_at: key.created_at,
    })),
  });
});

/**
 * POST /v1/api-keys/:id/revoke
 * Revoke an API key
 */
apiKeys.post("/:id/revoke", async (c) => {
  const auth = c.get("auth")!;
  const db = c.get("db");
  const id = c.req.param("id");

  // Get the key to verify ownership
  const key = db.apiKeys.getById(id);
  if (!key) {
    return c.json({ error: "not_found", message: "API key not found" }, 404);
  }

  // Verify ownership
  if (key.principal_id !== auth.principal.id) {
    return c.json({ error: "forbidden", message: "Not your API key" }, 403);
  }

  // Check if already revoked
  if (key.revoked_at) {
    return c.json({ error: "already_revoked", message: "API key already revoked" }, 400);
  }

  // Revoke the key
  db.apiKeys.revoke(id);

  // Log audit event
  db.audit.create({
    principalId: auth.principal.id,
    principalType: auth.principal.type,
    credentialId: auth.credential.id,
    action: "api_key.revoke",
    resourceType: "api_key",
    resourceId: id,
  });

  return c.json({ message: "API key revoked" });
});

export { apiKeys };
