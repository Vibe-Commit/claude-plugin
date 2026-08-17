/**
 * `vibecommit why` — the screenshotted surface. `CR-086`, W9.
 *
 * *"Show the conversation turns recorded against the commit that last changed
 * this line."* That sentence is VERBATIM-APPROVED (D61 §PS6), already in
 * `strings.ts` and already pinned by `test/help.golden.txt`. This module is what
 * makes it true.
 *
 * The screen is style guide §10.4; the copy is §R3's decision table in
 * `docs/designs/claims-audit-why.md`, which §10.4 says must not be paraphrased.
 * Layout is `DESIGN.md` §13 — six SGR roles, base-16 only, 80-column HARD WRAP,
 * §13.6's error shape, §13.7's exit contract.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ## ⚠ WHAT THIS VERB SHIPS WITHOUT, AND WHY IT SHIPS ANYWAY
 *
 * `why` is *blame → commit → attribution*. The third arrow has no producer, and
 * two more of this screen's inputs do not exist either. All four were
 * re-measured for this task rather than taken on trust (every tracked blob at
 * `vibecommit-capture` `4dcf47d`, `vibecommit-mcp` `eeda878`,
 * and `vibecommit-schema` `2c77400`, read as utf8 in
 * Python — never `grep`, because `src/redact.ts` carries literal NUL bytes and
 * `grep -I` skips it silently):
 *
 *   1. **`observed` has no producer in any repo** — 0 client git probes on the
 *      write path, and `vibecommit-mcp/src/conversation/edge_derivation.ts:36-47`
 *      states it outright. This module does not build one and must not be read
 *      as building one: `git blame` here is an INTERACTIVE READ-PATH probe whose
 *      output never crosses the ingest wire. `src/hooks/`, `src/post.ts` and
 *      `src/state.ts` are untouched.
 *   2. **Nothing writes `commit_file_attribution`** — the table `agent_id` lives
 *      on. `CR-070` created it; `CR-072` shipped the edge only and said so.
 *   3. **`capture_turns.subagent_count` EXISTS AND STILL HAS NO PRODUCER.**
 *      `CR-129a` added it (`vibecommit-schema` `f3022c5`), `integer`, nullable,
 *      no default. Nothing can carry it: mcp's `insertCaptureTurns` is an
 *      explicit seven-key literal and `blame_commit` selects
 *      `position, turn_hash`, so the column never reaches this client. The
 *      measurement, with the file and line for each answer, lives in
 *      `test/subagent-count.test.ts`.
 *
 *      ⚠ **A COLUMN LIST STOOD HERE AND IT WAS A TALLY — D101, WRITE THE
 *      PREDICATE, NEVER THE COUNT.** It read `capture_id, position,
 *      workspace_id, conversation_id, turn_hash, is_human_prompt`, and it was
 *      an exact transcription of the original `create table` when it was
 *      written. **Three later migrations emptied it, none of them wrong:**
 *      `20260610140000` added `human_prompt_hash`; `20260620180000` renamed
 *      `workspace_id` to `org_id` across fourteen tables; `20260820000000`
 *      added `subagent_count`. So the list decayed to naming a column that no
 *      longer exists — D97's species, a statement that was genuine when
 *      authored and was emptied later by someone else's correct change. **The
 *      live set is not restated here**, because restating it would start the
 *      same decay again; ask the catalog.
 *   4. **`blame_commit` does not exist** — it is `CR-085`, being built in
 *      another repo in this same wave, and D106 §1 measured production mcp still
 *      serving release v4, which has no ingest route at all. **There is no
 *      deployed server to test this against.**
 *
 * (1) and (2) are recorded in D104 §2 as owed their own `CR-###` and are
 * explicitly not this task's. (3) was `CR-129`: `CR-129a` shipped the column in
 * W10 and `CR-129d` verified the consumer against it — **the gap is narrower
 * than it was and it is not closed**, because a producer needs an mcp write
 * path AND an mcp read path, and no row owns either.
 *
 * D81 governs the shape of the answer: *"A task can be un-shippable because of
 * what it CLAIMS, not because of what it lacks… making the claim honest is
 * usually cheaper than building the thing, and it is always the correct
 * order."* So every one of those holes renders as an absence in this project's
 * grammar — **state the absence, state the cause, state what would change it** —
 * and none of them renders as a zero, a placeholder, or a silence.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ## THE THREE RULES THIS FILE IS BUILT AROUND
 *
 * **The payload is UNTRUSTED JSON.** `blame_commit` has no implementation to
 * agree with, so `BlameCommitPayload` below is a contract this repo DECLARES and
 * `CR-085` owns the other side of. Every field is validated; anything
 * unrecognised is `malformed` and renders as such rather than being partly
 * guessed at.
 *
 * **The client may render; it may not analyze** (D60 §D1a). The one authorised
 * deviation in this package is `CR-024d`'s redaction parse, by name; there is no
 * authorisation here. So the truncation totals come from the payload and this
 * module never counts the array it was handed, never ranks it, and never
 * reorders it.
 *
 * **`null` and ABSENT are different facts.** The schema comment on `agent_id`
 * says *"NULL = the main thread"* — so a null we were SENT is knowledge, and a
 * field that never arrived is not. An unmarked turn rendered from an absent
 * field is the overclaim, so a turn is rendered unmarked only when the field was
 * actually present.
 *
 * @provenance vibecommit-mcp src/read/envelope.ts — the one-text-part wire shape, retyped
 * @provenance vibecommit-schema capture_turns + commit_file_attribution — MEASURED ABSENCE, cited
 */
