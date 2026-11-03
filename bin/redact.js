/**
 * Out-of-tree redaction — `CR-024d`, D57 §OV8d.
 *
 * A Claude Code transcript records structured file reads and writes VERBATIM:
 * a `Read`, `Edit` or `Write` record carries a path and the file's content. When
 * that path is outside the repository the user consented to, the content of a
 * THIRD PARTY'S file is about to be uploaded under the user's credential and
 * attached to a repo that has nothing to do with it. That is a confidentiality
 * boundary, not a tidiness issue, and it is the whole reason this module exists.
 *
 * ## Why the client, permanently
 *
 * D57 §OV8d: *"Out-of-tree redaction is client-side. Server-side redaction would
 * break `turn_hash == sha256(content)`, so it cannot live on the server at
 * all."* A server that rewrote content after hashing would hold a hash chain
 * over bytes it no longer has. There is no server-side variant to fall back on.
 *
 * ## The deviation this is allowed to make, and its limit
 *
 * D60 §D6 says the client holds no ANALYSIS, and OV8d is the ONE recorded
 * deviation from it, because redacting requires parsing each line. The rule that
 * survives is *"the client may render; it may not analyze, hash, or
 * canonicalize."* So this module parses a line, finds a path, compares it to the
 * project root, and replaces a span. It extracts no turns, computes no digest,
 * canonicalises no record, and imports nothing from `vibecommit-mcp` — that last
 * one is a LICENSING violation, not a style one (D60 §D1a, D64).
 *
 * ## ⚠ LENGTH PRESERVATION IS THE LOAD-BEARING PROPERTY
 *
 * The client sends a raw byte span with `X-Byte-Offset: from`, and the server
 * advances its watermark by the DECOMPRESSED body's length
 * (`vibecommit-mcp/src/conversation/ingest_session.ts`). The client's own
 * `sentOffset` advances to `to`. If a redaction makes the body SHORTER, the two
 * watermarks diverge and every subsequent delta arrives flagged `gap: true`,
 * forever; longer, and every delta is `overlap: true`. A permanently
 * gap-flagged stream is a capture-health surface reporting data loss that is
 * not happening.
 *
 * So every replacement is padded to the exact byte length it replaced, and a
 * span too short to hold even the shortest honest marker is LEFT ALONE. That
 * trade — leak a sub-13-byte span rather than break the accounting — is the
 * brief's, stated rather than smuggled, and `redactSpan` counts what it skipped
 * so the number is reportable.
 *
 * ## Why re-serialising is safe here, measured rather than assumed
 *
 * `JSON.parse` → `JSON.stringify` was byte-identical on **39,910 of 39,910**
 * real transcript lines across 25 sessions, because the transcript is written by
 * `JSON.stringify` in the first place. That is what makes the padding
 * arithmetic exact instead of approximate. It is not taken on faith: every line
 * is round-tripped and compared BEFORE anything is changed, and a line that does
 * not round-trip is returned untouched.
 *
 * @provenance vibecommit-mcp src/conversation/ingest_session.ts — offset accounting, read
 */
import { Buffer } from "node:buffer";
import { DIALECTS } from "./agents/registry.js";
import { REDACTION } from "./copy/index.js";
import { isInside, isInsideAny } from "./paths.js";
/**
 * Keys whose STRING value is a filesystem path naming the record's subject.
 *
 * `notebook_path` is here because `NotebookEdit` names its file that way and
 * carries the cell source alongside — a shape that does NOT appear in the
 * 59,464-line corpus this module was measured against, and was therefore found
 * by attacking the rule rather than by observing traffic. Absence from a corpus
 * is not absence from the product.
 */
const PATH_KEYS = new Set(["file_path", "filePath", "notebook_path", "notebookPath"]);
/**
 * Keys whose value is file CONTENT, redacted when a sibling path is out of tree.
 *
 * Measured against 59,464 real transcript lines rather than assumed, and the
 * measurement is why this list is longer than "the file's content":
 *
 *   content       Read results (`toolUseResult.file.content`), Write inputs
 *   originalFile  the WHOLE pre-edit file, on every Edit result — 2,017 of them
 *                 in the sample, the largest single carrier by volume
 *   oldString/newString, old_string/new_string
 *                 Edit inputs and results, both sides of the change
 *
 * `structuredPatch` is handled separately below: it is an array of hunks whose
 * `lines` are file content too.
 */
const CONTENT_KEYS = new Set([
    "content",
    "originalFile",
    "oldString",
    "newString",
    "old_string",
    "new_string",
    // NotebookEdit's cell bodies. Same provenance as `notebook_path` above.
    "new_source",
    "old_source",
    "newSource",
    "oldSource",
    // C39 addendum: an `ExitPlanMode` result is `{plan, isAgent, filePath}`: the plan file's own text beside its out-of-tree path (3 records in the
    // C39 re-measure carried it through, the only same-record sibling that remained).
    "plan",
]);
/** Hunk arrays whose `lines` carry file content. */
const PATCH_KEY = "structuredPatch";
/** C39 (ii): Claude's record-level second copy of every tool input, keyed by tool_use id. */
const WIRE_KEY = "wireToolInputs";
/**
 * C38: record types whose content duplicates the conversation records and is withheld in EVERY copy, always, with no flag (P1, 2026-11-01).
 * `last-prompt`, `queue-operation` and `api-request-blob` repeated an out-of-tree file's text in 870 of 907 in-repo files in the first measurement;
 * the extension adds the three other request/snapshot types. None is read by the server (its reader skips them by type or never names them).
 * Their path-shaped KEYS stay (`trackedFileBackups`' paths): only string values are withheld, and the README says so.
 */
const ALWAYS_WITHHELD_TYPES = new Set([
    "last-prompt",
    "queue-operation",
    "api-request-blob",
    "api-request",
    "api-request-shape",
    "file-history-snapshot",
    "file-history-delta",
]);
function claudeAlwaysWithheld(record) {
    // C39 (iv): a model-written digest of the whole conversation, file text included. Strict: a data-shaped key makes the whole line go.
    if (record.isCompactSummary === true)
        return "strict";
    return typeof record.type === "string" && ALWAYS_WITHHELD_TYPES.has(record.type) ? "values" : null;
}
/**
 * C27: the cwd-less record types that carry NO conversation content, each bound to the key paths measured on a corpus of 346,120 cwd-less records.
 * A string under a key a KEEP type does not have today is withheld in a multi-repo copy; every other cwd-less type (and any type Claude Code adds
 * later) is AGGREGATE: default deny. `modelUsage`'s keys are model ids, normalised to `<datakey>`.
 */
const KEEP_KEYS = {
    mode: new Set(["type", "mode", "sessionId"]),
    "permission-mode": new Set(["type", "permissionMode", "sessionId"]),
    "atis-latch": new Set(["type", "atis", "sessionId"]),
    "bridge-session": new Set(["type", "bridgeSessionId", "lastSequenceNum", "ownerAccountUuid", "ownerOrganizationUuid", "sessionId"]),
    launched: new Set(["type"]),
    "tools-used": new Set(["type", "tools", "sessionId"]),
    "fork-context-ref": new Set(["type", "agentId", "contextLength", "parentLastUuid", "parentSessionId"]),
    "cost-state": new Set([
        "type",
        "sessionId",
        "startTime",
        "hasUnknownModelCost",
        "totalCostUSD",
        "totalAPIDuration",
        "totalAPIDurationWithoutRetries",
        "totalToolDuration",
        "totalDuration",
        "totalLinesAdded",
        "totalLinesRemoved",
        "modelUsage",
        "modelUsage.<datakey>",
        "modelUsage.<datakey>.inputTokens",
        "modelUsage.<datakey>.outputTokens",
        "modelUsage.<datakey>.cacheReadInputTokens",
        "modelUsage.<datakey>.cacheCreationInputTokens",
        "modelUsage.<datakey>.cacheCreationEphemeral5mInputTokens",
        "modelUsage.<datakey>.cacheCreationEphemeral1hInputTokens",
        "modelUsage.<datakey>.webSearchRequests",
        "modelUsage.<datakey>.costUSD",
        "modelUsage.<datakey>.thinkingTokens",
    ]),
};
/** The `attachment` and `system` subtypes measured on the corpus (cwd-bearing). One not listed is a FUTURE subtype: withheld in a multi-repo copy. */
const KNOWN_ATTACHMENT_TYPES = new Set(("hook_success total_tokens_reminder deferred_tools_record environment queued_command prompt_snapshot silent_turn_reminder date remote_session_change " +
    "model session_context credential_org deferred_tools_delta mcp_instructions_delta instructions skill_listing auto_mode nested_memory edited_text_file " +
    "structured_output agent_listing_delta file hook_additional_context compact_file_reference command_permissions read_truncation_notice " +
    "hook_non_blocking_error plan_mode plan_mode_exit peer_mention thinking_drop task_status invoked_skills hook_system_message plan_file_reference " +
    "hook_cancelled batching_reminder_sent auto_mode_exit task_reminder bash_output_audience_note ultra_effort_enter plan_mode_reentry skill_mention " +
    "workflow_keyword_request ultra_effort_exit already_read_file dynamic_skill").split(" "));
