import { createHash } from "node:crypto";
import { ulid } from "ulid";

// Re-export ULID generator
export { ulid };

// Principal types
export type PrincipalType = "user" | "service" | "agent" | "gateway";

// Identity providers
export type IdentityProvider = "auth0" | "local" | "botapi";

// API key prefixes
export const API_KEY_PREFIXES = {
  user: "arun_usr_",
  service: "arun_svc_",
  agent: "arun_agt_",
  gateway: "arun_gw_",
} as const;

export const SHARE_TOKEN_PREFIX = "arun_share_";

// Type definitions
export interface Principal {
  id: string;
  type: PrincipalType;
  name: string;
  namespaceId?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface Identity {
  id: string;
  principalId: string;
  provider: IdentityProvider;
  externalSubject: string;
  email?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  lastLoginAt?: string;
}

export interface ApiKey {
  id: string;
  principalId: string;
  name: string;
  keyPrefix: string;
  keyHash: string;
  scopes: string[];
  expiresAt?: string;
  lastUsedAt?: string;
  createdAt: string;
  revokedAt?: string;
}

export interface Namespace {
  id: string;
  slug: string;
  ownerPrincipalId: string;
  displayName?: string;
  description?: string;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

export interface Artifact {
  id: string;
  namespaceId: string;
  slug?: string;
  title: string;
  contentType: string;
  currentVersionId?: string;
  createdByPrincipalId: string;
  metadata?: Record<string, unknown>;
  labels?: string[];
  visibility: "private" | "public";
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
  archivedBy?: string;
  archiveReason?: string;
}

export interface ArtifactVersion {
  id: string;
  artifactId: string;
  versionNumber: number;
  blobHash: string;
  sizeBytes: number;
  searchableText?: string;
  createdByPrincipalId: string;
  provenance?: Provenance;
  createdAt: string;
}

export interface Provenance {
  // Source information
  source?: "mcp" | "cli" | "api" | "openclaw" | "git_import" | "git_sync";
  clientVersion?: string;

  // Git provenance (auto-captured when publishing from a git repo)
  gitRepoUrl?: string;
  gitRef?: string;
  gitCommitSha?: string;
  gitPath?: string;

  // Handoff envelope — agent-to-agent artifact exchange
  senderRuntime?: string;
  recipient?: string;
  threadId?: string;
  handoffKind?: string;
  replyToArtifactId?: string;

  // OpenClaw provenance
  openclawGatewayId?: string;
  openclawAgentId?: string;
  openclawSessionKey?: string;
  openclawChannel?: string;
  openclawPeer?: string;
  openclawRunId?: string;
}

// Connect session types
export type ConnectClientKind = "openclaw" | "claude_code" | "codex" | "mcp" | "generic" | "setup";
export type ConnectCompletionMode = "loopback" | "poll";

// Runtime instance types
export type RuntimeKind = "openclaw" | "claude_code" | "codex" | "mcp" | "generic";

export interface RuntimeInstance {
  id: string;
  principalId: string;
  ownerPrincipalId: string;
  namespaceId: string;
  displayName: string;
  runtimeKind: RuntimeKind;
  status: "active" | "inactive" | "revoked";
  connectSessionId?: string;
  connectedAt: string;
  lastSeenAt: string;
  lastActivityAt?: string;
  visibility: "private";
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

// Utility functions
export function generateId(): string {
  return ulid();
}

export function generateApiKeyPrefix(type: PrincipalType): string {
  return API_KEY_PREFIXES[type];
}

export function nowISO(): string {
  return new Date().toISOString();
}

export function computeContentHash(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export function getExtensionForContentType(contentType: string): string {
  switch (contentType) {
    case "text/markdown":
      return "md";
    case "application/json":
      return "json";
    default:
      return "txt";
  }
}
