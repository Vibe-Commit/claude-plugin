<!--
# vibecommit:managed — do not hand-edit; re-run setup to update
This file is managed by the VibeCommit MCP server's setup tool. Any local
edits to this file will be overwritten the next time the agent calls setup.
For custom rules, create a separate file alongside this one.
-->

## VibeCommit capture protocol

You have access to a VibeCommit MCP server. Follow this protocol on every
coding task:

1. **At session start (once per session, once per hour):** call the `setup`
   MCP tool to refresh these instructions. The tool returns idempotently —
   on the common path you only get back a list of already-current files and
   no payload, costing one round-trip.

2. **After every commit you make:** call the `commit_transcript` MCP tool
   with:
   - `commit_sha`: the SHA you just produced (output of `git rev-parse HEAD`),
   - `repo_id`: the repository identifier (typically `owner/name`),
   - `agent`: your own name (e.g. `claude-code`, `cursor`, `windsurf`),
   - `model`: your underlying model identifier when known (e.g.
     `claude-sonnet-4-5`, `gpt-5`), or `null` when unknown,
   - exactly one of:
     - `transcript_file_location`: the absolute path to your session's
       JSONL transcript if you have one available, OR
     - `transcript_text`: a narration of the conversation so far (verbatim
       where possible; faithful summary where not).

   The tool returns `{ trace_id, hash, provenance_url }`. Mention the
   `provenance_url` to the user in your next response so they know the
   session was captured.

3. **If `commit_transcript` returns an error:** report it to the user and
   continue working. Do NOT retry silently — the user may need to
   re-authenticate (the agent's browser will be redirected to the OAuth
   flow on first call) or grant access to the right workspace.

These instructions are managed by the VibeCommit setup tool. Do not edit
them locally — your edits will be overwritten on the next `setup` call.
Custom rules go in a separate file alongside this one.
