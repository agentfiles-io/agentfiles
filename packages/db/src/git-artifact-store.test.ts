import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { IsomorphicGitArtifactStore } from "./git-artifact-store.js";

async function getDirectorySizeBytes(dir: string): Promise<number> {
  let total = 0;
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await getDirectorySizeBytes(entryPath);
      continue;
    }

    total += (await lstat(entryPath)).size;
  }

  return total;
}

describe("IsomorphicGitArtifactStore.getRepoSizeBytes", () => {
  let tmpDir: string;
  let store: IsomorphicGitArtifactStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "git-artifact-store-test-"));
    store = new IsomorphicGitArtifactStore(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns the on-disk size of a namespace repo", async () => {
    const namespaceId = "ns-test";
    expect(await store.getRepoSizeBytes(namespaceId)).toBe(0);

    const release = await store.acquireNamespaceLock(namespaceId);
    try {
      await store.commitArtifact(
        namespaceId,
        "first/content.txt",
        Buffer.from("first write", "utf-8"),
        "First write",
        "tester"
      );

      const repoDir = join(tmpDir, "repos", namespaceId);
      const firstSize = await store.getRepoSizeBytes(namespaceId);
      expect(firstSize).toBeGreaterThan(0);
      expect(firstSize).toBe(await getDirectorySizeBytes(repoDir));

      await store.commitArtifact(
        namespaceId,
        "second/content.txt",
        Buffer.from("second write", "utf-8"),
        "Second write",
        "tester"
      );

      const secondSize = await store.getRepoSizeBytes(namespaceId);
      expect(secondSize).toBeGreaterThan(firstSize);
      expect(secondSize).toBe(await getDirectorySizeBytes(repoDir));
    } finally {
      release();
    }
  });
});
