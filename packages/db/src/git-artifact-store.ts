import git from "isomorphic-git";
import fs from "node:fs";
import { join, resolve, relative } from "node:path";

export interface GitArtifactStore {
  initNamespaceRepo(namespaceId: string): Promise<void>;
  getRepoSizeBytes(namespaceId: string): Promise<number>;

  /**
   * Acquire an exclusive namespace-scoped lock.
   * Callers MUST hold this lock when calling commitArtifact, getHead,
   * resetToCommit, or resetToEmpty — these methods are lock-free by design
   * so the caller can hold a single lock across the entire
   * getHead → commit → DB write → rollback-if-needed critical section.
   */
  acquireNamespaceLock(namespaceId: string): Promise<() => void>;

  /**
   * Commit content to the namespace repo. Caller must hold the namespace lock.
   */
  commitArtifact(
    namespaceId: string,
    filePath: string,
    content: Buffer,
    message: string,
    author: string
  ): Promise<string>; // returns commit SHA

  readAtCommit(
    namespaceId: string,
    filePath: string,
    commitSha: string
  ): Promise<Buffer | null>;
  diffArtifact(
    namespaceId: string,
    filePath: string,
    commitA: string,
    commitB: string
  ): Promise<string>;

  /** Get HEAD SHA. Caller must hold the namespace lock. */
  getHead(namespaceId: string): Promise<string | null>;

  /** Reset to a prior commit. Caller must hold the namespace lock. */
  resetToCommit(namespaceId: string, commitSha: string): Promise<void>;

  /**
   * Reset a repo to empty state (delete master ref).
   * Used to roll back a failed first write when there was no prior HEAD.
   * Caller must hold the namespace lock.
   */
  resetToEmpty(namespaceId: string): Promise<void>;
}

/**
 * Validate that a path segment is safe for use as a local artifact directory name.
 * Rejects traversal attacks (.., .git), absolute paths, and non-printable characters.
 */
export function validateArtifactPathSegment(segment: string): string | null {
  if (!segment || segment.length > 255) {
    return "Path segment must be 1-255 characters";
  }
  if (/^\.\.?$/.test(segment)) {
    return "Path segment must not be '.' or '..'";
  }
  if (segment.includes("/") || segment.includes("\\")) {
    return "Path segment must not contain slashes";
  }
  if (segment.startsWith(".")) {
    return "Path segment must not start with '.'";
  }
  // Only allow alphanumeric, hyphens, underscores
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(segment)) {
    return "Path segment must start with alphanumeric and contain only alphanumeric, hyphens, underscores, dots";
  }
  return null;
}

/**
 * Per-namespace in-memory mutex for write serialization.
 * Ensures only one git write operation per namespace at a time.
 *
 * Note: this is single-process only. Multi-process deployments would need
 * file-based or distributed locking (e.g., proper-lockfile or advisory locks).
 */
class NamespaceMutex {
  private chains = new Map<string, Promise<void>>();

  async acquire(namespaceId: string): Promise<() => void> {
    // Chain-based mutex: each acquirer appends to the end of the chain.
    // This is race-free because we atomically replace the chain entry
    // before awaiting the prior holder's promise.
    const prev = this.chains.get(namespaceId) ?? Promise.resolve();

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    // Atomically set ourselves as the tail of the chain
    this.chains.set(namespaceId, gate);

    // Wait for the previous holder to release
    await prev;

    return () => {
      // Only clean up if we're still the tail (no one queued after us)
      if (this.chains.get(namespaceId) === gate) {
        this.chains.delete(namespaceId);
      }
      release();
    };
  }
}

/**
 * Git-backed artifact storage. Each namespace gets its own bare-ish git repo.
 * Repos are stored at {basePath}/repos/{namespaceId}/
 */
export class IsomorphicGitArtifactStore implements GitArtifactStore {
  private basePath: string;
  private mutex = new NamespaceMutex();

  constructor(basePath: string) {
    this.basePath = join(basePath, "repos");
    if (!fs.existsSync(this.basePath)) {
      fs.mkdirSync(this.basePath, { recursive: true });
    }
  }

