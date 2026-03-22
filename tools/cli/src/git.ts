import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";
import type { Provenance } from "@attach/shared";

/**
 * Check if we're inside a git repository
 */
export function isGitRepo(): boolean {
  try {
    execSync("git rev-parse --git-dir", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the git repository root directory
 */
export function getGitRoot(): string | null {
  try {
    return execSync("git rev-parse --show-toplevel", { stdio: "pipe" })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

/**
 * Get the remote origin URL
 */
export function getRemoteUrl(): string | null {
  try {
    const url = execSync("git remote get-url origin", { stdio: "pipe" })
      .toString()
      .trim();
    // Convert SSH URLs to HTTPS for display
    if (url.startsWith("git@")) {
      const match = url.match(/git@([^:]+):(.+)\.git/);
      if (match) {
        return `https://${match[1]}/${match[2]}`;
      }
    }
    return url.replace(/\.git$/, "");
  } catch {
    return null;
  }
}

/**
 * Get the current branch name
 */
export function getCurrentBranch(): string | null {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", { stdio: "pipe" })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

/**
 * Get the current commit SHA
 */
export function getCommitSha(): string | null {
  try {
    return execSync("git rev-parse HEAD", { stdio: "pipe" }).toString().trim();
  } catch {
    return null;
  }
}

/**
 * Get the relative path from git root to a file
 */
export function getGitPath(filePath: string): string | null {
  const root = getGitRoot();
  if (!root) return null;

  const absolutePath = resolve(filePath);
  if (!existsSync(absolutePath)) return null;

  return relative(root, absolutePath);
}

/**
 * Auto-capture git provenance for publishing
 */
export function captureGitProvenance(filePath?: string): Partial<Provenance> {
  if (!isGitRepo()) {
    return {};
  }

  const provenance: Partial<Provenance> = {
    source: "cli",
  };

  const repoUrl = getRemoteUrl();
  if (repoUrl) {
    provenance.gitRepoUrl = repoUrl;
  }

  const branch = getCurrentBranch();
  if (branch) {
    provenance.gitRef = branch;
  }

  const sha = getCommitSha();
  if (sha) {
    provenance.gitCommitSha = sha;
  }

  if (filePath) {
    const gitPath = getGitPath(filePath);
    if (gitPath) {
      provenance.gitPath = gitPath;
    }
  }

  return provenance;
}

/**
 * Check if there are uncommitted changes
 */
export function hasUncommittedChanges(): boolean {
  try {
    const status = execSync("git status --porcelain", { stdio: "pipe" })
      .toString()
      .trim();
    return status.length > 0;
  } catch {
    return false;
  }
}