const KNOWN_SYSTEM_SUBTYPES = new Set("stop_hook_summary turn_duration away_summary informational local_command compact_boundary bridge_status scheduled_task_fire agents_killed".split(" "));
/** Subtypes whose text digests other turns (P1 C38 (b)): withheld in a multi-repo copy even though they carry a cwd. */
const AGGREGATE_ATTACHMENT_TYPES = new Set(["prompt_snapshot"]);
const AGGREGATE_SYSTEM_SUBTYPES = new Set(["away_summary"]);
function claudeAggregate(record) {
    const type = typeof record.type === "string" ? record.type : "";
    const hasCwd = typeof record.cwd === "string" && record.cwd !== "";
    if (!hasCwd) {
        // No folder of its own: nothing says whose it is. A KEEP type keeps only its measured keys; every other type is withheld.
        const keep = KEEP_KEYS[type];
        return keep === undefined ? { kind: "withhold" } : { kind: "keepKeys", paths: keep };
    }
    if (type === "attachment") {
        const attachment = record.attachment;
        const subtype = attachment !== null && typeof attachment === "object" ? attachment.type : undefined;
        if (typeof subtype !== "string" || !KNOWN_ATTACHMENT_TYPES.has(subtype) || AGGREGATE_ATTACHMENT_TYPES.has(subtype))
            return { kind: "withhold" };
    }
    else if (type === "system") {
        const subtype = record.subtype;
        if (typeof subtype !== "string" || !KNOWN_SYSTEM_SUBTYPES.has(subtype) || AGGREGATE_SYSTEM_SUBTYPES.has(subtype))
            return { kind: "withhold" };
    }
    return null;
}
/**
 * `claude-code` — the rules this module shipped with, unchanged.
 *
 * ⛔ **Byte-for-byte the pre-`CR-185` behaviour.** Nothing about the Claude path
 * moves in this task; the sets are the same three constants above, named.
 */
const CLAUDE_CODE_RULES = {
    pathKeys: PATH_KEYS,
    contentKeys: CONTENT_KEYS,
    nestedJsonKeys: new Set(),
    patchKeys: new Set([PATCH_KEY]),
    // C37 (a HIGH that shipped in 0.8.0): the path rule never fired on these attachment shapes, so a global ~/.claude/CLAUDE.md, a memory
    // file or an edited file outside the repository went out unredacted in EVERY copy, single-repo sessions included.
    attachment: {
        // `planFilePath` and `data.targetFile`/`data.path` (a plan file, a structured output about a file) name their subject the same way.
        pathKeys: new Set(["path", "filename", "planFilePath", "targetFile"]),
        // `planContent` is a plan file's text. `reason`, `summary`, `notes` and `gaps` are a structured output's prose ABOUT its `path`
        // (measured: attachment.structured_output.data). Each is withheld only when the path beside it is out of tree.
        contentKeys: new Set(["content", "rawContent", "snippet", "planContent", "reason", "summary", "notes", "gaps"]),
    },
    // C39 (iv): after a compaction Claude writes a `user` record flagged `isCompactSummary` whose text digests the conversation so far, including
    // what it read from files outside the repository. Nothing in it names a file, so the path rule cannot judge it.
    alwaysWithheld: claudeAlwaysWithheld,
    aggregate: claudeAggregate,
};
/**
 * `codex-cli` — ⛔ **the key set is D164 §8's MEASUREMENT, not a guess.**
 *
 * Measured over the 202-file / 14,109-line rollout corpus (M0.5). Two facts
 * shape every entry here, and both are ABSENCES:
 *
 *   - **`apply_patch` never appears.** The only `function_call` names are
 *     `exec_command` (436) and `write_stdin` (76). ⛔ **Codex writes files
 *     THROUGH THE SHELL**, so there is no Codex analogue of `PATH_KEYS` at the
 *     top level at all — the carrier is `cmd`, inside a JSON string, inside
 *     `arguments`.
 *   - **`cmd` is a `str` in 436/436, never an array** in that corpus. Nothing
 *     here depends on the array form, so no unexercised normaliser ships: a
 *     non-string `cmd` is simply not a content match and is left alone.
 *
 * ## Why `workdir` is the selector and `cmd` is the content
 *
 * `{workdir, cmd}` is the Codex shape of `{file_path, content}`. `workdir`
 * names where the command ran (436/436, always a path); `cmd` is what carries a
 * third party's bytes, because a shell write is a heredoc and the file's
 * content is inside the command string. So the existing rule applies unchanged:
 * an out-of-tree `workdir` makes its sibling `cmd` third-party content.
 *
 * ⚠ **`cwd` and `absolute_file_path` are selectors that fire nothing TODAY**,
 * and that is stated rather than disguised. `cwd` appears on `session_meta` and
 * `turn_context`, and `…review_output.findings[].code_location
 * .absolute_file_path` on `exited_review_mode` — none of those records carries a
 * content key or a nested document anywhere in its subtree, so each marks a
 * verdict that reaches nothing. They are here because they are literal,
 * measured path keys and absence from a corpus is not absence from the product
 * — the same reason `notebook_path` is in `PATH_KEYS`.
 *
 * ⛔ **`output` and `chars` are NOT content keys, deliberately.** They are the
 * shell's stdout and stdin — the Codex spelling of a Claude `tool_result`, which
 * this module does not redact either (a `tool_result` has no `PATH_KEYS`
 * sibling, so `inherited` stays false). ⚠ **That is a live hole on CLAUDE,
 * today, symmetric across agents.** Widening the control is a separate decision
 * about the control; reaching parity with it is this task. See the report.
 */
/** The Codex records that are injected instructions, never the user's or the agent's own words (C40 (2), P1 ruling 2026-11-01). */
function isCodexInstructionRecord(record) {
    if (record.type === "world_state")
        return true;
    const payload = record.payload;
    if (payload === null || typeof payload !== "object")
        return false;
    const p = payload;
    if (record.type === "response_item") {
        // The WHOLE role:user and role:developer streams, not a prefix match: it is the injected superset (`# AGENTS.md instructions for ...`,
        // `<user_action>` synthetics), and a prefix breaks when the wording changes. The human prompt is `event_msg/user_message`.
        if (p.type === "message")
            return p.role === "user" || p.role === "developer";
        return p.type === "additional_tools";
    }
    return record.type === "event_msg" && p.type === "entered_review_mode";
}
const CODEX_CLI_RULES = {
    pathKeys: new Set(["workdir", "cwd", "absolute_file_path"]),
    contentKeys: new Set(["cmd"]),
    nestedJsonKeys: new Set(["arguments"]),
    patchKeys: new Set(),
    // C40 (2): Codex injects the user's instruction files and its own prompts into the record stream, and none of those records names a path
    // for the path rule to judge. Measured on one machine (367 rollouts): the GLOBAL ~/.codex/AGENTS.md text is in all 161 `world_state`
    // records (`state.agents_md.text`) and in the `response_item/message` role:user injections. Nothing reads them: the human prompt comes
    // from `event_msg/user_message`, and the server's reader skips the model-input mirror. So they are withheld in EVERY copy, by TYPE, and
    // the next instruction field Codex adds is not a leak. Assistant prose (`event_msg/agent_message`, role:assistant) is NOT here.
    alwaysWithheld: (record) => (isCodexInstructionRecord(record) ? "strict" : null),
    withheldKeys: (key) => key === "base_instructions" || key.endsWith("developer_instructions"),
};
/**
 * ⛔ **Every profile, keyed by its label — and the `Record` is the lock.**
 *
 * `RedactionProfile` is a closed union (`agents/types.ts`), so a dialect that
 * declares a profile with no rules here is a COMPILE ERROR in a diff a human
 * reads, which is the same device `transport: "ndjson"` uses to lock the lane.
 */
