/**
 * API client for CLI (similar to MCP client but standalone)
 */

export interface AttachClientConfig {
  apiUrl: string;
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
}

export interface ArtifactListItem {
  id: string;
  slug: string | null;
  title: string;
  description: string | null;
  content_type: string;
  current_version: number;
  visibility: "private" | "public";
  created_at: string;
  updated_at: string;
}

export interface ListArtifactsOptions {
  limit?: number;
  signal?: AbortSignal;
}

export interface Namespace {
  id: string;
  slug: string;
  name: string;
}

interface ErrorResponse {
  error?: string;
  message?: string;
}

export class AttachClient {
  private apiUrl: string;
  private apiKey: string;

  constructor(config: AttachClientConfig) {
    this.apiUrl = config.apiUrl.replace(/\/$/, "");
    this.apiKey = config.apiKey;
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.apiUrl}${path}`;
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
      }))) as ErrorResponse;
      throw new Error(`API Error: ${error.message ?? "Request failed"} (${error.error ?? "unknown"})`);
    }

    return response.json() as Promise<T>;
  }

  async getMe(): Promise<{
    principal: { id: string; type: string; name: string };
    namespaces: Namespace[];
  }> {
    return this.request("/v1/me");
  }

  async getArtifact(id: string): Promise<Artifact> {
    return this.request(`/v1/artifacts/${id}`);
  }

  async getArtifactContent(id: string, version?: number): Promise<string> {
    const path = version
      ? `/v1/artifacts/${id}/content?version=${version}`
      : `/v1/artifacts/${id}/content`;

    const response = await fetch(`${this.apiUrl}${path}`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });

    if (!response.ok) {
      const error = (await response.json().catch(() => ({
        error: "unknown",
        message: response.statusText,
      }))) as ErrorResponse;
      throw new Error(`API Error: ${error.message ?? "Request failed"} (${error.error ?? "unknown"})`);
    }

    return response.text();
  }

  async createArtifact(input: {
    namespace_id: string;
    title: string;
    content: string;
    content_type: string;
    description?: string;
    slug?: string;
    message?: string;
    provenance?: Record<string, unknown>;
  }): Promise<Artifact> {
    return this.request("/v1/artifacts", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async updateArtifact(
    id: string,
    input: {
      content: string;
      title?: string;
      description?: string;
      message?: string;
      provenance?: Record<string, unknown>;
    }
  ): Promise<Artifact> {
    return this.request(`/v1/artifacts/${id}`, {
      method: "PUT",
      body: JSON.stringify(input),
    });
  }

  async listArtifacts(
    namespaceSlug: string,
    options?: ListArtifactsOptions
  ): Promise<{ artifacts: ArtifactListItem[] }> {
    const params = new URLSearchParams();
    if (options?.limit) params.set("limit", options.limit.toString());
    const query = params.toString();
    const requestOptions: RequestInit = {};
    if (options?.signal) {
      requestOptions.signal = options.signal;
    }

    return this.request(
      `/v1/namespaces/${namespaceSlug}/artifacts${query ? `?${query}` : ""}`,
      requestOptions
    );
  }

  async searchArtifacts(
    namespaceSlug: string,
    query: string,
    limit = 20
  ): Promise<{ artifacts: ArtifactListItem[] }> {
    // Client-side filtering for now
    const result = await this.listArtifacts(namespaceSlug, { limit: 100 });
    const lowerQuery = query.toLowerCase();
    const filtered = result.artifacts.filter(
      (a) =>
        a.title.toLowerCase().includes(lowerQuery) ||
        a.description?.toLowerCase().includes(lowerQuery)
    );
    return { artifacts: filtered.slice(0, limit) };
  }

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
    return this.request("/v1/grants", {
      method: "POST",
      body: JSON.stringify({ ...input, grantee_type: "token" }),
    });
  }

  async getNamespaceBySlug(slug: string): Promise<Namespace & { id: string }> {
    return this.request(`/v1/namespaces/${slug}`);
  }

  async getStats(): Promise<{
    artifacts: number;
    api_keys: number;
    instances: number;
    namespaces: number;
  }> {
    return this.request("/v1/stats");
  }

  async getAdminStats(): Promise<{
    users: number;
    agents: number;
    artifacts: number;
    versions: number;
    namespaces: number;
    api_keys: number;
    instances: number;
  }> {
    return this.request("/v1/stats/admin");
  }
}
