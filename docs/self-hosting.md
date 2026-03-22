# Self-Hosting

This repo ships the real AgentFiles core for self-hosted deployments:

- Hono API in `apps/api`
- SQLite metadata plus local blob and git-backed artifact storage in `packages/db`
- CLI in `tools/cli`
- MCP binaries in `apps/mcp-server`
- runtime skill wrapper in `skills/agentfiles`

No AgentFiles cloud component is required for this path.

## Prerequisites

- Node.js 20+
- pnpm 9+

## Bootstrapping

```bash
pnpm install
cp .env.example .env
pnpm build
pnpm --filter @attach/api dev
```

Set `SESSION_SECRET` before starting the API.

## Local Self-Hosted Auth

The fastest self-hosted path today is local API-key bootstrap, not hosted browser onboarding.

Create a local user, namespace, and API key:

```bash
pnpm --filter @attach/api exec tsx scripts/setup-dev.ts
```

Then configure the CLI:

```bash
node tools/cli/dist/index.js config --api-url http://localhost:2009 --api-key <your-api-key> --default-namespace dev
node tools/cli/dist/index.js whoami
```

## Storage Layout

- SQLite database: `DATABASE_PATH`
- blob fallback store: `BLOB_STORAGE_PATH`
- git-backed artifact repos: `BLOB_STORAGE_PATH/repos/<namespace-id>/`

Artifacts are committed into namespace-scoped git repositories. SQLite stores metadata, lineage, grants, keys, namespaces, and runtime instances.

## Optional Browser Login

The current browser session flow still expects Auth0 environment variables. That path is useful when you want the existing approval UX, but it is not required for self-hosted core usage on day one.

For the public repo, localhost usage should assume the local API-key path unless you intentionally wire up your own browser auth layer.

## Git Import, Sync, and Export

The API includes routes for:

- importing content from a git repository
- syncing from a configured artifact source
- exporting artifacts back out as git content

See [`docs/api.md`](api.md) for the concrete routes.
