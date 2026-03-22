import { Hono } from "hono";
import { setCookie, deleteCookie, getCookie } from "hono/cookie";
import type { Context } from "hono";

// Auth0 configuration (from environment)
interface Auth0Config {
  domain: string;
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
}

interface AuthFlowState {
  state: string;
  return_to: string;
}

function getAuth0Config(): Auth0Config {
  const domain = process.env["AUTH0_DOMAIN"];
  const clientId = process.env["AUTH0_CLIENT_ID"];
  const clientSecret = process.env["AUTH0_CLIENT_SECRET"];
  const callbackUrl = process.env["AUTH0_CALLBACK_URL"];

  if (!domain || !clientId || !clientSecret || !callbackUrl) {
    throw new Error("Auth0 configuration incomplete. Check environment variables.");
  }

  return { domain, clientId, clientSecret, callbackUrl };
}

// Simple state generation for CSRF protection
function generateState(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function encodeAuthFlowState(input: AuthFlowState): string {
  return Buffer.from(JSON.stringify(input), "utf-8").toString("base64url");
}

export function decodeAuthFlowState(value: string | undefined): AuthFlowState | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf-8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }

    const raw = parsed as Record<string, unknown>;
    if (typeof raw["state"] !== "string" || typeof raw["return_to"] !== "string") {
      return null;
    }

    return {
      state: raw["state"],
      return_to: sanitizeReturnTo(raw["return_to"]),
    };
  } catch {
    return null;
  }
}

export function sanitizeReturnTo(value: string | undefined): string {
  if (!value) {
    return "/dashboard";
  }

  // Only allow same-origin relative paths.
  if (!value.startsWith("/") || value.startsWith("//")) {
    return "/dashboard";
  }

  return value;
}