import { ABSENCE, COMMANDS, ERRORS, SIGNIN, WHY, renderCommitHeader, renderCommitIdentity, } from "../copy/index.js";
import { EXIT } from "../exit.js";
import { gitProbe, isShallowClone, resolveRepoSlug } from "../git.js";
import { emitJson } from "../json.js";
import { mcpUrl } from "../oauth/discovery.js";
import { readWithSession } from "../oauth/signin.js";
import { resolveProjectKey } from "../project.js";
import { WRAP_COLUMNS, paint, renderErrorBlock, truncatePath, wrap } from "../term.js";
import { writeLines } from "./context.js";
/** §10.4 indents the body two columns and the turn rows four under it. */
const BODY_INDENT = 2;
const TURN_INDENT = 4;
/** Excerpt continuation lines hang under the `>` (§10.4's drawing). */
const EXCERPT_INDENT = 13;
/** One read, one POST. Generous because it contains a server-side join. */
const READ_TIMEOUT_MS = 15_000;
/** `git blame` writes this SHA for a line that is not committed yet. */
const UNCOMMITTED_SHA = "0".repeat(40);
/** §10.4 renders the short form; the wire carries the full one. */
const ABBREV = 7;
const GRADES = new Set(["derived", "observed", "declared"]);
const MATCH_KINDS = new Set(["exact", "probable"]);
function parseMatchKind(value) {
    if (value === undefined || value === null)
        return { ok: true, value: null };
    return typeof value === "string" && MATCH_KINDS.has(value)
        ? { ok: true, value: value }
        : { ok: false };
}
/** A 7-40 hex sha on the wire, or nothing. Blank is not a sha. */
function asSha(value) {
    return typeof value === "string" && value.trim() !== "" ? value : null;
}
const isRecord = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
/** A count on the wire: a non-negative integer, or nothing. Never a coerced string. */
function asCount(value) {
    return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}
function asStrings(value) {
    if (!Array.isArray(value))
        return null;
    return value.every((v) => typeof v === "string") ? value : null;
}
/**
 * Validate one turn. Returns null on anything unexpected, which makes the whole
 * payload `malformed` — a partly-rendered turn list is the shape that reads as
 * complete, which is §R3's L2 concern one level down.
 */
function parseTurn(value) {
    if (!isRecord(value))
        return null;
    const position = asCount(value.position);
    // ⚠ PRESENT-NULL TOLERANCE, AND IT IS HARDENING RATHER THAN A FIX FOR A LIVE
    // BREAK (D112 §4). mcp emits `files: []` and `excerpt: [...] ?? []` — arrays,
    // never null, measured at `355a53e`. But its demonstrated HOUSE STYLE is
    // present-null (`emptyPayload` sets every absent field to null "so no key is
    // ever omitted"), so one `?? null` on that side would otherwise poison every
    // document. `null` here means the same as `[]` already means: WE DO NOT KNOW.
    const files = value.files === null ? [] : asStrings(value.files);
    if (position === null || files === null)
        return null;
    // ⚠ `string | null | ABSENT`, and the two absence forms are ONE fact here —
    // see the wire contract above. This is the field whose old
    // `typeof !== "string" -> return null` killed the whole document (D110 §1);
    // anything that is not a string and not an absence is still refused.
    const rawTool = value.tool;
    if (rawTool !== undefined && rawTool !== null && typeof rawTool !== "string")
        return null;
    const excerpt = value.excerpt === undefined || value.excerpt === null ? [] : asStrings(value.excerpt);
    if (excerpt === null)
        return null;
    // ⚠ PRESENCE, not truthiness. `null` is a legitimate value that means "main
    // thread"; a missing key means nothing is known, and the two must not collapse.
    const agentIdPresent = Object.prototype.hasOwnProperty.call(value, "agent_id");
    const rawAgentId = value.agent_id;
    if (agentIdPresent && rawAgentId !== null && typeof rawAgentId !== "string")
        return null;
    // The schema refuses `''` for exactly this reason: it would render as an
    // unnamed sub-agent, which is a plausible wrong answer rather than an error.
    if (typeof rawAgentId === "string" && rawAgentId.trim() === "")
        return null;
    return {
        position,
        tool: typeof rawTool === "string" ? rawTool : null,
        files,
        excerpt,
        agentId: typeof rawAgentId === "string" ? rawAgentId : null,
        agentIdPresent,
        subagentCount: value.subagent_count === undefined ? null : asCount(value.subagent_count),
    };
}
function parseWindow(value) {
    if (!isRecord(value))
        return null;
    const first = asCount(value.first);
    const last = asCount(value.last);
    const total = asCount(value.total);
    if (first === null || last === null || total === null)
        return null;
    // A window that does not bound anything is not a window. Rendering "showing
    // 12-16 of 3" would be arithmetic nobody checked.
    if (first > last || last > total)
        return null;
    return { first, last, total };
}
/** The whole document. `null` means malformed, and malformed renders as malformed. */
export function parseBlameCommitPayload(document) {
    if (!isRecord(document))
        return null;
    const state = document.state;
    if (state !== "cold_start" &&
        state !== "no_edge" &&
        state !== "squash_resolved" &&
        state !== "turns") {
        return null;
    }
    // ⚠ Parsed for EVERY state, because an unrecognised value means the two repos
    // disagree about the enum and that is not a per-branch concern.
    const matchKind = parseMatchKind(document.match_kind);
    if (!matchKind.ok)
        return null;
    if (state === "squash_resolved") {
        const recordedSha = asSha(document.recorded_sha);
        if (recordedSha === null)
            return null;
        // ⚠ D120 §2 — A NULL `match_kind` ON THIS STATE IS MALFORMED, NOT AN
        // ABSENCE. mcp ALWAYS emits the field here (`blame.ts`, the resolution
        // return), so a null is the two repos disagreeing about the enum rather
        // than a data state. And rendering it would make the STRONGER claim by
        // default: §R3 defines the unqualified copy as the `exact` variant, so an
        // unqualified render on unknown provenance asserts a recorded successor
        // pair we do not hold — D67's folding, reached by a different road. Same
        // reasoning as `grades` staying malformed, one field over.
        if (matchKind.value === null)
            return null;
        return {
            state,
            recordedSha,
            matchKind: matchKind.value,
            grades: [],
            turns: [],
            window: null,
            filesWithoutTurn: null,
        };
    }
    if (state !== "turns") {
        return {
            state,
            recordedSha: null,
            matchKind: matchKind.value,
            grades: [],
            turns: [],
            window: null,
            filesWithoutTurn: null,
        };
    }
    const rawGrades = asStrings(document.grades);
    // `gradeFloor` THROWS on an empty set, deliberately — a commit with no edge has
    // no header. A `turns` payload carrying no grade is therefore malformed rather
    // than something to render with a default, which would silently pick the
    // strongest claim available.
    if (rawGrades === null || rawGrades.length === 0 || !rawGrades.every((g) => GRADES.has(g))) {
        return null;
    }
    if (!Array.isArray(document.turns))
        return null;
    const turns = [];
    for (const raw of document.turns) {
        const turn = parseTurn(raw);
        if (turn === null)
            return null;
        turns.push(turn);
    }
    // ⚠ `null` joins `undefined` here for the same reason as `files` above —
    // hardening against mcp's present-null house style, not a live break.
    const windowAbsent = document.window === undefined || document.window === null;
    const window = windowAbsent ? null : parseWindow(document.window);
    if (!windowAbsent && window === null)
        return null;
    // ⚠ `recorded_sha` ON THE TURNS BRANCH — the whole of `CR-138`, and absent is
    // the ORDINARY case because most commits were never rewritten. Read here as
    // well as on `squash_resolved`, because reading it on one branch only is what
    // made the single-shot shape parse and deliver a null to the renderer: the
    // screen then claimed the BLAMED sha with no error and no gate (D65 §DR5).
    const rawRecorded = document.recorded_sha;
    if (rawRecorded !== undefined && rawRecorded !== null && asSha(rawRecorded) === null)
        return null;
    return {
        state,
        recordedSha: asSha(rawRecorded),
        matchKind: matchKind.value,
        grades: rawGrades,
        turns,
        window,
        filesWithoutTurn: asCount(document.files_without_turn),
    };
}
/**
 * `git blame` one line, via `--porcelain`.
 *
 * Porcelain rather than the human format: the human format embeds the author's
 * NAME, which can contain spaces, parentheses and digits, so every field after
 * it is positional guesswork. Porcelain puts the SHA first on its own line and
 * the timestamp on a labelled one.
 */
