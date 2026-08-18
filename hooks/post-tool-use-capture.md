# Opt-in: PostToolUse capture-enforcement hook (compliance tier)

> **Not installed by default.** The plugin's default capture path already
> includes Claude Code hooks — `Stop`, `PreCompact`, `SessionEnd`
> ([`hooks.json`](hooks.json)) — that invoke the bundled capture client
> directly, no agent cooperation required. What those hooks do NOT do is fire
> at the moment of `git commit` itself; they fire at the next session boundary.
> This recipe is for teams that want capture tied to each commit specifically,
> without waiting for that boundary, and are willing to run a local hook in a
> trusted environment. Enabling it is a deliberate, per-project act; nothing
> here is wired by `plugin.json`, `.mcp.json`, or any shipped `settings.json`.

## What it does

Claude Code fires a [`PostToolUse`](https://docs.claude.com/en/docs/claude-code/hooks)
hook after every tool call. This recipe matches the **`Bash`** tool and inspects
the command: when the command contains `git commit`, it invokes a small local
driver that captures the just-made commit's conversation into VibeCommit.

The driver:

1. Parses the current session's Claude Code JSONL transcript into an array of
   record objects.
2. Reads the OAuth token already stored on disk by the cooperative flow (the
   same token the MCP server obtained on first login — see the security note).
3. Calls the `commit_conversation` MCP tool with the transcript and the
   commit-linkage fields:
   - `commit_sha` — `git rev-parse HEAD`
   - `branch` — `git rev-parse --abbrev-ref HEAD`
   - `recent_git_log` — `git log -n 20 --format=%H%x09%s%x09%aI`
   - `transcript_records` — the parsed JSONL records, INLINE
   - (plus `repo_id` and `model` as usual)

The response carries a `provenance_url`; the driver logs it.

## Reuse the existing driver — do NOT write a new binary

This recipe **reuses the M6-T4 SessionEnd local driver** that already ships with
VibeCommit. That driver already does exactly the work above: *parse JSONL locally
→ records → authenticated `commit_conversation` call, reusing the stored OAuth
token.* The PostToolUse hook is just a second **trigger** for the same driver —
fire-on-`git commit` instead of fire-on-session-end.

Do not implement a parallel capture binary. Point the hook at the same driver
entry point you already use for SessionEnd. Both triggers flow through the same
tool and the same `content_digest` dedup, so they can never double-record the
same conversation (a hook capture taken right after a cooperative capture
classifies as a tail-delta EXTEND, or no-ops entirely).

## Self-gating and idempotency

This hook is safe to fire often:

- **Command gate.** The driver exits silently (status 0, no output) when the
  Bash command was not a `git commit`. `PostToolUse` has no command-substring
  matcher of its own, so the driver re-checks the command itself; a non-commit
  `Bash` call is a no-op.
- **Dedup makes redundant fires free.** If the conversation was already captured
  (e.g. the agent also cooperatively captured it), re-capturing is a free no-op
  on the server's `content_digest` probe. A redundant fire costs one
  round-trip and records nothing new.

Net effect: enabling this hook can only *raise* the capture rate. It never
double-bills and never corrupts the conversation DAG.

## Sample `settings.json` (opt-in — NOT installed by default)

Add this to your **own** project or user `settings.json` if you want the
enforcement path. The plugin does not ship it.

```jsonc
// .claude/settings.json — OPT-IN, not installed by the VibeCommit plugin.
// Enabling capture-enforcement hooks is a deliberate per-project decision and,
// for VibeCommit's own repos, stays behind the project deploy gate.
{
  "hooks": {
    "PostToolUse": [
      {
        // Run after every Bash tool call. The driver itself checks whether the
        // command was a `git commit` and exits silently otherwise.
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            // Point this at the SAME M6-T4 SessionEnd driver you already use.
            // It reads $CLAUDE_* hook env (session transcript path, cwd) on
            // stdin/env, self-gates on the `git commit` substring, parses the
            // JSONL, reuses the stored OAuth token, and calls
            // commit_conversation with commit_sha/branch/recent_git_log.
            "command": "vibecommit-capture-driver --trigger post-tool-use"
          }
        ]
      }
    ]
  }
}
```

> `vibecommit-capture-driver` above is a placeholder for the local M6-T4 driver
> entry point on your machine — substitute the real path/command you use for the
> SessionEnd trigger. The point of this recipe is the **matcher + trigger
> wiring**, not a new program.

## Security note (read before enabling)

This hook **reuses the OAuth token already stored on disk** by the cooperative
flow. Any process that can run the hook can therefore capture on your behalf.
That is acceptable inside a trusted developer or CI environment, but it means
you should not enable this hook on a machine where untrusted code can trigger
`Bash`/`PostToolUse`. This is why the path is opt-in and, in VibeCommit's own
repos, gated: enabling a capture-volume-increasing hook is a deploy-gated change,
not a default.

## See also

- `hooks/post-commit.sample` — a weaker, vendor-agnostic git `post-commit`
  breadcrumb. It is **secondary** to this hook: it cannot authenticate or
  capture by itself; it only keeps `recent_git_log` warm for the agent's next
  cooperative capture.
