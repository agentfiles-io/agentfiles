# CLI

The CLI lives in `tools/cli` and is published as `agentfiles-cli`.

## Build and Run Locally

```bash
pnpm build
node tools/cli/dist/index.js whoami
```

## Self-Hosted Configuration

For self-hosted usage, bootstrap an API key first and then save it locally:

```bash
node tools/cli/dist/index.js config --api-url http://localhost:2009 --api-key <your-api-key> --default-namespace dev
```

The CLI stores config in `~/.attach/config.json`.

This is the default public self-host flow. It does not require `agentfiles setup`, hosted approval, or Auth0.

## Core Commands

```bash
node tools/cli/dist/index.js publish ./artifact.md --title "Artifact"
node tools/cli/dist/index.js publish --content "hello" --title "Greeting"
node tools/cli/dist/index.js get <artifact-id>
node tools/cli/dist/index.js list -n dev
node tools/cli/dist/index.js search "query" -n dev
node tools/cli/dist/index.js share <artifact-id>
node tools/cli/dist/index.js whoami
```

## Handoff

```bash
node tools/cli/dist/index.js handoff codex --content "Please review this patch"
node tools/cli/dist/index.js handoff claude_code --reply-to-artifact-id <artifact-id> --content "Looks good"
```

Handoff metadata is stored in artifact provenance so other runtimes can preserve sender, recipient, thread, and reply relationships.

## Package Distribution

Building from source is enough for localhost use. If you want users to rely on:

- `npx agentfiles-cli@latest`
- `npm install -g agentfiles-cli`
- skill fallback to the published CLI package

then `agentfiles-cli` should be published from the new public repo as part of release setup.

## Watch

```bash
node tools/cli/dist/index.js watch -n dev
node tools/cli/dist/index.js watch -n dev --json
node tools/cli/dist/index.js watch -n dev --exec ./scripts/on-artifact.sh
```

Watch is polling-based in V1. It is useful for sidecars, wrappers, and local automations, but it is not a push stream.
