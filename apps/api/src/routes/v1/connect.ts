import { Hono } from "hono";
import { createHash } from "node:crypto";
import type { ConnectClientKind, ConnectCompletionMode } from "@attach/shared";
import { ConnectSessionRepository } from "@attach/db";
import { normalizeRequestedScope, type RequestedScope } from "../../utils/scope.js";
import { safeJsonParse } from "../../utils/json.js";
import { getPublicBaseUrl } from "../../utils/url.js";

const connect = new Hono();

// In-memory rate limiting (sufficient for single-node v1)
const rateLimits = new Map<string, { count: number; windowStart: number }>();
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_GLOBAL_MAX = 100;
const RATE_LIMIT_WINDOW_MS = 3_600_000; // 1 hour
const RATE_LIMIT_MAX_KEYS = 5_000;
let globalRateLimit = { count: 0, windowStart: 0 };

const VALID_CLIENT_KINDS = new Set<string>([
  "openclaw",
  "claude_code",
  "codex",
  "mcp",
  "generic",
  "setup",
]);
const VALID_COMPLETION_MODES = new Set<string>(["loopback", "poll"]);

function normalizeClientKey(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 64) {
    return null;
  }

  if (!/^[a-zA-Z0-9:.[\]-]+$/.test(trimmed)) {
    return null;
  }

  return trimmed;
}

function getClientIp(c: { req: { header: (name: string) => string | undefined } }): string {
  const trustProxyHeaders = process.env["TRUST_PROXY_HEADERS"] === "true";
  if (trustProxyHeaders) {
    const forwarded = normalizeClientKey(
      c.req.header("X-Forwarded-For")?.split(",")[0]
    );
    if (forwarded) {
      return forwarded;
    }

    const realIp = normalizeClientKey(c.req.header("X-Real-IP"));
    if (realIp) {
      return realIp;
    }
  }

  // Fallback key keeps non-proxied environments from collapsing into one shared bucket.
  const userAgent = c.req.header("User-Agent") ?? "unknown";
  const acceptLanguage = c.req.header("Accept-Language") ?? "";
  const fingerprint = createHash("sha256")
    .update(`${userAgent}|${acceptLanguage}`)
    .digest("hex")
    .slice(0, 24);
  return `anon_${fingerprint}`;
}

function checkRateLimit(ip: string): { allowed: boolean; retryAfter?: number } {
  const now = Date.now();

  // Evict stale entries to keep memory bounded.
  for (const [key, value] of rateLimits.entries()) {
    if (now - value.windowStart > RATE_LIMIT_WINDOW_MS) {
      rateLimits.delete(key);
    }
  }

  if (now - globalRateLimit.windowStart > RATE_LIMIT_WINDOW_MS) {
    globalRateLimit = { count: 0, windowStart: now };
  }
  if (globalRateLimit.count >= RATE_LIMIT_GLOBAL_MAX) {
    const retryAfter = Math.ceil(
      (globalRateLimit.windowStart + RATE_LIMIT_WINDOW_MS - now) / 1000
    );
    return { allowed: false, retryAfter };
  }

  const entry = rateLimits.get(ip);

  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    if (!entry && rateLimits.size >= RATE_LIMIT_MAX_KEYS) {
      const oldestKey = rateLimits.keys().next().value;
      if (oldestKey) {
        rateLimits.delete(oldestKey);
      }
    }
    rateLimits.set(ip, { count: 1, windowStart: now });
    globalRateLimit.count += 1;
    return { allowed: true };
  }

  if (entry.count >= RATE_LIMIT_MAX) {
    const retryAfter = Math.ceil(
      (entry.windowStart + RATE_LIMIT_WINDOW_MS - now) / 1000
    );
    return { allowed: false, retryAfter };
  }

  entry.count += 1;
  globalRateLimit.count += 1;
  return { allowed: true };
}

