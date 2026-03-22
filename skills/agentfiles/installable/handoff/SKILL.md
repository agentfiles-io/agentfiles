---
name: handoff
description: Hand off work to another AI agent (Codex, Claude Code, etc.) via AgentFiles. Use when the user wants to send context, files, or instructions to another runtime.
argument-hint: <recipient> [what to send]
disable-model-invocation: true
---

# Handoff

Hand off work to another agent via the AgentFiles MCP server.

## Arguments

`$0` is the recipient runtime (e.g. `codex`, `claude_code`).
Everything after the recipient is a natural-language description of what to hand off.

## What to do

1. Identify the recipient from `$0`.
2. Figure out what content to send:
   - If the user described specific content after the recipient (e.g. `/handoff codex send the API design above`), gather that content from the conversation.
   - If the user just said `/handoff codex`, send a summary of the current task state: what was done, what's next, key decisions made, and any relevant code or file paths.
   - If the conversation produced a plan, code, review, or other concrete output, include it verbatim.
3. Call the `artifact_publish` MCP tool with:
   - `title`: a short descriptive title (e.g. "API design for review", "Code review feedback")
   - `content`: the gathered content, formatted as markdown
   - `content_type`: `"text/markdown"`
   - `to`: the recipient from `$0`
   - `thread`: a descriptive thread ID if one makes sense (e.g. `pr-7-review`, `api-redesign`), or omit to let the server auto-generate one
   - `message`: a one-line version message (e.g. "Initial handoff", "Review feedback")
4. After publishing, tell the user:
   - The artifact ID
   - The recipient
   - The thread ID (so the other agent can search for it)
   - A suggestion like: "Tell $0 to search for thread '<thread>' in AgentFiles"

## Rules

- Always use the `artifact_publish` MCP tool. Do not shell out to the CLI.
- Do not ask for confirmation before publishing unless the content is ambiguous.
- Keep the content focused and actionable. The recipient agent should be able to pick up the work without extra context.
- If no namespace is configured, the MCP server will use the default. Do not ask the user for a namespace unless the publish fails.
