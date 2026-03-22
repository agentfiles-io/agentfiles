import { Hono } from "hono";
import { requireAuth, requirePermission, hasNamespaceAccess } from "../../middleware/auth.js";
import type { NamespaceRow } from "@attach/db";
import type { AuthContext } from "../../middleware/auth.js";

const lineage = new Hono();

lineage.use("*", requireAuth);
lineage.use("*", requirePermission("artifacts:read"));

function canReadNamespace(
  auth: AuthContext,
  namespace: Pick<NamespaceRow, "id" | "owner_id" | "visibility">
): boolean {
  return (
    hasNamespaceAccess(auth, namespace.id) &&
    (namespace.visibility === "public" ||
      namespace.owner_id === auth.principal.id ||
      auth.principal.namespace_id === namespace.id)
  );
}

/**
 * GET /v1/lineage
 * Cross-instance artifact activity for owned namespaces.
 * Shows: instance -> artifacts produced, instance -> artifacts updated,
 * artifacts touched by multiple distinct creators (= handoffs), grouped by namespace.
 */
lineage.get("/", async (c) => {
  const auth = c.get("auth")!;
  const db = c.get("db");

  // Get accessible namespaces for any principal type:
  // 1. User principals: namespaces they own
  // 2. Agent/service principals with namespace binding: their bound namespace
  // 3. Scoped API keys: namespaces listed in scope
  const namespaces: Array<{ id: string; slug: string; name: string }> = [];
  const seenIds = new Set<string>();

  const addNamespaceIfReadable = (namespace: NamespaceRow | null) => {
    if (!namespace) {
      return;
    }
    if (seenIds.has(namespace.id)) {
      return;
    }
    if (!canReadNamespace(auth, namespace)) {
      return;
    }
    namespaces.push({
      id: namespace.id,
      slug: namespace.slug,
      name: namespace.name,
    });
    seenIds.add(namespace.id);
  };

  // Owner-based access
  if (auth.principal.type === "user") {
    for (const ns of db.namespaces.getByOwner(auth.principal.id)) {
      addNamespaceIfReadable(ns);
    }
  }

  // Namespace-bound principals (agents, services)
  if (auth.principal.namespace_id) {
    addNamespaceIfReadable(db.namespaces.getById(auth.principal.namespace_id));
  }

  // Scoped API key namespace access
  if (auth.credential.scope?.namespaces) {
    for (const nsId of auth.credential.scope.namespaces) {
      addNamespaceIfReadable(db.namespaces.getById(nsId));
    }
  }

  const result = namespaces.map((ns) => {
    const artifacts = db.artifacts.listWithInstanceContext(ns.id);

    // Handoff = artifact touched by >1 distinct creator (user or agent)
    const handoffs = artifacts.filter((a) => a.distinct_creator_count > 1);

    return {
      namespace: { id: ns.id, slug: ns.slug, name: ns.name },
      artifact_count: artifacts.length,
      handoff_count: handoffs.length,
      artifacts: artifacts.map((a) => ({
        id: a.id,
        title: a.title,
        slug: a.slug,
        content_type: a.content_type,
        current_version: a.current_version,
        created_by_instance: a.created_by_instance_name
          ? { name: a.created_by_instance_name, runtime_kind: a.created_by_runtime_kind }
          : null,
        last_updated_by_instance: a.last_updated_by_instance_name
          ? { name: a.last_updated_by_instance_name, runtime_kind: a.last_updated_by_runtime_kind }
          : null,
        distinct_creator_count: a.distinct_creator_count,
        is_handoff: a.distinct_creator_count > 1,
        updated_at: a.updated_at,
      })),
    };
  });

  return c.json({ namespaces: result });
});

/**
 * GET /v1/artifacts/:id/lineage
 * Lineage for a single artifact: all versions with producing instances
 * and inferred handoff edges where the creator changes between versions.
 */
lineage.get("/artifacts/:id", async (c) => {
  const auth = c.get("auth")!;
  const db = c.get("db");
  const artifactId = c.req.param("id");

  const artifact = db.artifacts.getById(artifactId);
  if (!artifact) {
    return c.json({ error: "not_found", message: "Artifact not found" }, 404);
  }

  const namespace = db.namespaces.getById(artifact.namespace_id);
  if (!namespace) {
    return c.json({ error: "not_found", message: "Namespace not found" }, 404);
  }

  if (!canReadNamespace(auth, namespace)) {
    return c.json({ error: "forbidden", message: "Access denied" }, 403);
  }

  const versions = db.artifacts.getVersionsWithCreators(artifactId);

  // Detect inferred handoff edges: where creator changes between consecutive versions
  const handoffs: Array<{
    from_version: number;
    to_version: number;
    from_creator: string | null;
    from_creator_type: string | null;
    to_creator: string | null;
    to_creator_type: string | null;
  }> = [];

  for (let i = 1; i < versions.length; i++) {
    const prev = versions[i - 1]!;
    const curr = versions[i]!;
    if (prev.created_by !== curr.created_by) {
      handoffs.push({
        from_version: prev.version,
        to_version: curr.version,
        from_creator: prev.creator_name ?? prev.creator_principal_name,
        from_creator_type: prev.creator_principal_type,
        to_creator: curr.creator_name ?? curr.creator_principal_name,
        to_creator_type: curr.creator_principal_type,
      });
    }
  }

  return c.json({
    artifact: {
      id: artifact.id,
      title: artifact.title,
      slug: artifact.slug,
      content_type: artifact.content_type,
      namespace_id: artifact.namespace_id,
      current_version: artifact.current_version,
    },
    versions: versions.map((v) => ({
      id: v.id,
      version: v.version,
      content_hash: v.content_hash,
      content_size: v.content_size,
      message: v.message,
      created_at: v.created_at,
      created_by: v.created_by,
      creator_principal_type: v.creator_principal_type,
      creator_principal_name: v.creator_principal_name,
      creator_instance: v.creator_instance_id
        ? {
            id: v.creator_instance_id,
            name: v.creator_name,
            runtime_kind: v.creator_runtime_kind,
          }
        : null,
    })),
    handoffs,
    distinct_creator_count: new Set(versions.map((v) => v.created_by)).size,
  });
});

export { lineage };