function validateLoopbackUri(uri: string): boolean {
  try {
    const parsed = new URL(uri);
    if (parsed.protocol !== "http:") return false;
    const host = parsed.hostname;
    if (host !== "localhost" && host !== "127.0.0.1" && host !== "[::1]" && host !== "::1") {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * POST /v1/connect/sessions
 * Start a new connect session (no auth required, rate limited)
 */
connect.post("/sessions", async (c) => {
  const clientIp = getClientIp(c);
  const rateCheck = checkRateLimit(clientIp);
  if (!rateCheck.allowed) {
    c.header("Retry-After", String(rateCheck.retryAfter));
    return c.json(
      { error: "rate_limited", message: "Too many connect session requests" },
      429
    );
  }

  const db = c.get("db");
  db.connectSessions.expireActive();
  db.connectSessions.cleanupExpired();

  const body = await c.req.json<{
    client_kind?: string;
    completion_mode?: string;
    display_name?: string;
    code_challenge?: string;
    requested_scope?: unknown;
    requested_namespace_id?: string;
    loopback_redirect_uri?: string;
    metadata?: unknown;
  }>();

  // Validate required fields
  if (!body.client_kind || !VALID_CLIENT_KINDS.has(body.client_kind)) {
    return c.json(
      {
        error: "bad_request",
        message: `client_kind must be one of: ${[...VALID_CLIENT_KINDS].join(", ")}`,
      },
      400
    );
  }

  if (!body.completion_mode || !VALID_COMPLETION_MODES.has(body.completion_mode)) {
    return c.json(
      {
        error: "bad_request",
        message: `completion_mode must be one of: ${[...VALID_COMPLETION_MODES].join(", ")}`,
      },
      400
    );
  }

  if (!body.display_name || typeof body.display_name !== "string" || body.display_name.trim().length === 0) {
    return c.json(
      { error: "bad_request", message: "display_name is required" },
      400
    );
  }

  if (!body.code_challenge || typeof body.code_challenge !== "string" || body.code_challenge.length < 43) {
    return c.json(
      { error: "bad_request", message: "code_challenge is required (S256, min 43 chars)" },
      400
    );
  }

  // Validate and normalize requested_scope if provided
  let normalizedScope: RequestedScope | undefined;
  if (body.requested_scope !== undefined) {
    const scopeResult = normalizeRequestedScope(body.requested_scope);
    if (!scopeResult.ok) {
      return c.json(
        { error: "bad_request", message: scopeResult.message },
        400
      );
    }
    normalizedScope = scopeResult.scope;
  }

  // Validate loopback URI for loopback mode
  if (body.completion_mode === "loopback") {
    if (!body.loopback_redirect_uri) {
      return c.json(
        { error: "bad_request", message: "loopback_redirect_uri is required for loopback mode" },
        400
      );
    }
    if (!validateLoopbackUri(body.loopback_redirect_uri)) {
      return c.json(
        { error: "bad_request", message: "loopback_redirect_uri must be http://localhost, http://127.0.0.1, or http://[::1]" },
        400
      );
    }
  }

  const session = db.connectSessions.create({
    clientKind: body.client_kind as ConnectClientKind,
    completionMode: body.completion_mode as ConnectCompletionMode,
    displayName: body.display_name.trim(),
    codeChallenge: body.code_challenge,
    requestedScopeJson: normalizedScope
      ? JSON.stringify(normalizedScope)
      : undefined,
    requestedNamespaceId: body.requested_namespace_id,
    loopbackRedirectUri: body.loopback_redirect_uri,
    clientIp: clientIp,
    userAgent: c.req.header("User-Agent"),
    metadataJson: body.metadata ? JSON.stringify(body.metadata) : undefined,
  });

  // Build approval URL
  let baseUrl: string;
  try {
    baseUrl = getPublicBaseUrl(c.req.url);
  } catch {
    return c.json(
      { error: "server_error", message: "Server base URL is not configured correctly" },
      500
    );
  }
  const approvalUrl = `${baseUrl}/connect/${session.id}`;

  db.audit.create({
    principalId: "system",
    principalType: "system",
    action: "connect_session.create",
    resourceType: "connect_session",
    resourceId: session.id,
    clientIp: clientIp,
    userAgent: c.req.header("User-Agent"),
    details: {
      client_kind: body.client_kind,
      completion_mode: body.completion_mode,
    },
  });

  return c.json(
    {
      id: session.id,
      approval_url: approvalUrl,
      expires_at: session.expires_at,
    },
    201
  );
});

/**
 * GET /v1/connect/sessions/:id
 * Poll session status (no auth required)
 */
connect.get("/sessions/:id", async (c) => {
  const db = c.get("db");
  db.connectSessions.expireActive();
  db.connectSessions.cleanupExpired();
  const session = db.connectSessions.getValidById(c.req.param("id"));

  if (!session) {
    return c.json({ error: "not_found", message: "Connect session not found" }, 404);
  }

  // Return safe fields only
  return c.json({
    id: session.id,
    status: session.status,
    client_kind: session.client_kind,
    completion_mode: session.completion_mode,
    display_name: session.display_name,
    expires_at: session.expires_at,
    created_at: session.created_at,
  });
});

/**
 * POST /v1/connect/sessions/:id/redeem
 * Redeem an approved session for credentials (no auth, PKCE-bound)
 */
connect.post("/sessions/:id/redeem", async (c) => {
  const db = c.get("db");
  db.connectSessions.expireActive();
  db.connectSessions.cleanupExpired();
  const session = db.connectSessions.getValidById(c.req.param("id"));

  if (!session) {
    return c.json({ error: "not_found", message: "Connect session not found" }, 404);
  }

  if (session.status === "redeemed") {
    return c.json({ error: "gone", message: "Session already redeemed" }, 410);
  }

  if (session.status === "expired") {
    return c.json({ error: "gone", message: "Session expired" }, 410);
  }

  if (session.status !== "approved") {
    return c.json(
      { error: "bad_request", message: `Session is ${session.status}, not approved` },
      400
    );
  }

  const body = await c.req.json<{
    code_verifier?: string;
    one_time_auth_code?: string;
  }>();

  if (!body.code_verifier || typeof body.code_verifier !== "string") {
    return c.json(
      { error: "bad_request", message: "code_verifier is required" },
      400
    );
  }

  // Verify PKCE
  if (!ConnectSessionRepository.verifyCodeVerifier(session, body.code_verifier)) {
    return c.json(
      { error: "forbidden", message: "Invalid code_verifier" },
      403
    );
  }

  // For loopback mode, also verify one-time auth code
  if (session.completion_mode === "loopback") {
    if (!body.one_time_auth_code || typeof body.one_time_auth_code !== "string") {
      return c.json(
        { error: "bad_request", message: "one_time_auth_code is required for loopback mode" },
        400
      );
    }
    if (!ConnectSessionRepository.verifyAuthCode(session, body.one_time_auth_code)) {
      return c.json(
        { error: "forbidden", message: "Invalid one_time_auth_code" },
        403
      );
    }
  }

  // Verify provisioned data before issuing credentials.
  if (!session.provisioned_principal_id || !session.approved_scope_json) {
    return c.json(
      { error: "server_error", message: "Session is missing provisioned data" },
      500
    );
  }

  const scope = safeJsonParse<RequestedScope>(session.approved_scope_json, {
    permissions: ["artifacts:read"],
  });

  // Create credentials and transition the session in one transaction.
  let apiKeyResult: ReturnType<typeof db.apiKeys.create>;
  try {
    apiKeyResult = db.connectSessions.withTransaction(() => {
      const createdKey = db.apiKeys.create({
        principalId: session.provisioned_principal_id!,
        principalType: "agent",
        name: `${session.display_name} (connect)`,
        scope,
      });

      const redeemed = db.connectSessions.redeem(session.id);
      if (!redeemed) {
        throw new Error("redeem_conflict");
      }

      return createdKey;
    });
  } catch (error) {
    if (error instanceof Error && error.message === "redeem_conflict") {
      return c.json({ error: "gone", message: "Session already redeemed or expired" }, 410);
    }
    return c.json(
      { error: "server_error", message: "Failed to issue credentials" },
      500
    );
  }

  // Look up namespace for response
  const namespace = session.selected_namespace_id
    ? db.namespaces.getById(session.selected_namespace_id)
    : null;

  // Audit
  db.audit.create({
    principalId: session.provisioned_principal_id,
    principalType: "agent",
    action: "connect_session.redeem",
    resourceType: "connect_session",
    resourceId: session.id,
    details: { api_key_id: apiKeyResult.row.id },
  });

  db.audit.create({
    principalId: session.provisioned_principal_id,
    principalType: "agent",
    action: "api_key.create",
    resourceType: "api_key",
    resourceId: apiKeyResult.row.id,
    details: { via: "connect_session", connect_session_id: session.id },
  });

  let apiBaseUrl: string;
  try {
    apiBaseUrl = getPublicBaseUrl(c.req.url);
  } catch {
    return c.json(
      { error: "server_error", message: "Server base URL is not configured correctly" },
      500
    );
  }

  return c.json({
    api_base_url: apiBaseUrl,
    api_key: apiKeyResult.plaintext,
    principal: {
      id: session.provisioned_principal_id,
      type: "agent",
    },
    namespace: namespace
      ? { id: namespace.id, slug: namespace.slug }
      : null,
    scope,
    suggested_env: {
      ATTACH_API_URL: apiBaseUrl,
      ATTACH_API_KEY: apiKeyResult.plaintext,
    },
  });
});

/**
 * POST /v1/connect/sessions/:id/cancel
 * Cancel a session (PKCE proof for pending, session auth for approved)
 */
connect.post("/sessions/:id/cancel", async (c) => {
  const db = c.get("db");
  db.connectSessions.expireActive();
  db.connectSessions.cleanupExpired();
  const session = db.connectSessions.getValidById(c.req.param("id"));

  if (!session) {
    return c.json({ error: "not_found", message: "Connect session not found" }, 404);
  }

  if (session.status !== "pending" && session.status !== "approved") {
    return c.json(
      { error: "bad_request", message: `Cannot cancel session in ${session.status} state` },
      400
    );
  }

  if (session.status === "pending") {
    // Requires PKCE proof (the session starter)
    const body = await c.req.json<{ code_verifier?: string }>();
    if (!body.code_verifier || typeof body.code_verifier !== "string") {
      return c.json(
        { error: "bad_request", message: "code_verifier is required to cancel pending sessions" },
        400
      );
    }
    if (!ConnectSessionRepository.verifyCodeVerifier(session, body.code_verifier)) {
      return c.json(
        { error: "forbidden", message: "Invalid code_verifier" },
        403
      );
    }
  } else {
    // Approved: requires the approving user's session
    const auth = c.get("auth");
    if (!auth || auth.credential.type !== "session") {
      return c.json(
        { error: "unauthorized", message: "Session auth required to cancel approved sessions" },
        401
      );
    }
    if (auth.principal.id !== session.approved_by) {
      return c.json(
        { error: "forbidden", message: "Only the approving user can cancel" },
        403
      );
    }
  }

  const cancelled = db.connectSessions.cancel(session.id);
  if (!cancelled) {
    return c.json({ error: "bad_request", message: "Could not cancel session" }, 400);
  }

  db.audit.create({
    principalId: session.status === "approved" ? session.approved_by! : "system",
    principalType: session.status === "approved" ? "user" : "system",
    action: "connect_session.cancel",
    resourceType: "connect_session",
    resourceId: session.id,
  });

  return c.json({ message: "Session cancelled" });
});

export { connect };
