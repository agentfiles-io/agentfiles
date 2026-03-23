import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { cors } from "hono/cors";

import {
  initDb,
  migrate,
  setHmacSecret,
  setGrantHmacSecret,
  FileBlobStore,
  IsomorphicGitArtifactStore,
  PrincipalRepository,
  IdentityRepository,
  ApiKeyRepository,
  SessionRepository,
  NamespaceRepository,
  ArtifactRepository,
  AuditRepository,
  GrantRepository,
  ConnectSessionRepository,
  RuntimeInstanceRepository,
} from "@attach/db";
import type { GitArtifactStore } from "@attach/db";

import { authMiddleware, shareTokenMiddleware } from "./middleware/auth.js";
import { parseNamespaceStorageLimitBytes } from "./middleware/quota.js";
import { auth } from "./routes/auth.js";
import { me } from "./routes/v1/me.js";
import { apiKeys } from "./routes/v1/api-keys.js";
import { principals } from "./routes/v1/principals.js";
import { namespaces } from "./routes/v1/namespaces.js";
import { artifacts } from "./routes/v1/artifacts.js";
import { grants } from "./routes/v1/grants.js";
import { git } from "./routes/v1/git.js";
import { connect } from "./routes/v1/connect.js";
import { instances } from "./routes/v1/instances.js";
import { lineage } from "./routes/v1/lineage.js";
import { stats } from "./routes/v1/stats.js";
import { connectApproval } from "./routes/connect-approval.js";

// Initialize database
const dbPath = process.env["DATABASE_PATH"] ?? "./data/attach.db";
const db = initDb({ path: dbPath });

// Run migrations
migrate(db);

// Initialize HMAC secret for API key and grant hashing
const hmacSecret = process.env["SESSION_SECRET"];
if (!hmacSecret) {
  throw new Error("SESSION_SECRET must be set to a secret value of at least 32 bytes");
}
setHmacSecret(hmacSecret);
setGrantHmacSecret(hmacSecret);

// Initialize blob storage (legacy fallback) and git artifact store
const blobPath = process.env["BLOB_STORAGE_PATH"] ?? "./data/blobs";
const blobStore = new FileBlobStore(blobPath);
const gitStore = new IsomorphicGitArtifactStore(blobPath);
const namespaceStorageLimitBytes = parseNamespaceStorageLimitBytes(
  process.env["NAMESPACE_STORAGE_LIMIT_BYTES"]
);

// Initialize repositories
const repositories = {
  principals: new PrincipalRepository(db),
  identities: new IdentityRepository(db),
  apiKeys: new ApiKeyRepository(db),
  sessions: new SessionRepository(db),
  namespaces: new NamespaceRepository(db),
  artifacts: new ArtifactRepository(db),
  audit: new AuditRepository(db),
  grants: new GrantRepository(db),
  connectSessions: new ConnectSessionRepository(db),
  runtimeInstances: new RuntimeInstanceRepository(db),
};

import type { AuthContext, ShareTokenContext } from "./middleware/auth.js";

// Extend Hono context types
declare module "hono" {
  interface ContextVariableMap {
    db: typeof repositories;
    blob: typeof blobStore;
    gitStore: GitArtifactStore;
    storageLimitBytes: number;
    auth: AuthContext | null;
    shareToken: ShareTokenContext | null;
  }
}

const app = new Hono();

function redactSensitiveQueryParams(value: string): string {
  return value.replace(
    /([?&](?:token|code|state|id_token|access_token|refresh_token)=)[^&\s]+/gi,
    "$1[REDACTED]"
  );
}

function getAllowedCorsOrigins(): string[] {
  const rawOrigins =
    process.env["CORS_ORIGINS"] ??
    process.env["FRONTEND_ORIGIN"] ??
    (process.env["NODE_ENV"] === "development"
      ? "http://localhost:3000,http://127.0.0.1:3000"
      : "");

  return rawOrigins
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
}

const allowedCorsOrigins = new Set(getAllowedCorsOrigins());

function resolveCorsOrigin(origin: string): string | null {
  if (!origin) {
    return null;
  }
  return allowedCorsOrigins.has(origin) ? origin : null;
}

// Middleware
app.use("*", logger((line) => console.log(redactSensitiveQueryParams(line))));
app.use("*", cors({
  origin: resolveCorsOrigin,
  credentials: true,
  allowHeaders: ["Content-Type", "Authorization", "X-Share-Token"],
  allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  maxAge: 86400,
}));

// Inject database, blob store, and git store into context
app.use("*", async (c, next) => {
  c.set("db", repositories);
  c.set("blob", blobStore);
  c.set("gitStore", gitStore);
  c.set("storageLimitBytes", namespaceStorageLimitBytes);
  await next();
});

// Auth middleware (populates c.get("auth"))
app.use("*", authMiddleware);

// Share token middleware (populates c.get("shareToken"))
app.use("*", shareTokenMiddleware);

// Health check
app.get("/health", (c) => {
  return c.json({
    status: "ok",
    timestamp: new Date().toISOString(),
  });
});

// API version info
app.get("/", (c) => {
  return c.json({
    name: "AgentFiles API",
    version: "0.1.0",
    docs: "/docs",
  });
});

// Auth routes
app.route("/auth", auth);

// Browser connect approval routes (HTML)
app.route("/connect", connectApproval);

// API v1 routes
const v1 = new Hono();
v1.route("/me", me);
v1.route("/api-keys", apiKeys);
v1.route("/principals", principals);
v1.route("/namespaces", namespaces);
v1.route("/artifacts", artifacts);
v1.route("/grants", grants);
v1.route("/git", git);
v1.route("/connect", connect);
v1.route("/instances", instances);
v1.route("/lineage", lineage);
v1.route("/stats", stats);

app.route("/v1", v1);

// Start server
const port = parseInt(process.env["PORT"] ?? "2009", 10);

console.log(`Starting AgentFiles API on port ${port}...`);
console.log(`Database: ${dbPath}`);
console.log(`Blob storage: ${blobPath}`);

serve({
  fetch: app.fetch,
  port,
});

console.log(`AgentFiles API listening on http://localhost:${port}`);

export default app;
