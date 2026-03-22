# MCP

The MCP server lives in `apps/mcp-server` and ships two binaries:

- `agentfiles-mcp` for stdio
- `agentfiles-mcp-http` for HTTP transport

You can run both locally against a self-hosted API with no cloud dependency.

## Configuration

The server reads credentials from either:

- `ATTACH_API_URL` and `ATTACH_API_KEY`
- `~/.attach/config.json`

## Run Over Stdio

```bash
ATTACH_API_URL=http://localhost:2009 \
ATTACH_API_KEY=<your-api-key> \
node apps/mcp-server/dist/index.js
```

## Run Over HTTP

```bash
ATTACH_API_URL=http://localhost:2009 \
ATTACH_API_KEY=<your-api-key> \
node apps/mcp-server/dist/http.js --port 8787
```

Optional environment variables:

- `AGENTFILES_MCP_HOST`
- `AGENTFILES_MCP_PORT`
- `AGENTFILES_MCP_PATH`
- `PUBLIC_BASE_URL`
- `PUBLIC_APP_URL`

## HTTP Authentication

The HTTP transport expects:

```text
Authorization: Bearer <ATTACH_API_KEY>
```

Health check:

```text
GET /health
```

Default MCP path:

```text
/mcp
```

## ChatGPT / Remote Connector Shape

Expose the HTTP server over HTTPS and point your connector at:

```text
https://<your-host>/mcp
```

with the same bearer token header. This repo includes the server component, not a managed hosted connector.

## Package Distribution

For local source usage, building this repo is sufficient.

For package-driven installs such as `npx agentfiles-mcp@latest` or globally installing the MCP binaries, publish `agentfiles-mcp` from the public repo.