export function blameLine(dir, file, line) {
    const out = gitProbe(dir, ["blame", "--porcelain", "-L", `${line},${line}`, "--", file]);
    if (out === null)
        return null;
    return parseBlamePorcelain(out);
}
/** Exported so the parser can be driven against captured git output in the suite. */
export function parseBlamePorcelain(out) {
    const lines = out.split("\n");
    const header = /^([0-9a-f]{40}) \d+ (\d+)/.exec(lines[0] ?? "");
    if (header === null)
        return null;
    const sha = header[1];
    // A line that is not committed yet blames to the all-zero SHA. Rendering it
    // would put `0000000` on screen as if it identified something.
    if (sha === UNCOMMITTED_SHA)
        return null;
    let epoch = null;
    let tzOffsetMinutes = 0;
    for (const raw of lines) {
        if (raw.startsWith("author-time "))
            epoch = Number.parseInt(raw.slice(12).trim(), 10);
        else if (raw.startsWith("author-tz ")) {
            const tz = /^([+-])(\d{2})(\d{2})$/.exec(raw.slice(10).trim());
            if (tz !== null) {
                const magnitude = Number.parseInt(tz[2], 10) * 60 + Number.parseInt(tz[3], 10);
                tzOffsetMinutes = tz[1] === "-" ? -magnitude : magnitude;
            }
        }
    }
    if (epoch === null || !Number.isFinite(epoch))
        return null;
    // The AUTHOR's own date, not this machine's: a commit written at 23:30 in
    // Berlin is not a different day because the reader is in California.
    const shifted = new Date((epoch + tzOffsetMinutes * 60) * 1000);
    const date = shifted.toISOString().slice(0, 10);
    return {
        sha,
        commit: { line: Number.parseInt(header[2], 10), sha: sha.slice(0, ABBREV), date },
    };
}
/**
 * `<file>:<line>`.
 *
 * `lastIndexOf` rather than a split, because a path may legitimately contain a
 * colon and only the last one can be the line number. The tail must be all
 * digits and at least 1 — `file:0` and `file:-3` are not lines, and `file:1e3`
 * is the kind of input `parseInt` would quietly accept as 1.
 */