function sanitizeSlugSegment(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function buildDefaultNamespaceSlug(
  email: string | undefined,
  principalId: string,
  slugExists: (slug: string) => boolean
): string {
  const fallbackBase = `user-${principalId.slice(-8).toLowerCase()}`;
  const emailLocalPart = email?.split("@")[0] ?? "";
  const normalizedLocalPart = sanitizeSlugSegment(emailLocalPart);
  const base = normalizedLocalPart || fallbackBase;

  const candidates: string[] = [
    base,
    `${base}-${principalId.slice(-6).toLowerCase()}`,
  ];
  for (let i = 2; i <= 50; i += 1) {
    candidates.push(`${base}-${i}`);
  }
  candidates.push(`user-${principalId.toLowerCase()}`);

  for (const candidate of candidates) {
    if (!slugExists(candidate)) {
      return candidate;
    }
  }

  let suffix = 51;
  while (slugExists(`${base}-${suffix}`)) {
    suffix += 1;
  }
  return `${base}-${suffix}`;
}

const auth = new Hono();

/**
 * GET /auth/login
 * Redirects to Auth0 Universal Login
 */
auth.get("/login", async (c: Context) => {
  const config = getAuth0Config();
  const state = generateState();
  const returnTo = sanitizeReturnTo(c.req.query("return_to"));
  const encodedState = encodeAuthFlowState({ state, return_to: returnTo });

  // Store state in cookie for CSRF verification
  setCookie(c, "auth_state", encodedState, {
    httpOnly: true,
    secure: process.env["NODE_ENV"] === "production",
    sameSite: "Lax",
    maxAge: 300, // 5 minutes
    path: "/",
  });

  // Cleanup legacy cookie that stored return_to separately.
  deleteCookie(c, "auth_return_to");

  const params = new URLSearchParams({
    response_type: "code",
    client_id: config.clientId,
    redirect_uri: config.callbackUrl,
    scope: "openid profile email",
    state,
  });

  const authUrl = `https://${config.domain}/authorize?${params.toString()}`;
  return c.redirect(authUrl);
});

/**
 * GET /auth/callback
 * Handles Auth0 callback after login
 */
auth.get("/callback", async (c: Context) => {
  const config = getAuth0Config();
  const db = c.get("db");

  // Get authorization code and state
  const code = c.req.query("code");
  const state = c.req.query("state");
  const error = c.req.query("error");
  const errorDescription = c.req.query("error_description");

  // Handle Auth0 errors
  if (error) {
    console.error("Auth0 error:", error, errorDescription);
    return c.json(
      {
        error: "auth_failed",
        message: errorDescription ?? "Authentication failed",
      },
      400
    );
  }

  if (!code || !state) {
    return c.json(
      {
        error: "invalid_request",
        message: "Missing code or state parameter",
      },
      400
    );
  }

  // Verify state matches (CSRF protection)
  const rawStoredState = getCookie(c, "auth_state");
  const decodedState = decodeAuthFlowState(rawStoredState);
  const expectedState = decodedState?.state ?? rawStoredState;
  if (state !== expectedState) {
    return c.json(
      {
        error: "invalid_state",
        message: "State mismatch - possible CSRF attack",
      },
      400
    );
  }

  // Exchange code for tokens
  const tokenResponse = await fetch(`https://${config.domain}/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: config.callbackUrl,
    }),
  });

  if (!tokenResponse.ok) {
    const errorBody = await tokenResponse.text();
    console.error("Token exchange failed:", errorBody);
    return c.json(
      {
        error: "token_exchange_failed",
        message: "Failed to exchange authorization code",
      },
      500
    );
  }

  const tokens = (await tokenResponse.json()) as {
    access_token: string;
    id_token: string;
    token_type: string;
  };

  // Get user info from Auth0
  const userInfoResponse = await fetch(`https://${config.domain}/userinfo`, {
    headers: {
      Authorization: `Bearer ${tokens.access_token}`,
    },
  });

  if (!userInfoResponse.ok) {
    return c.json(
      {
        error: "userinfo_failed",
        message: "Failed to get user info",
      },
      500
    );
  }

  const userInfo = (await userInfoResponse.json()) as {
    sub: string;
    email?: string;
    email_verified?: boolean;
    name?: string;
    picture?: string;
  };

  // Find or create identity + principal
  let identity = db.identities.getByProviderSubject("auth0", userInfo.sub);
  let principal;

  if (identity) {
    // Existing user - update last login
    db.identities.updateLastLogin(identity.id);
    principal = db.principals.getById(identity.principal_id);
  } else if (userInfo.email && userInfo.email_verified) {
    // New Auth0 subject — check if email matches an existing identity
    const emailMatches = db.identities.getByEmail(userInfo.email);
    // Only link if all matching identities agree on the same principal.
    // If email maps to multiple principals, skip linking (ambiguous).
    const distinctPrincipalIds = new Set(emailMatches.map((m) => m.principal_id));
    if (emailMatches.length > 0 && distinctPrincipalIds.size === 1) {
      const existingPrincipalId = emailMatches[0]!.principal_id;
      principal = db.principals.getById(existingPrincipalId);

      // Only create the link if the principal still exists
      if (principal) {
        identity = db.identities.create({
          principalId: existingPrincipalId,
          provider: "auth0",
          externalSubject: userInfo.sub,
          email: userInfo.email,
          metadata: {
            name: userInfo.name,
            picture: userInfo.picture,
          },
        });

        db.audit.create({
          principalId: existingPrincipalId,
          principalType: "user",
          action: "auth.account_linked",
          resourceType: "identity",
          resourceId: identity.id,
          details: {
            provider: "auth0",
            linkedToIdentity: emailMatches[0]!.id,
          },
        });
      }
    }
  }

  if (!identity) {
    // Truly new user — create principal + identity + default namespace
    principal = db.principals.create({
      type: "user",
      name: userInfo.name ?? userInfo.email ?? "Unknown User",
      metadata: {
        picture: userInfo.picture,
      },
    });

    identity = db.identities.create({
      principalId: principal.id,
      provider: "auth0",
      externalSubject: userInfo.sub,
      email: userInfo.email,
      metadata: {
        name: userInfo.name,
        picture: userInfo.picture,
      },
    });

    // Create default namespace for new user
    const slug = buildDefaultNamespaceSlug(
      userInfo.email,
      principal.id,
      (candidate) => db.namespaces.slugExists(candidate)
    );

    db.namespaces.create({
      slug,
      name: "Default",
      ownerId: principal.id,
      visibility: "private",
    });

    // Log audit event
    db.audit.create({
      principalId: principal.id,
      principalType: "user",
      action: "auth.login",
      resourceType: "identity",
      resourceId: identity.id,
      details: {
        provider: "auth0",
        firstLogin: true,
      },
    });
  }

  if (!principal) {
    return c.json(
      {
        error: "principal_not_found",
        message: "Principal not found for identity",
      },
      500
    );
  }

  // Create browser session
  const session = db.sessions.create({
    principalId: principal.id,
    identityId: identity.id,
    userAgent: c.req.header("User-Agent"),
    ipAddress: c.req.header("X-Forwarded-For")?.split(",")[0] ??
      c.req.header("X-Real-IP"),
  });

  // Set session cookie
  setCookie(c, "attach_session", session.id, {
    httpOnly: true,
    secure: process.env["NODE_ENV"] === "production",
    sameSite: "Lax",
    maxAge: 7 * 24 * 60 * 60, // 7 days
    path: "/",
  });

  // Clear auth state cookie
  deleteCookie(c, "auth_state");

  const redirectTarget = sanitizeReturnTo(decodedState?.return_to);

  // Cleanup legacy cookie if present.
  deleteCookie(c, "auth_return_to");

  // Redirect to dashboard or return JSON based on Accept header
  const acceptsHtml = c.req.header("Accept")?.includes("text/html");
  if (acceptsHtml) {
    return c.redirect(redirectTarget);
  }

  return c.json({
    message: "Login successful",
    principal: {
      id: principal.id,
      type: principal.type,
      name: principal.name,
    },
  });
});

/**
 * POST /auth/logout
 * Clears session and optionally logs out of Auth0
 */
auth.post("/logout", async (c: Context) => {
  const db = c.get("db");
  const auth = c.get("auth");

  // Delete session from database if authenticated
  if (auth?.credential.type === "session") {
    db.sessions.delete(auth.credential.id);
  }

  // Clear session cookie
  deleteCookie(c, "attach_session");

  // Optionally redirect to Auth0 logout
  const returnTo = sanitizeReturnTo(c.req.query("return_to"));
  const auth0Logout = c.req.query("auth0_logout") === "true";

  if (auth0Logout) {
    const config = getAuth0Config();
    const logoutUrl = `https://${config.domain}/v2/logout?` +
      new URLSearchParams({
        client_id: config.clientId,
        returnTo: new URL(returnTo, c.req.url).toString(),
      }).toString();
    return c.redirect(logoutUrl);
  }

  const acceptsHtml = c.req.header("Accept")?.includes("text/html");
  if (acceptsHtml) {
    return c.redirect(returnTo);
  }

  return c.json({ message: "Logged out successfully" });
});

export { auth };
