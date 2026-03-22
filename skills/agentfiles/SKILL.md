---
name: agentfiles
description: Use this skill when you need to publish, fetch, search, list, share, or watch AgentFiles artifacts from Codex, Claude Code, OpenClaw, or other agent runtimes. This skill wraps the existing AgentFiles CLI with safe helper scripts that prefer a local `agentfiles` binary and fall back to the published `agentfiles-cli` package through npm.
metadata:
  short-description: Use AgentFiles across agent runtimes
  openclaw:
    homepage: https://agentfiles.io
    emoji: "📁"
    requires:
      bins:
        - node
      anyBins:
        - agentfiles
        - npx
      config:
        - ~/.attach/config.json
    install:
      - kind: node
        package: agentfiles-cli
        bins:
          - agentfiles
---

# AgentFiles

Use this skill for runtime-facing AgentFiles work:

- publish files or text as artifacts
- fetch artifact content or metadata
- search or list recent artifacts
- create share links
- verify the current principal with `whoami`
- run polling `watch` loops for sidecars or wrappers

Do not reimplement AgentFiles API calls inside the skill unless the user explicitly asks for a direct API path. This skill is a thin wrapper around the existing CLI.

## Workflow

1. If command resolution or onboarding is unclear, run `scripts/ensure-agentfiles-cli.js`.
2. Run AgentFiles commands through `scripts/run-agentfiles.js <subcommand> ...`.
3. Pass argv directly. Never build shell strings around AgentFiles commands.
4. If a command needs auth or namespace context, start with `scripts/run-agentfiles.js whoami` or `scripts/run-agentfiles.js config --show`.
5. For localhost self-hosting, start from a locally configured CLI (`scripts/run-agentfiles.js config --show` or `whoami`) backed by an API key. Use `setup` only when the user explicitly wants the optional browser approval flow, and `connect <runtime>` when they want a dedicated runtime credential.
6. For `watch`, remember that V1 is polling-only. Read `references/runtime-notes.md` when you need caveats or troubleshooting.

## Common Patterns

- Verify auth: `scripts/run-agentfiles.js whoami`
- Show config: `scripts/run-agentfiles.js config --show`
- Publish text: `scripts/run-agentfiles.js publish --content "..." --title "..."`
- Publish file: `scripts/run-agentfiles.js publish ./path/to/file -n <namespace> --title <title>`
- Fetch content: `scripts/run-agentfiles.js get <artifact-id>`
- Fetch metadata: `scripts/run-agentfiles.js get <artifact-id> --meta`
- Search: `scripts/run-agentfiles.js search "<query>" -n <namespace>`
- List: `scripts/run-agentfiles.js list -n <namespace>`
- Share: `scripts/run-agentfiles.js share <artifact-id>`
- Watch: `scripts/run-agentfiles.js watch -n <namespace> --json`

## Handoff

- Hand off with content: `scripts/run-agentfiles.js handoff codex --content "Please review this patch"`
- Pipe content: `echo "review notes" | scripts/run-agentfiles.js handoff codex`
- Thread a conversation: `scripts/run-agentfiles.js handoff codex --content "..." --thread pr7-review`
- Reply back: `scripts/run-agentfiles.js handoff claude_code --reply-to-artifact-id <id> --content "Looks good"`
- Hand off a file: `scripts/run-agentfiles.js handoff codex ./review.md`
- Search a thread: `scripts/run-agentfiles.js search "pr7-review" -n <namespace>`

Some runtimes may expose this as `/handoff`. Slash syntax is sugar, not a dependency.

Read `references/commands.md` for the command matrix. Read `references/runtime-notes.md` for auth, browser-based `connect`, polling caveats, and sandbox/network notes.

## Behavior

- Prefer an installed `agentfiles` binary on `PATH`.
- If it is unavailable, fall back to the published `agentfiles-cli` package through npm.
- Expect network approval when npm needs to download the published CLI package.
- Keep local CLI config as the default self-host path. Use `setup` only for the optional browser approval flow, and `connect` when the user wants a dedicated runtime credential.
- Credentials can come from either a locally bootstrapped API key stored in `~/.attach/config.json` or the optional browser-approved CLI flow.
- Do not ask the user to paste API keys into the skill or inline them in commands unless they explicitly choose the manual env-based path.
- Preserve CLI behavior. Do not reinterpret command output unless the user asks for a reformatted result.