export function parseTarget(argv) {
    const positional = argv.filter((arg) => !arg.startsWith("-"));
    if (positional.length !== 1)
        return null;
    const raw = positional[0];
    const at = raw.lastIndexOf(":");
    if (at <= 0 || at === raw.length - 1)
        return null;
    const tail = raw.slice(at + 1);
    if (!/^[0-9]+$/.test(tail))
        return null;
    const line = Number.parseInt(tail, 10);
    return line >= 1 ? { file: raw.slice(0, at), line } : null;
}
// ---------------------------------------------------------------------------
// Rendering.
// ---------------------------------------------------------------------------
/**
 * Assemble a §13.6 block from four copy constants.
 *
 * ⚠ THIS IS A COPY SINK AND IT IS REGISTERED AS ONE. `test/copy-inline-literals`
 * scans ARGUMENT POSITIONS, not values, so a literal handed to a helper the sink
 * list does not name reaches `renderErrorBlock` invisibly. Its own docblock says
 * *"a new writer needs a new entry here"*; `errorCopy: [0, 1, 2, 3]` is that
 * entry, and the mutation that proves it fires is in `test/why.test.ts`.
 */
function errorCopy(what, why, fixLabel, fix) {
    return { what, why: [why], fixLabel, fixes: [fix] };
}
/** §13.6's shape, with the identity line above it when we have one. */
function fail(ctx, copy, code, commit) {
    const identity = commit === undefined ? [] : [...wrap(renderCommitIdentity(commit), BODY_INDENT), ""];
    writeLines(ctx.stderr, [
        ...identity,
        ...renderErrorBlock({ kind: "bad", ...copy }, ctx.colour),
    ]);
    return code;
}
/**
 * An ABSENCE state — `CR-112`'s grammar, and the exit code rides WITH the copy.
 *
 * Rendered to STDOUT, not stderr: absence is an ANSWER. Exit 4 says so, and
 * collapsing it into 1 is one `||` away from the permanently BLOCKED claim that
 * absence of an edge means no agent was involved.
 *
 * ⚠ THE `fix` FIELD ALWAYS RENDERS, WITH OR WITHOUT A COMMAND. `renderErrorBlock`
 * drops `fixLabel` when `fixes` is empty, and `noEdge`'s remedy is the sentence
 * *"Nothing to fix. A record cannot be added to a commit after the fact"* — which
 * has no command beside it and is the third of the three grammar fields. Letting
 * it disappear would turn a whole state into absence-with-no-remedy, which is
 * the failure `copy-absence.test.ts` guards the STRING against and nothing was
 * guarding the SCREEN against.
 */
function absence(ctx, state, fixes, commit) {
    const lines = [
        ...wrap(renderCommitIdentity(commit), BODY_INDENT),
        "",
        ...renderErrorBlock(fixes.length > 0
            ? { kind: "warn", what: state.what, why: [state.why], fixLabel: state.fix, fixes }
            : { kind: "warn", what: state.what, why: [state.why] }, ctx.colour),
    ];
    if (fixes.length === 0)
        lines.push("", ...wrap(state.fix, 4));
    writeLines(ctx.stdout, lines);
    return state.exit;
}
/**
 * One turn row: `turn 12  [Edit]  session.ts  · sub-agent a782e50`.
 *
 * ⚠ **THE ATTRIBUTION NEVER COLLAPSES** (§10.5, D65 §DR2): *"the turn header and
 * the file-attribution table ALWAYS name the actor… Hiding a quote makes no
 * claim about who wrote the code; hiding an actor does."* So the marker is on
 * every row — including, when the field never arrived, the marker that says we
 * cannot name one.
 *
 * ⚠ **NO COLOUR ON THE MARKER** (D65 §DR3). `agent_id` is an ACTOR IDENTITY, the
 * same class as a branch name — status changes and needs attention, an actor
 * identity never changes and needs none — and a colour ramp would imply a
 * quality judgment about delegated work that the register permanently BLOCKS.
 * The 2026-06-20 founder override permits colour for status and access state
 * only, and this is neither.
 *
 * The file list is budgeted against what the row has left and truncated from the
 * LEFT (§13.4: the filename identifies and the directory does not), the same
 * hand-defence `status.ts` applies to its one runtime gutter row.
 *
 * ⚠ **ASSEMBLED FROM THE PARTS THAT ARE PRESENT — NO PART, NO SEPARATOR**
 * (D112 §3). Two of the four parts can be missing on today's wire, and the
 * gutters used to be hardcoded around them, so the hole rendered as whitespace.
 * Measured at `8aa94d6` by driving this function, `JSON.stringify` per row:
 *
 * ```
 * "    turn 12  [Edit]  "                        <- no files: TRAILING WHITESPACE
 * "    turn 13  [Write]    · actor not recorded" <- no files: FOUR-SPACE GUTTER
 * ```
 *
 * A trailing space is invisible in a terminal AND invisible in a diff, which is
 * why the suite asserts `line === line.trimEnd()` rather than reading the code.
 *
 * ⚠ **`files: []` MEANS "WE DO NOT KNOW WHICH FILES", NOT "THIS TURN TOUCHED
 * NONE"** — `commit_file_attribution` has no writer (D104 §2b) and mcp
 * hardcodes the empty array. Every row sits under `WHY.turnsIntro`'s framing,
 * so the row is UNDER-INFORMATIVE rather than false; a sentence naming that
 * absence may be owed and is not written here (D112 §3).
 */
