import { Hono } from "hono";
import { requireAuth } from "../../middleware/auth.js";

const stats = new Hono();

stats.use("*", requireAuth);

function isAdmin(principalId: string): boolean {
  const ids = process.env["ADMIN_PRINCIPAL_IDS"] ?? "";
  if (!ids) return false;
  return ids.split(",").map((s) => s.trim()).includes(principalId);
}

/**
 * GET /v1/stats
 * Returns stats scoped to the authenticated principal (for dashboard).
 */
stats.get("/", async (c) => {
  const auth = c.get("auth")!;
  const db = c.get("db");

  const namespaces = db.namespaces.getByOwner(auth.principal.id);
  const namespaceIds = namespaces.map((ns) => ns.id);

  const artifacts = db.artifacts.countByNamespaces(namespaceIds);
  const apiKeys = db.apiKeys.countByPrincipal(auth.principal.id);
  const instances = db.runtimeInstances.countByOwner(auth.principal.id);

  return c.json({
    artifacts,
    api_keys: apiKeys,
    instances,
    namespaces: namespaces.length,
  });
});

/**
 * GET /v1/stats/admin
 * Returns global platform stats. Requires principal ID in ADMIN_PRINCIPAL_IDS.
 */
stats.get("/admin", async (c) => {
  const auth = c.get("auth")!;

  if (auth.principal.type !== "user" || !isAdmin(auth.principal.id)) {
    return c.json({ error: "forbidden", message: "Not authorized for admin stats" }, 403);
  }

  const db = c.get("db");

  const users = db.principals.countByType("user");
  const agents = db.principals.countByType("agent");
  const artifacts = db.artifacts.countAll();
  const versions = db.artifacts.countVersionsAll();
  const namespaces = db.namespaces.countAll();
  const apiKeys = db.apiKeys.countAll();
  const instances = db.runtimeInstances.countAll();

  return c.json({
    users,
    agents,
    artifacts,
    versions,
    namespaces,
    api_keys: apiKeys,
    instances,
  });
});

export { stats };
