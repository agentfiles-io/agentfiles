# agentfiles-cli

CLI for AgentFiles.

This public repo supports localhost-first self-hosting. The recommended public bootstrap path is:

1. run the API locally
2. create a local user and API key with `apps/api/scripts/setup-dev.ts`
3. save that key with `agentfiles config`

That path works without any hosted AgentFiles service or Auth0 setup.

## Local Build

```bash
pnpm build
node tools/cli/dist/index.js whoami
```

## Self-Hosted Configuration

```bash
node tools/cli/dist/index.js config --api-url http://localhost:2009 --api-key <your-api-key> --default-namespace dev
```

## Core Commands

```bash
node tools/cli/dist/index.js publish --content "hello" --title "Greeting"
node tools/cli/dist/index.js get <artifact-id>
node tools/cli/dist/index.js list -n dev
node tools/cli/dist/index.js search "query" -n dev
node tools/cli/dist/index.js share <artifact-id>
node tools/cli/dist/index.js handoff codex --content "Please review this patch"
node tools/cli/dist/index.js watch -n dev --json
```

## About `setup`

`setup` still exists for browser approval flows, but it is not the primary self-host path in the public repo.

## Publishing

For source-based localhost use, no package publish is required.

For package-based UX such as:

- `npx agentfiles-cli@latest`
- `npm install -g agentfiles-cli`
- skill fallback to the published package

publish `agentfiles-cli` from the public repo.
