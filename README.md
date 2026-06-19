# VibeCommit — Claude Code Plugin

Git for AI-agent conversations: capture, search, and diff your agent sessions.
One-command install wires the VibeCommit MCP server into Claude Code so your
coding sessions become a queryable, tamper-evident history.

## Install

```
/plugin marketplace add Vibe-Commit/claude-plugin
/plugin install vibecommit-capture@vibecommit-capture
```

That's it. Claude Code now automatically:
- Calls `setup` once per session to load the capture rules
- Calls `commit_transcript` after every commit and shares the provenance URL with you

The full tool surface (below) is then available for Claude to capture the live
conversation, search your history, and diff sessions on request.

## What gets installed

The plugin delivers three rules files to your project and configures the MCP server:

| File | Purpose |
|---|---|
| `AGENTS.md` | Cross-vendor anchor — every agent framework reads this |
| `CLAUDE.md` | Claude Code project instructions with the capture protocol |
| `.claude/skills/vibecommit/SKILL.md` | Claude Code skill for explicit `/vibecommit` invocation |
| `.mcp.json` | MCP server config pointing at `https://api.vibecommit.ai/mcp` |

All rules files carry the capture protocol: call `setup` at session start, call
`commit_transcript` after every commit, and surface the `provenance_url` to the
user.

## Cross-vendor users

Using Cursor, Windsurf, VS Code Copilot, or another agent? The plugin path is
Claude Code-specific. For all other agents — or for the same per-session re-sync
experience across vendors — use the VibeCommit setup tool instead:

**https://www.vibecommit.ai/install**

The install page has one-liner MCP blocks for every supported agent. The `setup`
MCP tool delivers the same rules files the plugin ships, so you get byte-identical
content either way.

## How it works

VibeCommit is an MCP server at `https://api.vibecommit.ai/mcp`. It turns your
agent sessions into version control: an append-only, tamper-evident substrate you
can capture into, then search and diff. It exposes these tools:

**Capture**

- **`commit_conversation`** — capture the current coding conversation, no commit
  required. Pass the transcript file path or the parsed records inline; the server
  deduplicates against prior captures, links continuations into one conversation,
  and returns a `provenance_url`. Re-capturing the same conversation is a free no-op.
- **`commit_transcript`** — record a captured session for a specific commit. Pass
  the transcript file path or raw narration plus the commit SHA; returns a
  `provenance_url` the agent can show you.
- **`attach_to_existing_commit`** — recovery path: attach transcript provenance to
  a commit made outside the normal `commit_transcript` flow.

**Search & read**

- **`search_history`** — full-text search over your captured commit history by
  free-text query, with optional repo/org filters.
- **`query_history`** — list your prior commit captures, most-recent-first, with
  optional repo and time-window filters and keyset pagination.
- **`get_conversation`** — read one captured conversation in full: its captures
  and, for each, the ordered turns with reconstructed content.
- **`diff_conversation`** — compare two branches or runs of the same captured
  conversation and see where they diverge. Pure read — nothing is written.

**Setup**

- **`setup`** — install or refresh the per-agent rules files that wire your session
  into the capture flow. Re-runnable and idempotent; content-hash skip-if-current
  on the common path.

First call triggers OAuth in your browser (GitHub login). After that, capture is
silent.

## Version

Plugin version is pinned at `1.0.0` in `.claude-plugin/plugin.json`. You only
receive updates when this field is bumped — no surprise rebuilds on every commit.

## License

MIT. See [LICENSE](LICENSE).

This MIT license covers the plugin bundle in this repository (the rules files and `.mcp.json` configuration) only; the hosted VibeCommit MCP server it connects to at `https://api.vibecommit.ai/mcp` is a separate work licensed under the Business Source License 1.1, not MIT.