  private repoDir(namespaceId: string): string {
    if (!namespaceId || namespaceId.includes("..") || namespaceId.includes("/") || namespaceId.includes("\\")) {
      throw new Error(`Invalid namespace ID: ${namespaceId}`);
    }
    return join(this.basePath, namespaceId);
  }

  async initNamespaceRepo(namespaceId: string): Promise<void> {
    const dir = this.repoDir(namespaceId);
    if (fs.existsSync(join(dir, ".git"))) {
      return; // Already initialized
    }
    fs.mkdirSync(dir, { recursive: true });
    await git.init({ fs, dir });
  }

  async getRepoSizeBytes(namespaceId: string): Promise<number> {
    const dir = this.repoDir(namespaceId);
    if (!fs.existsSync(dir)) {
      return 0;
    }

    return getDirectorySizeBytes(dir);
  }

  /**
   * Acquire the namespace-scoped mutex. The returned function releases it.
   * Callers must hold this lock when calling commitArtifact, getHead,
   * resetToCommit, or resetToEmpty.
   */
  async acquireNamespaceLock(namespaceId: string): Promise<() => void> {
    return this.mutex.acquire(namespaceId);
  }

  /**
   * Get the current HEAD commit SHA for a namespace repo.
   * Returns null if the repo has no commits yet.
   * Caller must hold the namespace lock.
   */
  async getHead(namespaceId: string): Promise<string | null> {
    const dir = this.repoDir(namespaceId);
    if (!fs.existsSync(join(dir, ".git"))) return null;
    try {
      return await git.resolveRef({ fs, dir, ref: "HEAD" });
    } catch {
      return null; // No commits yet
    }
  }

  /**
   * Reset the namespace repo HEAD to a specific commit SHA.
   * Caller must hold the namespace lock.
   */
  async resetToCommit(namespaceId: string, commitSha: string): Promise<void> {
    const dir = this.repoDir(namespaceId);
    await git.writeRef({ fs, dir, ref: "refs/heads/master", value: commitSha, force: true });
    await git.checkout({ fs, dir, ref: "master", force: true });
  }

  /**
   * Reset a repo to an actually empty state by removing the namespace repo.
   * Used to roll back a failed first write when there was no prior HEAD.
   * Caller must hold the namespace lock.
   */
  async resetToEmpty(namespaceId: string): Promise<void> {
    const dir = this.repoDir(namespaceId);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  /**
   * Commit content to the namespace repo.
   * Caller must hold the namespace lock (via acquireNamespaceLock).
   */
  async commitArtifact(
    namespaceId: string,
    filePath: string,
    content: Buffer,
    message: string,
    author: string
  ): Promise<string> {
    const dir = this.repoDir(namespaceId);
    await this.initNamespaceRepo(namespaceId);

    // Validate that resolved path stays within the repo directory
    const fullPath = resolve(dir, filePath);
    const rel = relative(dir, fullPath);
    if (rel.startsWith("..") || rel.startsWith("/")) {
      throw new Error(`Path traversal detected: ${filePath}`);
    }

    const parentDir = join(fullPath, "..");
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    fs.writeFileSync(fullPath, content);
    await git.add({ fs, dir, filepath: filePath });

    const sha = await git.commit({
      fs,
      dir,
      message,
      author: {
        name: author,
        email: `${author}@agentfiles.local`,
      },
    });

    return sha;
  }

  async readAtCommit(
    namespaceId: string,
    filePath: string,
    commitSha: string
  ): Promise<Buffer | null> {
    const dir = this.repoDir(namespaceId);
    if (!fs.existsSync(join(dir, ".git"))) {
      return null;
    }

    // Validate that resolved path stays within the repo directory
    const fullPath = resolve(dir, filePath);
    const rel = relative(dir, fullPath);
    if (rel.startsWith("..") || rel.startsWith("/")) {
      throw new Error(`Path traversal detected: ${filePath}`);
    }

    try {
      // Read the commit to get the tree
      const { commit } = await git.readCommit({ fs, dir, oid: commitSha });
      const tree = commit.tree;

      // Walk the tree to find the file
      const result = await resolvePathInTree(fs, dir, tree, filePath);
      if (!result) return null;

      // Read the blob
      const { blob } = await git.readBlob({ fs, dir, oid: result });
      return Buffer.from(blob);
    } catch {
      return null;
    }
  }

  async diffArtifact(
    namespaceId: string,
    filePath: string,
    commitA: string,
    commitB: string
  ): Promise<string> {
    const [contentA, contentB] = await Promise.all([
      this.readAtCommit(namespaceId, filePath, commitA),
      this.readAtCommit(namespaceId, filePath, commitB),
    ]);

    const linesA = (contentA?.toString("utf-8") ?? "").split("\n");
    const linesB = (contentB?.toString("utf-8") ?? "").split("\n");

    return computeLineDiff(linesA, linesB, commitA.slice(0, 8), commitB.slice(0, 8));
  }
}

async function getDirectorySizeBytes(dir: string): Promise<number> {
  let total = 0;
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      total += await getDirectorySizeBytes(entryPath);
      continue;
    }

