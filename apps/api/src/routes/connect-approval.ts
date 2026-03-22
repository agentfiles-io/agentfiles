import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { randomBytes } from "node:crypto";
import type { Context } from "hono";
import { ConnectSessionRepository } from "@attach/db";
import { computeApprovedScope, type RequestedScope } from "../utils/scope.js";
import { safeJsonParse } from "../utils/json.js";
import { getPublicOrigin } from "../utils/url.js";
import { buildDefaultNamespaceSlug } from "./auth.js";
import type { ConnectClientKind, RuntimeKind } from "@attach/shared";

const connectApproval = new Hono();

function generateCsrfToken(): string {
  return randomBytes(32).toString("hex");
}

function getServerOrigin(c: Context): string {
  try {
    return getPublicOrigin(c.req.url);
  } catch {
    return "";
  }
}

function verifyCsrf(c: Context, formToken: string | undefined): boolean {
  // Verify Origin header
  const origin = c.req.header("Origin");
  const referer = c.req.header("Referer");
  const serverOrigin = getServerOrigin(c);
  if (!serverOrigin) {
    return false;
  }

  if (origin) {
    if (origin !== serverOrigin) return false;
  } else if (referer) {
    try {
      const refererOrigin = new URL(referer).origin;
      if (refererOrigin !== serverOrigin) return false;
    } catch {
      return false;
    }
  }
  // If neither Origin nor Referer is present, allow (some browsers don't send for same-origin)

  // Verify CSRF token from cookie matches form field
  const cookieToken = getCookie(c, "csrf_token");
  if (!cookieToken || !formToken) return false;
  return cookieToken === formToken;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

/**
 * GET /connect/:id
 * Browser approval page (requires session auth)
 */
connectApproval.get("/:id", async (c) => {
  const auth = c.get("auth");
  const db = c.get("db");
  const sessionId = c.req.param("id");

  // Redirect to login if not authenticated
  if (!auth || auth.credential.type !== "session") {
    const returnTo = `/connect/${sessionId}`;
    return c.redirect(`/auth/login?return_to=${encodeURIComponent(returnTo)}`);
  }

  const session = db.connectSessions.getValidById(sessionId);
  if (!session) {
    return c.html(renderErrorPage("Connect session not found or expired."), 404);
  }

  if (session.status !== "pending") {
    return c.html(
      renderErrorPage(`This connect session is already ${session.status}.`),
      400
    );
  }

  // Determine namespace options
  const userNamespaces = db.namespaces.getByOwner(auth.principal.id);

  // Generate CSRF token
  const csrfToken = generateCsrfToken();
  setCookie(c, "csrf_token", csrfToken, {
    httpOnly: true,
    secure: process.env["NODE_ENV"] === "production",
    sameSite: "Strict",
    maxAge: 600, // 10 minutes
    path: `/connect/${sessionId}`,
  });

  // Parse requested scope
  const requestedScope = session.requested_scope_json
    ? safeJsonParse<RequestedScope | null>(session.requested_scope_json, null) ?? undefined
    : undefined;

  // Determine which permissions will be granted
  const previewScope = computeApprovedScope(
    session.client_kind as ConnectClientKind,
    requestedScope,
    "preview"
  );

  db.audit.create({
    principalId: auth.principal.id,
    principalType: auth.principal.type,
    credentialId: auth.credential.id,
    action: "connect_session.view",
    resourceType: "connect_session",
    resourceId: session.id,
  });

  return c.html(
    renderApprovalPage({
      session,
      csrfToken,
      permissions: previewScope.permissions ?? [],
      namespaces: userNamespaces,
      requestedNamespaceId: session.requested_namespace_id,
    })
  );
});

/**
 * POST /connect/:id/approve
 * Approve a connect session (session auth + CSRF required)
 */
connectApproval.post("/:id/approve", async (c) => {
  const auth = c.get("auth");
  const db = c.get("db");
  const sessionId = c.req.param("id");

  if (!auth || auth.credential.type !== "session") {
    return c.html(renderErrorPage("Authentication required."), 401);
  }

  const formData = await c.req.parseBody();
  const csrfToken = typeof formData["csrf_token"] === "string" ? formData["csrf_token"] : undefined;

  if (!verifyCsrf(c, csrfToken)) {
    return c.html(renderErrorPage("CSRF validation failed. Please try again."), 403);
  }

  const session = db.connectSessions.getValidById(sessionId);
  if (!session) {
    return c.html(renderErrorPage("Connect session not found or expired."), 404);
  }

  if (session.status !== "pending") {
    return c.html(
      renderErrorPage(`This connect session is already ${session.status}.`),
      400
    );
  }

  // Resolve namespace
  const selectedNamespaceId = typeof formData["namespace_id"] === "string"
    ? formData["namespace_id"]
    : undefined;

  const userNamespaces = db.namespaces.getByOwner(auth.principal.id);
  let namespaceId: string;

  if (selectedNamespaceId) {
    // Verify user owns this namespace
    const ns = userNamespaces.find((n) => n.id === selectedNamespaceId);
    if (!ns) {
      return c.html(renderErrorPage("Invalid namespace selection."), 400);
    }
    namespaceId = ns.id;
  } else if (session.requested_namespace_id) {
    // Check if user owns the requested namespace
    const ns = userNamespaces.find((n) => n.id === session.requested_namespace_id);
    if (ns) {
      namespaceId = ns.id;
    } else if (userNamespaces.length === 1) {
      namespaceId = userNamespaces[0]!.id;
    } else if (userNamespaces.length === 0) {
      // Auto-create default namespace for first-time users
      const slug = buildDefaultNamespaceSlug(
        undefined,
        auth.principal.id,
        (candidate) => db.namespaces.slugExists(candidate)
      );
      const ns2 = db.namespaces.create({
        slug,
        name: "Default",
        ownerId: auth.principal.id,
        visibility: "private",
      });
      namespaceId = ns2.id;
    } else {
      return c.html(renderErrorPage("Please select a namespace."), 400);
    }
  } else if (userNamespaces.length === 1) {
    namespaceId = userNamespaces[0]!.id;
  } else if (userNamespaces.length === 0) {
    // Auto-create default namespace
    const slug = buildDefaultNamespaceSlug(
      undefined,
      auth.principal.id,
      (candidate) => db.namespaces.slugExists(candidate)
    );
    const ns = db.namespaces.create({
      slug,
      name: "Default",
      ownerId: auth.principal.id,
      visibility: "private",
    });
    namespaceId = ns.id;
  } else {
    return c.html(renderErrorPage("Please select a namespace."), 400);
  }

  // Compute approved scope
  const requestedScope = session.requested_scope_json
    ? safeJsonParse<RequestedScope | null>(session.requested_scope_json, null) ?? undefined
    : undefined;

  const approvedScope = computeApprovedScope(
    session.client_kind as ConnectClientKind,
    requestedScope,
    namespaceId
  );

  // Generate one-time auth code before transaction so we can return it for loopback.
  const oneTimeAuthCode = session.completion_mode === "loopback"
    ? randomBytes(32).toString("hex")
    : undefined;
  const oneTimeAuthCodeHash = oneTimeAuthCode
    ? ConnectSessionRepository.hashAuthCode(oneTimeAuthCode)
    : undefined;
  const oneTimeAuthCodeExpiresAt = oneTimeAuthCode
    ? new Date(Date.now() + 60 * 1000).toISOString()
    : undefined;

  // Create principal, approve session, and create runtime instance atomically.
  let principal;
  let runtimeInstance = null;
  try {
    const result = db.connectSessions.withTransaction(() => {
      const createdPrincipal = db.principals.create({
        type: "agent",
        name: session.display_name,
        namespaceId,
      });

      const approved = db.connectSessions.approve(session.id, {
        approvedBy: auth.principal.id,
        selectedNamespaceId: namespaceId,
        approvedScopeJson: JSON.stringify(approvedScope),
        provisionedPrincipalId: createdPrincipal.id,
        oneTimeAuthCodeHash,
        oneTimeAuthCodeExpiresAt,
      });

      if (!approved) {
        throw new Error("approve_conflict");
      }

      return {
        principal: createdPrincipal,
        runtimeInstance:
          session.client_kind === "setup"
            ? null
            : db.runtimeInstances.create({
                principalId: createdPrincipal.id,
                ownerPrincipalId: auth.principal.id,
                namespaceId,
                displayName: session.display_name,
                runtimeKind: session.client_kind as RuntimeKind,
                connectSessionId: session.id,
              }),
      };
    });

    principal = result.principal;
    runtimeInstance = result.runtimeInstance;
  } catch (error) {
    if (error instanceof Error && error.message === "approve_conflict") {
      return c.html(renderErrorPage("Could not approve session. It may have expired."), 400);
    }
    console.error("Unexpected connect approval error:", error);
    return c.html(renderErrorPage("Could not approve session. It may have expired."), 400);
  }

  db.audit.create({
    principalId: auth.principal.id,
    principalType: auth.principal.type,
    credentialId: auth.credential.id,
    action: "principal.create",
    resourceType: "principal",
    resourceId: principal.id,
    namespaceId,
    details: { via: "connect_session", connect_session_id: session.id },
  });

  db.audit.create({
    principalId: auth.principal.id,
    principalType: auth.principal.type,
    credentialId: auth.credential.id,
    action: "connect_session.approve",
    resourceType: "connect_session",
    resourceId: session.id,
    namespaceId,
  });

  if (runtimeInstance) {
    db.audit.create({
      principalId: auth.principal.id,
      principalType: auth.principal.type,
      credentialId: auth.credential.id,
      action: "runtime_instance.create",
      resourceType: "runtime_instance",
      resourceId: runtimeInstance.id,
      namespaceId,
      details: {
        via: "connect_session",
        connect_session_id: session.id,
        runtime_kind: session.client_kind,
      },
    });
  }

  // Redirect based on completion mode
  if (session.completion_mode === "loopback" && session.loopback_redirect_uri) {
    const redirectUrl = new URL(session.loopback_redirect_uri);
    redirectUrl.searchParams.set("connection_id", session.id);
    redirectUrl.searchParams.set("code", oneTimeAuthCode!);
    return c.redirect(redirectUrl.toString());
  }

  // Poll mode: render success page
  return c.html(renderSuccessPage("Approved! You can return to your runtime."));
});

/**
 * POST /connect/:id/deny
 * Deny a connect session (session auth + CSRF required)
 */
connectApproval.post("/:id/deny", async (c) => {
  const auth = c.get("auth");
  const db = c.get("db");
  const sessionId = c.req.param("id");

  if (!auth || auth.credential.type !== "session") {
    return c.html(renderErrorPage("Authentication required."), 401);
  }

  const formData = await c.req.parseBody();
  const csrfToken = typeof formData["csrf_token"] === "string" ? formData["csrf_token"] : undefined;

  if (!verifyCsrf(c, csrfToken)) {
    return c.html(renderErrorPage("CSRF validation failed. Please try again."), 403);
  }

  const session = db.connectSessions.getValidById(sessionId);
  if (!session) {
    return c.html(renderErrorPage("Connect session not found or expired."), 404);
  }

  if (session.status !== "pending") {
    return c.html(
      renderErrorPage(`This connect session is already ${session.status}.`),
      400
    );
  }

  db.connectSessions.cancel(session.id);

  db.audit.create({
    principalId: auth.principal.id,
    principalType: auth.principal.type,
    credentialId: auth.credential.id,
    action: "connect_session.deny",
    resourceType: "connect_session",
    resourceId: session.id,
  });

  return c.html(renderDeniedPage());
});

// --- HTML templates ---

function renderPage(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)} - AgentFiles</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f5f5f5; color: #333; display: flex; justify-content: center; align-items: center; min-height: 100vh; padding: 1rem; }
    .card { background: white; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); padding: 2rem; max-width: 480px; width: 100%; }
    h1 { font-size: 1.25rem; margin-bottom: 1rem; }
    .info { margin-bottom: 1.5rem; }
    .info dt { font-weight: 600; margin-top: 0.75rem; font-size: 0.875rem; color: #666; }
    .info dd { margin-top: 0.25rem; }
    .perms { list-style: none; padding: 0; }
    .perms li { padding: 0.25rem 0; font-family: monospace; font-size: 0.875rem; }
    .perms li::before { content: "\\2713 "; color: #22c55e; }
    .actions { display: flex; gap: 0.75rem; margin-top: 1.5rem; }
    .btn { padding: 0.625rem 1.25rem; border-radius: 8px; border: none; font-size: 0.875rem; cursor: pointer; font-weight: 500; }
    .btn-approve { background: #22c55e; color: white; flex: 1; }
    .btn-approve:hover { background: #16a34a; }
    .btn-deny { background: #ef4444; color: white; }
    .btn-deny:hover { background: #dc2626; }
    select { width: 100%; padding: 0.5rem; border: 1px solid #d1d5db; border-radius: 6px; font-size: 0.875rem; margin-top: 0.25rem; }
    .message { text-align: center; padding: 2rem 0; }
    .message h1 { font-size: 1.5rem; }
    .message p { margin-top: 0.5rem; color: #666; }
  </style>
</head>
<body>
  <div class="card">${body}</div>
</body>
</html>`;
}

function renderApprovalPage(opts: {
  session: { id: string; display_name: string; client_kind: string; expires_at: string };
  csrfToken: string;
  permissions: string[];
  namespaces: { id: string; slug: string; name: string }[];
  requestedNamespaceId: string | null;
}): string {
  const { session, csrfToken, permissions, namespaces, requestedNamespaceId } = opts;

  let namespaceHtml: string;
  if (namespaces.length <= 1) {
    const ns = namespaces[0];
    namespaceHtml = ns
      ? `<dd>${escapeHtml(ns.slug)}<input type="hidden" name="namespace_id" value="${escapeHtml(ns.id)}"></dd>`
      : `<dd><em>A default namespace will be created</em></dd>`;
  } else {
    const options = namespaces
      .map((ns) => {
        const selected =
          ns.id === requestedNamespaceId ? " selected" : "";
        return `<option value="${escapeHtml(ns.id)}"${selected}>${escapeHtml(ns.slug)}</option>`;
      })
      .join("");
    namespaceHtml = `<dd><select name="namespace_id">${options}</select></dd>`;
  }

  const permsList = permissions
    .map((p) => `<li>${escapeHtml(p)}</li>`)
    .join("");

  const expiresIn = Math.max(
    0,
    Math.round((new Date(session.expires_at).getTime() - Date.now()) / 60000)
  );

  const body = `
    <h1>Authorize Connection</h1>
    <dl class="info">
      <dt>Agent</dt>
      <dd>${escapeHtml(session.display_name)}</dd>
      <dt>Type</dt>
      <dd>${escapeHtml(session.client_kind)}</dd>
      <dt>Permissions</dt>
      <dd><ul class="perms">${permsList}</ul></dd>
      <dt>Namespace</dt>
      ${namespaceHtml}
    </dl>
    <p style="font-size: 0.75rem; color: #999;">Expires in ${expiresIn} minutes</p>
    <div class="actions">
      <form method="POST" action="/connect/${escapeHtml(session.id)}/approve" style="flex:1;display:flex;">
        <input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}">
        <button type="submit" class="btn btn-approve" style="flex:1;">Approve</button>
      </form>
      <form method="POST" action="/connect/${escapeHtml(session.id)}/deny">
        <input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}">
        <button type="submit" class="btn btn-deny">Deny</button>
      </form>
    </div>`;

  return renderPage("Authorize Connection", body);
}

function renderSuccessPage(message: string): string {
  return renderPage(
    "Approved",
    `<div class="message"><h1>Approved</h1><p>${escapeHtml(message)}</p></div>`
  );
}

function renderDeniedPage(): string {
  return renderPage(
    "Denied",
    `<div class="message"><h1>Connection Denied</h1><p>The connection request was denied.</p></div>`
  );
}

function renderErrorPage(message: string): string {
  return renderPage(
    "Error",
    `<div class="message"><h1>Error</h1><p>${escapeHtml(message)}</p></div>`
  );
}

export { connectApproval };