/**
 * `cursor` — ⛔ **the key sets are `D177 §10`'s MEASUREMENT, re-measured here.**
 *
 * `CR-194`. Measured over **all 18 `tool_use` calls** of the live corpus, and
 * the counts below were re-derived from those bytes by this task rather than
 * copied from the decision — they reproduce it exactly:
 *
 * ```
 * Shell        5   {command, description} ×4 · {command, description, working_directory} ×1
 * Read         4   {limit, path} ×3 · {path} ×1
 * Glob         4   {glob_pattern, target_directory} ×4
 * Write        1   {contents, path}
 * Grep         1   {glob, path, pattern}
 * WebSearch    1   {explanation, search_term}
 * GetMcpTools  1   {pattern}
 * ConnectScm   1   {github_repo}
 * ```
 *
 * ## ⛔ THREE SPELLINGS OF "PATH", NOT ONE
 *
 * `path`, `target_directory` and `working_directory` are three different tools'
 * names for the same role, and a rule set carrying only `path` would leave
 * `Glob` and the one `Shell` call that declares its directory unselected.
 * `{path, contents}` is the Cursor shape of `{file_path, content}`, so the
 * module's existing rule applies unchanged: an out-of-tree path key makes its
 * content-bearing siblings third-party content.
 *
 * ## ⛔ `nestedJsonKeys` IS EMPTY, AND FOR THE OPPOSITE REASON TO CLAUDE'S
 *
 * Claude's is empty because its tool input is already a real object. Cursor's is
 * empty for the *same* structural reason — `input` is a real object in **18/18**
 * — which is what makes Cursor unlike Codex, whose whole argument list arrives
 * as one escaped string in `arguments`. `walk` reaches it already.
 *
 * ## ⚠ `patchKeys` IS EMPTY BECAUSE THERE IS NO PATCH CARRIER
 *
 * No `structuredPatch` analogue appears anywhere in the 18 calls. ⛔ Not a
 * decision to skip one — an absence, and if Cursor grows an edit tool with hunk
 * arrays this is the line that will need re-measuring.
 *
 * ## ⛔ `description` AND `explanation` ARE NOT CONTENT KEYS
 *
 * Both are the model's own prose about what it is doing, not a third party's
 * bytes. Redacting them would withhold the record's most readable half for no
 * confidentiality gain, and `markerFor` would spend the span's budget on it.
 *
 * ## ⚠ `TODOS[123]` — THE HOLE THIS SHIPS WITH, MEASURED AND PINNED
 *
 * **4 of the 5 `Shell` calls carry no path key at all**, so their `command` has
 * no sibling to condemn it and ships whatever it holds. Precisely, in the
 * corpus: **2** begin `cd <abs> && …`, **1** embeds absolute paths inline
 * (`for d in … ; git -C "$d" …`), and **1** names no path at all. ⛔ **The fix
 * is NOT to treat `command` as a path key** — that hands a whole shell
 * transcript to `realpath`, which is the mistake `D172 §2` already caught once
 * (`payload.output` averaged 10 213 characters there). A `cd` inside a command
 * string is a fact about the shell, not a key this module can read. Pinned by a
 * PASSING cell in `test/redact-profiles.test.ts` so the hole is a recorded fact
 * rather than something a reader might believe was closed here.
 *
 * ⚠ And Cursor is clean on `TODOS[117]` (unredacted shell OUTPUT) for a reason
 * that is a **completeness loss, not a redaction win**: `tool_result` appears
 * **0** times in the corpus, so there is nothing to leak because there is
 * nothing captured (`D177 §5`).
 */
const CURSOR_RULES = {
    pathKeys: new Set(["path", "target_directory", "working_directory"]),
    contentKeys: new Set(["contents", "command"]),
    nestedJsonKeys: new Set(),
    patchKeys: new Set(),
};
const RULES = {
    "claude-code": CLAUDE_CODE_RULES,
    "codex-cli": CODEX_CLI_RULES,
    cursor: CURSOR_RULES,
};
/**
 * The rules a profile LABEL names.
 *
 * For a caller that already knows the dialect — `test/` does, and nothing in
 * `src/` should, because ⛔ **the profile is selected by the containing root and
 * not by anything the caller believes about the agent** (see
 * `rulesForTranscript`).
 */
export function rulesFor(profile) {
    return RULES[profile];
}
/**
 * ⛔ **THE FAIL-CLOSED PROFILE — the union of every rule any profile has.**
 *
 * Not a hand-written third profile: DERIVED, so a dialect added later
 * strengthens this automatically instead of quietly leaving a gap. A path
 * inside no known root gets every selector and every content key at once, which
 * over-redacts rather than under-redacts.
 *
 * ⚠ **Over-redaction is the cost, and it is real.** A Claude record's
 * top-level `cwd` becomes a selector here, so a line whose session `cwd` sits
 * outside the consented repo has its content withheld wholesale. That is the
 * right direction for a transcript we cannot attribute, and the wrong direction
 * for one we can — which is why it is the FALLBACK and not the default.
 */
const STRICTEST_RULES = {
    pathKeys: unionOf((rules) => rules.pathKeys),
    contentKeys: unionOf((rules) => rules.contentKeys),
    nestedJsonKeys: unionOf((rules) => rules.nestedJsonKeys),
    patchKeys: unionOf((rules) => rules.patchKeys),
    attachment: {
        pathKeys: unionOf((rules) => rules.attachment?.pathKeys ?? new Set()),
        contentKeys: unionOf((rules) => rules.attachment?.contentKeys ?? new Set()),
    },
    alwaysWithheld: (record) => {
        for (const rules of Object.values(RULES)) {
            const verdict = rules.alwaysWithheld?.(record) ?? null;
            if (verdict !== null)
                return verdict;
        }
        return null;
    },
    aggregate: (record) => {
        for (const rules of Object.values(RULES)) {
            const verdict = rules.aggregate?.(record) ?? null;
            if (verdict !== null)
                return verdict;
        }
        return null;
    },
    withheldKeys: (key) => Object.values(RULES).some((rules) => rules.withheldKeys?.(key) === true),
};
function unionOf(pick) {
    return new Set(Object.values(RULES).flatMap((rules) => [...pick(rules)]));
}
/**
 * ⛔ **THE PROFILE IS SELECTED BY WHICH REGISTRY ROOT CONTAINS THE RESOLVED
 * TRANSCRIPT PATH — NEVER BY THE `--agent=` FLAG (D164 §5).**
 *
 * The flag stays the BEHAVIOUR selector (roots to search, events, budgets,
 * delegated discovery). The scrubber stops depending on anyone remembering to
 * set it — which is the whole defect: both no-flag install paths (the
 * `.claude-plugin` bundle whose command carries no `--agent=`, and a
 * hand-written `.codex/` config) resolved to `claude-code`, and a Codex record
 * went through Claude's key set and was redacted NOT AT ALL.
 *
 * ## ⛔ This does NOT reopen `CR-183`'s `transcript_path`-as-selector rejection
 *
 * That rejection is about the **confinement boundary**, which is computed from
 * the registry and is never derived from input — and it still is. The
 * difference is the direction of the failure:
 *
 *   - choosing a **stricter scrubber** because a path sits outside every known
 *     root is **fail-closed**;
 *   - choosing a **wider root** because a path *claims* to be there is not.
 *
 * A wrong answer here costs a suboptimal profile and can never make a file
 * readable that was not readable before. `isInside` resolves both sides with
 * `realpathSync`, so a symlink cannot claim a root it is not under.
 *
 * ⛔ **AMBIGUITY FAILS CLOSED TOO.** Two dialects can be pointed at one
 * directory by environment (`CLAUDE_CONFIG_DIR` and `CODEX_HOME` are both
 * operator-set, and both sides resolve through `realpath`), and a path inside
 * two roots is a path whose producer is not known. Exactly one match selects a
 * profile; zero or two select the strictest.
 *
 * ⚠ **Today no path reaching this function is unattributed**, because
 * `isInsideAny(transcriptRoots(...))` refuses everything outside the union
 * BEFORE `readSpan` opens it. So the fallback is a second, independent line
 * rather than a live branch — stated plainly rather than left for a reader to
 * assume it has a caller (`feedback_unexercisable_branch_not_verified`).
 */
