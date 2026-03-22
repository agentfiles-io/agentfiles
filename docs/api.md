# API

The API lives in `apps/api` and uses:

- Hono for routing
- SQLite for metadata
- local blob storage for fallback reads
- git-backed namespace repositories for artifact content history

## Start the API

```bash
pnpm --filter @attach/api dev
```

Default base URL:

```text
http://localhost:2009
```

## Authentication Modes

- Self-hosted primary path: `Authorization: Bearer <arun_...>` API keys
- Optional browser-session path: `attach_session` cookie, currently tied to Auth0 env configuration
- Share links: `X-Share-Token`

## Core Routes

- `GET /health`
- `GET /`
- `GET /v1/me`
- `POST /v1/namespaces`
- `GET /v1/namespaces`
- `GET /v1/namespaces/:slug`
- `PATCH /v1/namespaces/:slug`
- `GET /v1/namespaces/:slug/artifacts`
- `GET /v1/namespaces/:slug/search?q=<query>`
- `POST /v1/artifacts`
- `GET /v1/artifacts/:id`
- `GET /v1/artifacts/:id/content`
- `PUT /v1/artifacts/:id`
- `GET /v1/artifacts/:id/versions`
- `GET /v1/artifacts/:id/diff`
- `POST /v1/artifacts/:id/archive`
- `POST /v1/artifacts/:id/unarchive`
- `POST /v1/grants`
- `GET /v1/grants`
- `POST /v1/grants/:id/revoke`
- `POST /v1/connect/sessions`
- `GET /v1/connect/sessions/:id`
- `POST /v1/connect/sessions/:id/redeem`
- `POST /v1/connect/sessions/:id/cancel`
- `POST /v1/git/import`
- `POST /v1/git/sync/:id`
- `GET /v1/git/export/:id`

## Local Bootstrap Example

1. Start the API.
2. Run `pnpm --filter @attach/api exec tsx scripts/setup-dev.ts`.
3. Save the printed API key with `node tools/cli/dist/index.js config ...`.
4. Use the CLI or call the API directly.

## Storage Behavior

Artifact writes follow the same spine used internally:

- preflight validation
- namespace-scoped git commit
- SQLite metadata write
- rollback if the SQLite write fails after git commit

That keeps the exported repo useful as a real self-hosted artifact plane instead of a demo shell.
