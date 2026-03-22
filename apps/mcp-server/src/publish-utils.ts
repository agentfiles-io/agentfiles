import { randomBytes } from "node:crypto";

export interface PublishHandoffInput {
  runtimeKind?: string | undefined;
  to?: string | undefined;
  thread?: string | undefined;
  kind?: string | undefined;
  replyToArtifactId?: string | undefined;
}

export interface PublishHandoffMetadata {
  recipient?: string;
  threadId?: string;
  handoffKind?: string;
  replyToArtifactId?: string;
}

function normalizeOptionalField(label: string, value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${label} must not be empty`);
  }

  return trimmed;
}

export function generateThreadId(): string {
  const ts = Date.now().toString(36);
  const rand = randomBytes(4).toString("hex");
  return `handoff-${ts}-${rand}`;
}

export function resolveNamespaceForPublish(
  explicitNamespace: string | undefined,
  defaultNamespace: string | undefined,
  artifactId: string | undefined,
): string | null {
  if (artifactId) {
    return null;
  }

  const namespace = explicitNamespace ?? defaultNamespace;
  if (!namespace) {
    throw new Error(
      "Namespace is required. Pass a namespace parameter or run: agentfiles config --default-namespace <slug>",
    );
  }

  return namespace;
}

export function buildPublishProvenance(
  input: PublishHandoffInput,
): {
  provenance: Record<string, unknown>;
  handoff: PublishHandoffMetadata;
} {
  const recipient = normalizeOptionalField("Handoff recipient ('to')", input.to);
  const explicitThreadId = normalizeOptionalField("Thread ID", input.thread);
  const explicitHandoffKind = normalizeOptionalField("Handoff kind", input.kind);
  const replyToArtifactId = normalizeOptionalField("Reply-to artifact ID", input.replyToArtifactId);

  const threadId = explicitThreadId ?? (recipient ? generateThreadId() : undefined);
  const handoffKind = explicitHandoffKind ?? (recipient ? "handoff" : undefined);

  const provenance: Record<string, unknown> = { source: "mcp" };
  if (input.runtimeKind?.trim()) {
    provenance["senderRuntime"] = input.runtimeKind.trim();
  }
  if (recipient) {
    provenance["recipient"] = recipient;
  }
  if (threadId) {
    provenance["threadId"] = threadId;
  }
  if (handoffKind) {
    provenance["handoffKind"] = handoffKind;
  }
  if (replyToArtifactId) {
    provenance["replyToArtifactId"] = replyToArtifactId;
  }

  const handoff: PublishHandoffMetadata = {};
  if (recipient) {
    handoff.recipient = recipient;
  }
  if (threadId) {
    handoff.threadId = threadId;
  }
  if (handoffKind) {
    handoff.handoffKind = handoffKind;
  }
  if (replyToArtifactId) {
    handoff.replyToArtifactId = replyToArtifactId;
  }

  return { provenance, handoff };
}