export function rulesForTranscript(home, env, transcriptPath) {
    const matches = DIALECTS.filter((dialect) => isInside(dialect.transcriptRoot(home, env), transcriptPath));
    return matches.length === 1 ? RULES[matches[0].redaction] : STRICTEST_RULES;
}
const NONE = { redacted: 0, skipped: 0 };
/**
 * Keys that stay readable in an isolated record. Everything else that is a string is content. The list is of STRUCTURE (what a
 * record is, who spoke, when, which tool by NAME) and not of anything a person typed or a tool printed; an unknown key is
 * withheld, so the failure direction is a thinner record and never a leak. `cwd` stays: it is how the record's origin is told
 * apart from the launch folder's, and it is a path, not a conversation (its residual is documented).
 */
const STRUCTURAL_KEYS = new Set([
    "type",
    "subtype",
    "role",
    "uuid",
    "parentUuid",
    "logicalParentUuid",
    "sessionId",
    "session_id",
    "timestamp",
    "version",
    "userType",
    "entrypoint",
    "requestId",
    "id",
    "call_id",
    "tool_use_id",
    "toolUseID",
    "name",
    "model",
    "status",
    "stop_reason",
    "stop_sequence",
    "level",
    "originator",
    "media_type",
    "cwd",
]);
/**
 * Redact one NDJSON line. **Pure, total, and length-preserving.**
 *
 * Returns the line UNCHANGED on anything it cannot handle — a blank line, a
 * parse failure, a line that does not round-trip. A hook cannot report an error
 * (DESIGN.md §13.7), and a redactor that dropped a line it could not parse would
 * be silent data loss on a path where D56 §D8 makes loss permanent.
 */
export function redactLine(line, projectRoots, rules, resolver = containment(), scope) {
    if (line === "")
        return { line, ...NONE };
    let parsed;
    try {
        parsed = JSON.parse(line);
    }
    catch {
        // A partial line at a span boundary lands here, and so does anything else
        // that is not JSON. Unchanged is the only honest answer.
        return { line, ...NONE };
    }
    if (scope?.observe !== undefined && parsed !== null && typeof parsed === "object" && !Array.isArray(parsed))
        scope.observe(parsed);
    // The round-trip gate. Padding arithmetic is only exact if everything this
    // module does NOT touch re-serialises to the same bytes.
    let baseline;
    try {
        baseline = JSON.stringify(parsed);
    }
    catch {
        return { line, ...NONE };
    }
    if (baseline !== line) {
        // ⛔ A line that does not round-trip cannot be padded string by string, but it must not bypass redaction (C18 #4b, C20). It is
        // withheld as a WHOLE line, length-preservingly, when it is another repo's record (R17), or when the structured-path rule
        // (with a folder target's exclusion roots) would have redacted ANYTHING in it: an out-of-tree file's content, a path the target
        // may not hold. A line with nothing to redact keeps today's answer: unchanged. (0.8.0 passed EVERY such line through; on one
        // machine's corpus these are Codex `token_count` records whose `used_percent` is written `N.0`, and none named a path, but the
        // next one could.)
        if (mustWithholdWhole(parsed, projectRoots, rules, resolver, scope))
            return { line: withheldLine(line), redacted: 1, skipped: 0 };
        return { line, ...NONE };
    }
    const counts = { projectRoots, resolver, rules, scope, redacted: 0, skipped: 0, slots: null };
    // C39 (iv) / C38 / C40 (2): a record the dialect withholds BY KIND (a digest of the conversation, a request blob, injected instructions) is
    // withheld in every copy, by the same `isolate` a foreign record gets. Like a foreign record, a length mismatch below withholds the WHOLE
    // line instead of sending the original. `strict` records that hold a data-shaped KEY (a skill name, a path) are withheld whole at once.
    const isObject = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
    const always = isObject ? (rules.alwaysWithheld?.(parsed) ?? null) : null;
    let withheldWhole = always !== null;
    if (always !== null) {
        if (always === "strict" && hasDataKeyInToolSubtree(parsed, true))
            return { line: withheldLine(line), redacted: 1, skipped: 0 };
        isolate(parsed, counts, false);
    }
    else if (isObject &&
        ((scope?.foreignRecord !== undefined && scope.foreignRecord(parsed)) ||
            namesFileOutOfTree(parsed, projectRoots, resolver, scope))) {
        withheldWhole = true;
        // R17: the whole record is another work tree's. Nothing is left for the path rule to decide.
        //
        // ⛔ C26: a KEY inside a tool subtree can itself be content (a result keyed by file name or path, `{"customers/bigbank.pdf": {...}}`),
        // and `isolate` withholds string VALUES, never keys. Such a record is withheld as a WHOLE line, the same length-preserving shape as
        // C20's. On one machine's corpus: 827 of 1,229,349 records (716 path-like, 256 with a space), every one under `toolUseResult`.
        if (hasDataKeyInToolSubtree(parsed))
            return { line: withheldLine(line), redacted: 1, skipped: 0 };
        isolate(parsed, counts, false);
    }
    else {
        const aggregate = scope?.multi === true && isObject ? (rules.aggregate?.(parsed) ?? null) : null;
        if (aggregate !== null) {
            // C27: a record whose origin the record cannot tell, in a copy of a session that named another work tree: withheld (or, for a KEEP type,
            // withheld outside its measured keys). A length mismatch below withholds the whole line.
            withheldWhole = true;
            if (aggregate.kind === "withhold")
                isolate(parsed, counts, false);
            else
                withholdOutsideKeys(parsed, aggregate.paths, counts);
        }
        else {
            scrubRecord(parsed, counts);
        }
    }
    if (counts.redacted === 0)
        return { line, redacted: 0, skipped: counts.skipped };
    let out;
    try {
        out = JSON.stringify(parsed);
    }
    catch {
        return { line, ...NONE };
    }
    // The backstop. Per-field arithmetic should make this exact; if it ever is
    // not, the accounting matters more than the redaction (see the header) and
    // the caller gets the original bytes plus an honest skip count.
    if (Buffer.byteLength(out) !== Buffer.byteLength(line)) {
        // A record that is withheld by KIND (another work tree's, or a conversation digest) is withheld whole rather than sent as written.
        if (withheldWhole)
            return { line: withheldLine(line), redacted: 1, skipped: 0 };
        return { line, redacted: 0, skipped: counts.redacted + counts.skipped };
    }
    return { line: out, redacted: counts.redacted, skipped: counts.skipped };
}
/** C48 (11): does the record's call name a file (see `RedactionScope.namedFiles`) that is outside this copy's tree or inside a hole? */
function namesFileOutOfTree(record, projectRoots, resolver, scope) {
    const files = scope?.namedFiles?.(record);
    return files !== undefined && files.some((file) => !resolver(projectRoots, file) || scope?.hole?.(file) === true);
}
function mustWithholdWhole(parsed, projectRoots, rules, resolver, scope) {
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
        return false;
    if (scope?.foreignRecord?.(parsed) === true)
        return true;
    if (namesFileOutOfTree(parsed, projectRoots, resolver, scope))
        return true;
    if ((rules.alwaysWithheld?.(parsed) ?? null) !== null)
        return true;
    if (scope?.multi === true && (rules.aggregate?.(parsed) ?? null) !== null)
        return true;
    // Would the path rule (with a folder target's exclusion roots, when there is one) have redacted anything here? Walk a COPY.
    let copy;
    try {
        copy = JSON.parse(JSON.stringify(parsed));
    }
    catch {
        return false;
    }
    const probe = { projectRoots, resolver, rules, scope, redacted: 0, skipped: 0, slots: null };
    scrubRecord(copy, probe);
    return probe.redacted > 0 || probe.skipped > 0;
}
/**
 * A line the same BYTE length as `line` that withholds all of it and is still one valid JSON object: `{"_":"****"}` for 8+ bytes,
 * `{}` plus spaces below that (JSON allows trailing whitespace). Pure ASCII, so its length is exactly its character count.
 */
