import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { publishArtifact } from "./publish-core.js";
import type { PublishDependencies, HandoffEnvelope } from "./publish-core.js";
import type { Artifact, AttachClient } from "./client.js";

function makeArtifact(overrides?: Partial<Artifact>): Artifact {
  return {
    id: "art_01TEST",
    namespace_id: "ns_01TEST",
    slug: null,
    title: "Test",
    description: null,
    content_type: "text/plain",
    current_version: 1,
    visibility: "private",
    metadata: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function makeDeps(overrides?: Partial<PublishDependencies>): PublishDependencies {
  const mockClient = {
    createArtifact: vi.fn().mockResolvedValue(makeArtifact()),
    updateArtifact: vi.fn().mockResolvedValue(makeArtifact()),
    getNamespaceBySlug: vi.fn().mockResolvedValue({ id: "ns_01TEST", slug: "test-ns", name: "Test" }),
  } as unknown as AttachClient;

  return {
    requireConfig: () => ({ api_url: "http://localhost:3000", api_key: "arun_usr_test", default_namespace: "test-ns" }),
    clientFactory: () => mockClient,
    exists: () => true,
    readFile: () => "file content",
    isTTY: true,
    git: {
      isGitRepo: () => true,
      captureGitProvenance: () => ({ gitRepoUrl: "https://github.com/test/repo", gitRef: "main", gitCommitSha: "abc123" }),
      hasUncommittedChanges: () => false,
    },
    ...overrides,
  };
}

function getCreateCall(deps: PublishDependencies): Record<string, unknown> {
  const client = deps.clientFactory!({ apiUrl: "", apiKey: "" });
  return (client.createArtifact as ReturnType<typeof vi.fn>).mock.calls[0]![0] as Record<string, unknown>;
}

describe("publishArtifact", () => {
  const originalEnv = process.env["ATTACH_RUNTIME_KIND"];

  beforeEach(() => {
    delete process.env["ATTACH_RUNTIME_KIND"];
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env["ATTACH_RUNTIME_KIND"] = originalEnv;
    } else {
      delete process.env["ATTACH_RUNTIME_KIND"];
    }
  });

  it("plain publish (no handoff) — no handoff fields in provenance", async () => {
    const deps = makeDeps();
    const result = await publishArtifact("report.md", { git: true }, undefined, deps);

    expect(result.isUpdate).toBe(false);
    expect(result.provenance["source"]).toBe("cli");
    expect(result.provenance["gitRepoUrl"]).toBe("https://github.com/test/repo");
    expect(result.provenance["recipient"]).toBeUndefined();
    expect(result.provenance["senderRuntime"]).toBeUndefined();
    expect(result.provenance["threadId"]).toBeUndefined();
  });

  it("handoff with --content — provenance has recipient, senderRuntime, default handoffKind", async () => {
    const deps = makeDeps();
    const handoff: HandoffEnvelope = { recipient: "codex" };

    const result = await publishArtifact(undefined, { content: "review this", git: true }, handoff, deps);

    expect(result.provenance["recipient"]).toBe("codex");
    expect(result.provenance["senderRuntime"]).toBe("cli");
    expect(result.provenance["handoffKind"]).toBe("handoff");
    expect(result.provenance["threadId"]).toMatch(/^handoff-/);
  });

  it("senderRuntime uses ATTACH_RUNTIME_KIND env when set", async () => {
    process.env["ATTACH_RUNTIME_KIND"] = "claude_code";
    const deps = makeDeps();
    const handoff: HandoffEnvelope = { recipient: "codex" };

    const result = await publishArtifact(undefined, { content: "hello", git: false }, handoff, deps);

    expect(result.provenance["senderRuntime"]).toBe("claude_code");
  });

  it("senderRuntime falls back to 'cli' when env absent", async () => {
    delete process.env["ATTACH_RUNTIME_KIND"];
    const deps = makeDeps();
    const handoff: HandoffEnvelope = { recipient: "codex" };

    const result = await publishArtifact(undefined, { content: "hello", git: false }, handoff, deps);

    expect(result.provenance["senderRuntime"]).toBe("cli");
  });

  it("threadId auto-generated when not provided", async () => {
    const deps = makeDeps();
    const handoff: HandoffEnvelope = { recipient: "codex" };

    const result = await publishArtifact(undefined, { content: "hello", git: false }, handoff, deps);

    expect(result.provenance["threadId"]).toMatch(/^handoff-[a-z0-9]+-[a-z0-9]+$/);
  });

  it("git provenance merges alongside handoff fields", async () => {
    const deps = makeDeps();
    const handoff: HandoffEnvelope = { recipient: "codex", threadId: "my-thread" };

    const result = await publishArtifact(undefined, { content: "hello", git: true }, handoff, deps);

    expect(result.provenance["gitRepoUrl"]).toBe("https://github.com/test/repo");
    expect(result.provenance["recipient"]).toBe("codex");
    expect(result.provenance["threadId"]).toBe("my-thread");
  });

  it("--no-git skips git provenance but handoff fields still present", async () => {
    const deps = makeDeps();
    const handoff: HandoffEnvelope = { recipient: "codex" };

    const result = await publishArtifact(undefined, { content: "hello", git: false }, handoff, deps);

    expect(result.provenance["gitRepoUrl"]).toBeUndefined();
    expect(result.provenance["recipient"]).toBe("codex");
    expect(result.provenance["senderRuntime"]).toBe("cli");
  });

  it("replyToArtifactId included when provided", async () => {
    const deps = makeDeps();
    const handoff: HandoffEnvelope = {
      recipient: "claude_code",
      replyToArtifactId: "art_01REPLY",
      threadId: "thread-1",
    };

    const result = await publishArtifact(undefined, { content: "LGTM", git: false }, handoff, deps);

    expect(result.provenance["replyToArtifactId"]).toBe("art_01REPLY");
  });

  it("title fallback: 'Handoff to <recipient>' when no explicit title or file", async () => {
    const deps = makeDeps();
    const handoff: HandoffEnvelope = { recipient: "codex" };

    const result = await publishArtifact(undefined, { content: "hello", git: false }, handoff, deps);

    expect(result.artifact).toBeDefined();
    // Check that the create call used the fallback title
    const call = getCreateCall(deps);
    expect(call["title"]).toBe("Handoff to codex");
  });

  it("stdin fallback works when no file and no --content", async () => {
    const readStdin = vi.fn().mockReturnValue("piped stdin content");
    const deps = makeDeps({ isTTY: false, readStdin });

    const result = await publishArtifact(undefined, { title: "Test", git: false }, undefined, deps);

    expect(readStdin).toHaveBeenCalled();
    expect(result.artifact).toBeDefined();
    const call = getCreateCall(deps);
    expect(call["content"]).toBe("piped stdin content");
  });

  it("defaultContentProvider() hook works", async () => {
    const deps = makeDeps({
      isTTY: true,
      defaultContentProvider: () => "provided content",
    });

    const result = await publishArtifact(undefined, { title: "Hook Test", git: false }, undefined, deps);

    expect(result.artifact).toBeDefined();
    const call = getCreateCall(deps);
    expect(call["content"]).toBe("provided content");
  });

  it("errors when no content source available", async () => {
    const deps = makeDeps({ isTTY: true });

    await expect(
      publishArtifact(undefined, { title: "No Content", git: false }, undefined, deps),
    ).rejects.toThrow("No content provided");
  });

  it("handoff defaults content-type to text/markdown when no file", async () => {
    const deps = makeDeps();
    const handoff: HandoffEnvelope = { recipient: "codex" };

    await publishArtifact(undefined, { content: "review this", git: false }, handoff, deps);

    const call = getCreateCall(deps);
    expect(call["content_type"]).toBe("text/markdown");
  });
});
