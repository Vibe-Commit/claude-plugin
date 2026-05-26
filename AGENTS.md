<!-- vibecommit:managed:start -->
<!--
# vibecommit:managed — do not hand-edit the section below; re-run setup to update
The section delimited by <!-- vibecommit:managed:start --> and
<!-- vibecommit:managed:end --> is managed by the VibeCommit MCP server's
setup tool. Content OUTSIDE those markers is yours to edit and is preserved
across setup re-runs. Edits inside the managed section will be overwritten.
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
<!-- vibecommit:managed:end -->