function withheldLine(line) {
    const length = Buffer.byteLength(line);
    if (length >= 8)
        return `{"_":"${"*".repeat(length - 8)}"}`;
    if (length >= 2)
        return `{}${" ".repeat(length - 2)}`;
    return "*".repeat(length);
}
/**
 * Redact every complete line in a raw transcript span.
 *
 * Operates on BYTES because a span is a byte range and its edges need not fall
 * on a line — or even on a character. Segments are split on `\n` and a segment
 * that does not decode to exactly its own bytes is passed through untouched,
 * which is what keeps a span that bisects a multi-byte character from changing
 * length when it is re-encoded.
 */
export function redactSpan(span, projectRoots, rules, scope, 
/** The absolute offset of `span[0]` in its file (`scope.at` is told each segment's). */
spanStart = 0) {
    const resolver = containment();
    const counts = { redacted: 0, skipped: 0 };
    const NEWLINE = 0x0a;
    const out = [];
    let start = 0;
    for (let i = 0; i <= span.length; i += 1) {
        if (i !== span.length && span[i] !== NEWLINE)
            continue;
        const segment = span.subarray(start, i);
        scope?.at?.(spanStart + start);
        out.push(redactSegment(segment, projectRoots, rules, resolver, counts, scope));
        if (i !== span.length)
            out.push(span.subarray(i, i + 1));
        start = i + 1;
    }
    const bytes = Buffer.concat(out);
    // Length preservation is the property the server's offset accounting rests
    // on, so it is checked here too rather than trusted from the parts.
    if (bytes.length !== span.length) {
        return { bytes: span, redacted: 0, skipped: counts.redacted + counts.skipped };
    }
    return { bytes, ...counts };
}
function redactSegment(segment, projectRoots, rules, resolver, counts, scope) {
    const text = segment.toString("utf8");
    // A lossy decode (the span bisected a character) would re-encode to a
    // different length. Pass the raw bytes through instead.
    if (Buffer.byteLength(text) !== segment.length)
        return segment;
    const result = redactLine(text, projectRoots, rules, resolver, scope);
    counts.redacted += result.redacted;
    counts.skipped += result.skipped;
    if (result.line === text)
        return segment;
    const replaced = Buffer.from(result.line, "utf8");
    return replaced.length === segment.length ? replaced : segment;
}
/**
 * C27: withhold every string in `node` whose KEY PATH is not in `allowed`. A path is the object keys from the root joined by `.`, with a key that is
 * not an identifier (a model id under `modelUsage`) written `<datakey>`; arrays add nothing to the path. A KEEP type is bound to the paths measured
 * for it, so a string under a key it does not have today is withheld, whatever the key is called.
 */
function withholdOutsideKeys(node, allowed, ctx, path = "") {
    if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i += 1) {
            const item = node[i];
            if (typeof item === "string") {
                if (!allowed.has(path))
                    withholdLeaf(node, i, ctx);
            }
            else {
                withholdOutsideKeys(item, allowed, ctx, path);
            }
        }
        return;
    }
    if (node === null || typeof node !== "object")
        return;
    const record = node;
    for (const key of Object.keys(record)) {
        const here = path === "" ? (SCHEMA_KEY.test(key) ? key : "<datakey>") : `${path}.${SCHEMA_KEY.test(key) ? key : "<datakey>"}`;
        const value = record[key];
        if (typeof value === "string") {
            if (!allowed.has(here))
                withholdLeaf(record, key, ctx);
        }
        else {
            withholdOutsideKeys(value, allowed, ctx, here);
        }
    }
}
/**
 * The path rule over one whole record: `walk` (the object-local rule), then C39 (i), the record-level sibling rule.
 *
 * ⛔ C39 (i): Claude records a Read twice in ONE record: the structured copy (`toolUseResult.file {filePath, content}`) that the path rule
 * judges, and the text the model was shown (`message.content[{type: "tool_result", content}]`, line-numbered), which has no path beside it
 * and was sent as written (a HIGH since 0.8.0; the same shape for Write and Edit results). When the record's `toolUseResult`, or a
 * `tool_use` input in its `message.content`, names a file outside the tree, EVERY `tool_result` block of that record is withheld, whatever
 * its encoding (a string, or an array of text items; an image's data too), length-preservingly. A result that names no file at all (a
 * shell's stdout, a hook's output, a Grep over a folder, a fetch) has nothing to judge by and stays as written: a stated residual.
 */
function scrubRecord(node, ctx) {
    walk(node, ctx);
    if (node === null || typeof node !== "object" || Array.isArray(node))
        return;
    const record = node;
    const message = record.message;
    if (message === null || typeof message !== "object")
        return;
    const blocks = message.content;
    if (!Array.isArray(blocks))
        return;
    const results = blocks.filter((b) => b !== null && typeof b === "object" && b.type === "tool_result");
    if (results.length === 0)
        return;
    const named = namesOutOfTree(record.toolUseResult, ctx) ||
        blocks.some((b) => b !== null && typeof b === "object" && b.type === "tool_use" && namesOutOfTree(b.input, ctx));
    if (named) {
        for (const block of results)
            withholdResultBlock(block, ctx);
        return;
    }
    // C40 (1): a result whose file is named only in the CALL (an image Read has no path in its result). The call's paths were recorded when the
    // transcript was scanned; they are judged HERE, per copy, with this copy's roots and holes. A call that is unknown fails closed.
    const lookup = ctx.scope?.calls;
    if (lookup === undefined)
        return;
    let condemned = false;
    for (const block of results) {
        const id = block.tool_use_id;
        if (typeof id !== "string")
            continue;
        const verdict = lookup(id);
        const out = verdict === "unknown" || (verdict !== "none" && verdict.some((path) => !ctx.resolver(ctx.projectRoots, path) || ctx.scope?.hole?.(path) === true));
        if (!out)
            continue;
        condemned = true;
        withholdResultBlock(block, ctx);
    }
    // The record's structured copy of the same result (an image Read's `toolUseResult.file.base64`) goes with it; the selector paths and `type` stay.
    if (condemned && record.toolUseResult !== null && typeof record.toolUseResult === "object")
        withholdResultLeavesExcept(record.toolUseResult, ctx, ctx.rules.pathKeys);
}
/** `withholdResultLeaves`, keeping the strings under `kept` keys too (the selector paths of a result). */
function withholdResultLeavesExcept(node, ctx, kept) {
    if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i += 1) {
            const item = node[i];
            if (typeof item === "string")
                withholdLeaf(node, i, ctx);
            else
                withholdResultLeavesExcept(item, ctx, kept);
        }
        return;
    }
    if (node === null || typeof node !== "object")
        return;
    const record = node;
    for (const key of Object.keys(record)) {
        const value = record[key];
        if (typeof value === "string") {
            if (!RESULT_KEPT_KEYS.has(key) && !kept.has(key))
                withholdLeaf(record, key, ctx);
        }
        else {
            withholdResultLeavesExcept(value, ctx, kept);
        }
    }
}
/**
 * Replace `container[key]` (a string leaf) with its withheld form and REGISTER A SLOT for it (C41), so a nested document's `pad` can lengthen
 * it when the encoded form needs a few more bytes. A replacement that registers no slot is one `pad` cannot balance.
 */
