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
]);
/** Hunk arrays whose `lines` carry file content. */
const PATCH_KEY = "structuredPatch";
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
const CODEX_CLI_RULES = {
    pathKeys: new Set(["workdir", "cwd", "absolute_file_path"]),
    contentKeys: new Set(["cmd"]),
    nestedJsonKeys: new Set(["arguments"]),
    patchKeys: new Set(),
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
 * Redact one NDJSON line. **Pure, total, and length-preserving.**
 *
 * Returns the line UNCHANGED on anything it cannot handle — a blank line, a
 * parse failure, a line that does not round-trip. A hook cannot report an error
 * (DESIGN.md §13.7), and a redactor that dropped a line it could not parse would
 * be silent data loss on a path where D56 §D8 makes loss permanent.
 */
export function redactLine(line, projectRoots, rules, resolver = containment()) {
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
    // The round-trip gate. Padding arithmetic is only exact if everything this
    // module does NOT touch re-serialises to the same bytes.
    let baseline;
    try {
        baseline = JSON.stringify(parsed);
    }
    catch {
        return { line, ...NONE };
    }
    if (baseline !== line)
        return { line, ...NONE };
    const counts = { projectRoots, resolver, rules, redacted: 0, skipped: 0, slots: null };
    walk(parsed, counts);
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
        return { line, redacted: 0, skipped: counts.redacted + counts.skipped };
    }
    return { line: out, redacted: counts.redacted, skipped: counts.skipped };
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
export function redactSpan(span, projectRoots, rules) {
    const resolver = containment();
    const counts = { redacted: 0, skipped: 0 };
    const NEWLINE = 0x0a;
    const out = [];
    let start = 0;
    for (let i = 0; i <= span.length; i += 1) {
        if (i !== span.length && span[i] !== NEWLINE)
            continue;
        const segment = span.subarray(start, i);
        out.push(redactSegment(segment, projectRoots, rules, resolver, counts));
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
function redactSegment(segment, projectRoots, rules, resolver, counts) {
    const text = segment.toString("utf8");
    // A lossy decode (the span bisected a character) would re-encode to a
    // different length. Pass the raw bytes through instead.
    if (Buffer.byteLength(text) !== segment.length)
        return segment;
    const result = redactLine(text, projectRoots, rules, resolver);
    counts.redacted += result.redacted;
    counts.skipped += result.skipped;
    if (result.line === text)
        return segment;
    const replaced = Buffer.from(result.line, "utf8");
    return replaced.length === segment.length ? replaced : segment;
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
inherited = false) {
    if (Array.isArray(node)) {
        for (const item of node)
            walk(item, ctx, inherited);
        return;
    }
    if (node === null || typeof node !== "object")
        return;
    const record = node;
    // A nested object that names its OWN file decides for its own subtree: an
    // in-tree read quoted inside an out-of-tree record is still the user's own
    // content, and the reverse is still somebody else's.
    const named = namesAFile(record, ctx.rules.pathKeys);
    const outOfTree = named === null ? inherited : !ctx.resolver(ctx.projectRoots, named);
    for (const key of Object.keys(record)) {
        const value = record[key];
        if (outOfTree && ctx.rules.contentKeys.has(key) && typeof value === "string") {
            replaceString(record, key, value, ctx);
        }
        else if (outOfTree && ctx.rules.patchKeys.has(key)) {
            redactPatch(value, ctx);
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
    for (const value of Object.values(record)) {
        walk(value, ctx, outOfTree);
    }
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
    // The INNER round-trip gate, for the reason the outer one exists: the
    // arithmetic below is only exact if everything this function does not touch
    // re-serialises to the same bytes.
    let baseline;
    try {
        baseline = JSON.stringify(inner);
    }
    catch {
        return;
    }
    if (baseline !== value)
        return;
    const target = Buffer.byteLength(JSON.stringify(value));
    const slots = [];
    const nested = { ...ctx, redacted: 0, skipped: 0, slots };
    walk(inner, nested, inherited);
    ctx.skipped += nested.skipped;
    if (nested.redacted === 0)
        return;
    const out = pad(inner, slots, target);
    if (out === null) {
        // Everything withheld inside is put back. Counted as skipped, because the
        // bytes are leaving unredacted and the number has to be reportable.
        ctx.skipped += nested.redacted;
        return;
    }
    record[key] = out;
    ctx.redacted += nested.redacted;
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
            const value = lines[i];
            if (typeof value !== "string")
                continue;
            const marker = markerFor(value);
            if (marker === null) {
                ctx.skipped += 1;
                continue;
            }
            lines[i] = marker;
            ctx.redacted += 1;
        }
    }
}
function replaceString(record, key, value, ctx) {
    const marker = markerFor(value);
    if (marker === null) {
        ctx.skipped += 1;
        return;
    }
    record[key] = marker;
    ctx.redacted += 1;
    ctx.slots?.push({ record, key });
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