-- Attach Run Initial Schema
-- Version: 001

-- Principals table (user, service, agent, gateway)
CREATE TABLE principals (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL CHECK (type IN ('user', 'service', 'agent', 'gateway')),
    name TEXT NOT NULL,
    namespace_id TEXT,
    metadata JSON,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX idx_principals_namespace ON principals(namespace_id);
CREATE INDEX idx_principals_type ON principals(type);

-- Identities table (links principals to external providers)
CREATE TABLE identities (
    id TEXT PRIMARY KEY,
    principal_id TEXT NOT NULL,
    provider TEXT NOT NULL CHECK (provider IN ('auth0', 'local', 'botapi')),
    external_subject TEXT NOT NULL,
    email TEXT,
    metadata JSON,
    created_at TEXT NOT NULL,
    last_login_at TEXT,

    UNIQUE(provider, external_subject),
    FOREIGN KEY (principal_id) REFERENCES principals(id) ON DELETE CASCADE
);

CREATE INDEX idx_identities_principal ON identities(principal_id);
CREATE INDEX idx_identities_provider ON identities(provider);
CREATE INDEX idx_identities_email ON identities(email);

-- API Keys table
CREATE TABLE api_keys (
    id TEXT PRIMARY KEY,
    principal_id TEXT NOT NULL,
    key_prefix TEXT NOT NULL,
    key_hash TEXT NOT NULL,
    name TEXT,
    scope JSON,
    expires_at TEXT,
    revoked_at TEXT,
    last_used_at TEXT,
    created_at TEXT NOT NULL,

    FOREIGN KEY (principal_id) REFERENCES principals(id) ON DELETE CASCADE
);

CREATE INDEX idx_api_keys_principal ON api_keys(principal_id);
CREATE INDEX idx_api_keys_prefix ON api_keys(key_prefix);
CREATE INDEX idx_api_keys_revoked ON api_keys(revoked_at);
CREATE INDEX idx_api_keys_expires ON api_keys(expires_at);

-- Browser Sessions table
CREATE TABLE browser_sessions (
    id TEXT PRIMARY KEY,
    principal_id TEXT NOT NULL,
    identity_id TEXT NOT NULL,
    user_agent TEXT,
    ip_address TEXT,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    last_active_at TEXT NOT NULL,

    FOREIGN KEY (principal_id) REFERENCES principals(id) ON DELETE CASCADE,
    FOREIGN KEY (identity_id) REFERENCES identities(id) ON DELETE CASCADE
);

CREATE INDEX idx_sessions_principal ON browser_sessions(principal_id);
CREATE INDEX idx_sessions_expires ON browser_sessions(expires_at);

-- Namespaces table
CREATE TABLE namespaces (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT,
    owner_id TEXT NOT NULL,
    visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'public')),
    settings JSON,
    git_mirror JSON,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,

    FOREIGN KEY (owner_id) REFERENCES principals(id)
);

CREATE INDEX idx_namespaces_owner ON namespaces(owner_id);
CREATE INDEX idx_namespaces_created ON namespaces(created_at);

-- Add foreign key from principals to namespaces (circular reference)
-- SQLite doesn't enforce this at CREATE time, but we handle it in application logic

-- Artifacts table
CREATE TABLE artifacts (
    id TEXT PRIMARY KEY,
    namespace_id TEXT NOT NULL,
    slug TEXT,
    title TEXT NOT NULL,
    description TEXT,
    content_type TEXT NOT NULL,
    current_version INTEGER NOT NULL DEFAULT 1,
    current_version_id TEXT,
    visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'public')),
    metadata JSON,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    created_by TEXT NOT NULL,
    archived_at TEXT,
    archived_by TEXT,
    archive_reason TEXT,

    UNIQUE(namespace_id, slug),
    FOREIGN KEY (namespace_id) REFERENCES namespaces(id),
    FOREIGN KEY (created_by) REFERENCES principals(id)
);

CREATE INDEX idx_artifacts_namespace ON artifacts(namespace_id);
CREATE INDEX idx_artifacts_created_by ON artifacts(created_by);
CREATE INDEX idx_artifacts_created_at ON artifacts(created_at DESC);
CREATE INDEX idx_artifacts_updated_at ON artifacts(updated_at DESC);
CREATE INDEX idx_artifacts_content_type ON artifacts(content_type);
CREATE INDEX idx_artifacts_archived ON artifacts(archived_at);
CREATE INDEX idx_artifacts_current_version ON artifacts(current_version_id);

