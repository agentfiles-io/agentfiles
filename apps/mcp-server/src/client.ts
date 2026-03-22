/**
 * API client for AgentFiles backend
 */

export interface AttachConfig {
  baseUrl: string;
  apiKey: string;
}

export interface Artifact {
  id: string;
  namespace_id: string;
  slug: string | null;
  title: string;
  description: string | null;
  content_type: string;
  current_version: number;
  visibility: "private" | "public";
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface ArtifactVersion {
  id: string;
  version: number;
  content_hash: string;
  content_size: number;
  message: string | null;
  provenance: Record<string, unknown>;
  git_commit_sha: string | null;
  git_path: string | null;
  created_at: string;
  created_by: string;
}

export interface Namespace {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  visibility: "private" | "public";
}

export interface SearchResult {
  artifacts: Array<Artifact & { score?: number }>;
}

export interface ApiError {
  error: string;
  message: string;
}

export interface CreateArtifactInput {
  namespace_id: string;
  title: string;
  content: string;
  content_type?: string;
  description?: string;
  slug?: string;
  metadata?: Record<string, unknown>;
  message?: string;
  provenance?: Record<string, unknown>;
}

export interface UpdateArtifactInput {
  content: string;
  title?: string;
  description?: string;
  message?: string;
  metadata?: Record<string, unknown>;
  provenance?: Record<string, unknown>;
}

export class AttachClient {
  private baseUrl: string;
  private apiKey: string;

  constructor(config: AttachConfig) {
    this.baseUrl = config.baseUrl.replace(/\/$/, "");
    this.apiKey = config.apiKey;
  }

