---
name: vibecommit
description: Capture this session into VibeCommit — automatic when VibeCommit's hooks are installed, otherwise by calling the commit_conversation MCP tool after each chunk of work and each commit. Also find which captured session produced a commit (blame_commit) and search captured history.
---
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

2. **Capture.** If VibeCommit's git and editor hooks are installed (Claude Code
   after `vibecommit connect`), capture is automatic: do NOT call
   `commit_conversation` to record your work, and do not send
   `commit_sha_successor` — the post-rewrite hook records rewrites.
   If your client has no VibeCommit hooks, capture with `commit_conversation`:
   call it after each meaningful chunk of work, and ALWAYS right after you make
   a git commit.
   - Send `transcript_records`: your session transcript (Claude Code JSONL)
     parsed into an array of record objects, INLINE. Do NOT send
     `transcript_file_location` to the hosted server — it cannot read your disk.
   - Add `repo_id` (`owner/name` or `null`) and `model`.
   - When you just committed, also send `commit_sha` (`git rev-parse HEAD`),
     `branch` (`git rev-parse --abbrev-ref HEAD`), and `recent_git_log` (the
     last 20 commits from `git log -n 20 --format=%H%x09%s%x09%aI`). The server
     links the capture to that commit and tells you if any recent commits still
     lack a capture.
   - If a squash, rebase or amend rewrote a sha you already captured, add
     `commit_sha_successor`: `{ ancestor_sha, successor_sha, match_kind }` —
     the old sha, the one that replaced it, and `"exact"` if you can name the
     rewrite or `"probable"` if you matched it by patch id. Send it ONLY when
     a rewrite happened; the two shas must differ. It is what lets
     `blame_commit` still resolve the old sha.
     Its optional `patch_id` MUST be computed with `--stable`, exactly:
     `git diff-tree -p --root --no-color --no-ext-diff <sha> | git patch-id --stable`
     Bare `git patch-id` is `--unstable` and gives a DIFFERENT id on any commit
     touching more than one file, so it will NOT match. Send `null` for a
     merge, an empty commit, or a sha your clone does not have.

   Not sure whether the hooks are installed? Ask `blame_commit` about a commit
   you made earlier in this session: `cold_start` or `no_edge` means nothing
   captured it, so call `commit_conversation`.

   Re-capturing the same conversation is a FREE no-op, so call it freely. The
   response includes a `provenance_url` — mention it to the user. If it reports
   `uncaptured_commits`, capture those too.

3. **If a capture call errors:** tell the user and continue. Do NOT retry
   silently — they may need to re-authenticate or pick the right workspace.
   If the error names a replacement tool, call the one it names rather than
   retrying the old one: the tool surface has moved on and this file is stale
   until your next `setup` call.

## VibeCommit review & search

You also have native tools to search, read, and diff the user's captured
history. Use them when the user asks to find, review, summarize, compare,
or replay past work. Reach for them yourself — do not make the user dig.

Read/search tools:
- `search_history` — list YOUR captured commits, most-recent-first. Narrow
  with optional `filters.repo` (a repository SLUG) / `filters.org`. A free-text
  `query` is NOT supported yet and returns an error: omit it. Returns
  `{ items:[{ kind, id, repo_id, repository, created_at, snippet }],
  page, total_pages, total }`. `repository` is
  `{ id, slug, display_name }`, null only while the server is mid-upgrade — it does
  NOT mean you lack access. ⚠ `repo_id` holds the SLUG and is deprecated: it is NOT the
  `repository_id` that `commit_coverage` returns and `blame_commit` accepts.
  Pass `repository.slug` to a `repo` argument and `repository.id` to a
  `repository_id` one.
- `blame_commit` — show the conversation turns recorded against ONE commit,
  the way `git blame` names a commit for a line. Name the repository with
  EITHER `repo` (the slug — `owner/name`, `host/owner/name`, or
  `local:<12 hex>` for a tree with no usable remote) OR `repository_id`,
  supplying exactly one, and pass `commit_sha`. FEWER than 40 hex is resolved as
  a prefix, the way `git` expands an abbreviation; an ambiguous prefix is REFUSED
  with the candidates named rather than guessed. `recorded_sha` is not a rewrite
  flag: it is null on an ordinary hit and on a stale sha with its own capture. Ask
  by argument instead — `superseded_by` lists what REPLACED the sha you asked
  about, `squashed_from` what it REPLACED. Check `superseded_by` on EVERY
  state: a rewritten sha usually keeps the capture it was made in, so it often
  answers `turns` with a non-empty `superseded_by`. `recorded_sha` is the
  pre-rewrite ancestor whose turns are shown, set only when your sha has no capture
  of its own; `resolved_sha` is a prefix expansion, never evidence of a rewrite.
  ⚠ Read `superseded_by` WITH
  `repository_successor_rows`: an empty list and 0 there means this repository has
  never recorded a rewrite, NOT that your sha is current. Rewrites are recorded
  only if the hook ran at the time, so empty is the common case.
  Resolution is at the COMMIT grain — `file_path`
  is accepted but does not narrow the result.
- `commit_coverage` — how many commits in a repository have a capture
  recorded against them, broken down by edge grade, with the recorded
  successor mapping. Pass `repo` (the same slug `blame_commit` takes) and
  `ref`, which is OPTIONAL and never defaulted — omit it and the answer echoes
  `ref: null` rather than guessing `main`. Omit the repository too and it reports
  on every repository you can read. It returns the shas we hold
  an edge for and NOT a percentage: reachability from a ref is a local git
  question the server cannot answer, so compute any rate in the user's own
  clone.
- `get_conversation` — open ONE captured conversation, by `conversation_id`
  OR by `commit_sha` plus `repo`/`repository_id` (the sha you hold from
  `blame_commit` or git): its captures and, per capture, the ordered turns with
  `content` (the work only: roles, text, tool calls and results).
- `diff_conversation` — compare two branches/runs of one conversation.
  Pass `conversation_id` plus `left` and `right`, each exactly one of
  `ref` (e.g. `"main"`) OR `capture_id`. Returns
  `{ common_prefix, divergence_index, left_delta, right_delta, truncated }`
  (`truncated: true` means a long side was tail-trimmed — the diff is
  partial; say so).

Typical flow: `search_history` to list commits → `blame_commit` for one →
`get_conversation` (by that sha) → `diff_conversation`.

Render results in chat:
- **Search:** a list of commits, most-recent-first — each SHA in `monospace`
  with its repo and date.
- **Blame:** name the commit the capture is recorded against, and say so
  explicitly when it differs from the sha the user asked about.
- **Coverage:** always give the ref alongside the count — a coverage number
  without its ref does not mean anything.
- **Diff:** report the shared prefix, the divergence point, then each
  side's delta; if `truncated`, flag that the comparison is partial.

These instructions are managed by the VibeCommit setup tool. Do not edit
them locally — your edits will be overwritten on the next `setup` call.
Your own rules belong outside this managed content.