function withholdLeaf(container, key, ctx) {
    const original = container[key];
    if (typeof original !== "string")
        return;
    const withheld = withholdString(original);
    if (withheld === null)
        return;
    container[key] = withheld;
    ctx.redacted += 1;
    ctx.slots?.push({ record: container, key: String(key) });
}
/** Keys inside a `tool_result` block that stay: what KIND of block this is, never what it holds. */
const RESULT_KEPT_KEYS = new Set(["type", "media_type"]);
function withholdResultBlock(block, ctx) {
    const content = block.content;
    if (typeof content === "string") {
        withholdLeaf(block, "content", ctx);
        return;
    }
    withholdResultLeaves(content, ctx);
}
function withholdResultLeaves(node, ctx) {
    if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i += 1) {
            const item = node[i];
            if (typeof item === "string")
                withholdLeaf(node, i, ctx);
            else
                withholdResultLeaves(item, ctx);
        }
        return;
    }
    if (node === null || typeof node !== "object")
        return;
    const record = node;
    for (const key of Object.keys(record)) {
        const value = record[key];
        if (typeof value === "string") {
            if (RESULT_KEPT_KEYS.has(key))
                continue;
            withholdLeaf(record, key, ctx);
        }
        else {
            withholdResultLeaves(value, ctx);
        }
    }
}
/** Withhold every string under `record[key]` (the value itself when it is a string), length-preserving. */
function withholdUnder(record, key, ctx) {
    const value = record[key];
    if (typeof value === "string") {
        withholdLeaf(record, key, ctx);
        return;
    }
    withholdResultLeaves(value, ctx);
}
/**
 * Walk the record, redacting content that sits beside an out-of-tree path.
 *
 * The rule is local and structural: within ONE object, a path key naming a file
 * outside the project root makes that object's content-bearing siblings
 * third-party content. That holds for every shape the transcript actually uses
 * — the tool_use input (`{file_path, content}`), the flat Edit result
 * (`{filePath, originalFile, oldString, newString, structuredPatch}`) and the
 * nested Read result (`file: {filePath, content}`) — without this module
 * needing to know which tool produced which.
 */
function walk(node, ctx, 
/** True once an ancestor named a file outside the tree. */
inherited = false, 
/** C37: True inside a record's `attachment` subtree, where `path`/`filename` and `rawContent`/`snippet` join the key sets. */
inAttachment = false) {
    if (Array.isArray(node)) {
        for (const item of node)
            walk(item, ctx, inherited, inAttachment);
        return;
    }
    if (node === null || typeof node !== "object")
        return;
    const record = node;
    const extra = inAttachment ? ctx.rules.attachment : undefined;
    // A nested object that names its OWN file decides for its own subtree: an
    // in-tree read quoted inside an out-of-tree record is still the user's own
    // content, and the reverse is still somebody else's.
    const named = namesAFile(record, ctx.rules.pathKeys) ?? (extra === undefined ? null : namesAFile(record, extra.pathKeys));
    const outOfTree = named === null ? inherited : !ctx.resolver(ctx.projectRoots, named) || ctx.scope?.hole?.(named) === true;
    for (const key of Object.keys(record)) {
        const value = record[key];
        // C38 (b): a `skills[]` item with NO path of its own (nothing to judge its content by) is withheld in EVERY copy, failing closed.
        if (inAttachment && key === "skills" && Array.isArray(value))
            withholdPathlessSkills(value, ctx);
        if (ctx.rules.withheldKeys?.(key) === true) {
            // C40 (2): injected instruction text, withheld whether or not a path is in scope.
            withholdUnder(record, key, ctx);
        }
        else if (outOfTree && (ctx.rules.contentKeys.has(key) || extra?.contentKeys.has(key) === true) && typeof value === "string") {
            replaceString(record, key, value, ctx);
        }
        else if (extra?.contentKeys.has(key) === true && value !== null && typeof value === "object") {
            // C41 (3) / C45 (1): an attachment's content key can hold ANY shape (a list of strings, a list of `{type, text}` blocks, nested lists), and an object
            // inside it can name a file of its own. Judged RECURSIVELY by the nearest file-naming object, whatever the leaf keys are called: under an out-of-tree
            // verdict every string leaf is withheld; under an in-tree one they are kept; an object naming a file replaces the verdict for its subtree.
            withholdUnlessOwnFile(value, ctx, outOfTree);
        }
        else if (outOfTree && ctx.rules.patchKeys.has(key)) {
            redactPatch(value, ctx);
        }
        else if (key === WIRE_KEY && value !== null && typeof value === "object" && !Array.isArray(value)) {
            // C39 (ii): `wireToolInputs` is `{<tool_use id>: {file_path, content}}`, a second copy of every tool input. An entry that is an
            // object is reached by the object-local rule below; an entry that is a JSON STRING is opened here, like Codex's `arguments`.
            const entries = value;
            for (const id of Object.keys(entries)) {
                const entry = entries[id];
                if (typeof entry === "string")
                    redactNested(entries, id, entry, ctx, outOfTree);
            }
        }
        else if (ctx.rules.nestedJsonKeys.has(key) && typeof value === "string") {
            // ⛔ NOT gated on `outOfTree`. The path key that decides a Codex exec
            // (`workdir`) lives INSIDE the nested document, so the outer object has
            // nothing to judge by — descending only when the outer record is already
            // condemned would never open the one carrier that matters.
            redactNested(record, key, value, ctx, outOfTree);
        }
    }
    // ⚠ The verdict is INHERITED down the subtree, and that is the fix for a hole
    // this module shipped with in review: `MultiEdit`'s `edits: [{old_string,
    // new_string}]` sit one level BELOW the object carrying `file_path`, so a rule
    // that only redacted an object's own keys walked straight past a third party's
    // file content. Verified leaking before the change and redacted after.
    // C37: every attachment record carries `rendered: [{content}]`, the text the model was shown for it, which REPEATS the attachment's file
    // content (an `instructions` record's `rendered` holds the whole CLAUDE.md). `rendered` is a sibling of `attachment`, not inside it, so
    // the verdict of the file(s) the attachment names must reach it explicitly.
    const renderedOut = !inAttachment && ctx.rules.attachment !== undefined && typeof record.attachment === "object" && record.attachment !== null
        ? attachmentNamesOutOfTree(record.attachment, ctx)
        : false;
    for (const [key, value] of Object.entries(record)) {
        if (key === "rendered" && !inAttachment && ctx.rules.attachment !== undefined && typeof record.attachment === "object" && record.attachment !== null) {
            // C41 / P2's (3b) / C45 (1): `rendered` repeats the attachment's content, whatever its shape (`[{content}]` in every real record, `[{type, text}]`
            // possible). Under an out-of-tree attachment verdict every string leaf is withheld except `type`/`media_type`; under an in-tree one they are kept; in
            // both, a nested object that names its own file decides for its subtree.
            withholdValueUnlessOwnFile(record, key, ctx, renderedOut);
            // C46: IN ADDITION to the normal walk, never instead of it. The verdict above withholds string leaves; it does not open an encoded carrier
            // (`wireToolInputs`, `arguments`) nested inside `rendered`, which the walk decodes and redacts. Walking over markers already written is idempotent.
            // inAttachment=true (C47): `rendered` repeats the attachment, so its objects name their files by the attachment's selectors too (path, filename, planFilePath, targetFile).
            walk(record[key], ctx, outOfTree || renderedOut, true);
            continue;
        }
        walk(value, ctx, outOfTree, inAttachment || (ctx.rules.attachment !== undefined && key === "attachment"));
    }
}
/** C38 (b): the content of a `skills[]` item that names no file of its own, withheld whatever copy it is in. */
function withholdPathlessSkills(items, ctx) {
    const contentKeys = new Set([...ctx.rules.contentKeys, ...(ctx.rules.attachment?.contentKeys ?? [])]);
    for (const item of items) {
        if (item === null || typeof item !== "object" || Array.isArray(item))
            continue;
        const skill = item;
        if ((namesAFile(skill, ctx.rules.pathKeys) ?? namesAFile(skill, ctx.rules.attachment?.pathKeys ?? new Set())) !== null)
            continue;
        for (const key of Object.keys(skill)) {
            if (!contentKeys.has(key))
                continue;
            const value = skill[key];
            if (typeof value === "string")
                withholdLeaf(skill, key, ctx);
            else
                withholdResultLeaves(value, ctx);
        }
    }
}
/** `withholdUnlessOwnFile` for `container[key]`, which may itself be a bare string (`rendered: "S"`): that is withheld too (C44 (1)). */
function withholdValueUnlessOwnFile(container, key, ctx, outOfTree = true) {
    if (typeof container[key] === "string") {
        if (outOfTree)
            withholdLeaf(container, key, ctx);
    }
    else {
        withholdUnlessOwnFile(container[key], ctx, outOfTree);
    }
}
/** Is the file an object names inside the tree, and not in a hole? Only then does the object decide for itself (C44 (1)). */
function ownFileInTree(own, ctx) {
    return ctx.resolver(ctx.projectRoots, own) && ctx.scope?.hole?.(own) !== true;
}
/**
 * Withhold the string leaves under `node` that belong to somebody else's file, except under `type`/`media_type`. The verdict is INHERITED down the subtree
 * (`outOfTree`, true at the call sites, which run under an out-of-tree verdict) and an object that names a file REPLACES it with its own: an object naming
 * an IN-TREE file is the user's own (its strings stay) and an object naming an OUT-OF-TREE file has every leaf withheld, its path selectors excepted.
 * Neither is an exemption for what is nested inside it (C45 (1)): a child object that names its own file decides for itself, so an out-of-tree file nested
 * in an in-tree object is withheld and an in-tree one nested in an out-of-tree object is kept.
 */
