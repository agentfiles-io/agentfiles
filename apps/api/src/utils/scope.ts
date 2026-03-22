import type { ConnectClientKind } from "@attach/shared";

export type RequestedScope = { namespaces?: string[]; permissions?: string[] };

export const ALLOWED_SCOPE_PERMISSIONS = new Set([
  "api_keys:write",
  "artifacts:read",
  "artifacts:write",
  "grants:read",
  "grants:write",
  "namespaces:read",
  "namespaces:write",
  "principals:write",
]);

export const CONNECT_SCOPE_PRESETS: Record<ConnectClientKind, string[]> = {
  openclaw: ["artifacts:read", "artifacts:write", "namespaces:read"],
  claude_code: ["artifacts:read", "artifacts:write", "namespaces:read"],
  codex: ["artifacts:read", "artifacts:write", "namespaces:read"],
  mcp: ["artifacts:read", "artifacts:write", "namespaces:read"],
  generic: ["artifacts:read", "namespaces:read"],
  setup: ["artifacts:read", "artifacts:write", "namespaces:read"],
};

export const CONNECT_BLOCKED_PERMISSIONS = new Set([
  "api_keys:write",
  "principals:write",
  "namespaces:write",
]);

export function normalizeStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") {
      return null;
    }
    const trimmed = item.trim();
    if (!trimmed) {
      return null;
    }
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      normalized.push(trimmed);
    }
  }

  return normalized;
}

export function normalizeRequestedScope(
  scope: unknown
): { ok: true; scope: RequestedScope | undefined } | { ok: false; message: string } {
  if (scope === undefined) {
    return { ok: true, scope: undefined };
  }

  if (!scope || typeof scope !== "object" || Array.isArray(scope)) {
    return { ok: false, message: "scope must be an object when provided" };
  }

  const raw = scope as Record<string, unknown>;
  const normalized: RequestedScope = {};

  if (Object.hasOwn(raw, "permissions")) {
    const permissions = normalizeStringArray(raw["permissions"]);
    if (!permissions || permissions.length === 0) {
      return {
        ok: false,
        message: "scope.permissions must be a non-empty array of strings",
      };
    }

    const invalidPermissions = permissions.filter(
      (permission) => !ALLOWED_SCOPE_PERMISSIONS.has(permission)
    );
    if (invalidPermissions.length > 0) {
      return {
        ok: false,
        message: `Invalid scope permission(s): ${invalidPermissions.join(", ")}`,
      };
    }

    normalized.permissions = permissions;
  }

  if (Object.hasOwn(raw, "namespaces")) {
    const namespaces = normalizeStringArray(raw["namespaces"]);
    if (!namespaces || namespaces.length === 0) {
      return {
        ok: false,
        message: "scope.namespaces must be a non-empty array of strings",
      };
    }
    normalized.namespaces = namespaces;
  }

  if (!normalized.permissions && !normalized.namespaces) {
    return {
      ok: false,
      message: "scope must include at least one of: permissions, namespaces",
    };
  }

  // Scoped keys must explicitly define permissions so access is unambiguous.
  if (!normalized.permissions) {
    return {
      ok: false,
      message: "scope.permissions is required when scope is provided",
    };
  }

  return { ok: true, scope: normalized };
}

function toBoundSet(values: string[] | undefined): Set<string> | null {
  if (!values || values.length === 0) {
    return null;
  }
  return new Set(values);
}

export function isRequestedScopeAllowed(
  auth: { credential: { type: string; scope: RequestedScope | null } },
  requested: RequestedScope | undefined
): boolean {
  // Browser sessions always have full access.
  if (auth.credential.type === "session") {
    return true;
  }

  // Backward compatibility: unscoped API keys keep full behavior.
  const parentScope = auth.credential.scope;
  if (!parentScope) {
    return true;
  }

  // Scoped API keys may only mint equally-or-more-restricted keys.
  if (!requested) {
    return false;
  }

  const allowedPermissions = toBoundSet(parentScope.permissions);
  if (allowedPermissions) {
    const requestedPermissions = requested.permissions;
    if (!requestedPermissions || requestedPermissions.length === 0) {
      return false;
    }
    if (!requestedPermissions.every((permission) => allowedPermissions.has(permission))) {
      return false;
    }
  }

  const allowedNamespaces = toBoundSet(parentScope.namespaces);
  if (allowedNamespaces) {
    const requestedNamespaces = requested.namespaces;
    if (!requestedNamespaces || requestedNamespaces.length === 0) {
      return false;
    }
    if (!requestedNamespaces.every((namespaceId) => allowedNamespaces.has(namespaceId))) {
      return false;
    }
  }

  return true;
}

export function computeApprovedScope(
  clientKind: ConnectClientKind,
  requestedScopeJson: RequestedScope | undefined,
  namespaceId: string
): RequestedScope {
  const preset = CONNECT_SCOPE_PRESETS[clientKind];
  const requestedPerms = requestedScopeJson?.permissions;
  let permissions: string[];
  if (requestedPerms) {
    permissions = requestedPerms.filter(
      (p) => preset.includes(p) && !CONNECT_BLOCKED_PERMISSIONS.has(p)
    );
  } else {
    permissions = [...preset];
  }
  if (permissions.length === 0) permissions = [...preset];
  return { permissions, namespaces: [namespaceId] };
}