function turnRow(turn) {
    const marker = attributionMarker(turn);
    const head = `${" ".repeat(TURN_INDENT)}${WHY.turnLabel} ${turn.position}${turn.tool === null ? "" : `${GAP}[${turn.tool}]`}`;
    const tail = marker === "" ? "" : `${GAP}${marker}`;
    const files = turn.files.join(", ");
    if (files === "")
        return `${head}${tail}`;
    const budget = Math.max(8, WRAP_COLUMNS - head.length - tail.length - GAP.length);
    return `${head}${GAP}${truncatePath(files, budget)}${tail}`;
}
/**
 * The two columns §10.4 puts between the parts of a turn row.
 *
 * A separator, not copy — the same class as `ELLIPSIS` below and as the `": "`
 * that `test/copy-inline-literals.test.ts` documents as correctly living in
 * code ("prose means contains a letter"). Named because the row now has three
 * places that need exactly this width and a fourth that must NOT have it.
 */
const GAP = "  ";
/**
 * §R3's three-row attribution table, in its stated order.
 *
 * Row 3 — *"more than one distinct `agent_id` in the commit → header carries no
 * agent id; attribution stays per turn"* — is satisfied STRUCTURALLY rather than
 * by a branch: §R3's header is the identity line plus the evidence sentence, and
 * neither can carry an agent id at any grade. The suite asserts that rather than
 * assuming it.
 */
function attributionMarker(turn) {
    if (turn.agentId !== null)
        return WHY.subAgentMarker(turn.agentId);
    // ⚠ NO PRODUCER. Implemented so the row exists the day the column does; today
    // nothing on the wire can set it, and it is NEVER rendered from a zero.
    if (turn.subagentCount !== null && turn.subagentCount > 0) {
        return WHY.subAgentCountMarker(turn.subagentCount);
    }
    // Present-and-null is knowledge: the main thread. Absent is not.
    return turn.agentIdPresent ? "" : WHY.actorUnrecordedMarker;
}
/**
 * Bound one excerpt line to what the screen has left.
 *
 * ⚠ FOUND BY THE 80-COLUMN CHECK ON RENDERED OUTPUT, not by reading. `wrap()`
 * deliberately emits a single word longer than the width on its OWN LINE rather
 * than breaking it — correct for a URL or a path, where breaking makes it
 * uncopyable. **An excerpt is neither.** It is verbatim transcript, so it can
 * carry a minified line or a base64 blob with no space in it for 200 columns,
 * and that word then overflows §13.4's hard wrap. A transcript is not a thing
 * anyone copies out of this screen whole, so the trade `wrap()` makes for URLs
 * is the wrong one here.
 *
 * Truncated from the RIGHT, unlike `truncatePath`: the START of a quote is what
 * identifies it, which is the mirror of §13.4's reasoning for paths (*the
 * filename identifies and the directory does not*). §10.4's own drawing shows
 * excerpts ending mid-sentence, so this is the shape it was drawn with.
 */
function boundQuote(quote) {
    // The `> ` marker and its trailing space come out of the same budget.
    const budget = WRAP_COLUMNS - EXCERPT_INDENT - WHY.excerptPrefix.length - 1;
    const chars = [...quote];
    return chars.length <= budget ? quote : `${chars.slice(0, budget - 1).join("")}${ELLIPSIS}`;
}
/**
 * A separator, not copy — the same class as `": "` and `"\n"`, which
 * `test/copy-inline-literals.test.ts` documents as correctly living in code
 * ("prose means contains a letter"). One column, three bytes, which is why
 * every width check in this package counts columns.
 */
const ELLIPSIS = "…";
/** The turn list, its excerpts, and the two counted notices §R3 requires. */
function turnLines(ctx, payload, file) {
    const out = ["", ...wrap(WHY.turnsIntro(file), BODY_INDENT), ""];
    for (const turn of payload.turns) {
        out.push(turnRow(turn));
        for (const quote of turn.excerpt) {
            // Verbatim scrubbed transcript, never a summary (§10.4). `muted`, and the
            // `>` prefix is the quote marker the drawing uses.
            for (const line of wrap(`${WHY.excerptPrefix} ${boundQuote(quote)}`, EXCERPT_INDENT)) {
                out.push(paint(ctx.colour, "muted", line));
            }
        }
    }
    // §R3's L2 — NO SILENT DROPS. Files in the commit whose `turn_hash` is NULL
    // are COUNTED, because omitting them makes a partial set read as complete.
    // The number is the server's; nothing here counts anything.
    const missing = payload.filesWithoutTurn;
    if (missing !== null && missing > 0) {
        out.push("", ...wrap(missing === 1 ? WHY.fileWithoutTurn : WHY.filesWithoutTurn(String(missing)), BODY_INDENT));
    }
    // ⚠ The truncation notice renders only when the payload SAYS the list is
    // partial, and every number in it is the payload's. D60 §D1a: windowing an
    // already-ordered list for display is rendering; deriving the numbers is not.
    const w = payload.window;
    if (w !== null && (w.first > 1 || w.last < w.total)) {
        out.push(...wrap(WHY.truncation(String(w.first), String(w.last), String(w.total)), BODY_INDENT));
    }
    return out;
}
/**
 * The `CR-129` note — the attribution hole, held open and named on screen.
 *
 * ⚠ Rendered when ANY turn arrived without the field, in the absence grammar
 * (absence · cause · remedy) and NOT as a sixth `ABSENCE` state: those five are
 * whole-screen empty states that all exit 4, and this is a caveat on a screen
 * that has content. `test/copy-absence.test.ts` asserts the set is exactly five.
 *
 * No glyph. §10.6 gives the `warn` glyph to state D alone, because only D is
 * actionable, and there is nothing the reader of this note can do.
 */
