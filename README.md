# VibeCommit — Claude Code Plugin

One-command install for session capture in Claude Code.
VibeCommit records what your AI agent did: Claude Code hooks capture sessions at
their Stop, PreCompact, and SessionEnd boundaries by default, with an opt-in hook
for capture at the moment of commit — see [below](#optional-capture-on-every-commit-compliance-tier).

## Install

```
/plugin marketplace add Vibe-Commit/claude-plugin
/plugin install vibecommit@vibecommit-capture
```

That's it. Claude Code now:
- Fires Claude Code hooks on `Stop`, `PreCompact`, and `SessionEnd` that invoke
  the bundled capture client directly — capture that does not depend on the
  agent calling a tool
- Connects the VibeCommit MCP server, so your agent can search, blame and diff
  your captured history (`search_history`, `blame_commit`, `commit_coverage`,
  `get_conversation`, `diff_conversation`)

## What gets installed

The plugin installs hooks and the MCP server config:

| Component | Purpose |
|---|---|
| `hooks/hooks.json` | `Stop`, `PreCompact` and `SessionEnd` hooks that run the bundled capture client |
| `bin/` | The vendored capture client those hooks invoke |
| `.mcp.json` | MCP server config pointing at `https://api.vibecommit.ai/mcp` |

**The rules files are not installed by the plugin.** `AGENTS.md`, `CLAUDE.md` and
`.claude/skills/vibecommit/SKILL.md` in this repository are the canonical rules text,
but Claude Code does not load a plugin's root `CLAUDE.md` or `AGENTS.md` as context,
and this plugin has no `skills/` directory, so installing the plugin alone gives your
agent no rules text. The rules files reach your project through the VibeCommit
server's `setup` tool, which writes them into your repository as a managed section
(content outside the managed markers stays yours).

## Cross-vendor users

Using Cursor, Windsurf, VS Code Copilot, or another agent? The plugin path is
Claude Code-specific. For all other agents — or for the same per-session re-sync
experience across vendors — use the VibeCommit setup tool instead:

**https://www.vibecommit.ai/install**

The install page has one-liner MCP blocks for every supported agent. The `setup`
MCP tool delivers the same rules files the plugin ships, so you get byte-identical
content either way.

## How it works

Capture happens two ways, and both write to the same history: Claude Code hooks
(`Stop`/`PreCompact`/`SessionEnd`, installed automatically with this plugin)
invoke the bundled capture client directly, and the MCP server below is called
cooperatively by your agent when it has the rules text (delivered by `setup`, not
by this plugin install). Re-capturing the same conversation through either path is
a free no-op, so the two never double-record.

VibeCommit's MCP server is at `https://api.vibecommit.ai/mcp`. The tools the
cooperative flow relies on:

- **`setup`** — returns the rules files for your agent (idempotent; skip-if-current
  on the common path)
- **`commit_conversation`** — captures the current conversation. Send the
  transcript records inline (plus `commit_sha`/`branch`/`recent_git_log` after a
  commit); the server deduplicates, links continuations, and returns a
  `provenance_url`. Re-capturing the same conversation is a free no-op.

The server also exposes read tools to search, read, and diff your captured
history (`search_history`, `blame_commit`, `commit_coverage`,
`get_conversation`, `diff_conversation`).

First call triggers OAuth in your browser (GitHub login). After that, every
`commit_conversation` call is silent.

## Optional: capture on every commit (compliance tier)

The default hooks above ([`hooks/hooks.json`](hooks/hooks.json)) fire at session
boundaries — `Stop`, `PreCompact`, `SessionEnd` — not at the moment of `git commit`
itself. Teams that want a capture tied to each commit, without waiting for the
next boundary, can opt into one of two additional local hooks. Recipes live in
[`hooks/`](hooks); neither is wired by the plugin.

- **PostToolUse capture hook** ([`hooks/post-tool-use-capture.md`](hooks/post-tool-use-capture.md))
  — a Claude Code `PostToolUse` hook that fires on `git commit` Bash calls and
  invokes the local capture driver immediately, tighter-grained than the default
  session-boundary hooks.
- **git `post-commit` breadcrumb** ([`hooks/post-commit.sample`](hooks/post-commit.sample))
  — a vendor-agnostic shell hook. It is **secondary**: it cannot authenticate or
  capture on its own; it just keeps `recent_git_log` warm for the agent's next
  cooperative capture.

**Security note.** The PostToolUse hook reuses the OAuth token already stored on
disk by the cooperative flow, so any process that can trigger it can capture on
your behalf. Enable it only in trusted developer or CI environments.

Enabling capture-volume-increasing hooks is a deliberate change and, in
VibeCommit's own repos, stays behind the project deploy gate.

## Version

Plugin version is pinned at `1.0.0` in `.claude-plugin/plugin.json`. You only
receive updates when this field is bumped — no surprise rebuilds on every commit.

## License

MIT. See [LICENSE](LICENSE).

This MIT license covers the plugin bundle in this repository (the rules files and `.mcp.json` configuration) only; the hosted VibeCommit MCP server it connects to at `https://api.vibecommit.ai/mcp` is a separate work licensed under the Business Source License 1.1, not MIT.
