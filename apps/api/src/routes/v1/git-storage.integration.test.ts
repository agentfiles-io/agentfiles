import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";

import {
  Database,
  type DatabaseType,
  migrate,
  FileBlobStore,
  IsomorphicGitArtifactStore,
  PrincipalRepository,
  IdentityRepository,
  ApiKeyRepository,
  SessionRepository,
  NamespaceRepository,
  ArtifactRepository,
  AuditRepository,
  GrantRepository,
  ConnectSessionRepository,
  RuntimeInstanceRepository,
  setHmacSecret,
} from "@attach/db";
import type { GitArtifactStore } from "@attach/db";

import type { AuthContext } from "../../middleware/auth.js";
import { artifacts } from "./artifacts.js";

interface TestRepositories {
  principals: PrincipalRepository;
  identities: IdentityRepository;
  apiKeys: ApiKeyRepository;
  sessions: SessionRepository;
  namespaces: NamespaceRepository;
  artifacts: ArtifactRepository;
  audit: AuditRepository;
  grants: GrantRepository;
  connectSessions: ConnectSessionRepository;
  runtimeInstances: RuntimeInstanceRepository;
}

function createRepositories(db: DatabaseType): TestRepositories {
  return {
    principals: new PrincipalRepository(db),
    identities: new IdentityRepository(db),
    apiKeys: new ApiKeyRepository(db),
    sessions: new SessionRepository(db),
    namespaces: new NamespaceRepository(db),
    artifacts: new ArtifactRepository(db),
    audit: new AuditRepository(db),
    grants: new GrantRepository(db),
    connectSessions: new ConnectSessionRepository(db),
    runtimeInstances: new RuntimeInstanceRepository(db),
  };
}

function createTestApp(
  repositories: TestRepositories,
  blobStore: FileBlobStore,
  gitStore: GitArtifactStore,
  auth: AuthContext | null
): Hono {
  const app = new Hono();

  app.use("*", async (c, next) => {
    c.set("db", repositories);
    c.set("blob", blobStore);
    c.set("gitStore", gitStore);
    c.set("auth", auth);
    c.set("shareToken", null);
    await next();
  });

  app.route("/v1/artifacts", artifacts);
  return app;
}