function attributionNote(ctx) {
    return [
        "",
        ...wrap(WHY.attributionWhat, BODY_INDENT),
        ...wrap(WHY.attributionWhy, BODY_INDENT).map((l) => paint(ctx.colour, "muted", l)),
        ...wrap(WHY.attributionNotAFinding, BODY_INDENT).map((l) => paint(ctx.colour, "muted", l)),
        ...wrap(WHY.attributionFix, BODY_INDENT).map((l) => paint(ctx.colour, "muted", l)),
    ];
}
// ---------------------------------------------------------------------------
// The read lane. Every arm branches; none exits 0 and silent.
// ---------------------------------------------------------------------------
/**
 * `authorizedAccessToken`'s six outcomes.
 *
 * ⚠ `busy` and `expired` are the two `SIGNIN`'s docblock deferred to this task
 * BY NAME — *"the read verbs are `CR-086` (`why`, W9) and `CR-108` (`report`,
 * W10)"* — and this is the first renderer of either.
 *
 * `no-session` and `expired` exit **3**, not 1: both mean "sign in", which
 * §13.7 makes distinct precisely so a wrapper can branch on it without parsing
 * copy. The rest are failures of this attempt and exit 1.
 */
function notAuthorized(ctx, authorized, commit) {
    switch (authorized.kind) {
        case "no-session":
            return fail(ctx, errorCopy(WHY.signedOutWhat, WHY.signedOutWhy, WHY.signedOutFix, COMMANDS.signIn), EXIT.notConnected, commit);
        case "expired":
            return fail(ctx, errorCopy(SIGNIN.expiredWhat, SIGNIN.expiredWhy, SIGNIN.expiredFix, COMMANDS.signIn), EXIT.notConnected, commit);
        case "busy":
            return fail(ctx, errorCopy(SIGNIN.busyWhat, SIGNIN.busyWhy, SIGNIN.busyFix, COMMANDS.why), EXIT.failure, commit);
        case "unreachable":
            return fail(ctx, errorCopy(WHY.unreachableWhat, WHY.unreachableWhy, WHY.readFix, COMMANDS.why), EXIT.failure, commit);
        case "malformed":
            return fail(ctx, errorCopy(WHY.malformedWhat, WHY.malformedWhy, WHY.readFix, COMMANDS.why), EXIT.failure, commit);
        case "ok":
            // Unreachable by construction: `readWithSession` only wraps a NON-ok
            // outcome in `not-authorized`. Rendered rather than thrown, because a
            // crash here would be a worse answer than an honest failure.
            return fail(ctx, errorCopy(WHY.malformedWhat, WHY.malformedWhy, WHY.readFix, COMMANDS.why), EXIT.failure, commit);
    }
}
export async function why(ctx, argv, deps = {}) {
    // §13.3 — `--json` emits nothing but the JSON document on stdout, and D122 §2
    // rules that §13.3 REQUIRES it here. Read once and carried, never re-derived
    // per branch. Every FAILURE below is unchanged: §13.6's block to stderr,
    // nothing on stdout. Only the four ANSWER states branch (`renderPayload`).
    const json = argv.includes("--json");
    const target = parseTarget(argv);
    if (target === null) {
        return fail(ctx, errorCopy(WHY.usageWhat, WHY.usageWhy, WHY.usageFix, COMMANDS.why), EXIT.usage);
    }
    const projectKey = resolveProjectKey(ctx.cwd);
    if (projectKey === null) {
        writeLines(ctx.stderr, renderErrorBlock({ kind: "bad", what: ERRORS.notAGitRepo, why: [] }, ctx.colour));
        return EXIT.failure;
    }
    // ⚠ BEFORE the blame, not after: on a shallow clone the answer would be
    // plausible and wrong, and this is a REFUSAL, not an absence.
    if (isShallowClone(projectKey)) {
        return fail(ctx, errorCopy(WHY.shallowWhat, WHY.shallowWhy, WHY.shallowFix, WHY.shallowFixCommand), EXIT.failure);
    }
    const blamed = blameLine(projectKey, target.file, target.line);
    if (blamed === null) {
        return fail(ctx, errorCopy(WHY.blameWhat, WHY.blameWhy, WHY.blameFix, COMMANDS.why), EXIT.failure);
    }
    const endpoint = mcpUrl(ctx.env);
    if (endpoint === null) {
        return fail(ctx, errorCopy(SIGNIN.noServerWhat, SIGNIN.noServerRefusedWhy, WHY.readFix, COMMANDS.why), EXIT.failure, blamed.commit);
    }
    const read = deps.read ?? readWithSession;
    const outcome = await read(endpoint, "blame_commit", {
        repo: resolveRepoSlug(projectKey),
        commit_sha: blamed.sha,
        file_path: target.file,
    }, {
        home: ctx.home,
        fetch,
        nowMs: () => ctx.now().getTime(),
        read: { fetch, timeoutMs: READ_TIMEOUT_MS },
    });
    return render(ctx, outcome, blamed.commit, target.file, json);
}
/** Every arm of `Read`, and every arm of `Authorized` inside one of them. */
function render(ctx, outcome, commit, file, json) {
    switch (outcome.kind) {
        case "not-authorized":
            return notAuthorized(ctx, outcome.authorized, commit);
        case "unauthorized":
            // A 401 that survived one refresh and one retry. The bearer is dead.
            return fail(ctx, errorCopy(WHY.signedOutWhat, WHY.signedOutWhy, WHY.signedOutFix, COMMANDS.signIn), EXIT.notConnected, commit);
        case "unreachable":
            return fail(ctx, errorCopy(WHY.unreachableWhat, WHY.unreachableWhy, WHY.readFix, COMMANDS.why), EXIT.failure, commit);
        case "rpc-error":
            // ⚠ Never a bare HTTP status or a raw JSON-RPC code on screen (§13.6).
            return fail(ctx, errorCopy(WHY.serverErrorWhat, WHY.serverErrorWhy, WHY.readFix, COMMANDS.why), EXIT.failure, commit);
        case "malformed":
            return fail(ctx, errorCopy(WHY.malformedWhat, WHY.malformedWhy, WHY.readFix, COMMANDS.why), EXIT.failure, commit);
        case "ok": {
            // ⚠ `isError` rides the SAME envelope as a success and is a documented
            // field of a contract with an external owner. A caller that only branched
            // on the transport would read a tool failure as a record.
            if (outcome.isError) {
                return fail(ctx, errorCopy(WHY.serverErrorWhat, WHY.serverErrorWhy, WHY.readFix, COMMANDS.why), EXIT.failure, commit);
            }
            const payload = parseBlameCommitPayload(outcome.document);
            if (payload === null) {
                return fail(ctx, errorCopy(WHY.malformedWhat, WHY.malformedWhy, WHY.readFix, COMMANDS.why), EXIT.failure, commit);
            }
            return renderPayload(ctx, payload, commit, file, json);
        }
    }
}
/**
 * §R3's squash disclosure, and THE ONE PLACE THE TWO CLAIMS ARE DISTINGUISHED.
 *
 * ⚠ **SHARED BY BOTH SCREENS DELIBERATELY.** The terminal `squash_resolved`
 * state and the `turns` header make the same claim about the same pair, so
 * D67's folding arrives the moment one of them learns to tell `exact` from
 * `probable` and the other does not. At `8aa94d6` the terminal screen dropped
 * `match_kind` entirely — **zero occurrences in this repo** — so a recorded
 * successor and a patch-id guess rendered identically, live in the tree. One
 * helper, both callers, and a cell on each.
 *
 * ⚠ `exact` renders UNQUALIFIED per §R3: the base copy states no provenance at
 * all, so there is nothing further owed. Only `probable` earns a stated basis.
 * A `null` `match_kind` also renders unqualified — mcp always emits the field
 * on this state, so null means the two repos disagree, and whether THAT should
 * be malformed is a decision rather than a builder's call.
 */
