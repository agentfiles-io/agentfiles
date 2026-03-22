import { describe, expect, it } from "vitest";
import { buildPublishProvenance, resolveNamespaceForPublish } from "./publish-utils.js";

describe("buildPublishProvenance", () => {
  it("auto-generates a thread ID and default kind for handoffs", () => {
    const { provenance, handoff } = buildPublishProvenance({
      runtimeKind: "codex",
      to: " claude_code ",
    });

    expect(provenance).toMatchObject({
      source: "mcp",
      senderRuntime: "codex",
      recipient: "claude_code",
      handoffKind: "handoff",
    });
    expect(handoff).toMatchObject({
      recipient: "claude_code",
      handoffKind: "handoff",
    });
    expect(handoff.threadId).toMatch(/^handoff-/);
    expect(provenance["threadId"]).toBe(handoff.threadId);
  });

  it("preserves explicit handoff metadata", () => {
    const { provenance, handoff } = buildPublishProvenance({
      to: "codex",
      thread: "pr-7-review",
      kind: "review_request",
      replyToArtifactId: "01ABC",
    });

    expect(provenance).toMatchObject({
      source: "mcp",
      recipient: "codex",
      threadId: "pr-7-review",
      handoffKind: "review_request",
      replyToArtifactId: "01ABC",
    });
    expect(handoff).toEqual({
      recipient: "codex",
      threadId: "pr-7-review",
      handoffKind: "review_request",
      replyToArtifactId: "01ABC",
    });
  });

  it("rejects empty handoff fields", () => {
    expect(() => buildPublishProvenance({ to: "   " })).toThrow(
      "Handoff recipient ('to') must not be empty",
    );
    expect(() => buildPublishProvenance({ thread: "   " })).toThrow("Thread ID must not be empty");
  });
});

describe("resolveNamespaceForPublish", () => {
  it("requires a namespace for creates", () => {
    expect(() => resolveNamespaceForPublish(undefined, undefined, undefined)).toThrow(
      "Namespace is required.",
    );
  });

  it("uses explicit or default namespace for creates", () => {
    expect(resolveNamespaceForPublish("docs", "fallback", undefined)).toBe("docs");
    expect(resolveNamespaceForPublish(undefined, "fallback", undefined)).toBe("fallback");
  });

  it("skips namespace lookup for updates by artifact ID", () => {
    expect(resolveNamespaceForPublish(undefined, undefined, "01ABC")).toBeNull();
    expect(resolveNamespaceForPublish("docs", "fallback", "01ABC")).toBeNull();
  });
});
