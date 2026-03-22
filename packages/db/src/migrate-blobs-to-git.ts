/**
 * Backfill script: migrate existing blob-backed artifact versions to git storage.
 *
 * For each namespace:
 *   1. Init git repo if not exists
 *   2. For each artifact, for each version (ordered ASC):
 *      - Skip if git_commit_sha already set (idempotent)
 *      - Read content from FileBlobStore via storage_key
 *      - Derive local git path from artifact slug/id + content_type
 *      - Commit to namespace git repo with original version message
 *      - Update artifact_versions row: set git_commit_sha + git_path
 *
 * IMPORTANT: Stop the API server before running this script.
 * The script does not acquire namespace locks, so concurrent API writes
 * during migration could corrupt git history.
 *
 * Not auto-run — invoke manually:
 *   pnpm --filter @attach/db exec tsx src/migrate-blobs-to-git.ts
 *
 * Requires env vars: DATABASE_PATH, BLOB_STORAGE_PATH
 */


import { getExtensionForContentType } from "@attach/shared";
import { initDb, migrate } from "./index.js";
import { FileBlobStore } from "./blob.js";
import { IsomorphicGitArtifactStore, validateArtifactPathSegment } from "./git-artifact-store.js";

async function main() {
  const dbPath = process.env["DATABASE_PATH"] ?? "./data/attach.db";
  const blobPath = process.env["BLOB_STORAGE_PATH"] ?? "./data/blobs";

  console.log(`Database: ${dbPath}`);
  console.log(`Blob storage: ${blobPath}`);

  const db = initDb({ path: dbPath });
  migrate(db);
  const blobStore = new FileBlobStore(blobPath);
  const gitStore = new IsomorphicGitArtifactStore(blobPath);
  // Get all namespaces
  const allNamespaces = db
    .prepare("SELECT id FROM namespaces")
    .all() as Array<{ id: string }>;

  let totalMigrated = 0;
  let totalSkipped = 0;

  for (const ns of allNamespaces) {
    console.log(`\nProcessing namespace: ${ns.id}`);

    // Init git repo
    await gitStore.initNamespaceRepo(ns.id);

    // Get all artifacts in this namespace
    const artifactRows = db
      .prepare(
        "SELECT id, slug, content_type FROM artifacts WHERE namespace_id = ? ORDER BY created_at ASC"
      )
      .all(ns.id) as Array<{
      id: string;
      slug: string | null;
      content_type: string;
    }>;

    for (const artifact of artifactRows) {
      const ext = getExtensionForContentType(artifact.content_type);
      const pathSegment = artifact.slug ?? artifact.id;
      const safeSegment = validateArtifactPathSegment(pathSegment) !== null ? artifact.id : pathSegment;
      const gitPath = `${safeSegment}/content.${ext}`;

      // Get versions ordered ASC (chronological order for git commits)
      const versions = db
        .prepare(
          "SELECT id, version, storage_key, message, created_by, git_commit_sha FROM artifact_versions WHERE artifact_id = ? ORDER BY version ASC"
        )
        .all(artifact.id) as Array<{
        id: string;
        version: number;
        storage_key: string;
        message: string | null;
        created_by: string;
        git_commit_sha: string | null;
      }>;

      for (const version of versions) {
        // Idempotent — skip if already migrated
        if (version.git_commit_sha) {
          totalSkipped++;
          continue;
        }

        // Read from blob store
        const content = blobStore.get(version.storage_key);
        if (!content) {
          console.warn(
            `  WARNING: Missing blob for artifact ${artifact.id} v${version.version} (storage_key: ${version.storage_key})`
          );
          continue;
        }

        // Commit to git. On partial-failure re-runs (git committed but DB update
        // failed), this creates a duplicate commit with identical content — harmless
        // for a one-time migration, and the returned SHA will be correct.
        const commitMessage =
          version.message ?? `Version ${version.version}`;
        const commitSha = await gitStore.commitArtifact(
          ns.id,
          gitPath,
          content,
          commitMessage,
          version.created_by
        );

        // Update version row
        db.prepare(
          "UPDATE artifact_versions SET git_commit_sha = ?, git_path = ? WHERE id = ?"
        ).run(commitSha, gitPath, version.id);

        totalMigrated++;
      }
    }
  }

  console.log(`\nMigration complete.`);
  console.log(`  Migrated: ${totalMigrated} versions`);
  console.log(`  Skipped (already migrated): ${totalSkipped} versions`);

  db.close();
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
