-- Migration 005: Add "setup" to connect_sessions.client_kind CHECK
-- SQLite cannot alter CHECK constraints in-place, so rebuild the table.

PRAGMA foreign_keys = OFF;

BEGIN TRANSACTION;

CREATE TABLE connect_sessions_new (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN (
            'pending','approved','redeemed',
            'expired','cancelled','failed'
        )),
    client_kind TEXT NOT NULL
        CHECK (client_kind IN ('openclaw','claude_code','codex','mcp','generic','setup')),
    completion_mode TEXT NOT NULL
        CHECK (completion_mode IN ('loopback','poll')),
    display_name TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    code_challenge_method TEXT NOT NULL DEFAULT 'S256'
        CHECK (code_challenge_method = 'S256'),
    requested_scope_json TEXT,
    requested_namespace_id TEXT,
    selected_namespace_id TEXT,
    approved_by TEXT,
    approved_at TEXT,
    approved_scope_json TEXT,
    provisioned_principal_id TEXT,
    one_time_auth_code_hash TEXT,
    one_time_auth_code_expires_at TEXT,
    loopback_redirect_uri TEXT,
    client_ip TEXT,
    user_agent TEXT,
    metadata_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    redeemed_at TEXT,
    cancelled_at TEXT,
    failed_at TEXT,
    failure_reason TEXT,
    FOREIGN KEY (requested_namespace_id) REFERENCES namespaces(id),
    FOREIGN KEY (selected_namespace_id) REFERENCES namespaces(id),
    FOREIGN KEY (approved_by) REFERENCES principals(id),
    FOREIGN KEY (provisioned_principal_id) REFERENCES principals(id)
);

INSERT INTO connect_sessions_new (
    id,
    status,
    client_kind,
    completion_mode,
    display_name,
    code_challenge,
    code_challenge_method,
    requested_scope_json,
    requested_namespace_id,
    selected_namespace_id,
    approved_by,
    approved_at,
    approved_scope_json,
    provisioned_principal_id,
    one_time_auth_code_hash,
    one_time_auth_code_expires_at,
    loopback_redirect_uri,
    client_ip,
    user_agent,
    metadata_json,
    created_at,
    updated_at,
    expires_at,
    redeemed_at,
    cancelled_at,
    failed_at,
    failure_reason
)
SELECT
    id,
    status,
    client_kind,
    completion_mode,
    display_name,
    code_challenge,
    code_challenge_method,
    requested_scope_json,
    requested_namespace_id,
    selected_namespace_id,
    approved_by,
    approved_at,
    approved_scope_json,
    provisioned_principal_id,
    one_time_auth_code_hash,
    one_time_auth_code_expires_at,
    loopback_redirect_uri,
    client_ip,
    user_agent,
    metadata_json,
    created_at,
    updated_at,
    expires_at,
    redeemed_at,
    cancelled_at,
    failed_at,
    failure_reason
FROM connect_sessions;

DROP TABLE connect_sessions;
ALTER TABLE connect_sessions_new RENAME TO connect_sessions;

CREATE INDEX idx_connect_sessions_status ON connect_sessions(status);
CREATE INDEX idx_connect_sessions_expires ON connect_sessions(expires_at);

COMMIT;

PRAGMA foreign_keys = ON;
