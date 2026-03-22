#!/usr/bin/env tsx
/**
 * Create a read-only API key for testing scope enforcement
 */

import {
  initDb,
  setHmacSecret,
  PrincipalRepository,
  ApiKeyRepository,
} from "@attach/db";

const dbPath = process.env["DATABASE_PATH"] ?? "./data/attach.db";
const db = initDb({ path: dbPath });

const hmacSecret = process.env["SESSION_SECRET"] ?? "0".repeat(64);
setHmacSecret(hmacSecret);

const principals = new PrincipalRepository(db);
const apiKeys = new ApiKeyRepository(db);

// Find dev user
const users = principals.listByType("user");
const devUser = users.find(p => p.name === "Dev User");

if (!devUser) {
  console.error("Dev user not found. Run setup-dev.ts first.");
  process.exit(1);
}

console.log("Creating read-only API key...");
const result = apiKeys.create({
  principalId: devUser.id,
  principalType: "user",
  name: "Read-Only Test Key",
  scope: { permissions: ["artifacts:read", "namespaces:read"] }, // No write permission!
});

console.log(`\nRead-only API key (artifacts:read, namespaces:read only):`);
console.log(`\n  ${result.plaintext}\n`);