-- Artifact Versions table
CREATE TABLE artifact_versions (
    id TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    content_hash TEXT NOT NULL,
    content_size INTEGER NOT NULL,
    storage_key TEXT NOT NULL,
    searchable_text TEXT,
    message TEXT,
    provenance JSON NOT NULL,
    created_at TEXT NOT NULL,
    created_by TEXT NOT NULL,

    UNIQUE(artifact_id, version),
    FOREIGN KEY (artifact_id) REFERENCES artifacts(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES principals(id)
);

CREATE INDEX idx_versions_artifact ON artifact_versions(artifact_id);
CREATE INDEX idx_versions_hash ON artifact_versions(content_hash);
CREATE INDEX idx_versions_created_at ON artifact_versions(created_at DESC);

-- Labels table
CREATE TABLE labels (
    id TEXT PRIMARY KEY,
    namespace_id TEXT NOT NULL,
    name TEXT NOT NULL,
    color TEXT,
    description TEXT,
    created_at TEXT NOT NULL,

    UNIQUE(namespace_id, name),
    FOREIGN KEY (namespace_id) REFERENCES namespaces(id) ON DELETE CASCADE
);

CREATE INDEX idx_labels_namespace ON labels(namespace_id);

-- Artifact Labels junction table
CREATE TABLE artifact_labels (
    artifact_id TEXT NOT NULL,
    label_id TEXT NOT NULL,
    created_at TEXT NOT NULL,

    PRIMARY KEY (artifact_id, label_id),
    FOREIGN KEY (artifact_id) REFERENCES artifacts(id) ON DELETE CASCADE,
    FOREIGN KEY (label_id) REFERENCES labels(id) ON DELETE CASCADE
);

CREATE INDEX idx_artifact_labels_label ON artifact_labels(label_id);

-- Grants table (sharing)
CREATE TABLE grants (
    id TEXT PRIMARY KEY,
    namespace_id TEXT NOT NULL,
    artifact_id TEXT,
    grantee_type TEXT NOT NULL CHECK (grantee_type IN ('principal', 'token', 'public')),
    grantee_id TEXT,
    token_prefix TEXT,
    token_hash TEXT,
    permissions JSON NOT NULL,
    expires_at TEXT,
    created_at TEXT NOT NULL,
    created_by TEXT NOT NULL,
    revoked_at TEXT,

    FOREIGN KEY (namespace_id) REFERENCES namespaces(id),
    FOREIGN KEY (artifact_id) REFERENCES artifacts(id) ON DELETE CASCADE,
    FOREIGN KEY (created_by) REFERENCES principals(id)
);

CREATE INDEX idx_grants_namespace ON grants(namespace_id);
CREATE INDEX idx_grants_artifact ON grants(artifact_id);
CREATE INDEX idx_grants_grantee ON grants(grantee_id);
CREATE INDEX idx_grants_token_prefix ON grants(token_prefix);
CREATE INDEX idx_grants_expires ON grants(expires_at);
CREATE INDEX idx_grants_revoked ON grants(revoked_at);

-- Webhooks table
CREATE TABLE webhooks (
    id TEXT PRIMARY KEY,
    namespace_id TEXT NOT NULL,
    url TEXT NOT NULL,
    events JSON NOT NULL,
    secret_hash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'failed')),
    failure_count INTEGER DEFAULT 0,
    last_triggered_at TEXT,
    last_success_at TEXT,
    last_failure_at TEXT,
    last_failure_reason TEXT,
    created_at TEXT NOT NULL,
    created_by TEXT NOT NULL,

    FOREIGN KEY (namespace_id) REFERENCES namespaces(id),
    FOREIGN KEY (created_by) REFERENCES principals(id)
);

CREATE INDEX idx_webhooks_namespace ON webhooks(namespace_id);
CREATE INDEX idx_webhooks_status ON webhooks(status);

-- Audit Events table (append-only)
CREATE TABLE audit_events (
    id TEXT PRIMARY KEY,
    timestamp TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    principal_type TEXT NOT NULL,
    credential_id TEXT,
    action TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    namespace_id TEXT,
    details JSON,
    client_ip TEXT,
    user_agent TEXT,
    success INTEGER NOT NULL DEFAULT 1,
    error_message TEXT
);

CREATE INDEX idx_audit_timestamp ON audit_events(timestamp DESC);
CREATE INDEX idx_audit_principal ON audit_events(principal_id);
CREATE INDEX idx_audit_resource ON audit_events(resource_type, resource_id);
CREATE INDEX idx_audit_namespace ON audit_events(namespace_id);
CREATE INDEX idx_audit_action ON audit_events(action);

-- Full-Text Search virtual table
CREATE VIRTUAL TABLE artifacts_fts USING fts5(
    artifact_id,
    searchable_text,
    tokenize='porter unicode61'
);

-- FTS Triggers

-- Insert into FTS when artifact is created with a version
CREATE TRIGGER artifacts_fts_insert AFTER INSERT ON artifacts
WHEN NEW.current_version_id IS NOT NULL
BEGIN
    INSERT INTO artifacts_fts(artifact_id, searchable_text)
    SELECT NEW.id, av.searchable_text
    FROM artifact_versions av
    WHERE av.id = NEW.current_version_id;
END;

-- Update FTS when current_version_id changes
CREATE TRIGGER artifacts_fts_version_update AFTER UPDATE OF current_version_id ON artifacts
WHEN NEW.current_version_id IS NOT NULL
BEGIN
    DELETE FROM artifacts_fts WHERE artifact_id = OLD.id;
    INSERT INTO artifacts_fts(artifact_id, searchable_text)
    SELECT NEW.id, av.searchable_text
    FROM artifact_versions av
    WHERE av.id = NEW.current_version_id;
END;

-- Remove from FTS when artifact is archived
CREATE TRIGGER artifacts_fts_archive AFTER UPDATE OF archived_at ON artifacts
WHEN NEW.archived_at IS NOT NULL AND OLD.archived_at IS NULL
BEGIN
    DELETE FROM artifacts_fts WHERE artifact_id = OLD.id;
END;

-- Add back to FTS when artifact is unarchived
CREATE TRIGGER artifacts_fts_unarchive AFTER UPDATE OF archived_at ON artifacts
WHEN NEW.archived_at IS NULL AND OLD.archived_at IS NOT NULL
BEGIN
    INSERT INTO artifacts_fts(artifact_id, searchable_text)
    SELECT NEW.id, av.searchable_text
    FROM artifact_versions av
    WHERE av.id = NEW.current_version_id;
END;

-- Migrations tracking table
CREATE TABLE _migrations (
    name TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
);