function withholdUnlessOwnFile(node, ctx, outOfTree = true) {
    if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i += 1) {
            const item = node[i];
            if (typeof item === "string") {
                if (outOfTree)
                    withholdLeaf(node, i, ctx);
            }
            else {
                withholdUnlessOwnFile(item, ctx, outOfTree);
            }
        }
        return;
    }
    if (node === null || typeof node !== "object")
        return;
    const record = node;
    const own = namesAFile(record, ctx.rules.pathKeys) ?? namesAFile(record, ctx.rules.attachment?.pathKeys ?? new Set());
    const here = own === null ? outOfTree : !ownFileInTree(own, ctx);
    const attachmentKeys = ctx.rules.attachment?.pathKeys;
    for (const key of Object.keys(record)) {
        const value = record[key];
        if (typeof value === "string") {
            const selector = own !== null && (ctx.rules.pathKeys.has(key) || attachmentKeys?.has(key) === true);
            if (here && !RESULT_KEPT_KEYS.has(key) && !selector)
                withholdLeaf(record, key, ctx);
        }
        else {
            withholdUnlessOwnFile(value, ctx, here);
        }
    }
}
/** Does any object in this attachment subtree name a file (by `path`, `filename`, `filePath`, ...) that is out of tree? Pure: it redacts nothing. */
function attachmentNamesOutOfTree(node, ctx) {
    return namesOutOfTree(node, ctx, ctx.rules.attachment?.pathKeys);
}
/**
 * Does any object in this subtree name a file outside the tree, by a path key of the profile (and `extraKeys`)? Pure: it redacts nothing.
 * C27: NO depth cap (it failed OPEN-then-closed: past 12 levels it condemned a deeply nested in-tree MCP result for nothing). `walk` has none and parsed JSON is acyclic.
 */
function namesOutOfTree(node, ctx, extraKeys) {
    if (Array.isArray(node))
        return node.some((item) => namesOutOfTree(item, ctx, extraKeys));
    if (node === null || typeof node !== "object")
        return false;
    const record = node;
    const named = namesAFile(record, ctx.rules.pathKeys) ?? (extraKeys === undefined ? null : namesAFile(record, extraKeys));
    if (named !== null && (!ctx.resolver(ctx.projectRoots, named) || ctx.scope?.hole?.(named) === true))
        return true;
    return Object.values(record).some((value) => namesOutOfTree(value, ctx, extraKeys));
}
/**
 * Descend into a key whose STRING value is itself a JSON document — `CR-185`.
 *
 * Codex hands the whole argument list to the model as one escaped string, so
 * `{"cmd": …, "workdir": …}` is not reachable by `walk` at all: it is a leaf
 * from the outer document's point of view. D164 §8 measured that the string is
 * always JSON (512/512) and always parseable (0 failures), which is what makes
 * this a descent rather than a heuristic.
 *
 * ## ⛔ THE ACCEPTANCE PREDICATE IS THE OUTER ENCODING
 *
 * ```
 * byteLength(JSON.stringify(sOut)) === byteLength(JSON.stringify(s))
 * ```
 *
 * and it is NOT the same test as the inner one, because the outer
 * `JSON.stringify` escapes `"` and `\` a SECOND time. A `cmd` containing two
 * newlines carries two backslashes inside `s`; each costs two bytes in the outer
 * encoding and the marker's plain ASCII costs one, so an inner-exact
 * replacement lands the whole line SHORT. Length preservation is load-bearing —
 * a short body permanently gap-flags the stream (see the module header) — so the
 * shortfall is measured against the outer encoding and padded out with the fill
 * character, which costs exactly one byte at both levels.
 *
 * ⚠ **The deficit can only ever be non-negative**: replacing an escaped value
 * with unescaped ASCII of the same INNER byte length removes escapes and can
 * never add them. It is still measured rather than assumed, and a negative one
 * abandons the replacement.
 *
 * Anything that does not parse, does not round-trip, or cannot be made to land
 * on the exact byte count is LEFT ALONE and counted as skipped — the same trade
 * `markerFor` makes, for the same reason.
 */
function redactNested(record, key, value, ctx, inherited) {
    let inner;
    try {
        inner = JSON.parse(value);
    }
    catch {
        // Not a JSON document after all. A string is not content on its own.
        return;
    }
    if (inner === null || typeof inner !== "object")
        return;
    // The INNER round-trip gate, for the reason the outer one exists: the arithmetic below is only exact if everything this function does not
    // touch re-serialises to the same bytes. ⛔ C41 (1): a document that fails it is NOT left alone: it is judged first (below), and when it
    // needs redaction the WHOLE encoded string is withheld.
    let roundTrips = true;
    try {
        roundTrips = JSON.stringify(inner) === value;
    }
    catch {
        roundTrips = false;
    }
    const target = Buffer.byteLength(JSON.stringify(value));
    const slots = [];
    const nested = { ...ctx, redacted: 0, skipped: 0, slots };
    walk(inner, nested, inherited);
    // Nothing in it needs redaction: it ships as written (a long encoded document with no out-of-tree content is the common case).
    if (nested.redacted === 0 && nested.skipped === 0)
        return;
    // ⛔ C41 (1)(2), fail closed: the document NEEDS redaction, and either it does not round-trip (whitespace, key spacing) or `pad` cannot
    // balance it. The original is NEVER put back: the whole encoded string becomes one withheld value, which keeps the outer length and the
    // outer JSON valid. (A record with an out-of-tree `workdir` in non-canonical arguments used to ship as written.)
    const out = roundTrips ? pad(inner, slots, target) : null;
    if (out === null) {
        withholdLeaf(record, key, ctx);
        return;
    }
    record[key] = out;
    ctx.redacted += nested.redacted;
    ctx.skipped += nested.skipped;
}
/**
 * Re-encode the nested document at exactly `target` outer-encoded bytes.
 *
 * Returns null when it cannot be done, which leaves the caller holding the
 * original string.
 */
function pad(inner, slots, target) {
    let out;
    try {
        out = JSON.stringify(inner);
    }
    catch {
        return null;
    }
    const deficit = target - Buffer.byteLength(JSON.stringify(out));
    if (deficit < 0)
        return null;
    if (deficit > 0) {
        // Any one marker will do: the fill character is ASCII and unescaped, so it
        // costs one byte at both encoding levels wherever it lands.
        if (slots.length === 0)
            return null;
        const slot = slots[slots.length - 1];
        slot.record[slot.key] = widen(String(slot.record[slot.key]), deficit);
        try {
            out = JSON.stringify(inner);
        }
        catch {
            return null;
        }
    }
    // Belt and braces, exactly as `markerFor` does: the arithmetic above is
    // exact, and this is what proves it for THIS document rather than in general.
    return Buffer.byteLength(JSON.stringify(out)) === target ? out : null;
}
/**
 * Lengthen a marker by `extra` fill characters, INSIDE its brackets.
 *
 * The marker is user-visible — it lands in the record a customer reads back
 * (`copy/strings.ts`) — so the fill goes where `markerFor`'s own fill goes and
 * the shape stays `[OUT-OF-TREE: N bytes withheld…]`. Appending after the
 * closing bracket would be equally length-preserving and would read as a bug.
 */
function widen(marker, extra) {
    const fill = REDACTION.fill.repeat(extra);
    return marker.endsWith(REDACTION.tail)
        ? `${marker.slice(0, -REDACTION.tail.length)}${fill}${REDACTION.tail}`
        : `${marker}${fill}`;
}
/**
 * Keys whose subtree is a TOOL's arguments or a tool's result: what a command was given and what it printed. ⛔ **No key is
 * structural in here** (P1, A-T4 review): an MCP call from repo A such as `create_repository {name: "acme-secret-merger"}`, or a
 * todo list's `id` and `status`, is content of the work done there even though `name` and `id` are scaffolding on the record
 * itself. A tool_result's own `content` is the same kind of subtree.
 */