  private async request<T>(
    path: string,
    options: RequestInit = {}
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const response = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
        ...options.headers,
      },
    });

    if (!response.ok) {
      const error = (await response.json().catch(() => ({
        error: "unknown",
        message: response.statusText,
      }))) as ApiError;
      throw new Error(`API Error: ${error.message} (${error.error})`);
    }

    return response.json() as Promise<T>;
  }

  /**
   * Get an artifact by ID
   */
  async getArtifact(id: string): Promise<Artifact> {
    return this.request<Artifact>(`/v1/artifacts/${id}`);
  }

  /**
   * Get artifact content
   */
  async getArtifactContent(id: string, version?: number): Promise<string> {
    const path = version
      ? `/v1/artifacts/${id}/content?version=${version}`
      : `/v1/artifacts/${id}/content`;

    const response = await fetch(`${this.baseUrl}${path}`, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
    });

    if (!response.ok) {
      const error = (await response.json().catch(() => ({
        error: "unknown",
        message: response.statusText,
      }))) as ApiError;
      throw new Error(`API Error: ${error.message} (${error.error})`);
    }

    return response.text();
  }

  /**
   * List artifact versions
   */
  async listVersions(id: string): Promise<{ versions: ArtifactVersion[] }> {
    return this.request<{ versions: ArtifactVersion[] }>(
      `/v1/artifacts/${id}/versions`
    );
  }

  /**
   * List artifacts in a namespace
   */
  async listArtifacts(
    namespaceSlug: string,
    options?: {
      limit?: number;
      offset?: number;
      content_type?: string;
    }
  ): Promise<{ artifacts: Artifact[] }> {
    const params = new URLSearchParams();
    if (options?.limit) params.set("limit", options.limit.toString());
    if (options?.offset) params.set("offset", options.offset.toString());
    if (options?.content_type) params.set("content_type", options.content_type);

    const query = params.toString();
    const path = `/v1/namespaces/${namespaceSlug}/artifacts${query ? `?${query}` : ""}`;

    return this.request<{ artifacts: Artifact[] }>(path);
  }

  /**
   * Get namespace by slug
   */
  async getNamespace(slug: string): Promise<Namespace> {
    return this.request<Namespace>(`/v1/namespaces/${slug}`);
  }

  /**
   * List accessible namespaces
   */
  async listNamespaces(): Promise<{ namespaces: Namespace[] }> {
    return this.request<{ namespaces: Namespace[] }>(`/v1/namespaces`);
  }

  /**
   * Search artifacts in a namespace
   */
  async searchArtifacts(
    namespaceSlug: string,
    query: string,
    limit = 20
  ): Promise<SearchResult> {
    const params = new URLSearchParams({
      q: query,
      limit: String(limit),
    });

    try {
      return await this.request<SearchResult>(
        `/v1/namespaces/${namespaceSlug}/search?${params.toString()}`
      );
    } catch {
      // Backward-compatible fallback for older API servers.
      const result = await this.listArtifacts(namespaceSlug, { limit: 100 });
      const lowerQuery = query.toLowerCase();
      const filtered = result.artifacts.filter(
        (a) =>
          a.title.toLowerCase().includes(lowerQuery) ||
          a.description?.toLowerCase().includes(lowerQuery)
      );
      return { artifacts: filtered.slice(0, limit) };
    }
  }

  /**
   * Get the latest artifact in a namespace
   */
  async getLatestArtifact(namespaceSlug: string): Promise<Artifact | null> {
    const result = await this.listArtifacts(namespaceSlug, { limit: 1 });
    return result.artifacts[0] ?? null;
  }

  /**
   * Get current principal info
   */
  async getMe(): Promise<{
    principal: { id: string; type: string; name: string };
    namespaces: Namespace[];
  }> {
    return this.request(`/v1/me`);
  }

  /**
   * Create a new artifact
   */
  async createArtifact(input: CreateArtifactInput): Promise<Artifact & { version: ArtifactVersion }> {
    const body: Record<string, unknown> = {
      namespace_id: input.namespace_id,
      title: input.title,
      content: input.content,
      content_type: input.content_type ?? "text/plain",
    };
    if (input.description) body["description"] = input.description;
    if (input.slug) body["slug"] = input.slug;
    if (input.metadata) body["metadata"] = input.metadata;
    if (input.message) body["message"] = input.message;
    if (input.provenance) body["provenance"] = input.provenance;

    return this.request(`/v1/artifacts`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  /**
   * Update an artifact (create new version)
   */
  async updateArtifact(id: string, input: UpdateArtifactInput): Promise<Artifact & { version: ArtifactVersion }> {
    const body: Record<string, unknown> = { content: input.content };
    if (input.title) body["title"] = input.title;
    if (input.description) body["description"] = input.description;
    if (input.message) body["message"] = input.message;
    if (input.metadata) body["metadata"] = input.metadata;
    if (input.provenance) body["provenance"] = input.provenance;

    return this.request(`/v1/artifacts/${id}`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
  }

  /**
   * Create a share grant for an artifact
   */
  async createGrant(input: {
    namespace_id: string;
    artifact_id?: string;
    permissions?: string[];
    expires_at?: string;
  }): Promise<{
    id: string;
    token: string;
    token_prefix: string;
    expires_at: string | null;
  }> {
    return this.request(`/v1/grants`, {
      method: "POST",
      body: JSON.stringify({
        ...input,
        grantee_type: "token",
      }),
    });
  }

  /**
   * List grants for a namespace
   */
  async listGrants(namespaceId: string): Promise<{
    grants: Array<{
      id: string;
      artifact_id: string | null;
      token_prefix: string;
      permissions: string[];
      expires_at: string | null;
    }>;
  }> {
    return this.request(`/v1/grants?namespace_id=${namespaceId}`);
  }

  /**
   * Diff two versions of an artifact (path-scoped git diff).
   * Returns plain-text diff from the server.
   */
  async diffArtifact(id: string, versionA: number, versionB: number): Promise<string> {
    const path = `/v1/artifacts/${id}/diff?version_a=${versionA}&version_b=${versionB}`;
    const response = await fetch(`${this.baseUrl}${path}`, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
    });

    if (!response.ok) {
      const error = (await response.json().catch(() => ({
        error: "unknown",
        message: response.statusText,
      }))) as ApiError;
      throw new Error(`API Error: ${error.message} (${error.error})`);
    }

    return response.text();
  }

  /**
   * Import a file from a git repository
   */
  async gitImport(input: {
    repo_url: string;
    path: string;
    branch?: string;
    namespace_id: string;
    title?: string;
    description?: string;
    slug?: string;
    content_type?: string;
  }): Promise<Artifact & { version: ArtifactVersion }> {
    return this.request(`/v1/git/import`, {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  /**
   * Sync an artifact with its git source
   */
  async gitSync(artifactId: string): Promise<{
    synced: boolean;
    message: string;
    previous_version?: number;
    new_version?: number;
    current_version?: number;
    version?: ArtifactVersion;
  }> {
    return this.request(`/v1/git/sync/${artifactId}`, {
      method: "POST",
    });
  }
}
