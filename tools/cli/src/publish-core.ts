import { randomBytes } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { basename, extname } from "node:path";
import { requireConfig } from "./config.js";
import {
  captureGitProvenance,
  isGitRepo,
  hasUncommittedChanges,
} from "./git.js";
import { AttachClient } from "./client.js";
import type { Artifact, AttachClientConfig } from "./client.js";

export interface PublishOptions {
  namespace?: string;
  title?: string;
  description?: string;
  slug?: string;
  message?: string;
  content?: string;
  contentType?: string;
  update?: string;
  git: boolean;
}

export interface HandoffEnvelope {
  recipient: string;
  threadId?: string;
  handoffKind?: string;
  replyToArtifactId?: string;
}

export interface PublishResult {
  artifact: Artifact;
  provenance: Record<string, unknown>;
  isUpdate: boolean;
}

/** Dependency injection for testability */
export interface PublishDependencies {
  clientFactory?: (config: AttachClientConfig) => AttachClient;
  readFile?: (path: string) => string;
  readStdin?: () => string;
  exists?: (path: string) => boolean;
  defaultContentProvider?: () => string | undefined;
  git?: {
    isGitRepo: () => boolean;
    captureGitProvenance: (file?: string) => Record<string, unknown>;
    hasUncommittedChanges: () => boolean;
  };
  requireConfig?: () => { api_url: string; api_key: string; default_namespace?: string };
  isTTY?: boolean;
}

function detectContentType(file: string): string {
  const ext = extname(file).toLowerCase();
  if (ext === ".md" || ext === ".markdown") return "text/markdown";
  if (ext === ".json") return "application/json";
  return "text/plain";
}

function generateThreadId(): string {
  const ts = Date.now().toString(36);
  const rand = randomBytes(4).toString("hex");
  return `handoff-${ts}-${rand}`;
}

export async function publishArtifact(
  file: string | undefined,
  options: PublishOptions,
  handoff?: HandoffEnvelope,
  deps?: PublishDependencies,
): Promise<PublishResult> {
  const configFn = deps?.requireConfig ?? requireConfig;
  const config = configFn();
  const clientFactory = deps?.clientFactory ?? ((c: AttachClientConfig) => new AttachClient(c));
  const client = clientFactory({ apiUrl: config.api_url, apiKey: config.api_key });
  const fileExists = deps?.exists ?? existsSync;
  const fileRead = deps?.readFile ?? ((p: string) => readFileSync(p, "utf-8"));
  const gitHelpers = deps?.git ?? { isGitRepo, captureGitProvenance, hasUncommittedChanges };

  // Resolve content
  let content: string | undefined;
  let contentType = options.contentType ?? "text/plain";
  let title = options.title;

  if (options.content) {
    content = options.content;
  } else if (file) {
    if (!fileExists(file)) {
      throw new Error(`File not found: ${file}`);
    }
    content = fileRead(file);
    if (!options.contentType) {
      contentType = detectContentType(file);
    }
    if (!title) {
      title = basename(file, extname(file));
    }
  } else {
    // Try stdin if not a TTY
    const isTTY = deps?.isTTY ?? process.stdin.isTTY;
    if (!isTTY) {
      const stdinReader = deps?.readStdin ?? (() => readFileSync(0, "utf-8"));
      try {
        content = stdinReader();
      } catch {
        // stdin not available
      }
    }

    // Try defaultContentProvider hook
    if (!content && deps?.defaultContentProvider) {
      content = deps.defaultContentProvider();
    }

    if (!content) {
      throw new Error("No content provided. Pass a file, use --content, or pipe stdin.");
    }
  }

  // Default to markdown for handoffs without explicit content-type
  if (handoff && !options.contentType && !file) {
    contentType = "text/markdown";
  }

  // Title fallback
  if (!title && handoff) {
    title = `Handoff to ${handoff.recipient}`;
  }
  if (!title) {
    throw new Error("Title is required. Use --title <title>");
  }

  // Namespace
  const namespaceSlug = options.namespace ?? config.default_namespace;
  if (!namespaceSlug && !options.update) {
    throw new Error("Namespace is required. Use --namespace <slug>");
  }

  // Git provenance
  let provenance: Record<string, unknown> = { source: "cli" };
  if (options.git !== false && gitHelpers.isGitRepo()) {
    const gitProvenance = gitHelpers.captureGitProvenance(file);
    provenance = { ...provenance, ...gitProvenance };

    if (gitHelpers.hasUncommittedChanges()) {
      console.warn(
        "Warning: You have uncommitted changes. Provenance may not match committed state.",
      );
    }
  }

  // Handoff envelope
  if (handoff) {
    if (!handoff.recipient.trim()) {
      throw new Error("Handoff recipient must not be empty");
    }
    provenance["senderRuntime"] = process.env["ATTACH_RUNTIME_KIND"] ?? "cli";
    provenance["recipient"] = handoff.recipient.trim();
    provenance["threadId"] = handoff.threadId ?? generateThreadId();
    provenance["handoffKind"] = handoff.handoffKind ?? "handoff";
    if (handoff.replyToArtifactId) {
      provenance["replyToArtifactId"] = handoff.replyToArtifactId;
    }
  }

  // Create or update
  let artifact: Artifact;
  let isUpdate = false;

  if (options.update) {
    const updateInput: Parameters<typeof client.updateArtifact>[1] = {
      content,
      provenance,
    };
    if (options.title) updateInput.title = options.title;
    if (options.description) updateInput.description = options.description;
    if (options.message) updateInput.message = options.message;

    artifact = await client.updateArtifact(options.update, updateInput);
    isUpdate = true;
  } else {
    const ns = await client.getNamespaceBySlug(namespaceSlug!);

    const createInput: Parameters<typeof client.createArtifact>[0] = {
      namespace_id: ns.id,
      title,
      content,
      content_type: contentType,
      provenance,
    };
    if (options.description) createInput.description = options.description;
    if (options.slug) createInput.slug = options.slug;
    if (options.message) createInput.message = options.message;

    artifact = await client.createArtifact(createInput);
  }

  return { artifact, provenance, isUpdate };
}
