import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Database as DatabaseType } from "better-sqlite3";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "..", "migrations");

interface Migration {
  name: string;
  sql: string;
}

function getAppliedMigrations(db: DatabaseType): Set<string> {
  // Check if _migrations table exists
  const tableExists = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='_migrations'`
    )
    .get();

  if (!tableExists) {
    return new Set();
  }

  const rows = db.prepare(`SELECT name FROM _migrations`).all() as Array<{
    name: string;
  }>;
  return new Set(rows.map((r) => r.name));
}

function getPendingMigrations(applied: Set<string>): Migration[] {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  const pending: Migration[] = [];

  for (const file of files) {
    const name = file.replace(".sql", "");
    if (!applied.has(name)) {
      const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf-8");
      pending.push({ name, sql });
    }
  }

  return pending;
}

function recordMigration(db: DatabaseType, name: string): void {
  db.prepare(`INSERT INTO _migrations (name, applied_at) VALUES (?, ?)`).run(
    name,
    new Date().toISOString()
  );
}

export function migrate(db: DatabaseType): { applied: string[] } {
  const applied = getAppliedMigrations(db);
  const pending = getPendingMigrations(applied);

  const newlyApplied: string[] = [];

  for (const migration of pending) {
    console.log(`Applying migration: ${migration.name}`);
    db.exec(migration.sql);
    recordMigration(db, migration.name);
    newlyApplied.push(migration.name);
  }

  if (newlyApplied.length === 0) {
    console.log("No pending migrations.");
  } else {
    console.log(`Applied ${newlyApplied.length} migration(s).`);
  }

  return { applied: newlyApplied };
}

export function getMigrationStatus(
  db: DatabaseType
): { applied: string[]; pending: string[] } {
  const applied = getAppliedMigrations(db);
  const pending = getPendingMigrations(applied);

  return {
    applied: Array.from(applied).sort(),
    pending: pending.map((m) => m.name),
  };
}