function squashWhy(blamed, matchKind) {
    const why = [ABSENCE.squashResolved.why(blamed)];
    if (matchKind === "probable")
        why.push(WHY.squashProbableBasis);
    // ⚠ THE ASYMMETRY IS EXPLAINED, NOT REMOVED. Two builders read the differing
    // sha lengths as a defect, and the answer is a clause rather than a
    // truncation that would destroy the value — see THE SHA-LENGTH RULE above.
    why.push(WHY.squashShaLengths);
    return why;
}
/**
 * The exit code of each absence state, read from the COPY rather than restated.
 *
 * ⚠ `CR-112`'s grammar puts the exit code beside the sentence deliberately — the
 * `absence()` helper above takes both off one object — so the `--json` path
 * reads the same field instead of hardcoding `4`. A document and a screen that
 * disagreed about the exit code would be the plausible-wrong-answer class (D98)
 * arriving through a second renderer.
 */
const ABSENCE_EXIT = {
    cold_start: ABSENCE.coldStart.exit,
    no_edge: ABSENCE.noEdge.exit,
    squash_resolved: ABSENCE.squashResolved.exit,
};
/**
 * One turn, as the machine surface renders it — `src/json.ts`'s zero rule
 * applied field by field.
 *
 * ⛔ **`files` IS `null` WHENEVER THE LIST IS EMPTY, AND NEVER `[]`.** This
 * module's own `turnRow` docblock rules on the fact: *"`files: []` MEANS 'WE DO
 * NOT KNOW WHICH FILES', NOT 'THIS TURN TOUCHED NONE'"* — `commit_file_
 * attribution` has no writer (D104 §2b) and mcp hardcodes the empty array. So an
 * empty list on today's wire is an ABSENCE OF KNOWLEDGE, and emitting `[]` would
 * turn it into a measurement claim that this turn touched no files. `[]` stays
 * legal in the schema and simply cannot be produced today; the day a writer
 * lands, a wire that means "none" needs its own signal, not this silence.
 *
 * ⚠ `agent_id` alone is not enough and that is the whole of `agentIdPresent`:
 * `null` MEANS the main thread, so a missing key and a null key are DIFFERENT
 * facts and `agent_id_recorded` is what keeps them apart. Collapsing them would
 * render an unattributed turn as main-thread work.
 *
 * `subagent_count` is echoed, never defaulted — the column has no producer
 * (`CR-129`), so `null` is what the wire actually says and `0` would be a count
 * nobody took.
 */
function turnDocument(turn) {
    return {
        position: turn.position,
        tool: turn.tool,
        files: turn.files.length === 0 ? null : turn.files,
        agent_id: turn.agentId,
        agent_id_recorded: turn.agentIdPresent,
        subagent_count: turn.subagentCount,
    };
}
/**
 * The `--json` document for every state — §13.3, and THE ONE PLACE THE THREE-WAY
 * GRADE DISTINCTION IS MACHINE-READABLE.
 *
 * ⛔ **`grades` IS ECHOED, NEVER WIDENED.** `observed` has no producer in any
 * repo (D104 §2a), so a document that listed the full enum — or filled the gap
 * with a zero — would advertise a grade nothing can emit. What the wire sent is
 * what appears; the empty array on the three non-`turns` states is the honest
 * *no edge is held*, which is what those states mean.
 *
 * The shape is the SAME on all four states so a wrapper has one parse path. The
 * fields a state cannot fill are `null` (not known) or `[]` (measured none), per
 * `src/json.ts` — never absent, and never zero.
 */
