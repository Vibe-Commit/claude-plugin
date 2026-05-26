# VibeCommit — Claude Code Plugin

One-command install for session capture in Claude Code.
VibeCommit records what your AI agent did and why — every commit, every session.

## Install

```
/plugin marketplace add Vibe-Commit/claude-plugin
/plugin install vibecommit-capture@vibecommit-capture
```

That's it. Claude Code now automatically:
- Calls `setup` once per session to load the capture rules
- Calls `commit_transcript` after every commit and shares the provenance URL with you

## What gets installed

The plugin delivers three rules files to your project and configures the MCP server:

| File | Purpose |
|---|---|
| `AGENTS.md` | Cross-vendor anchor — every agent framework reads this |
| `CLAUDE.md` | Claude Code project instructions with the capture protocol |
| `.claude/skills/vibecommit/SKILL.md` | Claude Code skill for explicit `/vibecommit` invocation |
| `.mcp.json` | MCP server config pointing at `https://api.vibecommit.ai/mcp` |

All rules files carry the cooperation-rate-load-bearing capture protocol: call
`setup` at session start, call `commit_transcript` after every commit, surface the
`provenance_url` to the user.

## Cross-vendor users

Using Cursor, Windsurf, VS Code Copilot, or another agent? The plugin path is
Claude Code-specific. For all other agents — or for the same per-session re-sync
experience across vendors — use the VibeCommit setup tool instead:

**https://www.vibecommit.ai/install**

The install page has one-liner MCP blocks for every supported agent. The `setup`
MCP tool delivers the same rules files the plugin ships, so you get byte-identical
content either way.

## How it works

VibeCommit is an MCP server at `https://api.vibecommit.ai/mcp`. It exposes three
tools:

- **`setup`** — returns the rules files for your agent (idempotent; skip-if-current
  on the common path)
- **`commit_transcript`** — uploads the session transcript + commit SHA; returns
  `{ trace_id, hash, provenance_url }`
- **`attach_to_existing_commit`** — retroactively links a transcript to a commit

First call triggers OAuth in your browser (GitHub login). After that, every
`commit_transcript` call is silent.

## Version

Plugin version is pinned at `1.0.0` in `.claude-plugin/plugin.json`. You only
receive updates when this field is bumped — no surprise rebuilds on every commit.

## License

MIT. See [LICENSE](LICENSE).
