import { Hono } from "hono";
import {
  requireAuth,
  requirePermission,
  hasNamespaceAccess,
} from "../../middleware/auth.js";
import { safeJsonParse } from "../../utils/json.js";

const me = new Hono();

// Require authentication for all /me routes
me.use("*", requireAuth);
me.use("*", requirePermission("namespaces:read"));

/**
 * GET /v1/me
 * Get current principal info
 */
me.get("/", async (c) => {
  const auth = c.get("auth")!;
  const db = c.get("db");

  // Get namespaces owned by this principal
  const namespaces = db.namespaces
    .getByOwner(auth.principal.id)
    .filter((namespace) => hasNamespaceAccess(auth, namespace.id));

  // Parse metadata
  const metadata = safeJsonParse<Record<string, unknown> | null>(
    auth.principal.metadata,
    null
  );

  // If caller is an agent principal, include runtime instance info and update last_seen
  let runtimeInstance = null;
  if (auth.principal.type === "agent") {
    const instance = db.runtimeInstances.getByPrincipalId(auth.principal.id);
    if (instance) {
      db.runtimeInstances.updateLastSeen(instance.id);
      runtimeInstance = {
        id: instance.id,
        display_name: instance.display_name,
        runtime_kind: instance.runtime_kind,
        status: instance.status,
        namespace_id: instance.namespace_id,
        connected_at: instance.connected_at,
        last_seen_at: instance.last_seen_at,
      };
    }
  }

  return c.json({
    principal: {
      id: auth.principal.id,
      type: auth.principal.type,
      name: auth.principal.name,
      metadata,
      created_at: auth.principal.created_at,
    },
    namespaces: namespaces.map((ns) => ({
      id: ns.id,
      slug: ns.slug,
      name: ns.name,
      visibility: ns.visibility,
    })),
    credential: {
      type: auth.credential.type,
      id: auth.credential.id,
    },
    ...(runtimeInstance ? { runtime_instance: runtimeInstance } : {}),
  });
});

export { me };
