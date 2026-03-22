import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Database as DatabaseType } from "better-sqlite3";
import { generateId, nowISO, SHARE_TOKEN_PREFIX } from "@attach/shared";

export interface GrantRow {
  id: string;
  namespace_id: string;
  artifact_id: string | null;
  grantee_type: "principal" | "token" | "public";
  grantee_id: string | null;
  token_prefix: string | null;
  token_hash: string | null;
  permissions: string;
  expires_at: string | null;
  created_at: string;
  created_by: string;
  revoked_at: string | null;
}

export interface CreateGrantInput {
  namespaceId: string;
  artifactId?: string;
  granteeType: "principal" | "token" | "public";
  granteeId?: string;
  permissions: string[];
  expiresAt?: string;
  createdBy: string;
}

export interface CreateGrantResult {
  row: GrantRow;
  token: string | undefined; // Only returned for token grants, at creation time
}

// Use the same HMAC secret as API keys
let hmacSecret: Buffer | null = null;

export function setGrantHmacSecret(secret: string): void {
  const isHex = /^[0-9a-fA-F]+$/.test(secret) && secret.length % 2 === 0;
  const parsed = isHex ? Buffer.from(secret, "hex") : Buffer.from(secret, "utf-8");
  if (parsed.length < 32) {
    throw new Error("Grant HMAC secret must be at least 32 bytes");
  }
  hmacSecret = parsed;
}

function getHmacSecret(): Buffer {
  if (!hmacSecret) {
    throw new Error("HMAC secret not configured for grants.");
  }
  return hmacSecret;
}

function hashToken(token: string): string {
  return createHmac("sha256", getHmacSecret()).update(token).digest("hex");
}

function generateShareToken(): string {
  const bytes = randomBytes(24);
  const random = bytes
    .toString("base64")
    .replace(/\+/g, "")
    .replace(/\//g, "")
    .replace(/=/g, "")
    .slice(0, 24);
  return `${SHARE_TOKEN_PREFIX}${random}`;
}

export class GrantRepository {
  constructor(private db: DatabaseType) {}

  create(input: CreateGrantInput): CreateGrantResult {
    const id = generateId();
    const now = nowISO();

    let tokenPrefix: string | null = null;
    let tokenHash: string | null = null;
    let plaintoken: string | undefined;

    // Generate token for token-based grants
    if (input.granteeType === "token") {
      plaintoken = generateShareToken();
      tokenPrefix = plaintoken.slice(0, 12); // "arun_share_x"
      tokenHash = hashToken(plaintoken);
    }

    this.db
      .prepare(
        `INSERT INTO grants (id, namespace_id, artifact_id, grantee_type, grantee_id, token_prefix, token_hash, permissions, expires_at, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        input.namespaceId,
        input.artifactId ?? null,
        input.granteeType,
        input.granteeId ?? null,
        tokenPrefix,
        tokenHash,
        JSON.stringify(input.permissions),
        input.expiresAt ?? null,
        now,
        input.createdBy
      );

    return {
      row: this.getById(id)!,
      token: plaintoken,
    };
  }

  getById(id: string): GrantRow | null {
    return (
      (this.db
        .prepare(`SELECT * FROM grants WHERE id = ?`)
        .get(id) as GrantRow | undefined) ?? null
    );
  }

  getByNamespace(namespaceId: string): GrantRow[] {
    return this.db
      .prepare(
        `SELECT * FROM grants WHERE namespace_id = ? AND revoked_at IS NULL ORDER BY created_at DESC`
      )
      .all(namespaceId) as GrantRow[];
  }

  getByArtifact(artifactId: string): GrantRow[] {
    return this.db
      .prepare(
        `SELECT * FROM grants WHERE artifact_id = ? AND revoked_at IS NULL ORDER BY created_at DESC`
      )
      .all(artifactId) as GrantRow[];
  }

  /**
   * Validate a share token and return the grant if valid.
   */
  validateToken(token: string): GrantRow | null {
    if (!token.startsWith(SHARE_TOKEN_PREFIX)) {
      return null;
    }

    const prefix = token.slice(0, 12);
    const tokenHash = hashToken(token);
    const now = nowISO();

    // Find grants with matching prefix
    const candidates = this.db
      .prepare(
        `SELECT * FROM grants
         WHERE token_prefix = ?
         AND revoked_at IS NULL
         AND (expires_at IS NULL OR expires_at > ?)`
      )
      .all(prefix, now) as GrantRow[];

    // Constant-time comparison
    for (const candidate of candidates) {
      if (!candidate.token_hash) continue;

      const candidateHashBuffer = Buffer.from(candidate.token_hash, "hex");
      const providedHashBuffer = Buffer.from(tokenHash, "hex");

      if (
        candidateHashBuffer.length === providedHashBuffer.length &&
        timingSafeEqual(candidateHashBuffer, providedHashBuffer)
      ) {
        return candidate;
      }
    }

    return null;
  }

  revoke(id: string): void {
    this.db
      .prepare(`UPDATE grants SET revoked_at = ? WHERE id = ?`)
      .run(nowISO(), id);
  }

  parsePermissions(row: GrantRow): string[] {
    try {
      return JSON.parse(row.permissions) as string[];
    } catch {
      return [];
    }
  }

  /**
   * Check if a grant allows a specific permission.
   */
  hasPermission(row: GrantRow, permission: string): boolean {
    const permissions = this.parsePermissions(row);
    return permissions.includes(permission);
  }
}
