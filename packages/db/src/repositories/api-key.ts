import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Database as DatabaseType } from "better-sqlite3";
import {
  generateId,
  nowISO,
  generateApiKeyPrefix,
  type PrincipalType,
} from "@attach/shared";

export interface ApiKeyRow {
  id: string;
  principal_id: string;
  key_prefix: string;
  key_hash: string;
  name: string | null;
  scope: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
  created_at: string;
}

export interface CreateApiKeyInput {
  principalId: string;
  principalType: PrincipalType;
  name?: string;
  scope?: { namespaces?: string[]; permissions?: string[] };
  expiresAt?: string;
}

export interface CreateApiKeyResult {
  row: ApiKeyRow;
  plaintext: string; // Only returned at creation time
}

export interface ApiKeyScope {
  namespaces?: string[];
  permissions?: string[];
}

// Secret key for HMAC - should be loaded from environment
let hmacSecret: Buffer | null = null;

export function setHmacSecret(secret: string): void {
  const isHex = /^[0-9a-fA-F]+$/.test(secret) && secret.length % 2 === 0;
  const parsed = isHex ? Buffer.from(secret, "hex") : Buffer.from(secret, "utf-8");
  if (parsed.length < 32) {
    throw new Error("HMAC secret must be at least 32 bytes");
  }
  hmacSecret = parsed;
}

function getHmacSecret(): Buffer {
  if (!hmacSecret) {
    throw new Error("HMAC secret not configured. Call setHmacSecret() first.");
  }
  return hmacSecret;
}

function hashKey(key: string): string {
  return createHmac("sha256", getHmacSecret()).update(key).digest("hex");
}

function generateRandomKey(): string {
  // Generate 24 bytes = 32 base64 chars, we'll use base62-ish (alphanumeric)
  const bytes = randomBytes(24);
  return bytes
    .toString("base64")
    .replace(/\+/g, "")
    .replace(/\//g, "")
    .replace(/=/g, "")
    .slice(0, 24);
}

function normalizeStringArray(value: unknown): string[] | null {
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

export class ApiKeyRepository {
  constructor(private db: DatabaseType) {}

  create(input: CreateApiKeyInput): CreateApiKeyResult {
    const id = generateId();
    const now = nowISO();

    // Generate the full key: prefix + random
    const prefix = generateApiKeyPrefix(input.principalType);
    const randomPart = generateRandomKey();
    const plaintext = `${prefix}${randomPart}`;

    // Store only the hash
    const keyHash = hashKey(plaintext);

    this.db
      .prepare(
        `INSERT INTO api_keys (id, principal_id, key_prefix, key_hash, name, scope, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.principalId,
        prefix,
        keyHash,
        input.name ?? null,
        input.scope ? JSON.stringify(input.scope) : null,
        input.expiresAt ?? null,
        now
      );

    return {
      row: this.getById(id)!,
      plaintext, // Only time the plaintext is available
    };
  }

  getById(id: string): ApiKeyRow | null {
    return (
      (this.db
        .prepare(`SELECT * FROM api_keys WHERE id = ?`)
        .get(id) as ApiKeyRow | undefined) ?? null
    );
  }

  getByPrincipal(principalId: string): ApiKeyRow[] {
    return this.db
      .prepare(
        `SELECT * FROM api_keys WHERE principal_id = ? AND revoked_at IS NULL ORDER BY created_at DESC`
      )
      .all(principalId) as ApiKeyRow[];
  }

  /**
   * Validate an API key and return the associated row if valid.
   * Uses constant-time comparison to prevent timing attacks.
   */
  validate(plaintext: string): ApiKeyRow | null {
    // Extract prefix (e.g., "arun_usr_")
    const prefixMatch = plaintext.match(/^(arun_[a-z]+_)/);
    if (!prefixMatch) {
      return null;
    }

    const prefix = prefixMatch[1];
    const keyHash = hashKey(plaintext);

    // Find all keys with this prefix (should be few)
    const candidates = this.db
      .prepare(
        `SELECT * FROM api_keys
         WHERE key_prefix = ?
         AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at > ?)`
      )
      .all(prefix, nowISO()) as ApiKeyRow[];

    // Constant-time comparison for each candidate
    for (const candidate of candidates) {
      const candidateHashBuffer = Buffer.from(candidate.key_hash, "hex");
      const providedHashBuffer = Buffer.from(keyHash, "hex");

      if (
        candidateHashBuffer.length === providedHashBuffer.length &&
        timingSafeEqual(candidateHashBuffer, providedHashBuffer)
      ) {
        // Update last_used_at
        this.updateLastUsed(candidate.id);
        return candidate;
      }
    }

    return null;
  }

  revoke(id: string): void {
    this.db
      .prepare(`UPDATE api_keys SET revoked_at = ? WHERE id = ?`)
      .run(nowISO(), id);
  }

  updateLastUsed(id: string): void {
    this.db
      .prepare(`UPDATE api_keys SET last_used_at = ? WHERE id = ?`)
      .run(nowISO(), id);
  }

  parseScope(row: ApiKeyRow): ApiKeyScope | null {
    if (!row.scope) {
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(row.scope);
    } catch {
      return null;
    }

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }

    const raw = parsed as Record<string, unknown>;
    const hasPermissions = Object.hasOwn(raw, "permissions");
    const hasNamespaces = Object.hasOwn(raw, "namespaces");

    if (!hasPermissions && !hasNamespaces) {
      return null;
    }

    const scope: ApiKeyScope = {};

    if (hasPermissions) {
      const permissions = normalizeStringArray(raw["permissions"]);
      if (!permissions) {
        return null;
      }
      scope.permissions = permissions;
    }

    if (hasNamespaces) {
      const namespaces = normalizeStringArray(raw["namespaces"]);
      if (!namespaces) {
        return null;
      }
      scope.namespaces = namespaces;
    }

    return scope;
  }

  countByPrincipal(principalId: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) as count FROM api_keys WHERE principal_id = ? AND revoked_at IS NULL`)
      .get(principalId) as { count: number };
    return row.count;
  }

  countAll(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) as count FROM api_keys WHERE revoked_at IS NULL`)
      .get() as { count: number };
    return row.count;
  }
}
