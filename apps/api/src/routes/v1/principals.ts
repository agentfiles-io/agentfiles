import { Hono } from "hono";
import {
  requireAuth,
  requirePrincipalType,
  requirePermission,
  hasNamespaceAccess,
} from "../../middleware/auth.js";
import { safeJsonParse } from "../../utils/json.js";

const principals = new Hono();

// Require authentication for all routes
principals.use("*", requireAuth);
principals.use("*", requirePermission("principals:write"));

/**
 * POST /v1/principals
 * Create a service/agent/gateway principal.
 * Only users and gateways can create other principals.
 */
principals.post("/", requirePrincipalType("user", "gateway"), async (c) => {
  const auth = c.get("auth")!;
  const db = c.get("db");

  const body = await c.req.json<{
    type: "service" | "agent" | "gateway";
    name: string;
    namespace_id?: string;
    metadata?: Record<string, unknown>;
  }>();

  // Validate type
  if (!["service", "agent", "gateway"].includes(body.type)) {
    return c.json(
      { error: "invalid_type", message: "Type must be service, agent, or gateway" },
      400
    );
  }

  // Users can only create service/agent principals
  if (auth.principal.type === "user" && body.type === "gateway") {
    return c.json(
      { error: "forbidden", message: "Users cannot create gateway principals" },
      403
    );
  }

  // If namespace_id is provided, verify ownership
  if (body.namespace_id) {
    const namespace = db.namespaces.getById(body.namespace_id);
    if (!namespace) {
      return c.json({ error: "not_found", message: "Namespace not found" }, 404);
    }

    // User must own the namespace
    if (namespace.owner_id !== auth.principal.id) {
      return c.json(
        { error: "forbidden", message: "You don't own this namespace" },
        403
      );
    }

    if (!hasNamespaceAccess(auth, namespace.id)) {
      return c.json({ error: "forbidden", message: "Namespace not in API key scope" }, 403);
    }
  }

  // Create the principal
  const principal = db.principals.create({
    type: body.type,
    name: body.name,
    namespaceId: body.namespace_id,
    metadata: body.metadata,
  });

  // Log audit event
  db.audit.create({
    principalId: auth.principal.id,
    principalType: auth.principal.type,
    credentialId: auth.credential.id,
    action: "principal.create",
    resourceType: "principal",
    resourceId: principal.id,
    namespaceId: body.namespace_id,
    details: {
      created_principal_type: body.type,
      created_principal_name: body.name,
    },
  });

  return c.json(
    {
      id: principal.id,
      type: principal.type,
      name: principal.name,
      namespace_id: principal.namespace_id,
      metadata: safeJsonParse<Record<string, unknown> | null>(principal.metadata, null),
      created_at: principal.created_at,
    },
    201
  );
});

export { principals };