describe("Git-backed artifact storage", () => {
  let db: DatabaseType;
  let repositories: TestRepositories;
  let blobStore: FileBlobStore;
  let gitStore: IsomorphicGitArtifactStore;
  let auth: AuthContext;
  let namespaceId: string;
  let tmpDir: string;
  let app: Hono;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "git-storage-test-"));
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    setHmacSecret("a]T7c!kR$mZ9v&bY2wQ#eX5pN8hJ0fDa");
    migrate(db);

    repositories = createRepositories(db);
    blobStore = new FileBlobStore(join(tmpDir, "blobs"));
    gitStore = new IsomorphicGitArtifactStore(join(tmpDir, "blobs"));

    const owner = repositories.principals.create({
      type: "user",
      name: "Test User",
    });

    const ns = repositories.namespaces.create({
      slug: "test-ns",
      name: "Test Namespace",
      ownerId: owner.id,
      visibility: "private",
    });
    namespaceId = ns.id;

    auth = {
      principal: owner,
      credential: {
        type: "api_key",
        id: "key_test",
        scope: {
          permissions: ["artifacts:read", "artifacts:write"],
        },
      },
    };

    app = createTestApp(repositories, blobStore, gitStore, auth);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates an artifact with git-backed storage and reads content back", async () => {
    const createRes = await app.request("/v1/artifacts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        namespace_id: namespaceId,
        title: "Test Doc",
        content: "Hello git world",
        content_type: "text/markdown",
        slug: "test-doc",
      }),
    });

    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { id: string; version: { version: number } };
    expect(created.version.version).toBe(1);

    // Verify git metadata is stored in the version row
    const version = repositories.artifacts.getVersionByNumber(created.id, 1);
    expect(version).not.toBeNull();
    expect(version!.git_commit_sha).toBeTruthy();
    expect(version!.git_path).toBe("test-doc/content.md");

    // Read content back via the API
    const contentRes = await app.request(`/v1/artifacts/${created.id}/content`);
    expect(contentRes.status).toBe(200);
    const content = await contentRes.text();
    expect(content).toBe("Hello git world");
  });

  it("updates an artifact creating new git commits per version", async () => {
    // Create
    const createRes = await app.request("/v1/artifacts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        namespace_id: namespaceId,
        title: "Evolving Doc",
        content: "Version 1 content",
        content_type: "text/plain",
        slug: "evolving",
      }),
    });
    const created = (await createRes.json()) as { id: string };

    // Update
    const updateRes = await app.request(`/v1/artifacts/${created.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "Version 2 content",
        message: "Updated content",
      }),
    });
    expect(updateRes.status).toBe(200);
    const updated = (await updateRes.json()) as { current_version: number };
    expect(updated.current_version).toBe(2);

    // Verify both versions have distinct git commits
    const v1 = repositories.artifacts.getVersionByNumber(created.id, 1);
    const v2 = repositories.artifacts.getVersionByNumber(created.id, 2);
    expect(v1!.git_commit_sha).toBeTruthy();
    expect(v2!.git_commit_sha).toBeTruthy();
    expect(v1!.git_commit_sha).not.toBe(v2!.git_commit_sha);
    expect(v1!.git_path).toBe(v2!.git_path); // same file path

    // Read v1 content
    const v1Res = await app.request(`/v1/artifacts/${created.id}/content?version=1`);
    expect(await v1Res.text()).toBe("Version 1 content");

    // Read v2 content
    const v2Res = await app.request(`/v1/artifacts/${created.id}/content?version=2`);
    expect(await v2Res.text()).toBe("Version 2 content");
  });

  it("reads legacy blob-backed versions when git metadata is null", async () => {
    // Simulate a legacy version by inserting directly via repository (no git metadata)
    const contentBuf = Buffer.from("legacy content", "utf-8");
    const storageKey = blobStore.put(contentBuf);
    const { createHash } = await import("node:crypto");
    const contentHash = createHash("sha256").update(contentBuf).digest("hex");

    const result = repositories.artifacts.create({
      namespaceId,
      title: "Legacy Artifact",
      contentType: "text/plain",
      createdBy: auth.principal.id,
      contentHash,
      contentSize: contentBuf.length,
      storageKey,
      provenance: { source: "api" },
    });

    // Version should have null git metadata
    const version = repositories.artifacts.getVersion(result.version.id);
    expect(version!.git_commit_sha).toBeNull();

    // Read via API — should fall back to blob store
    const contentRes = await app.request(`/v1/artifacts/${result.artifact.id}/content`);
    expect(contentRes.status).toBe(200);
    expect(await contentRes.text()).toBe("legacy content");
  });

  it("returns path-scoped diff between two git-backed versions", async () => {
    // Create artifact
    const createRes = await app.request("/v1/artifacts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        namespace_id: namespaceId,
        title: "Diff Test",
        content: "line1\nline2\nline3",
        content_type: "text/plain",
        slug: "diff-test",
      }),
    });
    const created = (await createRes.json()) as { id: string };

    // Update
    await app.request(`/v1/artifacts/${created.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "line1\nmodified\nline3\nline4",
      }),
    });

    // Get diff
    const diffRes = await app.request(
      `/v1/artifacts/${created.id}/diff?version_a=1&version_b=2`
    );
    expect(diffRes.status).toBe(200);
    const diff = await diffRes.text();

    // Diff should contain both + and - markers
    expect(diff).toContain("-");
    expect(diff).toContain("+");
    expect(diff).toContain("line1");
  });

  it("resetToEmpty removes rolled-back repo state before the next first write", async () => {
    const release = await gitStore.acquireNamespaceLock(namespaceId);

    try {
      await gitStore.commitArtifact(
        namespaceId,
        "first/content.txt",
        Buffer.from("first write", "utf-8"),
        "First write",
        auth.principal.id
      );

      await gitStore.resetToEmpty(namespaceId);
      expect(await gitStore.getHead(namespaceId)).toBeNull();

      const nextCommit = await gitStore.commitArtifact(
        namespaceId,
        "second/content.txt",
        Buffer.from("second write", "utf-8"),
        "Second write",
        auth.principal.id
      );

      const rolledBackContent = await gitStore.readAtCommit(namespaceId, "first/content.txt", nextCommit);
      const currentContent = await gitStore.readAtCommit(namespaceId, "second/content.txt", nextCommit);

      expect(rolledBackContent).toBeNull();
      expect(currentContent?.toString("utf-8")).toBe("second write");
    } finally {
      release();
    }
  });

  it("returns 409 when slug is already taken", async () => {
    // Create first artifact with slug
    await app.request("/v1/artifacts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        namespace_id: namespaceId,
        title: "First",
        content: "content",
        content_type: "text/plain",
        slug: "unique-slug",
      }),
    });

    // Try to create another with the same slug
    const dupRes = await app.request("/v1/artifacts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        namespace_id: namespaceId,
        title: "Duplicate",
        content: "content",
        content_type: "text/plain",
        slug: "unique-slug",
      }),
    });

    expect(dupRes.status).toBe(409);
    const body = (await dupRes.json()) as { error: string };
    expect(body.error).toBe("slug_taken");
  });
});
