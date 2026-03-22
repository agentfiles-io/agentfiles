import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";

import { AttachClient } from "./client.js";
import type { ResolvedMcpConfig } from "./config.js";
import { buildPublishProvenance, resolveNamespaceForPublish } from "./publish-utils.js";

let client: AttachClient;
let serverConfig: ResolvedMcpConfig;

export function initServer(config: ResolvedMcpConfig): void {
  serverConfig = config;
  client = new AttachClient(config);
}

function resolveNamespace(explicit: string | undefined): string {
  const ns = explicit ?? serverConfig.defaultNamespace;
  if (!ns) {
    throw new McpError(
      ErrorCode.InvalidParams,
      "Namespace is required. Pass a namespace parameter or run: agentfiles config --default-namespace <slug>",
    );
  }
  return ns;
}

// Create MCP server
export const server = new Server(
  {
    name: "agentfiles",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
      resources: {},
    },
  }
);

// Tool definitions
const TOOLS = [
  {
    name: "artifact_get",
    description: "Get an artifact by its ID",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: {
          type: "string",
          description: "The artifact ID (ULID)",
        },
        include_content: {
          type: "boolean",
          description: "Whether to include the artifact content (default: true)",
          default: true,
        },
        version: {
          type: "number",
          description: "Specific version number (default: latest)",
        },
      },
      required: ["id"],
    },
  },
  {
    name: "artifact_get_latest",
    description: "Get the most recently updated artifact in a namespace",
    inputSchema: {
      type: "object" as const,
      properties: {
        namespace: {
          type: "string",
          description: "Namespace slug (uses default namespace if omitted)",
        },
        include_content: {
          type: "boolean",
          description: "Whether to include the artifact content (default: true)",
          default: true,
        },
      },
      required: [],
    },
  },
  {
    name: "artifact_search",
    description: "Search for artifacts by query string",
    inputSchema: {
      type: "object" as const,
      properties: {
        namespace: {
          type: "string",
          description: "Namespace slug to search in (uses default namespace if omitted)",
        },
        query: {
          type: "string",
          description: "Search query (matches title and description)",
        },
        limit: {
          type: "number",
          description: "Maximum number of results (default: 10, max: 50)",
          default: 10,
        },
      },
      required: ["query"],
    },
  },
  {
    name: "artifact_list_recent",
    description: "List recent artifacts in a namespace",
    inputSchema: {
      type: "object" as const,
      properties: {
        namespace: {
          type: "string",
          description: "Namespace slug (uses default namespace if omitted)",
        },
        limit: {
          type: "number",
          description: "Maximum number of results (default: 10, max: 50)",
          default: 10,
        },
        content_type: {
          type: "string",
          description: "Filter by content type (e.g., text/markdown)",
        },
      },
      required: [],
    },
  },
  {
    name: "artifact_diff",
    description: "Compare two versions of an artifact",
    inputSchema: {
      type: "object" as const,
      properties: {
        id: {
          type: "string",
          description: "The artifact ID",
        },
        version_a: {
          type: "number",
          description: "First version number",
        },
        version_b: {
          type: "number",
          description: "Second version number",
        },
      },
      required: ["id", "version_a", "version_b"],
    },
  },
  {
    name: "namespace_list",
    description: "List available namespaces",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "artifact_publish",
    description: "Create or update an artifact",
    inputSchema: {
      type: "object" as const,
      properties: {
        namespace: {
          type: "string",
          description: "Namespace slug to publish to (uses default namespace if omitted)",
        },
        title: {
          type: "string",
          description: "Artifact title",
        },
        content: {
          type: "string",
          description: "Artifact content (text)",
        },
        content_type: {
          type: "string",
          description: "MIME type (default: text/plain)",
          enum: ["text/plain", "text/markdown", "application/json"],
        },
        description: {
          type: "string",
          description: "Brief description",
        },
        slug: {
          type: "string",
          description: "URL-friendly identifier (optional)",
        },
        artifact_id: {
          type: "string",
          description: "Existing artifact ID to update (creates new version)",
        },
        message: {
          type: "string",
          description: "Version message (like a commit message)",
        },
        to: {
          type: "string",
          description: "Recipient runtime (e.g., 'codex', 'claude_code') for handoff envelope",
        },
        thread: {
          type: "string",
          description: "Thread ID for grouping related handoff artifacts",
        },
        kind: {
          type: "string",
          description: "Handoff kind (e.g., 'review_request', 'feedback', 'task')",
        },
        reply_to_artifact_id: {
          type: "string",
          description: "Artifact ID this is replying to in a handoff thread",
        },
      },
      required: ["title", "content"],
    },
  },
  {
    name: "artifact_share",
    description: "Create a share link for an artifact",
    inputSchema: {
      type: "object" as const,
      properties: {
        artifact_id: {
          type: "string",
          description: "Artifact ID to share",
        },
        namespace_id: {
          type: "string",
          description: "Namespace ID (required if not sharing specific artifact)",
        },
        expires_in_days: {
          type: "number",
          description: "Number of days until link expires (default: 7)",
        },
      },
      required: ["artifact_id"],
    },
  },
  {
    name: "git_import",
    description: "Import a file from a git repository (GitHub, GitLab, Bitbucket)",
    inputSchema: {
      type: "object" as const,
      properties: {
        repo_url: {
          type: "string",
          description: "Git repository URL (e.g., https://github.com/owner/repo)",
        },
        path: {
          type: "string",
          description: "Path to the file in the repository",
        },
        branch: {
          type: "string",
          description: "Branch name (default: main)",
        },
        namespace: {
          type: "string",
          description: "Namespace slug to import into (uses default namespace if omitted)",
        },
        title: {
          type: "string",
          description: "Artifact title (default: filename)",
        },
        description: {
          type: "string",
          description: "Brief description",
        },
        slug: {
          type: "string",
          description: "URL-friendly identifier (optional)",
        },
      },
      required: ["repo_url", "path"],
    },
  },
  {
    name: "git_sync",
    description: "Sync an artifact with its git source (fetch latest and create new version if changed)",
    inputSchema: {
      type: "object" as const,
      properties: {
        artifact_id: {
          type: "string",
          description: "Artifact ID to sync",
        },
      },
      required: ["artifact_id"],
    },
  },
];

