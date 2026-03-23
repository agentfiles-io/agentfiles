import type { GitArtifactStore } from "@attach/db";

export const DEFAULT_NAMESPACE_STORAGE_LIMIT_BYTES = 0;
const ESTIMATED_GIT_WRITE_OVERHEAD_BYTES = 64 * 1024;

export interface StorageQuotaResult {
  allowed: boolean;
  repoSizeBytes: number;
  estimatedGrowthBytes: number;
  estimatedUsageBytes: number;
}

export function parseNamespaceStorageLimitBytes(raw: string | undefined): number {
  if (!raw || raw.trim() === "") {
    return DEFAULT_NAMESPACE_STORAGE_LIMIT_BYTES;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error("NAMESPACE_STORAGE_LIMIT_BYTES must be a non-negative integer");
  }

  return parsed;
}

export function estimateStorageGrowthBytes(incomingContentSize: number): number {
  return incomingContentSize * 2 + ESTIMATED_GIT_WRITE_OVERHEAD_BYTES;
}

export async function enforceStorageQuota(
  gitStore: GitArtifactStore,
  namespaceId: string,
  incomingContentSize: number,
  storageLimitBytes: number
): Promise<StorageQuotaResult> {
  if (storageLimitBytes === 0) {
    return {
      allowed: true,
      repoSizeBytes: 0,
      estimatedGrowthBytes: 0,
      estimatedUsageBytes: 0,
    };
  }

  const repoSizeBytes = await gitStore.getRepoSizeBytes(namespaceId);
  const estimatedGrowthBytes = estimateStorageGrowthBytes(incomingContentSize);
  const estimatedUsageBytes = repoSizeBytes + estimatedGrowthBytes;

  return {
    allowed: estimatedUsageBytes <= storageLimitBytes,
    repoSizeBytes,
    estimatedGrowthBytes,
    estimatedUsageBytes,
  };
}

export function buildStorageQuotaExceededBody(
  repoSizeBytes: number,
  storageLimitBytes: number,
  estimatedGrowthBytes: number,
  estimatedUsageBytes: number
) {
  return {
    error: "storage_quota_exceeded",
    message: `Namespace storage limit (${storageLimitBytes} bytes) exceeded`,
    current_usage_bytes: repoSizeBytes,
    estimated_growth_bytes: estimatedGrowthBytes,
    estimated_usage_bytes: estimatedUsageBytes,
    limit_bytes: storageLimitBytes,
  };
}
