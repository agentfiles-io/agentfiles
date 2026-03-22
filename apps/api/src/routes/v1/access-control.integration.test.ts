import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";

import {
  Database,
  type DatabaseType,
  migrate,
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

import type { AuthContext } from "../../middleware/auth.js";
import { namespaces } from "./namespaces.js";
import { me } from "./me.js";
import { artifacts } from "./artifacts.js";
import { instances } from "./instances.js";
import { lineage } from "./lineage.js";
import { apiKeys } from "./api-keys.js";

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

interface ErrorResponse {
  error: string;
  message: string;
}

interface MeResponse {
  principal: {
    id: string;
    type: string;
    name: string;
    metadata: Record<string, unknown> | null;
    created_at: string;
  };
  namespaces: Array<{
    id: string;
    slug: string;
    name: string;
    visibility: "private" | "public";
  }>;
  credential: {
    type: "api_key" | "session";
    id: string;
  };
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
  routePath: string,
  route: Hono,
  repositories: TestRepositories,
  auth: AuthContext | null
): Hono {
  const app = new Hono();

  app.use("*", async (c, next) => {
    c.set("db", repositories);
    c.set("auth", auth);
    c.set("shareToken", null);
    await next();
  });

  app.route(routePath, route);
  return app;
}

describe("Route integration: namespaces write authorization", () => {
  let db: DatabaseType;
  let repositories: TestRepositories;
  let ownerAuth: AuthContext;
  let ownerNamespaceSlug: string;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db);

    repositories = createRepositories(db);
    const owner = repositories.principals.create({
      type: "user",
      name: "Owner User",
    });
    const ownerNamespace = repositories.namespaces.create({
      slug: "owner-ns",
      name: "Owner Namespace",
      ownerId: owner.id,
      visibility: "private",
    });

    ownerAuth = {
      principal: owner,
      credential: {
        type: "api_key",
        id: "key_owner",
        scope: {
          permissions: ["namespaces:read"],
        },
      },
    };
    ownerNamespaceSlug = ownerNamespace.slug;
  });

  afterEach(() => {
    db.close();
  });

  it("rejects namespace creation without namespaces:write", async () => {
    const app = createTestApp("/v1/namespaces", namespaces, repositories, ownerAuth);

    const response = await app.request("/v1/namespaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        slug: "new-ns",
        name: "New Namespace",
      }),
    });

    expect(response.status).toBe(403);
    const body = (await response.json()) as ErrorResponse;
    expect(body).toMatchObject({ error: "forbidden" });
    expect(body.message).toContain("namespaces:write");
  });

  it("rejects namespace updates without namespaces:write", async () => {
    const app = createTestApp("/v1/namespaces", namespaces, repositories, ownerAuth);

    const response = await app.request(`/v1/namespaces/${ownerNamespaceSlug}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Renamed Namespace",
      }),
    });

    expect(response.status).toBe(403);
    const body = (await response.json()) as ErrorResponse;
    expect(body).toMatchObject({ error: "forbidden" });
    expect(body.message).toContain("namespaces:write");
  });
});

describe("Route integration: /v1/me namespace scope filtering", () => {
  let db: DatabaseType;
  let repositories: TestRepositories;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db);

    repositories = createRepositories(db);
  });

  afterEach(() => {
    db.close();
  });

  it("returns only namespaces included in API key namespace scope", async () => {
    const owner = repositories.principals.create({
      type: "user",
      name: "Scoped Owner",
    });

    const allowedNamespace = repositories.namespaces.create({
      slug: "allowed-ns",
      name: "Allowed Namespace",
      ownerId: owner.id,
      visibility: "private",
    });
    const otherNamespace = repositories.namespaces.create({
      slug: "other-ns",
      name: "Other Namespace",
      ownerId: owner.id,
      visibility: "private",
    });

    const auth: AuthContext = {
      principal: owner,
      credential: {
        type: "api_key",
        id: "key_scoped",
        scope: {
          permissions: ["namespaces:read"],
          namespaces: [allowedNamespace.id],
        },
      },
    };

    const app = createTestApp("/v1/me", me, repositories, auth);
    const response = await app.request("/v1/me");

    expect(response.status).toBe(200);
    const body = (await response.json()) as MeResponse;
    expect(body.namespaces).toHaveLength(1);
    const firstNamespace = body.namespaces[0];
    expect(firstNamespace).toBeDefined();
    if (!firstNamespace) {
      throw new Error("Expected a namespace in response");
    }
    expect(firstNamespace).toMatchObject({
      id: allowedNamespace.id,
      slug: allowedNamespace.slug,
    });
    expect(firstNamespace.id).not.toBe(otherNamespace.id);
  });

  it("returns owned namespaces for unscoped owner API keys", async () => {
    const owner = repositories.principals.create({
      type: "user",
      name: "Unscoped Owner",
    });

    const firstNamespace = repositories.namespaces.create({
      slug: "owner-a",
      name: "Owner Namespace A",
      ownerId: owner.id,
      visibility: "private",
    });
    const secondNamespace = repositories.namespaces.create({
      slug: "owner-b",
      name: "Owner Namespace B",
      ownerId: owner.id,
      visibility: "private",
    });

    const auth: AuthContext = {
      principal: owner,
      credential: {
        type: "api_key",
        id: "key_unscoped_owner",
        scope: null,
      },
    };

    const app = createTestApp("/v1/me", me, repositories, auth);
    const response = await app.request("/v1/me");

    expect(response.status).toBe(200);
    const body = (await response.json()) as MeResponse;
    expect(body.namespaces).toHaveLength(2);
    const returnedIds = body.namespaces.map((namespace) => namespace.id);
    expect(returnedIds).toContain(firstNamespace.id);
    expect(returnedIds).toContain(secondNamespace.id);
  });
});

describe("Route integration: /v1/instances ownership boundaries", () => {
  let db: DatabaseType;
  let repositories: TestRepositories;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db);
    repositories = createRepositories(db);
  });

  afterEach(() => {
    db.close();
  });

  it("allows an agent principal to read its own runtime instance", async () => {
    const owner = repositories.principals.create({ type: "user", name: "Owner" });
    const namespace = repositories.namespaces.create({
      slug: "instances-self",
      name: "Instances Self",
      ownerId: owner.id,
      visibility: "private",
    });

    const agent = repositories.principals.create({
      type: "agent",
      name: "Agent One",
      namespaceId: namespace.id,
    });

    const ownInstance = repositories.runtimeInstances.create({
      principalId: agent.id,
      ownerPrincipalId: owner.id,
      namespaceId: namespace.id,
      displayName: "Agent One Runtime",
      runtimeKind: "generic",
    });

    const auth: AuthContext = {
      principal: agent,
      credential: {
        type: "api_key",
        id: "key_agent_self",
        scope: { permissions: ["namespaces:read", "artifacts:read"] },
      },
    };

    const app = createTestApp("/v1/instances", instances, repositories, auth);
    const response = await app.request(`/v1/instances/${ownInstance.id}`);

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      instance: { id: string; principal_id: string };
    };
    expect(body.instance.id).toBe(ownInstance.id);
    expect(body.instance.principal_id).toBe(agent.id);
  });

  it("denies instance detail without artifacts:read", async () => {
    const owner = repositories.principals.create({ type: "user", name: "Owner" });
    const namespace = repositories.namespaces.create({
      slug: "instances-no-artifact-read",
      name: "Instances No Artifact Read",
      ownerId: owner.id,
      visibility: "private",
    });

    const agent = repositories.principals.create({
      type: "agent",
      name: "Agent One",
      namespaceId: namespace.id,
    });

    const ownInstance = repositories.runtimeInstances.create({
      principalId: agent.id,
      ownerPrincipalId: owner.id,
      namespaceId: namespace.id,
      displayName: "Agent One Runtime",
      runtimeKind: "generic",
    });

    const auth: AuthContext = {
      principal: agent,
      credential: {
        type: "api_key",
        id: "key_agent_missing_artifacts_read",
        scope: { permissions: ["namespaces:read"] },
      },
    };

    const app = createTestApp("/v1/instances", instances, repositories, auth);
    const response = await app.request(`/v1/instances/${ownInstance.id}`);

    expect(response.status).toBe(403);
    const body = (await response.json()) as ErrorResponse;
    expect(body).toMatchObject({ error: "forbidden" });
    expect(body.message).toContain("artifacts:read");
  });

  it("denies an agent principal from reading another instance in the same namespace", async () => {
    const owner = repositories.principals.create({ type: "user", name: "Owner" });
    const namespace = repositories.namespaces.create({
      slug: "instances-cross",
      name: "Instances Cross",
      ownerId: owner.id,
      visibility: "private",
    });

    const agentA = repositories.principals.create({
      type: "agent",
      name: "Agent A",
      namespaceId: namespace.id,
    });
    const agentB = repositories.principals.create({
      type: "agent",
      name: "Agent B",
      namespaceId: namespace.id,
    });

    repositories.runtimeInstances.create({
      principalId: agentA.id,
      ownerPrincipalId: owner.id,
      namespaceId: namespace.id,
      displayName: "Runtime A",
      runtimeKind: "generic",
    });
    const targetInstance = repositories.runtimeInstances.create({
      principalId: agentB.id,
      ownerPrincipalId: owner.id,
      namespaceId: namespace.id,
      displayName: "Runtime B",
      runtimeKind: "generic",
    });

    const auth: AuthContext = {
      principal: agentA,
      credential: {
        type: "api_key",
        id: "key_agent_a",
        scope: { permissions: ["namespaces:read", "artifacts:read"] },
      },
    };

    const app = createTestApp("/v1/instances", instances, repositories, auth);
    const response = await app.request(`/v1/instances/${targetInstance.id}`);

    expect(response.status).toBe(403);
    const body = (await response.json()) as ErrorResponse;
    expect(body).toMatchObject({ error: "forbidden" });
  });
});

describe("Route integration: /v1/lineage authorization", () => {
  let db: DatabaseType;
  let repositories: TestRepositories;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db);
    repositories = createRepositories(db);
  });

  afterEach(() => {
    db.close();
  });

  it("denies artifact lineage reads across private namespaces for non-owners", async () => {
    const ownerA = repositories.principals.create({ type: "user", name: "Owner A" });
    const ownerB = repositories.principals.create({ type: "user", name: "Owner B" });

    const namespaceB = repositories.namespaces.create({
      slug: "lineage-owner-b",
      name: "Lineage Owner B",
      ownerId: ownerB.id,
      visibility: "private",
    });

    const artifact = repositories.artifacts.create({
      namespaceId: namespaceB.id,
      title: "Private Artifact B",
      contentType: "text/plain",
      createdBy: ownerB.id,
      contentHash: "hash_lineage_private_b",
      contentSize: 32,
      storageKey: "hash_lineage_private_b",
      searchableText: "private lineage payload",
      provenance: { source: "api" },
    }).artifact;

    const auth: AuthContext = {
      principal: ownerA,
      credential: {
        type: "session",
        id: "sess_owner_a",
        scope: null,
      },
    };

    const app = createTestApp("/v1/lineage", lineage, repositories, auth);
    const response = await app.request(`/v1/lineage/artifacts/${artifact.id}`);

    expect(response.status).toBe(403);
    const body = (await response.json()) as ErrorResponse;
    expect(body).toMatchObject({ error: "forbidden" });
  });

  it("ignores foreign namespace IDs embedded in API key scope on lineage listing", async () => {
    const ownerA = repositories.principals.create({ type: "user", name: "Owner A" });
    const ownerB = repositories.principals.create({ type: "user", name: "Owner B" });

    const namespaceA = repositories.namespaces.create({
      slug: "lineage-owner-a",
      name: "Lineage Owner A",
      ownerId: ownerA.id,
      visibility: "private",
    });
    const namespaceB = repositories.namespaces.create({
      slug: "lineage-owner-b-2",
      name: "Lineage Owner B 2",
      ownerId: ownerB.id,
      visibility: "private",
    });

    repositories.artifacts.create({
      namespaceId: namespaceA.id,
      title: "Owner A Artifact",
      contentType: "text/plain",
      createdBy: ownerA.id,
      contentHash: "hash_lineage_a",
      contentSize: 16,
      storageKey: "hash_lineage_a",
      searchableText: "owner a data",
      provenance: { source: "api" },
    });
    repositories.artifacts.create({
      namespaceId: namespaceB.id,
      title: "Owner B Artifact",
      contentType: "text/plain",
      createdBy: ownerB.id,
      contentHash: "hash_lineage_b",
      contentSize: 16,
      storageKey: "hash_lineage_b",
      searchableText: "owner b data",
      provenance: { source: "api" },
    });

    const auth: AuthContext = {
      principal: ownerA,
      credential: {
        type: "api_key",
        id: "key_owner_a_scoped",
        scope: {
          permissions: ["artifacts:read"],
          namespaces: [namespaceB.id],
        },
      },
    };

    const app = createTestApp("/v1/lineage", lineage, repositories, auth);
    const response = await app.request("/v1/lineage");

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      namespaces: Array<{ namespace: { id: string } }>;
    };

    const returnedNamespaceIds = body.namespaces.map((entry) => entry.namespace.id);
    expect(returnedNamespaceIds).not.toContain(namespaceB.id);
  });
});

describe("Route integration: API key namespace scope validation", () => {
  let db: DatabaseType;
  let repositories: TestRepositories;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db);
    repositories = createRepositories(db);
    setHmacSecret("a".repeat(64));
  });

  afterEach(() => {
    db.close();
  });

  it("rejects creating API keys scoped to namespaces not controlled by the caller", async () => {
    const ownerA = repositories.principals.create({ type: "user", name: "Owner A" });
    const ownerB = repositories.principals.create({ type: "user", name: "Owner B" });

    const namespaceB = repositories.namespaces.create({
      slug: "apikey-owner-b",
      name: "API Key Owner B",
      ownerId: ownerB.id,
      visibility: "private",
    });

    const auth: AuthContext = {
      principal: ownerA,
      credential: {
        type: "session",
        id: "sess_owner_a",
        scope: null,
      },
    };

    const app = createTestApp("/v1/api-keys", apiKeys, repositories, auth);
    const response = await app.request("/v1/api-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "bad-scope",
        scope: {
          permissions: ["artifacts:read"],
          namespaces: [namespaceB.id],
        },
      }),
    });

    expect(response.status).toBe(403);
    const body = (await response.json()) as ErrorResponse;
    expect(body).toMatchObject({ error: "forbidden" });
  });

  it("allows creating API keys scoped to namespaces owned by the caller", async () => {
    const owner = repositories.principals.create({ type: "user", name: "Owner" });

    const namespace = repositories.namespaces.create({
      slug: "apikey-owner-ok",
      name: "API Key Owner OK",
      ownerId: owner.id,
      visibility: "private",
    });

    const auth: AuthContext = {
      principal: owner,
      credential: {
        type: "session",
        id: "sess_owner",
        scope: null,
      },
    };

    const app = createTestApp("/v1/api-keys", apiKeys, repositories, auth);
    const response = await app.request("/v1/api-keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "good-scope",
        scope: {
          permissions: ["artifacts:read"],
          namespaces: [namespace.id],
        },
      }),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as {
      scope: { namespaces?: string[]; permissions?: string[] } | null;
    };
    expect(body.scope?.namespaces).toEqual([namespace.id]);
  });
});

describe("Route integration: namespace search", () => {
  let db: DatabaseType;
  let repositories: TestRepositories;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db);
    repositories = createRepositories(db);
  });

  afterEach(() => {
    db.close();
  });

  it("returns full-text search results for accessible namespaces", async () => {
    const owner = repositories.principals.create({
      type: "user",
      name: "Search Owner",
    });
    const namespace = repositories.namespaces.create({
      slug: "search-ns",
      name: "Search Namespace",
      ownerId: owner.id,
      visibility: "private",
    });

    const matching = repositories.artifacts.create({
      namespaceId: namespace.id,
      title: "Alpha note",
      description: "contains unique token",
      contentType: "text/plain",
      createdBy: owner.id,
      contentHash: "hash_search_match",
      contentSize: 20,
      storageKey: "hash_search_match",
      searchableText: "alpha unique_search_token",
      provenance: { source: "api" },
    }).artifact;
    repositories.artifacts.create({
      namespaceId: namespace.id,
      title: "Beta note",
      description: "other content",
      contentType: "text/plain",
      createdBy: owner.id,
      contentHash: "hash_search_other",
      contentSize: 15,
      storageKey: "hash_search_other",
      searchableText: "beta unrelated",
      provenance: { source: "api" },
    });

    const auth: AuthContext = {
      principal: owner,
      credential: {
        type: "api_key",
        id: "key_search",
        scope: {
          permissions: ["artifacts:read"],
        },
      },
    };

    const app = createTestApp("/v1/namespaces", namespaces, repositories, auth);
    const response = await app.request(
      `/v1/namespaces/${namespace.slug}/search?q=unique_search_token`
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { artifacts: Array<{ id: string }> };
    expect(body.artifacts).toHaveLength(1);
    expect(body.artifacts[0]?.id).toBe(matching.id);
  });

  it("rejects malformed FTS query syntax", async () => {
    const owner = repositories.principals.create({
      type: "user",
      name: "Search Owner",
    });
    const namespace = repositories.namespaces.create({
      slug: "search-invalid-query",
      name: "Search Invalid Query",
      ownerId: owner.id,
      visibility: "private",
    });

    const auth: AuthContext = {
      principal: owner,
      credential: {
        type: "api_key",
        id: "key_search_invalid",
        scope: {
          permissions: ["artifacts:read"],
        },
      },
    };

    const app = createTestApp("/v1/namespaces", namespaces, repositories, auth);
    const response = await app.request(
      `/v1/namespaces/${namespace.slug}/search?q=%28`
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as ErrorResponse;
    expect(body).toMatchObject({ error: "bad_request" });
    expect(body.message).toContain("Invalid search query");
  });

  it("denies namespace search without artifacts:read", async () => {
    const owner = repositories.principals.create({
      type: "user",
      name: "Search Owner",
    });
    const namespace = repositories.namespaces.create({
      slug: "search-no-artifact-read",
      name: "Search No Artifact Read",
      ownerId: owner.id,
      visibility: "private",
    });

    const auth: AuthContext = {
      principal: owner,
      credential: {
        type: "api_key",
        id: "key_search_no_artifacts_read",
        scope: {
          permissions: ["namespaces:read"],
        },
      },
    };

    const app = createTestApp("/v1/namespaces", namespaces, repositories, auth);
    const response = await app.request(
      `/v1/namespaces/${namespace.slug}/search?q=anything`
    );

    expect(response.status).toBe(403);
    const body = (await response.json()) as ErrorResponse;
    expect(body).toMatchObject({ error: "forbidden" });
    expect(body.message).toContain("artifacts:read");
  });

  it("denies namespace artifact listing without artifacts:read", async () => {
    const owner = repositories.principals.create({
      type: "user",
      name: "List Owner",
    });
    const namespace = repositories.namespaces.create({
      slug: "list-no-artifact-read",
      name: "List No Artifact Read",
      ownerId: owner.id,
      visibility: "private",
    });

    const auth: AuthContext = {
      principal: owner,
      credential: {
        type: "api_key",
        id: "key_list_no_artifacts_read",
        scope: {
          permissions: ["namespaces:read"],
        },
      },
    };

    const app = createTestApp("/v1/namespaces", namespaces, repositories, auth);
    const response = await app.request(`/v1/namespaces/${namespace.slug}/artifacts`);

    expect(response.status).toBe(403);
    const body = (await response.json()) as ErrorResponse;
    expect(body).toMatchObject({ error: "forbidden" });
    expect(body.message).toContain("artifacts:read");
  });
});

describe("Route integration: public grants read access", () => {
  let db: DatabaseType;
  let repositories: TestRepositories;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db);

    repositories = createRepositories(db);
  });

  afterEach(() => {
    db.close();
  });

  it("allows unauthenticated artifact reads when an active public read grant exists", async () => {
    const owner = repositories.principals.create({
      type: "user",
      name: "Owner",
    });
    const namespace = repositories.namespaces.create({
      slug: "pub-ns",
      name: "Public Grant Namespace",
      ownerId: owner.id,
      visibility: "private",
    });
    const artifact = repositories.artifacts.create({
      namespaceId: namespace.id,
      title: "Shared Artifact",
      description: "shared by public grant",
      contentType: "text/plain",
      createdBy: owner.id,
      contentHash: "hash_public_grant",
      contentSize: 12,
      storageKey: "hash_public_grant",
      searchableText: "Shared Artifact",
      provenance: { source: "api" },
    }).artifact;

    repositories.grants.create({
      namespaceId: namespace.id,
      artifactId: artifact.id,
      granteeType: "public",
      permissions: ["read"],
      createdBy: owner.id,
    });

    const app = createTestApp("/v1/artifacts", artifacts, repositories, null);
    const response = await app.request(`/v1/artifacts/${artifact.id}`);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { id: string; title: string };
    expect(body).toMatchObject({
      id: artifact.id,
      title: "Shared Artifact",
    });
  });

  it("denies unauthenticated reads when public grant is expired", async () => {
    const owner = repositories.principals.create({
      type: "user",
      name: "Owner",
    });
    const namespace = repositories.namespaces.create({
      slug: "expired-pub-ns",
      name: "Expired Public Grant Namespace",
      ownerId: owner.id,
      visibility: "private",
    });
    const artifact = repositories.artifacts.create({
      namespaceId: namespace.id,
      title: "Expired Shared Artifact",
      contentType: "text/plain",
      createdBy: owner.id,
      contentHash: "hash_expired_public_grant",
      contentSize: 16,
      storageKey: "hash_expired_public_grant",
      searchableText: "Expired Shared Artifact",
      provenance: { source: "api" },
    }).artifact;

    repositories.grants.create({
      namespaceId: namespace.id,
      artifactId: artifact.id,
      granteeType: "public",
      permissions: ["read"],
      expiresAt: "2000-01-01T00:00:00Z",
      createdBy: owner.id,
    });

    const app = createTestApp("/v1/artifacts", artifacts, repositories, null);
    const response = await app.request(`/v1/artifacts/${artifact.id}`);

    expect(response.status).toBe(403);
    const body = (await response.json()) as ErrorResponse;
    expect(body).toMatchObject({ error: "forbidden" });
  });

  it("allows unauthenticated reads from namespace-wide public grants", async () => {
    const owner = repositories.principals.create({
      type: "user",
      name: "Owner",
    });
    const namespace = repositories.namespaces.create({
      slug: "namespace-wide-pub-ns",
      name: "Namespace-wide Public Grant Namespace",
      ownerId: owner.id,
      visibility: "private",
    });
    const artifact = repositories.artifacts.create({
      namespaceId: namespace.id,
      title: "Namespace Shared Artifact",
      contentType: "text/plain",
      createdBy: owner.id,
      contentHash: "hash_namespace_public_grant",
      contentSize: 20,
      storageKey: "hash_namespace_public_grant",
      searchableText: "Namespace Shared Artifact",
      provenance: { source: "api" },
    }).artifact;

    repositories.grants.create({
      namespaceId: namespace.id,
      granteeType: "public",
      permissions: ["read"],
      createdBy: owner.id,
    });

    const app = createTestApp("/v1/artifacts", artifacts, repositories, null);
    const response = await app.request(`/v1/artifacts/${artifact.id}`);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { id: string };
    expect(body.id).toBe(artifact.id);
  });
});