    const stats = await fs.promises.lstat(entryPath);
    total += stats.size;
  }

  return total;
}

/**
 * Compute a unified-style line diff using LCS (longest common subsequence).
 * Produces proper `-`/`+` output that handles insertions and deletions correctly,
 * unlike naive positional comparison.
 */
export function computeLineDiff(
  linesA: string[],
  linesB: string[],
  labelA: string,
  labelB: string,
): string {
  // Build LCS table
  const m = linesA.length;
  const n = linesB.length;

  // Guard against OOM: LCS requires O(m*n) memory. Cap at 5k lines per side
  // (~200MB worst case). For larger files, fall back to a simple summary.
  const MAX_DIFF_LINES = 5_000;
  if (m > MAX_DIFF_LINES || n > MAX_DIFF_LINES) {
    const output: string[] = [];
    output.push(`--- ${labelA}`);
    output.push(`+++ ${labelB}`);
    output.push("");
    output.push(`Diff too large (${m} vs ${n} lines). Showing summary only.`);
    output.push(`- ${labelA}: ${m} lines`);
    output.push(`+ ${labelB}: ${n} lines`);
    return output.join("\n");
  }

  // Use 1-indexed for cleaner LCS logic
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (linesA[i - 1] === linesB[j - 1]) {
        dp[i]![j] = dp[i - 1]![j - 1]! + 1;
      } else {
        dp[i]![j] = Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
      }
    }
  }

  // Backtrack to produce diff
  const result: string[] = [];
  let i = m;
  let j = n;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && linesA[i - 1] === linesB[j - 1]) {
      result.push(`  ${linesA[i - 1]}`);
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) {
      result.push(`+ ${linesB[j - 1]}`);
      j--;
    } else {
      result.push(`- ${linesA[i - 1]}`);
      i--;
    }
  }

  result.reverse();

  const output: string[] = [];
  output.push(`--- ${labelA}`);
  output.push(`+++ ${labelB}`);
  output.push("");
  output.push(...result);

  return output.join("\n");
}

/**
 * Resolve a file path within a git tree, walking through nested tree objects.
 * Returns the blob OID if found, null otherwise.
 */
async function resolvePathInTree(
  fsModule: typeof fs,
  dir: string,
  treeOid: string,
  filePath: string
): Promise<string | null> {
  const parts = filePath.split("/").filter(Boolean);
  let currentTree = treeOid;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    const { tree } = await git.readTree({ fs: fsModule, dir, oid: currentTree });
    const entry = tree.find((e) => e.path === part);
    if (!entry) return null;

    if (i === parts.length - 1) {
      // Last part — should be a blob
      return entry.type === "blob" ? entry.oid : null;
    } else {
      // Intermediate part — should be a tree
      if (entry.type !== "tree") return null;
      currentTree = entry.oid;
    }
  }

  return null;
}
