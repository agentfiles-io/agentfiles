-- Migration 003: Runtime Instances
-- First-class model for named runtime instances (Claude Code, Codex, OpenClaw, etc.)

CREATE TABLE runtime_instances (
  id TEXT PRIMARY KEY NOT NULL,
  principal_id TEXT NOT NULL REFERENCES principals(id),
  owner_principal_id TEXT NOT NULL REFERENCES principals(id),
  namespace_id TEXT NOT NULL REFERENCES namespaces(id),
  display_name TEXT NOT NULL,
  runtime_kind TEXT NOT NULL CHECK(runtime_kind IN ('openclaw', 'claude_code', 'codex', 'mcp', 'generic')),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'inactive', 'revoked')),
  connect_session_id TEXT REFERENCES connect_sessions(id),
  connected_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  last_activity_at TEXT,
  visibility TEXT NOT NULL DEFAULT 'private',
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_runtime_instances_owner ON runtime_instances(owner_principal_id);
CREATE UNIQUE INDEX idx_runtime_instances_principal_unique ON runtime_instances(principal_id);
CREATE INDEX idx_runtime_instances_namespace ON runtime_instances(namespace_id);
CREATE INDEX idx_runtime_instances_kind ON runtime_instances(runtime_kind);
CREATE INDEX idx_runtime_instances_status ON runtime_instances(status);

-- Add index on artifact_versions.created_by for lineage join performance
CREATE INDEX IF NOT EXISTS idx_versions_created_by ON artifact_versions(created_by);
