# Skills

The runtime skill wrapper lives in `skills/agentfiles`.

It is intentionally thin:

- prefers a local `agentfiles` binary when available
- falls back to the published `agentfiles-cli` package
- reuses the normal CLI config in `~/.attach/config.json`
- avoids re-implementing API logic inside the skill

For localhost self-hosting, users can rely on a locally built `agentfiles` binary. The npm fallback is useful only once `agentfiles-cli` is published from the public repo.

## Files

- `skills/agentfiles/SKILL.md`
- `skills/agentfiles/scripts/run-agentfiles.js`
- `skills/agentfiles/scripts/ensure-agentfiles-cli.js`
- `skills/agentfiles/references/*`

## Typical Flow

1. Configure the CLI locally.
2. Install or point the runtime at `skills/agentfiles`.
3. Run `scripts/run-agentfiles.js whoami`.
4. Use the skill for publish, search, list, get, share, watch, and handoff flows.

The exported repo includes the actual skill wrapper, not a placeholder.
