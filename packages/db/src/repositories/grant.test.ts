import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";

import { migrate } from "../migrate.js";
import { PrincipalRepository } from "./principal.js";
import { NamespaceRepository } from "./namespace.js";
import { GrantRepository, setGrantHmacSecret } from "./grant.js";

describe("GrantRepository", () => {
  let db: DatabaseType;
  let principals: PrincipalRepository;
  let namespaces: NamespaceRepository;
  let grants: GrantRepository;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db);

    principals = new PrincipalRepository(db);
    namespaces = new NamespaceRepository(db);
    grants = new GrantRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it("rejects short grant HMAC secrets", () => {
    expect(() => setGrantHmacSecret("too-short")).toThrow(
      "Grant HMAC secret must be at least 32 bytes"
    );
  });

  it("creates token grants that can be validated", () => {
    setGrantHmacSecret("a".repeat(64));

    const owner = principals.create({
      type: "user",
      name: "Owner User",
    });

    const namespace = namespaces.create({
      slug: "test-ns",
      name: "Test Namespace",
      ownerId: owner.id,
    });

    const created = grants.create({
      namespaceId: namespace.id,
      granteeType: "token",
      permissions: ["read"],
      createdBy: owner.id,
    });

    expect(created.token).toMatch(/^arun_share_/);
    expect(created.row.token_prefix).toBeTruthy();
    expect(created.row.token_hash).toBeTruthy();

    const validated = grants.validateToken(created.token!);
    expect(validated).not.toBeNull();
    expect(validated?.id).toBe(created.row.id);
  });

  it("does not validate revoked grants", () => {
    setGrantHmacSecret("a".repeat(64));

    const owner = principals.create({
      type: "user",
      name: "Owner User",
    });

    const namespace = namespaces.create({
      slug: "test-ns-2",
      name: "Test Namespace 2",
      ownerId: owner.id,
    });

    const created = grants.create({
      namespaceId: namespace.id,
      granteeType: "token",
      permissions: ["read"],
      createdBy: owner.id,
    });

    grants.revoke(created.row.id);

    const validated = grants.validateToken(created.token!);
    expect(validated).toBeNull();
  });
});
