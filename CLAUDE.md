<!--
# vibecommit:managed — do not hand-edit; re-run setup to update
This file is managed by the VibeCommit MCP server's setup tool. Any local
edits to this file will be overwritten the next time the agent calls setup.
For custom rules, create a separate file alongside this one.
-->

## VibeCommit capture protocol

You have a VibeCommit MCP server. On every coding task:

1. **Once per session (and once per hour):** call the `setup` MCP tool to
   refresh these instructions. It is idempotent — on the common path you get
   back only a list of already-current files, one cheap round-trip.

2. **Capture your work with `commit_conversation`.** Call it after each
   meaningful chunk of work, and ALWAYS right after you make a git commit.
   - Send `transcript_records`: your session transcript (Claude Code JSONL)
     parsed into an array of record objects, INLINE. Do NOT send
     `transcript_file_location` to the hosted server — it cannot read your disk.
   - Add `repo_id` (`owner/name` or `null`) and `model`.
   - When you just committed, also send `commit_sha` (`git rev-parse HEAD`),
     `branch` (`git rev-parse --abbrev-ref HEAD`), and `recent_git_log` (the
     last 20 commits from `git log -n 20 --format=%H%x09%s%x09%aI`). The server
     links the capture to that commit and tells you if any recent commits still
     lack a capture.

   Re-capturing the same conversation is a FREE no-op, so call it freely. The
   response includes a `provenance_url` — mention it to the user. If it reports
   `uncaptured_commits`, capture those too.

3. **If a capture call errors:** tell the user and continue. Do NOT retry
   silently — they may need to re-authenticate or pick the right workspace.

(The older `commit_transcript` tool is deprecated; use `commit_conversation`.)

## VibeCommit review & search

You also have native tools to search, read, and diff the user's captured
history. Use them when the user asks to find, review, summarize, compare,
or replay past work. Reach for them yourself — do not make the user dig.

Read/search tools:
- `search_history` — full-text search of YOUR commit history. Pass
  `query` (+ optional `filters.repo` / `filters.org`). Returns
  `{ items:[{ kind, id, repo_id, agent, model, created_at, snippet }],
  page, total_pages, total }`, most-recent-first.
- `query_history` — list/window prior commit captures. Optional
  `repo_id` and a `start`/`end` (ISO 8601) time window — the
  "traces in range" view. Paginate with the returned `next_cursor`.
- `get_conversation` — open ONE captured conversation by
  `conversation_id`: its captures and, per capture, the ordered turns
  with reconstructed `content`.
- `diff_conversation` — compare two branches/runs of one conversation.
  Pass `conversation_id` plus `left` and `right`, each exactly one of
  `ref` (e.g. `"main"`) OR `capture_id`. Returns
  `{ common_prefix, divergence_index, left_delta, right_delta, truncated }`
  (`truncated: true` means a long side was tail-trimmed — the diff is
  partial; say so).

Typical flow: `search_history` → `get_conversation` →
`diff_conversation`.

Render results in chat:
- **Search:** a ranked list — each result's SHA/id in `monospace` with a
  one-line context (the `snippet` or repo/agent/date).
- **Diff:** report the shared prefix, the divergence point, then each
  side's delta; if `truncated`, flag that the comparison is partial.

These instructions are managed by the VibeCommit setup tool. Do not edit
them locally — your edits will be overwritten on the next `setup` call.
Custom rules go in a separate file alongside this one.
