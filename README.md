# AgentFiles

AgentFiles is the open-core artifact layer for multi-agent workflows. It gives agents and tools a shared artifact plane with a self-hostable API, CLI, MCP server, SQLite metadata, git-backed artifact storage, polling watch flows, and handoff semantics.

`/handoff` is the core workflow: one agent publishes a review packet, patch note, or next-step brief as an artifact with sender, recipient, thread, and reply lineage attached. Claude Code and OpenClaw can expose that as `/handoff`, Codex can send the same envelope through `agentfiles handoff`, and ChatGPT can read the exact same artifact stream over MCP without copy-paste.

That means a review packet published from Claude Code on a VPS can be picked up later by Codex on a laptop, inspected from ChatGPT over MCP, or replied to from OpenClaw in the same thread. AgentFiles is the shared artifact plane underneath those runtimes, not another chat silo.

The public repo is localhost-first. You can run it entirely on your own machine without any AgentFiles cloud dependency, hosted dashboard, or Auth0 setup.

This repository contains the self-hostable core:

- artifact publish, read, list, search, share, archive, diff, and version history
- API key based API access
- MCP over stdio and HTTP
- CLI workflows for publish, handoff, watch, search, and sharing
- local file storage plus git-backed artifact commits
- the `skills/agentfiles` wrapper used by runtime integrations

The hosted/commercial control plane and dashboard are intentionally not included here. Internal workspace packages also intentionally remain `@attach/*` in this split so the private source repo can keep shipping without a destabilizing rename.

## Quickstart

### Prerequisites

- Node.js 20+
- pnpm 9+

### 1. Install and configure

```bash
pnpm install
cp .env.example .env
```

Set at least `SESSION_SECRET` in `.env` before starting the API.

### 2. Build and start the API

```bash
pnpm build
pnpm --filter @attach/api dev
```

By default the API listens on `http://localhost:2009`.

### 3. Bootstrap a local self-hosted user and API key

In another terminal:

```bash
pnpm --filter @attach/api exec tsx scripts/setup-dev.ts
```

That script initializes SQLite, creates a local user, creates a namespace, and prints an API key for self-hosted development.

### 4. Configure the CLI

```bash
node tools/cli/dist/index.js config --api-url http://localhost:2009 --api-key <your-api-key> --default-namespace dev
node tools/cli/dist/index.js whoami
```

### 5. Publish and inspect an artifact

```bash
node tools/cli/dist/index.js publish --content "hello from AgentFiles" --title "Greeting"
node tools/cli/dist/index.js list -n dev
node tools/cli/dist/index.js search "greeting" -n dev
```

## MCP

Start the HTTP MCP server with the same API key:

```bash
ATTACH_API_URL=http://localhost:2009 \
ATTACH_API_KEY=<your-api-key> \
node apps/mcp-server/dist/http.js --port 8787
```

For stdio usage:

```bash
ATTACH_API_URL=http://localhost:2009 \
ATTACH_API_KEY=<your-api-key> \
node apps/mcp-server/dist/index.js
```

## Packages

This repo is usable from source immediately. For package-driven workflows such as:

- `npx agentfiles-cli@latest ...`
- `npm install -g agentfiles-cli`
- `npx agentfiles-mcp@latest`
- skill fallback to the published CLI package

the public repo should also publish `agentfiles-cli` and `agentfiles-mcp`.

## Repo Structure

```text
apps/api         Hono API server
apps/mcp-server  MCP server binaries
packages/db      SQLite + git-backed storage layer
packages/shared  Shared types and helpers
tools/cli        agentfiles CLI
skills/agentfiles Runtime skill wrapper around the CLI
docs/            Self-hosting, API, MCP, watch/handoff, and local dev guides
```

## Key Docs

- [`docs/self-hosting.md`](docs/self-hosting.md)
- [`docs/api.md`](docs/api.md)
- [`docs/cli.md`](docs/cli.md)
- [`docs/mcp.md`](docs/mcp.md)
- [`docs/watch-handoff.md`](docs/watch-handoff.md)
- [`docs/local-development.md`](docs/local-development.md)
- [`docs/skills.md`](docs/skills.md)

## What Is Not Included

- hosted attach.dev / AgentFiles control-plane code
- browser dashboard and org/admin surfaces
- private operational docs and roadmap notes
- secret material or hosted deployment configuration

## License

MIT
