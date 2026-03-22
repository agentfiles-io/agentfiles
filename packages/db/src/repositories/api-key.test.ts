import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import type { Database as DatabaseType } from "better-sqlite3";

import { migrate } from "../migrate.js";
import { PrincipalRepository } from "./principal.js";
import { ApiKeyRepository, setHmacSecret } from "./api-key.js";

describe("ApiKeyRepository", () => {
  let db: DatabaseType;
  let principals: PrincipalRepository;
  let apiKeys: ApiKeyRepository;

  beforeEach(() => {
    db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db);

    principals = new PrincipalRepository(db);
    apiKeys = new ApiKeyRepository(db);
  });

  afterEach(() => {
    db.close();
  });

  it("rejects HMAC secrets that are too short", () => {
    expect(() => setHmacSecret("short")).toThrow("HMAC secret must be at least 32 bytes");
  });

  it("accepts both long utf-8 and hex secrets", () => {
    expect(() => setHmacSecret("0123456789abcdef".repeat(4))).not.toThrow();
    expect(() => setHmacSecret("a".repeat(64))).not.toThrow();
  });

  it("creates and validates API keys", () => {
    setHmacSecret("a".repeat(64));

    const principal = principals.create({
      type: "user",
      name: "Test User",
    });

    const created = apiKeys.create({
      principalId: principal.id,
      principalType: principal.type,
      name: "test-key",
      scope: {
        permissions: ["artifacts:read"],
        namespaces: ["ns_test"],
      },
    });

    expect(created.plaintext).toMatch(/^arun_usr_/);

    const validated = apiKeys.validate(created.plaintext);
    expect(validated).not.toBeNull();
    expect(validated?.id).toBe(created.row.id);
  });

  it("does not validate expired API keys", () => {
    setHmacSecret("a".repeat(64));

    const principal = principals.create({
      type: "user",
      name: "Test User",
    });

    const created = apiKeys.create({
      principalId: principal.id,
      principalType: principal.type,
      expiresAt: "2000-01-01T00:00:00Z",
    });

    const validated = apiKeys.validate(created.plaintext);
    expect(validated).toBeNull();
  });

  it("parseScope normalizes and deduplicates valid scope arrays", () => {
    setHmacSecret("a".repeat(64));

    const principal = principals.create({
      type: "user",
      name: "Test User",
    });

    const created = apiKeys.create({
      principalId: principal.id,
      principalType: principal.type,
      scope: {
        permissions: ["artifacts:read"],
      },
    });

    db.prepare(`UPDATE api_keys SET scope = ? WHERE id = ?`).run(
      JSON.stringify({
        permissions: ["artifacts:read", " artifacts:read ", "namespaces:read"],
        namespaces: ["ns_a", "ns_a", " ns_b "],
      }),
      created.row.id
    );

    const row = apiKeys.getById(created.row.id);
    expect(row).not.toBeNull();
    expect(apiKeys.parseScope(row!)).toEqual({
      permissions: ["artifacts:read", "namespaces:read"],
      namespaces: ["ns_a", "ns_b"],
    });
  });

  it("parseScope rejects malformed or invalid scope payloads", () => {
    setHmacSecret("a".repeat(64));

    const principal = principals.create({
      type: "user",
      name: "Test User",
    });

    const created = apiKeys.create({
      principalId: principal.id,
      principalType: principal.type,
      scope: {
        permissions: ["artifacts:read"],
      },
    });

    db.prepare(`UPDATE api_keys SET scope = ? WHERE id = ?`).run(
      '{"permissions":"artifacts:write"}',
      created.row.id
    );
    let row = apiKeys.getById(created.row.id);
    expect(row).not.toBeNull();
    expect(apiKeys.parseScope(row!)).toBeNull();

    db.prepare(`UPDATE api_keys SET scope = ? WHERE id = ?`).run(
      "not-json",
      created.row.id
    );
    row = apiKeys.getById(created.row.id);
    expect(row).not.toBeNull();
    expect(apiKeys.parseScope(row!)).toBeNull();
  });
});
