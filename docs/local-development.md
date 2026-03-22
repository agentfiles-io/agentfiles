# Local Development

## Install

```bash
pnpm install
```

## Main Workspace Commands

```bash
pnpm build
pnpm typecheck
pnpm test
pnpm lint
```

## Run Individual Surfaces

```bash
pnpm --filter @attach/api dev
pnpm --filter agentfiles-mcp dev
pnpm --filter agentfiles-cli dev
pnpm --filter @attach/agentfiles-skill test
```

## Self-Hosted Dev Bootstrap

```bash
cp .env.example .env
pnpm build
pnpm --filter @attach/api dev
pnpm --filter @attach/api exec tsx scripts/setup-dev.ts
```

Then configure the CLI with the printed API key.

This localhost flow is the intended public default. It does not depend on the hosted dashboard or browser login.

## Why `@attach/*` Still Exists

This mirror keeps internal workspace package names unchanged on purpose:

- avoids breaking the private repo’s active branches and imports
- keeps the export low risk and repeatable
- defers the `@attach/*` to `@agentfiles/*` rename to a later pass

The public packages and binaries are already branded correctly:

- `agentfiles-cli`
- `agentfiles-mcp`
- `agentfiles`

For a polished public experience, the new public repo should also own package publishing for `agentfiles-cli` and `agentfiles-mcp`.
