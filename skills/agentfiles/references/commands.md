# AgentFiles Command Matrix

Use `scripts/run-agentfiles.js` for all command execution so the skill can safely choose between a local `agentfiles` binary and the published `agentfiles-cli` package through npm.

## Read Operations

- `scripts/run-agentfiles.js whoami`
  - Verify auth, principal identity, and visible namespaces.
- `scripts/run-agentfiles.js config --show`
  - Show current CLI config without changing it.
- `scripts/run-agentfiles.js list -n <namespace> [-l <limit>]`
  - List recent artifacts in a namespace.
- `scripts/run-agentfiles.js search "<query>" -n <namespace> [-l <limit>]`
  - Search artifacts by title or description.
- `scripts/run-agentfiles.js get <artifact-id>`
  - Print artifact content.
- `scripts/run-agentfiles.js get <artifact-id> --meta`
  - Print artifact metadata.
- `scripts/run-agentfiles.js get <artifact-id> -o <file>`
  - Write artifact content to a file.

## Write Operations

- `scripts/run-agentfiles.js publish ./file -n <namespace> --title <title>`
  - Publish a file as a new artifact.
- `scripts/run-agentfiles.js publish --content "<text>" -n <namespace> --title <title>`
  - Publish inline text.
- `scripts/run-agentfiles.js publish ./file --update <artifact-id> [-m <message>]`
  - Create a new version of an existing artifact.
- `scripts/run-agentfiles.js handoff <recipient> --content "<text>" [-n <namespace>] [--thread <id>]`
  - Publish an artifact addressed to another runtime with handoff envelope metadata.
- `scripts/run-agentfiles.js handoff <recipient> --reply-to-artifact-id <id> --content "<text>"`
  - Reply to a handoff artifact in a thread.
- `scripts/run-agentfiles.js share <artifact-id> [-e <days>]`
  - Create a temporary share token and preview URL.

## Watch Operations

- `scripts/run-agentfiles.js watch -n <namespace>`
  - Start a foreground polling watcher.
- `scripts/run-agentfiles.js watch -n <namespace> --json`
  - Emit NDJSON events for wrappers and scripts.
- `scripts/run-agentfiles.js watch -n <namespace> --since all --once`
  - Emit the currently visible set once and exit.
- `scripts/run-agentfiles.js watch -n <namespace> --exec ./script`
  - Run a local executable for each emitted event.

Read `references/runtime-notes.md` before using `watch` in automation.

## Connect and Config

- `scripts/run-agentfiles.js setup`
  - Run the primary one-command onboarding flow for shared local credentials plus Claude Code/Codex auto-configuration.
- `scripts/run-agentfiles.js config --api-url <url> --api-key <key> [--default-namespace <slug>]`
  - Write CLI config directly when the API URL and key are already known.
- `scripts/run-agentfiles.js connect <runtime>`
  - Use only when the user explicitly wants a runtime-specific browser approval flow.

## Command Selection Rules

- Start with `whoami` if auth state is unclear.
- Start with `config --show` if namespace resolution is unclear.
- Prefer `setup` before `connect` unless dedicated per-runtime credentials are required.
- Use `publish --update <id>` for new versions instead of re-creating an artifact.
- Use `--json` for machine-readable `watch` output.
- Keep `connect` out of the default path for scripted or already-configured machines.
