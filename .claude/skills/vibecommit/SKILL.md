---
name: vibecommit
description: Capture this session into VibeCommit by calling the commit_conversation MCP tool after each meaningful chunk of work and right after every git commit. Refresh instructions by calling the setup tool.
---
<!--
# vibecommit:managed — do not hand-edit; re-run setup to update
This file is managed by the VibeCommit MCP server's setup tool. Any local
edits to this file will be overwritten the next time the agent calls setup.
For custom rules, create a separate file alongside this one.
-->

## VibeCommit capture protocol

You have a VibeCommit MCP server. On every coding task:

1. Once per session (and once per hour): call the `setup` MCP tool to refresh
   these instructions.

2. Capture your work with `commit_conversation`. Call it after each meaningful
   chunk of work, and ALWAYS right after you make a git commit.
   - Send `transcript_records`: your session transcript (Claude Code JSONL)
     parsed into an array of record objects, INLINE. Do NOT send
     `transcript_file_location` to the hosted server — it cannot read your disk.
   - Add `repo_id` (`owner/name` or `null`) and `model`.
   - When you just committed, also send `commit_sha` (`git rev-parse HEAD`),
     `branch` (`git rev-parse --abbrev-ref HEAD`), and `recent_git_log` (the
     last 20 commits from `git log -n 20 --format=%H%x09%s%x09%aI`).

   Re-capturing the same conversation is a FREE no-op. The response includes a
   `provenance_url` — mention it to the user. If it reports `uncaptured_commits`,
   capture those too.

3. If a capture call errors: tell the user and continue. Do NOT retry silently.

(The older `commit_transcript` tool is deprecated; use `commit_conversation`.)