// Handle list tools request
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: TOOLS };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "artifact_get": {
        const { id, include_content = true, version } = args as {
          id: string;
          include_content?: boolean;
          version?: number;
        };

        const artifact = await client.getArtifact(id);
        let content: string | undefined;

        if (include_content) {
          content = await client.getArtifactContent(id, version);
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  ...artifact,
                  content: content,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "artifact_get_latest": {
        const { namespace: rawNs, include_content = true } = args as {
          namespace?: string;
          include_content?: boolean;
        };
        const namespace = resolveNamespace(rawNs);

        const artifact = await client.getLatestArtifact(namespace);
        if (!artifact) {
          return {
            content: [
              {
                type: "text",
                text: "No artifacts found in namespace",
              },
            ],
          };
        }

        let content: string | undefined;
        if (include_content) {
          content = await client.getArtifactContent(artifact.id);
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  ...artifact,
                  content: content,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "artifact_search": {
        const { namespace: rawNs, query, limit = 10 } = args as {
          namespace?: string;
          query: string;
          limit?: number;
        };
        const namespace = resolveNamespace(rawNs);

        const result = await client.searchArtifacts(
          namespace,
          query,
          Math.min(limit, 50)
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case "artifact_list_recent": {
        const { namespace: rawNs, limit = 10, content_type } = args as {
          namespace?: string;
          limit?: number;
          content_type?: string;
        };
        const namespace = resolveNamespace(rawNs);

        const options: { limit: number; content_type?: string } = {
          limit: Math.min(limit, 50),
        };
        if (content_type) {
          options.content_type = content_type;
        }

        const result = await client.listArtifacts(namespace, options);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case "artifact_diff": {
        const { id, version_a, version_b } = args as {
          id: string;
          version_a: number;
          version_b: number;
        };

        // Use server-side diff endpoint (path-scoped git diff when available)
        const diff = await client.diffArtifact(id, version_a, version_b);

        return {
          content: [
            {
              type: "text",
              text: diff,
            },
          ],
        };
      }

      case "namespace_list": {
        const result = await client.listNamespaces();
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case "artifact_publish": {
        const typedArgs = args as {
          namespace?: string;
          title: string;
          content: string;
          content_type?: string;
          description?: string;
          slug?: string;
          artifact_id?: string;
          message?: string;
          to?: string;
          thread?: string;
          kind?: string;
          reply_to_artifact_id?: string;
        };

        let namespaceSlug: string | null;
        let provenance: Record<string, unknown>;
        let handoff: {
          recipient?: string;
          threadId?: string;
          handoffKind?: string;
          replyToArtifactId?: string;
        };

        try {
          namespaceSlug = resolveNamespaceForPublish(
            typedArgs.namespace,
            serverConfig.defaultNamespace,
            typedArgs.artifact_id,
          );
          ({ provenance, handoff } = buildPublishProvenance({
            runtimeKind: process.env["ATTACH_RUNTIME_KIND"],
            to: typedArgs.to,
            thread: typedArgs.thread,
            kind: typedArgs.kind,
            replyToArtifactId: typedArgs.reply_to_artifact_id,
          }));
        } catch (error) {
          throw new McpError(
            ErrorCode.InvalidParams,
            error instanceof Error ? error.message : "Invalid publish parameters",
          );
        }

        let result;
        if (typedArgs.artifact_id) {
          // Update existing artifact - build input conditionally
          const updateInput: import("./client.js").UpdateArtifactInput = {
            content: typedArgs.content,
            provenance,
          };
          if (typedArgs.title) updateInput.title = typedArgs.title;
          if (typedArgs.description) updateInput.description = typedArgs.description;
          if (typedArgs.message) updateInput.message = typedArgs.message;

          result = await client.updateArtifact(typedArgs.artifact_id, updateInput);
        } else {
          const ns = await client.getNamespace(namespaceSlug!);

          // Create new artifact - build input conditionally
          const createInput: import("./client.js").CreateArtifactInput = {
            namespace_id: ns.id,
            title: typedArgs.title,
            content: typedArgs.content,
            content_type: typedArgs.content_type ?? "text/plain",
            provenance,
          };
          if (typedArgs.description) createInput.description = typedArgs.description;
          if (typedArgs.slug) createInput.slug = typedArgs.slug;
          if (typedArgs.message) createInput.message = typedArgs.message;

          result = await client.createArtifact(createInput);
        }

        const response: Record<string, unknown> = {
          id: result.id,
          title: result.title,
          current_version: result.current_version,
          message: typedArgs.artifact_id ? "Artifact updated" : "Artifact created",
        };
        if (handoff.recipient) response["recipient"] = handoff.recipient;
        if (handoff.threadId) response["thread_id"] = handoff.threadId;
        if (handoff.handoffKind) response["handoff_kind"] = handoff.handoffKind;
        if (handoff.replyToArtifactId) response["reply_to_artifact_id"] = handoff.replyToArtifactId;

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(response, null, 2),
            },
          ],
        };
      }

      case "artifact_share": {
        const { artifact_id, namespace_id, expires_in_days = 7 } = args as {
          artifact_id: string;
          namespace_id?: string;
          expires_in_days?: number;
        };

        // Get artifact to find namespace_id if not provided
        const artifact = await client.getArtifact(artifact_id);
        const nsId = namespace_id ?? artifact.namespace_id;

        // Calculate expiry
        const expiresAt = new Date(
          Date.now() + expires_in_days * 24 * 60 * 60 * 1000
        ).toISOString();

        const grant = await client.createGrant({
          namespace_id: nsId,
          artifact_id,
          permissions: ["read"],
          expires_at: expiresAt,
        });

        // Build share URL
        const shareUrl = new URL(`/a/${artifact_id}`, serverConfig.shareBaseUrl).toString();

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  share_url: shareUrl,
                  token: grant.token,
                  token_header: "X-Share-Token",
                  expires_at: expiresAt,
                  artifact_id,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "git_import": {
        const typedArgs = args as {
          repo_url: string;
          path: string;
          branch?: string;
          namespace?: string;
          title?: string;
          description?: string;
          slug?: string;
        };

        // Get namespace to find namespace_id
        const ns = await client.getNamespace(resolveNamespace(typedArgs.namespace));

        const importInput: Parameters<typeof client.gitImport>[0] = {
          repo_url: typedArgs.repo_url,
          path: typedArgs.path,
          namespace_id: ns.id,
        };
        if (typedArgs.branch) importInput.branch = typedArgs.branch;
        if (typedArgs.title) importInput.title = typedArgs.title;
        if (typedArgs.description) importInput.description = typedArgs.description;
        if (typedArgs.slug) importInput.slug = typedArgs.slug;

        const result = await client.gitImport(importInput);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  id: result.id,
                  title: result.title,
                  slug: result.slug,
                  version: result.current_version,
                  content_type: result.content_type,
                  source: {
                    repo_url: typedArgs.repo_url,
                    path: typedArgs.path,
                    branch: typedArgs.branch ?? "main",
                  },
                  message: "Artifact imported from git",
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "git_sync": {
        const { artifact_id } = args as { artifact_id: string };

        const result = await client.gitSync(artifact_id);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [
        {
          type: "text",
          text: `Error: ${message}`,
        },
      ],
      isError: true,
    };
  }
});

// Resource definitions
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  // List namespaces as resources
  try {
    const { namespaces } = await client.listNamespaces();

    const resources = namespaces.map((ns) => ({
      uri: `namespace://${ns.slug}/latest`,
      name: `${ns.name} - Latest Artifact`,
      description: `Most recent artifact in ${ns.name}`,
      mimeType: "application/json",
    }));

    return { resources };
  } catch {
    return { resources: [] };
  }
});

// Handle resource reads
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;

  try {
    // Parse URI: artifact://{id} or artifact://{id}/v/{version} or namespace://{slug}/latest
    if (uri.startsWith("artifact://")) {
      const path = uri.replace("artifact://", "");
      const versionMatch = path.match(/^(.+)\/v\/(\d+)$/);

      let id: string;
      let version: number | undefined;

      if (versionMatch) {
        id = versionMatch[1]!;
        version = parseInt(versionMatch[2]!, 10);
      } else {
        id = path;
      }

      const artifact = await client.getArtifact(id);
      const content = await client.getArtifactContent(id, version);

      return {
        contents: [
          {
            uri,
            mimeType: artifact.content_type,
            text: content,
          },
        ],
      };
    }

    if (uri.startsWith("namespace://")) {
      const path = uri.replace("namespace://", "");
      const match = path.match(/^(.+)\/latest$/);

      if (!match) {
        throw new McpError(ErrorCode.InvalidRequest, "Invalid namespace URI");
      }

      const namespaceSlug = match[1]!;
      const artifact = await client.getLatestArtifact(namespaceSlug);

      if (!artifact) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          "No artifacts in namespace"
        );
      }

      const content = await client.getArtifactContent(artifact.id);

      return {
        contents: [
          {
            uri,
            mimeType: artifact.content_type,
            text: content,
          },
        ],
      };
    }

    throw new McpError(ErrorCode.InvalidRequest, `Unknown URI scheme: ${uri}`);
  } catch (error) {
    if (error instanceof McpError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new McpError(ErrorCode.InternalError, message);
  }
});
