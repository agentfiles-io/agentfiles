# Watch and Handoff

## Watch

`agentfiles watch` polls the namespace artifact list and emits events for new versions.

Examples:

```bash
node tools/cli/dist/index.js watch -n dev
node tools/cli/dist/index.js watch -n dev --json
node tools/cli/dist/index.js watch -n dev --once --since all
node tools/cli/dist/index.js watch -n dev --exec ./scripts/on-artifact.sh
```

When `--exec` is used, the CLI exports:

- `AGENTFILES_EVENT`
- `AGENTFILES_ARTIFACT_ID`
- `AGENTFILES_ARTIFACT_TITLE`
- `AGENTFILES_NAMESPACE`
- `AGENTFILES_VERSION`
- `AGENTFILES_UPDATED_AT`

V1 watch caveats:

- polling only
- in-memory seen-state only
- high-churn namespaces can outrun the polling window

## Handoff

Handoff is implemented as normal artifact publish/update flow with provenance fields that describe agent-to-agent intent.

Examples:

```bash
node tools/cli/dist/index.js handoff codex --content "Please review this patch"
node tools/cli/dist/index.js handoff codex ./review.md --thread pr-17
node tools/cli/dist/index.js handoff claude_code --reply-to-artifact-id <artifact-id> --content "Applied"
```

Important provenance fields:

- `senderRuntime`
- `recipient`
- `threadId`
- `handoffKind`
- `replyToArtifactId`

Because handoff rides on the normal artifact spine, it works with API, CLI, search, sharing, namespace scoping, and git-backed history.