const TOOL_SUBTREE_KEYS = new Set(["input", "arguments", "toolUseResult", "tool_use_result"]);
/**
 * A schema key is an identifier: letters, digits and underscores, starting with a letter or underscore, at most 64. Anything else as a
 * KEY inside a tool subtree (a path, a file name, a URL, an id, a flag such as `-n`, a name with a space or a hyphen) is data wearing a
 * key's clothes (C26). Deliberately the narrow side: measured against the wider "looks like a path, file name, URL or id" test, it adds
 * two keys in 1.2 million records (`-n`), and a thinner record is the failure direction this module chooses.
 */
const SCHEMA_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
/** Does any key inside a tool-arguments or tool-result subtree of this record fail `SCHEMA_KEY`? Same subtree test as `isolate`. */
function hasDataKeyInToolSubtree(node, inTool = false) {
    if (Array.isArray(node))
        return node.some((item) => hasDataKeyInToolSubtree(item, inTool));
    if (node === null || typeof node !== "object")
        return false;
    const record = node;
    const isToolResult = record.type === "tool_result";
    for (const key of Object.keys(record)) {
        if (inTool && !SCHEMA_KEY.test(key))
            return true;
        const childInTool = inTool || TOOL_SUBTREE_KEYS.has(key) || (isToolResult && key === "content");
        if (hasDataKeyInToolSubtree(record[key], childInTool))
            return true;
    }
    return false;
}
/**
 * R17: withhold every content-bearing string of a record that ran inside another work tree. On the record's OWN scaffolding,
 * strings under a STRUCTURAL key stay; everything else, and EVERYTHING inside a tool-arguments or tool-result subtree, becomes a
 * length-preserving marker; a string too short for a marker becomes a same-length run of `*` (`withholdString`), never kept.
 */
function isolate(node, ctx, keptKey, inTool = false) {
    if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i += 1) {
            const item = node[i];
            if (typeof item === "string") {
                if (keptKey && !inTool)
                    continue;
                const withheld = withholdString(item);
                if (withheld === null)
                    continue;
                node[i] = withheld;
                ctx.redacted += 1;
            }
            else {
                isolate(item, ctx, keptKey, inTool);
            }
        }
        return;
    }
    if (node === null || typeof node !== "object")
        return;
    const record = node;
    const isToolResult = record.type === "tool_result";
    for (const key of Object.keys(record)) {
        const value = record[key];
        const childInTool = inTool || TOOL_SUBTREE_KEYS.has(key) || (isToolResult && key === "content");
        if (typeof value === "string") {
            if (inTool || !STRUCTURAL_KEYS.has(key)) {
                const withheld = withholdString(value);
                if (withheld !== null) {
                    record[key] = withheld;
                    ctx.redacted += 1;
                }
            }
        }
        else {
            isolate(value, ctx, !childInTool && STRUCTURAL_KEYS.has(key), childInTool);
        }
    }
}
/**
 * What an ISOLATED record's string becomes: the usual length-preserving marker, or, when the string is too short to hold even the
 * smallest honest marker, a same-length run of `*` (C18 #4a). A foreign record is withheld, not sampled: a `"password":"secret"` too
 * short for a marker is still another repo's content. `null` only for the empty string, which has nothing to hide.
 */
function withholdString(value) {
    const marker = markerFor(value);
    if (marker !== null)
        return marker;
    const target = Buffer.byteLength(JSON.stringify(value)) - 2;
    return target > 0 ? "*".repeat(target) : null;
}
/** The path this object names, or null if it names none. */
function namesAFile(record, pathKeys) {
    for (const key of Object.keys(record)) {
        if (!pathKeys.has(key))
            continue;
        const value = record[key];
        if (typeof value === "string" && value !== "")
            return value;
    }
    return null;
}
/** `structuredPatch: [{ lines: [...] }]` — the changed lines of the file. */
function redactPatch(patch, ctx) {
    if (!Array.isArray(patch))
        return;
    for (const hunk of patch) {
        if (hunk === null || typeof hunk !== "object" || Array.isArray(hunk))
            continue;
        const lines = hunk.lines;
        if (!Array.isArray(lines))
            continue;
        for (let i = 0; i < lines.length; i += 1) {
            if (typeof lines[i] === "string")
                withholdLeaf(lines, i, ctx);
        }
    }
}
function replaceString(record, key, value, ctx) {
    // C39 (b): a value too short for the 13-byte marker becomes a same-length run of `*` (`withholdString`), never kept. 0.8.0 kept it and
    // counted it as skipped; `isolate` already withheld such a value in another repo's record, so the trade is no longer needed.
    void value;
    withholdLeaf(record, key, ctx);
}
/**
 * A marker whose JSON-ENCODED byte length is exactly the original's.
 *
 * Encoded, not raw: what has to match is the bytes on the wire, and
 * `JSON.stringify` escapes newlines, quotes and control characters, so a
 * 400-byte source file is rarely 400 bytes of JSON. The marker is pure ASCII
 * with nothing `JSON.stringify` escapes, so its encoded length is simply its
 * own length plus the two quotes — which is what makes the padding exact.
 *
 * Null when even `[out-of-tree]` does not fit. The caller counts that and leaves
 * the value alone: a short span left intact is a small leak, and a mis-sized one
 * is a permanently gap-flagged stream.
 */
export function markerFor(original) {
    const target = Buffer.byteLength(JSON.stringify(original)) - 2;
    if (target < 0)
        return null;
    const head = REDACTION.head(Buffer.byteLength(original));
    const fill = target - head.length - REDACTION.tail.length;
    const marker = fill >= 0
        ? `${head}${REDACTION.fill.repeat(fill)}${REDACTION.tail}`
        : target >= REDACTION.short.length
            ? REDACTION.short + REDACTION.fill.repeat(target - REDACTION.short.length)
            : null;
    if (marker === null)
        return null;
    // Belt and braces: the arithmetic above is exact, and this is what proves it
    // for THIS value rather than in general.
    return Buffer.byteLength(JSON.stringify(marker)) === target + 2 ? marker : null;
}
/**
 * `isInsideAny`, memoised for one span.
 *
 * `isInside` resolves BOTH sides with `realpathSync` — reused rather than
 * reimplemented, because a string prefix test is exactly what misses
 * `~/code/repo/x -> /etc`, the hole `/cso` finding 1 found in `paths.ts`. An
 * unresolvable path resolves to "outside", which here means REDACT: fail closed.
 *
 * The cache exists because one span can carry hundreds of records naming a
 * handful of paths, and each miss is two `realpath` syscalls PER ROOT against a
 * hook's wall-clock budget (DESIGN.md §13.7). It lives for one span and is not
 * shared, so a path that changes between invocations is re-resolved.
 *
 * ## ⛔ THE KEY IS LENGTH-PREFIXED NOW, because it carries a LIST
 *
 * `<root>NUL<candidate>` was injective while the root was ONE string. Joining a
 * SET with that same separator is not: `["a" NUL "b"], "c"` and `["a"], "b" NUL
 * "c"` produce the identical key, and one span would then serve a cached
 * containment verdict for a boundary nobody asked about — silently, in the
 * direction that leaks as readily as the direction that redacts.
 *
 * `<n>NUL<len>NUL<root>…<candidate>` decodes uniquely: the count says how many
 * roots follow and each root's own length says where it ends, so nothing a root
 * or a candidate can hold is able to impersonate a delimiter. The NUL stays the
 * separator it always was — a POSIX path cannot contain one — with the lengths
 * as the belt to its braces.
 */
function containment() {
    const seen = new Map();
    return (roots, candidate) => {
        const prefix = roots.map((root) => `${root.length} ${root}`).join("");
        const key = `${roots.length} ${prefix}${candidate}`;
        const hit = seen.get(key);
        if (hit !== undefined)
            return hit;
        const inside = isInsideAny(roots, candidate);
        seen.set(key, inside);
        return inside;
    };
}
//# sourceMappingURL=redact.js.map