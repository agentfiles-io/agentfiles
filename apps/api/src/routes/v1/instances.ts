import { Hono } from "hono";
import {
  requireAuth,
  requirePermission,
  hasNamespaceAccess,
  hasPermission,
} from "../../middleware/auth.js";

const instances = new Hono();

instances.use("*", requireAuth);
instances.use("*", requirePermission("namespaces:read"));

/**
 * GET /v1/instances
 * List runtime instances for the current owner
 */
instances.get("/", async (c) => {
  const auth = c.get("auth")!;
  const db = c.get("db");

  // For user principals: list instances they own
  // For agent principals: only their own instance
  let instanceRows;
  if (auth.principal.type === "user") {
    instanceRows = db.runtimeInstances.listByOwner(auth.principal.id);
  } else {
    const own = db.runtimeInstances.getByPrincipalId(auth.principal.id);
    instanceRows = own ? [own] : [];
  }

  // Filter by namespace access
  const filtered = instanceRows.filter((inst) =>
    hasNamespaceAccess(auth, inst.namespace_id)
  );

  const instances = filtered.map((inst) => ({
    id: inst.id,
    display_name: inst.display_name,
    runtime_kind: inst.runtime_kind,
    namespace_id: inst.namespace_id,
    status: inst.status,
    connected_at: inst.connected_at,
    last_seen_at: inst.last_seen_at,
    last_activity_at: inst.last_activity_at,
    created_at: inst.created_at,
  }));

  return c.json({ instances });
});

/**
 * GET /v1/instances/:id
 * Instance detail + artifacts created/updated by this instance
 */
instances.get("/:id", async (c) => {
  const auth = c.get("auth")!;
  const db = c.get("db");
  const instanceId = c.req.param("id");

  const instance = db.runtimeInstances.getById(instanceId);
  if (!instance) {
    return c.json({ error: "not_found", message: "Instance not found" }, 404);
  }

  // Check access
  if (!hasNamespaceAccess(auth, instance.namespace_id)) {
    return c.json({ error: "forbidden", message: "Access denied" }, 403);
  }

  // User principals can read instances they own.
  if (auth.principal.type === "user" && instance.owner_principal_id !== auth.principal.id) {
    return c.json({ error: "forbidden", message: "Access denied" }, 403);
  }

  // Non-user principals can only read their own runtime instance.
  if (auth.principal.type !== "user" && instance.principal_id !== auth.principal.id) {
    return c.json({ error: "forbidden", message: "Access denied" }, 403);
  }

  // Artifact summaries require artifact read permission.
  if (!hasPermission(auth, "artifacts:read")) {
    return c.json(
      {
        error: "forbidden",
        message: "This action requires the 'artifacts:read' permission",
      },
      403
    );
  }

  // Get artifacts created by this instance's principal
  const createdArtifacts = db.artifacts.listByCreator(instance.principal_id);

  // Get artifacts updated by this instance's principal
  const updatedArtifacts = db.artifacts.listUpdatedByCreator(instance.principal_id);

  return c.json({
    instance: {
      id: instance.id,
      display_name: instance.display_name,
      runtime_kind: instance.runtime_kind,
      principal_id: instance.principal_id,
      namespace_id: instance.namespace_id,
      status: instance.status,
      connected_at: instance.connected_at,
      last_seen_at: instance.last_seen_at,
      last_activity_at: instance.last_activity_at,
      created_at: instance.created_at,
    },
    artifacts_created: createdArtifacts.map((a) => ({
      id: a.id,
      title: a.title,
      slug: a.slug,
      content_type: a.content_type,
      current_version: a.current_version,
      created_at: a.created_at,
      updated_at: a.updated_at,
    })),
    artifacts_updated: updatedArtifacts.map((a) => ({
      id: a.id,
      title: a.title,
      slug: a.slug,
      content_type: a.content_type,
      current_version: a.current_version,
      created_at: a.created_at,
      updated_at: a.updated_at,
    })),
  });
});

export { instances };
