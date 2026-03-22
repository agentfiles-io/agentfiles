import type { Context, Next } from "hono";
import { getCookie } from "hono/cookie";
import type { PrincipalRow, GrantRow, ApiKeyScope } from "@attach/db";

// Context type for authenticated requests
export interface AuthContext {
  principal: PrincipalRow;
  credential: {
    type: "api_key" | "session";
    id: string;
    scope: ApiKeyScope | null; // Only present for API keys
  };
}

// Context type for share token access
export interface ShareTokenContext {
  grant: GrantRow;
  permissions: string[];
}

/**
 * Share token middleware that extracts and validates share tokens.
 * Share tokens must be passed via header.
 * Does not reject unauthenticated requests.
 */
export async function shareTokenMiddleware(c: Context, next: Next) {
  const db = c.get("db");
  let shareToken: ShareTokenContext | null = null;

  const token = c.req.header("X-Share-Token") ?? undefined;

  if (token) {
    const grant = db.grants.validateToken(token);
    if (grant) {
      shareToken = {
        grant,
        permissions: db.grants.parsePermissions(grant),
      };
    }
  }

  c.set("shareToken", shareToken);
  await next();
}

/**
 * Auth middleware that supports both API key and session authentication.
 * Does not reject unauthenticated requests - use requireAuth() for that.
 */
export async function authMiddleware(c: Context, next: Next) {
  const db = c.get("db");
  let auth: AuthContext | null = null;

  // Try API key first (Authorization header)
  const authHeader = c.req.header("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.slice(7);

    // Check if it's an API key (starts with arun_)
    if (token.startsWith("arun_")) {
      const apiKey = db.apiKeys.validate(token);
      if (apiKey) {
        const principal = db.principals.getById(apiKey.principal_id);
        if (principal) {
          auth = {
            principal,
            credential: {
              type: "api_key",
              id: apiKey.id,
              scope: db.apiKeys.parseScope(apiKey),
            },
          };
        }
      }
    }
  }

  // Try session cookie if no API key auth
  if (!auth) {
    const sessionId = getCookie(c, "attach_session");
    if (sessionId) {
      const session = db.sessions.validate(sessionId);
      if (session) {
        const principal = db.principals.getById(session.principal_id);
        if (principal) {
          auth = {
            principal,
            credential: { type: "session", id: session.id, scope: null },
          };
        }
      }
    }
  }

  c.set("auth", auth);
  await next();
}

/**
 * Middleware that requires authentication.
 * Returns 401 if not authenticated.
 */
export async function requireAuth(c: Context, next: Next) {
  const auth = c.get("auth");

  if (!auth) {
    return c.json(
      {
        error: "unauthorized",
        message: "Authentication required",
      },
      401
    );
  }

  await next();
}

/**
 * Middleware that requires a specific principal type.
 */
export function requirePrincipalType(...types: string[]) {
  return async (c: Context, next: Next) => {
    const auth = c.get("auth");

    if (!auth) {
      return c.json(
        {
          error: "unauthorized",
          message: "Authentication required",
        },
        401
      );
    }

    if (!types.includes(auth.principal.type)) {
      return c.json(
        {
          error: "forbidden",
          message: `This action requires a ${types.join(" or ")} principal`,
        },
        403
      );
    }

    await next();
  };
}

/**
 * Check if an auth context has the required permission.
 * Sessions (browser auth) have full access.
 * API keys must have the permission in their scope.
 */
export function hasPermission(auth: AuthContext, permission: string): boolean {
  // Sessions have full access
  if (auth.credential.type === "session") {
    return true;
  }

  // API keys without scope default to minimal read-only permissions
  const scope = auth.credential.scope;
  if (!scope) {
    const defaultPermissions = ["artifacts:read", "namespaces:read"];
    return defaultPermissions.includes(permission);
  }

  // Scoped keys must explicitly list allowed permissions.
  if (!Array.isArray(scope.permissions)) {
    return false;
  }

  // Check if permission is in scope
  return scope.permissions.includes(permission);
}

/**
 * Check if an auth context has access to a namespace.
 * Sessions have full access.
 * API keys may be scoped to specific namespaces.
 */
export function hasNamespaceAccess(auth: AuthContext, namespaceId: string): boolean {
  // Sessions have full access
  if (auth.credential.type === "session") {
    return true;
  }

  // If explicit namespace scope is set, enforce it strictly.
  const scope = auth.credential.scope;
  if (scope?.namespaces && scope.namespaces.length > 0) {
    return scope.namespaces.includes(namespaceId);
  }

  // Backward-compatible/default behavior:
  // - Namespace-bound principals can access only their bound namespace.
  // - User principals can access all their owned namespaces (owner checks happen in routes).
  if (auth.principal.namespace_id) {
    return auth.principal.namespace_id === namespaceId;
  }

  if (auth.principal.type === "user") {
    return true;
  }

  return false;
}

/**
 * Middleware that requires a specific permission.
 * Returns 403 if the API key doesn't have the required permission.
 */
export function requirePermission(permission: string) {
  return async (c: Context, next: Next) => {
    const auth = c.get("auth") as AuthContext | null;

    if (!auth) {
      return c.json(
        {
          error: "unauthorized",
          message: "Authentication required",
        },
        401
      );
    }

    if (!hasPermission(auth, permission)) {
      return c.json(
        {
          error: "forbidden",
          message: `This action requires the '${permission}' permission`,
        },
        403
      );
    }

    await next();
  };
}

/**
 * Check if a share token grants read access to a specific artifact.
 */
export function shareTokenCanReadArtifact(
  shareToken: ShareTokenContext | null,
  artifactId: string,
  namespaceId: string
): boolean {
  if (!shareToken) return false;
  if (!shareToken.permissions.includes("read")) return false;

  const grant = shareToken.grant;

  // Check namespace matches
  if (grant.namespace_id !== namespaceId) return false;

  // If grant is for a specific artifact, check it matches
  if (grant.artifact_id && grant.artifact_id !== artifactId) return false;

  return true;
}

/**
 * Middleware that requires either authentication OR a valid share token with read access.
 * Useful for artifact read endpoints that should support both authenticated and shared access.
 */
export function requireAuthOrShareToken(
  getArtifactInfo: (c: Context) => Promise<{ artifactId: string; namespaceId: string } | null>
) {
  return async (c: Context, next: Next) => {
    const auth = c.get("auth") as AuthContext | null;
    const shareToken = c.get("shareToken") as ShareTokenContext | null;

    // If authenticated, allow access (authorization handled elsewhere)
    if (auth) {
      await next();
      return;
    }

    // If share token present, validate access
    if (shareToken) {
      const artifactInfo = await getArtifactInfo(c);
      if (artifactInfo && shareTokenCanReadArtifact(shareToken, artifactInfo.artifactId, artifactInfo.namespaceId)) {
        await next();
        return;
      }
    }

    return c.json(
      {
        error: "unauthorized",
        message: "Authentication or valid share token required",
      },
      401
    );
  };
}
