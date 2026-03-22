#!/usr/bin/env tsx
/**
 * Development setup script - creates a user, API key, and namespace
 */

import {
  initDb,
  migrate,
  setHmacSecret,
  PrincipalRepository,
  ApiKeyRepository,
  NamespaceRepository,
} from "@attach/db";

const dbPath = process.env["DATABASE_PATH"] ?? "./data/attach.db";
const db = initDb({ path: dbPath });

// Run migrations
migrate(db);

// Set HMAC secret (use same default as server for dev)
const hmacSecret = process.env["SESSION_SECRET"] ?? "0".repeat(64);
setHmacSecret(hmacSecret);

// Initialize repositories
const principals = new PrincipalRepository(db);
const apiKeys = new ApiKeyRepository(db);
const namespaces = new NamespaceRepository(db);

// Check if dev user already exists
const existingUsers = principals.listByType("user");
const existingPrincipal = existingUsers.find(p => p.name === "Dev User");

if (existingPrincipal) {
  console.log("Dev user already exists:");
  console.log(`  ID: ${existingPrincipal.id}`);
  console.log(`  Name: ${existingPrincipal.name}`);

  // List existing API keys
  const keys = apiKeys.getByPrincipal(existingPrincipal.id);
  if (keys.length > 0) {
    console.log("\nExisting API keys:");
    for (const key of keys) {
      console.log(`  ${key.name}: ${key.key_prefix}...`);
    }
    console.log("\nNote: Full API key is only shown at creation time.");
  } else {
    // Create API key for existing user
    console.log("\nNo API keys found. Creating one...");
    const apiKeyResult = apiKeys.create({
      principalId: existingPrincipal.id,
      principalType: "user",
      name: "Dev CLI Key",
      scope: { permissions: ["artifacts:read", "artifacts:write", "namespaces:read"] },
    });
    console.log(`\n${"=".repeat(60)}`);
    console.log(`API Key (save this, it won't be shown again!):`);
    console.log(`\n  ${apiKeyResult.plaintext}\n`);
    console.log(`${"=".repeat(60)}`);
  }

  // List namespaces
  let ns = namespaces.getByOwner(existingPrincipal.id);
  if (ns.length > 0) {
    console.log("\nNamespaces:");
    for (const n of ns) {
      console.log(`  ${n.slug}: ${n.name}`);
    }
  } else {
    // Create default namespace
    console.log("\nNo namespaces found. Creating default...");
    const namespace = namespaces.create({
      slug: "dev",
      name: "Dev Namespace",
      description: "Default development namespace",
      ownerId: existingPrincipal.id,
      visibility: "private",
    });
    console.log(`Created namespace: ${namespace.slug}`);
  }

  console.log("\n--- Setup Complete ---");
  process.exit(0);
}

// Create dev user
console.log("Creating dev user...");
const principal = principals.create({
  type: "user",
  name: "Dev User",
});
console.log(`Created principal: ${principal.id}`);

// Create API key
console.log("\nCreating API key...");
const apiKeyResult = apiKeys.create({
  principalId: principal.id,
  principalType: "user",
  name: "Dev CLI Key",
  scope: { permissions: ["artifacts:read", "artifacts:write", "namespaces:read"] },
});
console.log(`Created API key: ${apiKeyResult.row.name}`);
console.log(`\n${"=".repeat(60)}`);
console.log(`API Key (save this, it won't be shown again!):`);
console.log(`\n  ${apiKeyResult.plaintext}\n`);
console.log(`${"=".repeat(60)}`);

// Create default namespace
console.log("\nCreating default namespace...");
const namespace = namespaces.create({
  slug: "dev",
  name: "Dev Namespace",
  description: "Default development namespace",
  ownerId: principal.id,
  visibility: "private",
});
console.log(`Created namespace: ${namespace.slug}`);

console.log("\n--- Setup Complete ---");
console.log("\nTo configure the CLI, run:");
console.log(`\n  node tools/cli/dist/index.js config --api-key ${apiKeyResult.plaintext} --default-namespace dev\n`);