function whyDocument(payload, commit, file) {
    return {
        commit: { sha: commit.sha, date: commit.date, line: commit.line },
        file,
        recorded_sha: payload.recordedSha,
        match_kind: payload.matchKind,
        grades: payload.grades,
        turns: payload.turns.map(turnDocument),
        window: payload.window === null
            ? null
            : { first: payload.window.first, last: payload.window.last, total: payload.window.total },
        files_without_turn: payload.filesWithoutTurn,
    };
}
function renderPayload(ctx, payload, commit, file, json) {
    // §13.3 — one document, nothing else, and the exit code is the SAME one the
    // screen returns. Placed above the switch rather than inside each arm so no
    // future state can be added that silently prints prose under the flag.
    if (json) {
        emitJson(ctx.stdout, "why", payload.state, whyDocument(payload, commit, file));
        return payload.state === "turns" ? EXIT.ok : ABSENCE_EXIT[payload.state];
    }
    switch (payload.state) {
        case "cold_start":
            return absence(ctx, ABSENCE.coldStart, [COMMANDS.connect], commit);
        case "no_edge":
            // `fix` is "Nothing to fix…", so there is no command to offer beside it.
            return absence(ctx, ABSENCE.noEdge, [], commit);
        case "squash_resolved": {
            // ⚠ D65 §DR5 — BOTH SHAs render. `CR-109` owns this state and `CR-074`
            // owns the successor lookup; this renders what the payload says and builds
            // neither. The header may NOT claim the transcript recorded the blamed SHA.
            //
            // ⚠ THIS SCREEN IS THE DEAD END `CR-138` EXISTS TO CLOSE, and it remains
            // only for a payload that carries no turns. It hands the reader a sha and
            // `parseTarget` accepts no sha form, so there is no step two. When mcp
            // starts putting `recorded_sha` on the `turns` branch (`CR-138b`), the
            // arm below renders the same disclosure WITH the session under it.
            //
            // ⚠⚠ AND ITS REMEDY CLAUSE WAS SILENTLY VANISHING — `CR-109d`, found by
            // planting a phrase in `ABSENCE.squashResolved.fix` and watching a screen
            // scan stay GREEN. `renderErrorBlock` DROPS `fixLabel` when `fixes` is
            // empty, this state has no command to offer, and it is the ONE absence
            // state that does not go through `absence()` — so it shipped with two of
            // the grammar's three fields. `absence()`'s own docblock had already
            // ruled on exactly this: *"Letting it disappear would turn a whole state
            // into absence-with-no-remedy, which is the failure `copy-absence.test.ts`
            // guards the STRING against and nothing was guarding the SCREEN
            // against."* The guard existed; this state was outside it.
            // ⚠ FULL, NOT ABBREVIATED — see THE SHA-LENGTH RULE. The asymmetry with
            // the blamed sha is information, and `squashWhy` explains it on screen.
            const recorded = payload.recordedSha ?? "";
            writeLines(ctx.stdout, [
                ...wrap(renderCommitIdentity(commit), BODY_INDENT),
                "",
                ...renderErrorBlock({
                    kind: "warn",
                    what: ABSENCE.squashResolved.what(commit.sha, recorded),
                    why: squashWhy(commit.sha, payload.matchKind),
                }, ctx.colour),
                "",
                ...wrap(ABSENCE.squashResolved.fix, 4),
            ]);
            return ABSENCE.squashResolved.exit;
        }
        case "turns": {
            const lines = [];
            // ⚠ THE SQUASH DISCLOSURE COMES FIRST, ABOVE THE HEADER PAIR — D65 §DR5
            // and §10.4's *"anything below the fold is not a qualification"*.
            //
            // ⚠ AND `renderCommitHeader`'S TWO LINES WERE NOT SPLIT TO SLOT IT
            // BETWEEN THEM, deliberately: its docblock rules that the identity line
            // and the evidence sentence *"are one unit: rendering either without the
            // other is what the structural rule exists to prevent."* So the
            // qualification goes above the pair rather than through it, and the
            // reader learns which sha the session belongs to before reading any
            // sentence about evidence.
            if (payload.recordedSha !== null) {
                lines.push(...renderErrorBlock({
                    kind: "warn",
                    what: ABSENCE.squashResolved.what(commit.sha, payload.recordedSha),
                    why: squashWhy(commit.sha, payload.matchKind),
                }, ctx.colour), "");
            }
            // ⚠ THE ONE HEADER RENDERER, taking the grade. `gradeFloor` governs: on a
            // mixed-grade commit the header takes the FLOOR (D61 §PS6), because a
            // header reporting the strongest grade would describe evidence we do not
            // hold for every edge on that commit.
            lines.push(...[...renderCommitHeader(payload.grades, commit)].flatMap((l) => wrap(l, BODY_INDENT)));
            lines.push(...turnLines(ctx, payload, truncatePath(file, WRAP_COLUMNS - 40)));
            // The hole, named — see `attributionNote`.
            if (payload.turns.some((t) => !t.agentIdPresent))
                lines.push(...attributionNote(ctx));
            writeLines(ctx.stdout, lines);
            // ⚠ EXIT 0, NOT 4, EVEN WITH THE DISCLOSURE. Exit 4 means "connected,
            // nothing to report"; this screen HAS the session on it. The terminal
            // `squash_resolved` state above keeps 4 because it genuinely has nothing.
            return EXIT.ok;
        }
    }
}
//# sourceMappingURL=why.js.map