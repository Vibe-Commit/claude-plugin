/**
 * `vibecommit report --since` — coverage and grade mix. `CR-108`, W10.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ## ⚠ THE STRONGEST CLAIM IN THE PRODUCT, ON ITS WEAKEST FOOTING
 *
 * §PS6 blocked this surface outright, and **D67 cleared it on stated terms**.
 * The terms are the build, not advice — shipping the number without them does
 * not lift the block:
 *
 *   1. **Definition, coverage % and grade mix render TOGETHER or NOT AT ALL.**
 *   2. **Per grade, never blended**, and the **ref is named inline** — a bare
 *      percentage is meaningless because the number is ref-relative.
 *   3. **Only exact `commit_sha_successors` rows count toward the numerator**;
 *      patch-id matches render as a **separate labelled line**, never folded in.
 *   4. **On a shallow clone it REFUSES**, and that refusal is load-bearing.
 *   5. **The denominator is "commits we hold an edge for", NEVER "commits the
 *      agent made"** — that number does not exist in the schema, and inventing
 *      it turns a coverage report into a cooperation-rate claim.
 *
 * ## ⚠ THE RATE IS COMPUTED HERE, AND THAT IS AN AUTHORISED DEVIATION
 *
 * D60 §D1a says the client may render and may not analyze. **D67 puts the
 * reachability computation on the client ON PURPOSE**, because the server has
 * no repository: `commit_coverage` returns the shas we hold an edge for and
 * **deliberately no rate**, since *"a null rate invites a renderer to print
 * something."* So this module runs `git` and divides. Cited so a later reader
 * does not read it as a D1a violation.
 *
 * ## ⚠⚠ WHAT `--since` CAN AND CANNOT BOUND — READ THIS BEFORE CHANGING IT
 *
 * **THIS CLIENT SENDS `commit_coverage` NO WINDOW: `{ repo, ref }` only.** The
 * tool's optional `since`/`until` (CR-151) bound when the server RECORDED an
 * edge, not when the commit was made, so they are not `--since` and are not sent.
 * The server's `edges_held` and `captured_shas` are therefore **repository-wide**,
 * and so is the rate. `--since` bounds **the local half only**: the commit list
 * read from the user's own clone, which selects the two empty states (both name
 * the window, because both are local facts). **The rate's sentence claims no
 * window, deliberately**, because claiming one would be the plausible-wrong-answer
 * class (D98) on the product's most load-bearing number.
 *
 * That split is a real gap, reported rather than smoothed. Closing it needs a
 * server window on the commit's own time, which CR-151's is not. (CLI UX PR-A:
 * this comment used to say the tool accepts no window, which was true only
 * before CR-151.)
 *
 * @provenance vibecommit-mcp src/read/coverage.ts — the payload shape, retyped
 */
import { isShellSafeToken, rerunLine } from "../args.js";
import { ABSENCE, ARGS, COMMANDS, ORG_ANSWER, REPORT, SIGNIN, WHY, } from "../copy/index.js";
import { renderVerbHelp } from "../verb_help.js";
import { EXIT } from "../exit.js";
import { currentBranch, gitProbe, isReachable, isShallowClone, resolveRepoSlug, resolvesToCommit } from "../git.js";
import { emitJson } from "../json.js";
import { mcpUrl } from "../oauth/discovery.js";
import { orgAnswers, orgHeadings, withOrg } from "../oauth/org_answers.js";
import { terminalSafe } from "../printable.js";
import { readWithSession } from "../oauth/signin.js";
import { resolveProjectKey } from "../project.js";
import { renderErrorBlock, wrap } from "../term.js";
import { Writable } from "node:stream";
import { notAGitRepoBlock, writeFailure, writeLines } from "./context.js";
import { channelCommand } from "../install.js";
/** §10.3 indents the body two columns, the same as `why`'s screens. */
const BODY_INDENT = 2;
/** One read, one POST. Generous because it contains a server-side join. */
const READ_TIMEOUT_MS = 15_000;
/** `--since` is a calendar date and nothing else — see `parseArgs`. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/**
 * 0.17.5 A5 (P6 scope): the shape AND a real calendar day. `ISO_DATE` alone passed `2026-13-45`, which git does not refuse: it widened the
 * window, the hazard `REPORT.sinceWhy` says the check stops. The date must round-trip through the Date constructor unchanged.
 */
function isCalendarDate(value) {
    if (!ISO_DATE.test(value))
        return false;
    const [year, month, day] = value.split("-").map(Number);
    // rv175-9: `setFullYear`, not the constructor, which maps years 0-99 to 1900-1999 (so `0099-01-01`, accepted by 0.17.4, was refused).
    // Noon, so no zone's midnight change can move the day.
    const date = new Date(2000, 0, 1, 12);
    date.setFullYear(year, month - 1, day);
    return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}
const isRecord = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
function asCount(value) {
    return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}
/** A count the server may mark "not available to this caller": a non-negative integer, or an explicit `null`. ABSENT or any other value is `undefined` (malformed). */
function asCountOrNull(value) {
    if (value === null)
        return null;
    const n = asCount(value);
    return n === null ? undefined : n;
}
/** The whole document. `null` means malformed, and malformed renders as malformed. */
export function parseCoveragePayload(document) {
    if (!isRecord(document))
        return null;
    const ref = document.ref;
    if (typeof ref !== "string" || ref.trim() === "")
        return null;
    const edgesHeld = asCount(document.edges_held);
    const exactSuccessors = asCountOrNull(document.exact_successors);
    if (edgesHeld === null || exactSuccessors === undefined)
        return null;
    if (!Array.isArray(document.captured_shas))
        return null;
    const capturedShas = document.captured_shas;
    if (!capturedShas.every((s) => typeof s === "string" && s.trim() !== ""))
        return null;
    // ⚠ EVERY GRADE IS A NON-NEGATIVE INTEGER, and an unrecognised grade name is
    // MALFORMED rather than skipped. A fourth grade appearing on the wire means
    // the two repos disagree about an enum that lives in three of them with
    // nothing verifying they agree — dropping it silently would render a mix that
    // does not add up and looks fine.
    if (!isRecord(document.by_grade))
        return null;
    const byGrade = {};
    for (const [name, raw] of Object.entries(document.by_grade)) {
        const count = asCount(raw);
        if (count === null || !GRADE_ORDER.includes(name))
            return null;
        byGrade[name] = count;
    }
    // ⚠ `probable_line` is read for its COUNT ONLY. `label` is deliberately not
    // parsed — see the docblock above.
    if (!isRecord(document.probable_line))
        return null;
    const probableCount = asCountOrNull(document.probable_line.count);
    if (probableCount === undefined)
        return null;
    return { ref, edgesHeld, byGrade, capturedShas, exactSuccessors, probableCount };
}
/**
 * The order the grade mix renders in, and the ONLY place a grade name appears.
 *
 * ⚠ Strongest first, which is also `ALL_GRADES`' order. The NAMES are used to
 * look up copy and are never printed — DESIGN.md §13.3 puts grade words in
 * `--json` only, D65 §DR4 keeps them off the screen, and `test/why.test.ts`
 * already enforces that for the other read verb.
 */
const GRADE_ORDER = ["derived", "observed", "declared"];
const GRADE_LABEL = {
    derived: REPORT.gradeDerivedLabel,
    observed: REPORT.gradeObservedLabel,
    declared: REPORT.gradeDeclaredLabel,
};
/**
 * `[--since <YYYY-MM-DD>] [--ref <ref>]`, or `--since=<date>` and `--ref=<ref>`. A value flag with no value is a problem, never a
 * silent default (T16, ENG-9). A bare word that is not a flag is refused: `report 2026-07-08` did not mean what it looked like.
 *
 * ⚠ **THE DATE SHAPE IS ENFORCED RATHER THAN PASSED THROUGH.** `git log
 * --since` accepts almost anything and silently widens the window on input it
 * cannot read — *"yesterdya"* is not an error, it is a different answer. That is
 * D98's class on the field that bounds the whole report.
 */
export function parseArgs(argv) {
    let since = null;
    let ref = null;
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === "--since" || arg === "--ref") {
            const value = argv[i + 1];
            if (value === undefined || value.startsWith("-"))
                return { problem: "needs-value", flag: arg };
            if (arg === "--since")
                since = value;
            else
                ref = value;
            i += 1;
        }
        else if (arg.startsWith("--since=") || arg.startsWith("--ref=")) {
            const eq = arg.indexOf("=");
            const value = arg.slice(eq + 1);
            if (value === "")
                return { problem: "needs-value", flag: arg.slice(0, eq) };
            if (arg.startsWith("--since="))
                since = value;
            else
                ref = value;
        }
        else if (!arg.startsWith("-")) {
            return { problem: "unrecognized", token: arg };
        }
    }
    if (since !== null && !isCalendarDate(since))
        return { problem: "bad-date", ref };
    return { since, ref };
}
/**
 * The default window's start (T16, ENG-10, ENG-45): the local calendar date six days before `now`, so today plus the six before it
 * are the seven days. Built by calendar arithmetic on the Date constructor, never by subtracting 6 x 24 hours, which lands on the
 * wrong date for an hour or so after a spring-forward.
 */
export function defaultSince(now) {
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6);
    const pad = (n) => String(n).padStart(2, "0");
    return `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`;
}
// ---------------------------------------------------------------------------
// Rendering.
// ---------------------------------------------------------------------------
function errorCopy(code, what, why, fixLabel, fix) {
    return { code, what, why: [why], fixLabel, fixes: [fix] };
}
/**
 * A failure, written the way the mode wants it: §13.6's block on stderr, or under `--json` ONE failure document on stdout
 * and nothing on stderr (PR 7). The fix commands go through the install channel, so a plugin-only machine is told
 * `node <path> report`, not a `vibecommit` it does not have.
 */
function fail(ctx, json, copy, code) {
    writeFailure(ctx, { kind: "bad", ...copy, fixes: copy.fixes.map((fix) => channelCommand(ctx.env, ctx.selfPath, fix)) }, json ? "report" : null);
    return code;
}
/**
 * An ABSENCE state — `CR-112`'s grammar, exit code riding with the copy.
 *
 * Rendered to STDOUT: absence is an ANSWER. ⚠ And the `fix` sentence renders
 * even with no command beside it — `renderErrorBlock` drops `fixLabel` when
 * `fixes` is empty, which is how state 5's remedy silently vanished for a whole
 * wave (`CR-109d`). Both `report` states DO have a command, so they take the
 * ordinary path; the shape is written this way so they cannot lose it later.
 */
function absence(ctx, what, why, fixLabel, fixes) {
    const block = fixes.length > 0
        ? { kind: "warn", what, why: [why], fixLabel, fixes: fixes.map((fix) => channelCommand(ctx.env, ctx.selfPath, fix)) }
        : { kind: "warn", what, why: [why] };
    const lines = [...renderErrorBlock(block, ctx.colour)];
    if (fixes.length === 0)
        lines.push("", ...wrap(fixLabel, 4));
    writeLines(ctx.stdout, lines);
    return EXIT.empty;
}
/** `notAuthorized`'s six outcomes, the same six `why` renders. */
function notAuthorized(ctx, json, authorized, rerun) {
    switch (authorized.kind) {
        case "no-session":
            return fail(ctx, json, errorCopy("NOT_SIGNED_IN", WHY.signedOutWhat, WHY.signedOutWhy, WHY.signedOutFix, COMMANDS.signIn), EXIT.notConnected);
        case "expired":
            return fail(ctx, json, errorCopy("SIGNIN_ENDED", SIGNIN.expiredWhat, SIGNIN.expiredWhy, SIGNIN.expiredFix, COMMANDS.signIn), EXIT.notConnected);
        case "busy":
            return fail(ctx, json, errorCopy("SIGNIN_BUSY", SIGNIN.busyWhat, SIGNIN.busyWhy, SIGNIN.busyFix, rerun), EXIT.failure);
        case "unreachable":
            return fail(ctx, json, errorCopy("RECORD_SERVICE_UNREACHABLE", WHY.unreachableWhat, WHY.unreachableWhy, WHY.readFix, rerun), EXIT.failure);
        case "malformed":
        case "ok":
            // `ok` is unreachable by construction — `readWithSession` only wraps a
            // NON-ok outcome. Rendered rather than thrown: a crash here would be a
            // worse answer than an honest failure.
            return fail(ctx, json, errorCopy("RECORD_ANSWER_UNREADABLE", WHY.malformedWhat, WHY.malformedWhy, WHY.readFix, rerun), EXIT.failure);
    }
}
/**
 * D67's three-part unit. **Together or not at all.**
 *
 * ⚠ The grade mix omits a grade whose count is ZERO, and the total still
 * reconciles against `edgesHeld`. A `0` beside a grade is a measurement claim,
 * not an absence — and `observed` has no producer in any repo (D104 §2a), so
 * rendering `observed: 0` would illustrate a screen the data can never fill.
 */
function coverageScreen(payload, reachable, percent) {
    const lines = [
        ...wrap(REPORT.definition(terminalSafe(payload.ref)), BODY_INDENT),
        "",
        ...wrap(REPORT.rate(String(reachable), String(payload.edgesHeld), terminalSafe(payload.ref), String(percent)), BODY_INDENT),
    ];
    const parts = GRADE_ORDER.filter((g) => (payload.byGrade[g] ?? 0) > 0).map((g) => REPORT.gradeCount(String(payload.byGrade[g]), GRADE_LABEL[g]));
    if (parts.length > 0) {
        lines.push(...wrap(`${REPORT.gradeMixIntro} ${parts.join(", ")}.`, BODY_INDENT));
    }
    // ⚠ ITS OWN LINE, IN OUR WORDS, NEVER ADDED TO THE RATE ABOVE (D67).
    if (payload.probableCount !== null && payload.probableCount > 0) {
        const text = payload.probableCount === 1 ? REPORT.probableOne : REPORT.probable(String(payload.probableCount));
        lines.push("", ...wrap(text, BODY_INDENT));
    }
    // An unknown (null) exact-successor count is said, in our words: the rate above counts only what is still reachable.
    if (payload.exactSuccessors === null)
        lines.push("", ...wrap(REPORT.exactUnknown, BODY_INDENT));
    return lines;
}
export async function report(ctx, argv, deps = {}) {
    // `TODOS[184]`. Check-first, before `parseArgs`/anything else. Reads and writes nothing.
    if (argv.includes("--help") || argv.includes("-h")) {
        const helpVerb = "report"; // an identifier, not a literal, at the writer: `copy-inline-literals` follows argument positions
        writeLines(ctx.stdout, renderVerbHelp(helpVerb));
        return EXIT.ok;
    }
    // §13.3 — `--json` emits nothing but the JSON document on stdout, and D122 §2
    // rules that §13.3 REQUIRES it here. Every FAILURE below is unchanged (§13.6
    // to stderr, nothing on stdout); the three ANSWER states branch.
    const json = argv.includes("--json");
    const args = parseArgs(argv);
    if ("problem" in args) {
        // An identifier, not a literal, at the writer (`copy-inline-literals` follows argument positions).
        const reportVerb = "report";
        // The why line names THIS install's help command (the plugin channel has no `vibecommit` on PATH), as `main()`'s refusal does.
        const reportHelp = channelCommand(ctx.env, ctx.selfPath, ARGS.helpCommand(reportVerb));
        if (args.problem === "needs-value") {
            return fail(ctx, json, errorCopy("ARGUMENT_NEEDS_VALUE", ARGS.needsValueWhat(args.flag), `${ARGS.acceptsWhy(reportHelp)} ${ARGS.nothingRead}`, ARGS.fixLabel, ARGS.helpCommand(reportVerb)), EXIT.usage);
        }
        if (args.problem === "unrecognized") {
            return fail(ctx, json, errorCopy("UNRECOGNIZED_ARGUMENT", ARGS.unrecognizedWhat(args.token, reportVerb), `${ARGS.acceptsWhy(reportHelp)} ${ARGS.nothingRead}`, ARGS.fixLabel, ARGS.helpCommand(reportVerb)), EXIT.usage);
        }
        // 0.17.5 item 5d (P7 FINAL): the label asks for a YYYY-MM-DD date, so the command under it carries `--since <YYYY-MM-DD>` (it printed
        // bare `report`, the default window), and a typed `--ref` is kept (`reportShape` when it is not shell-safe).
        const sinceFix = args.ref === null ? COMMANDS.reportSince : isShellSafeToken(args.ref) ? COMMANDS.reportSinceRef(args.ref) : COMMANDS.reportShape;
        return fail(ctx, json, errorCopy("REPORT_SINCE_UNREADABLE", REPORT.sinceWhat, REPORT.sinceWhy, REPORT.sinceFix, sinceFix), EXIT.usage);
    }
    // 0.17.5 item 4 (P6 scope; P7 FINAL): every "this again" line reruns the command as typed. It printed bare `report`, which asks about
    // the current branch over the default window. `reportShape` only when a typed token is not shell-safe.
    const rerun = rerunLine("report", argv, COMMANDS.reportShape);
    // T16: the window. The start is the explicit date, or today minus six calendar days. Git gets `<date> 00:00`, so the date given is the
    // first day counted (a bare date would take the time of day from now, and drop that day's earlier commits).
    const since = args.since ?? defaultSince(ctx.now());
    const windowLine = args.since === null ? REPORT.windowLineDefault(since) : REPORT.windowLineExplicit(since);
    const projectKey = resolveProjectKey(ctx.cwd);
    if (projectKey === null) {
        writeFailure(ctx, notAGitRepoBlock(ctx), json ? "report" : null);
        return EXIT.failure;
    }
    // ⚠⚠ THE SHALLOW REFUSAL FIRES FIRST, BEFORE THE REF, BEFORE THE LOCAL LOG
    // AND BEFORE ANY NETWORK CALL. D67 makes it load-bearing rather than
    // defensive, and `strings.ts` addresses a contract to this verb BY NAME: *"the
    // caller MUST establish that the clone is complete before selecting either
    // `report` empty state"* — because on a shallow clone *"no commits in this
    // window"* is a claim the clone cannot support. State 3's sentence is written
    // unqualified precisely because this refusal guarantees it.
    if (isShallowClone(projectKey)) {
        return fail(ctx, json, errorCopy("SHALLOW_CLONE", REPORT.shallowWhat, REPORT.shallowWhy, WHY.shallowFix, WHY.shallowFixCommand), EXIT.failure);
    }
    const ref = args.ref ?? currentBranch(projectKey);
    if (ref === null) {
        return fail(ctx, json, errorCopy("REPORT_REF_UNNAMEABLE", REPORT.refWhat, REPORT.refWhy, REPORT.refFix, COMMANDS.reportRef), EXIT.usage);
    }
    // ⚠ THE WINDOW IS A LOCAL FACT, and so are both empty states. `git log`
    // answers "what commits are on this ref in this window" without a server,
    // which is what lets state 3 render before anything is read.
    const log = gitProbe(projectKey, ["log", "--format=%H", `--since=${since} 00:00`, ref, "--"]);
    if (log === null) {
        // 0.17.4 [6b] (P7 FINAL): git could not read this ref (an unknown `--ref`, an unborn branch); HEAD need not be detached.
        return fail(ctx, json, errorCopy("REPORT_REF_UNNAMEABLE", REPORT.refWhat, REPORT.refUnreadableWhy, REPORT.refFix, COMMANDS.reportRef), EXIT.usage);
    }
    // 0.17.5 item 1 (P6 scope; P7 FINAL): a ref `git log` reads that names no single commit (a range) is refused HERE, before any read. Every
    // reachability probe would answer unknown, and the block printed a fetch that cannot help.
    // rv175-P1 (P6): only git's own "no" (false) is this refusal. A git that did not answer (null) goes on: the reachability probe below asks
    // again, and if git still cannot answer for a recorded commit, it refuses with REPORT_REACHABILITY_UNKNOWN and the typed rerun, whose
    // words ("Git could not say whether some recorded commits are still reachable…") are true only once the recorded commits are known.
    // Where no recorded commit asks git (an empty `captured_shas` beside held edges), `renderPayload` asks again before any share.
    const refResolved = resolvesToCommit(projectKey, ref);
    if (refResolved === false) {
        return fail(ctx, json, errorCopy("REPORT_REF_UNNAMEABLE", REPORT.refWhat, REPORT.refNotOneCommitWhy, REPORT.refFix, COMMANDS.reportRef), EXIT.usage);
    }
    const windowShas = log.split("\n").filter((line) => line.trim() !== "");
    const window = REPORT.window(since);
    if (windowShas.length === 0) {
        // STATE 3 — no commits at all. Different fact from state 4, and collapsing
        // them would read as a coverage claim we cannot make.
        //
        // ⛔ THE SERVER WAS NEVER ASKED ON THIS PATH, so every counted field is
        // `null` — NOT KNOWN — and not `0`. A zero here would be a measurement claim
        // about a measurement that was never taken (`CR-129a`), and it is exactly
        // what makes this state distinguishable from state 4 below, where the server
        // DID answer and DID say zero. That distinction is the whole of "not known"
        // vs "none" on this verb.
        if (json) {
            emitJson(ctx.stdout, "report", "no_commits", {
                since,
                ref,
                window_commits: 0,
                edges_held: null,
                by_grade: null,
                reachable: null,
                exact_successors: null,
                counted: null,
                percent: null,
                probable_count: null,
            });
            return EXIT.empty;
        }
        return absence(ctx, ABSENCE.reportNoCommits.what(ref, window), ABSENCE.reportNoCommits.why(ref), ABSENCE.reportNoCommits.fix, 
        // 0.17.5 (P6 scope): "…run this again" over the command as typed; bare `report` is the default window, not a widened one.
        [rerun]);
    }
    const endpoint = mcpUrl(ctx.env);
    if (endpoint === null) {
        return fail(ctx, json, 
        // 0.17.5 A3 (P7 FINAL): `mcpUrl` is null only for a refused VIBECOMMIT_MCP_URL, so a rerun fails the same way; the fix is the variable.
        errorCopy("SIGNIN_SERVICE_NOT_FOUND", SIGNIN.noServerWhat, SIGNIN.noServerRefusedWhy, SIGNIN.noServerRefusedFix, SIGNIN.noServerRefusedCommand), EXIT.failure);
    }
    const read = deps.read ?? readWithSession;
    const outcome = await read(endpoint, "commit_coverage", 
    // ⚠ `repo` (the slug) — NOT `repository_id`. `CR-142` gave the tool a slug
    // form because this client holds a slug and nothing else, and the two are
    // EXACTLY-ONE: supplying both is refused rather than resolved by precedence.
    { repo: resolveRepoSlug(projectKey), ref }, {
        home: ctx.home,
        fetch,
        nowMs: () => ctx.now().getTime(),
        read: { fetch, timeoutMs: READ_TIMEOUT_MS },
    });
    return render(ctx, outcome, projectKey, ref, window, windowShas.length, {
        json,
        since,
        header: windowLine,
        rerun,
        refResolved: refResolved === true,
    });
}
/** Every arm of `Read`, and every arm of `Authorized` inside one of them. */
function render(ctx, outcome, projectKey, ref, window, windowCommits, opts) {
    switch (outcome.kind) {
        case "not-authorized":
            return notAuthorized(ctx, opts.json, outcome.authorized, opts.rerun);
        case "unauthorized":
            return fail(ctx, opts.json, errorCopy("NOT_SIGNED_IN", WHY.signedOutWhat, WHY.signedOutWhy, WHY.signedOutFix, COMMANDS.signIn), EXIT.notConnected);
        case "unreachable":
            return fail(ctx, opts.json, errorCopy("RECORD_SERVICE_UNREACHABLE", WHY.unreachableWhat, WHY.unreachableWhy, WHY.readFix, opts.rerun), EXIT.failure);
        case "rpc-error":
            // ⚠ Never a bare HTTP status or a raw JSON-RPC code on screen (§13.6).
            return fail(ctx, opts.json, errorCopy("RECORD_SERVICE_ERROR", WHY.serverErrorWhat, WHY.serverErrorWhy, WHY.readFix, opts.rerun), EXIT.failure);
        case "malformed":
            return fail(ctx, opts.json, errorCopy("RECORD_ANSWER_UNREADABLE", WHY.malformedWhat, WHY.malformedWhy, WHY.readFix, opts.rerun), EXIT.failure);
        case "ok": {
            // ⚠ `isError` rides the SAME envelope as a success. A caller that only
            // branched on the transport would read a tool failure as a record.
            if (outcome.isError) {
                return fail(ctx, opts.json, errorCopy("RECORD_SERVICE_ERROR", WHY.serverErrorWhat, WHY.serverErrorWhy, WHY.readFix, opts.rerun), EXIT.failure);
            }
            // M-a answers in three shapes (src/oauth/org_answers.ts): the legacy body, a body plus `org`, and `{ org: null, results: [...] }` when several
            // organizations answer. Each organization's BODY goes through the unchanged parser; one unreadable body makes the whole answer unreadable.
            const answers = orgAnswers(outcome.document);
            const payloads = answers === null ? null : answers.map((a) => parseCoveragePayload(a.body));
            if (answers === null || payloads === null || payloads.some((p) => p === null)) {
                return fail(ctx, opts.json, errorCopy("RECORD_ANSWER_UNREADABLE", WHY.malformedWhat, WHY.malformedWhy, WHY.readFix, opts.rerun), EXIT.failure);
            }
            if (answers.length === 1) {
                const only = answers[0];
                if (!opts.json || only.org === null)
                    return renderPayload(ctx, payloads[0], projectKey, ref, window, windowCommits, opts);
                // rv-cap127c 1: under --json the answer's own `org` object is kept, raw, beside the single-organization body
                const buf = bufferStream();
                const exit = renderPayload({ ...ctx, stdout: buf.stream }, payloads[0], projectKey, ref, window, windowCommits, opts);
                ctx.stdout.write(exit === EXIT.failure ? buf.text() : withOrg(buf.text(), only.org));
                return exit;
            }
            return renderEach(ctx, answers.map((a, i) => ({ org: a.org, payload: payloads[i] })), projectKey, ref, window, windowCommits, opts);
        }
    }
}
/** A stream that keeps what is written to it. */
function bufferStream() {
    const chunks = [];
    const stream = new Writable({
        write(chunk, _enc, cb) {
            chunks.push(String(chunk));
            cb();
        },
    });
    return { stream, text: () => chunks.join("") };
}
/**
 * SEVERAL organizations answered. Each is rendered by the same `renderPayload` into its own buffer, so a failure in any one (an unanswerable
 * reachability probe, a payload that disagrees with the clone) fails the whole command with nothing half-printed. Their rates are NOT merged: an
 * edge counted in two organizations would be counted twice, and a blended rate would claim a denominator nobody holds.
 *
 * Text: each organization's screen under its own name (`ORG_ANSWER.heading`). `--json`: ONE document,
 * `{ schema, verb, outcome, since, org: null, results: [ { org: {id, name}, outcome, ...the single-organization body } ] }`, outcome `coverage` when any
 * organization has a rate and otherwise the first organization's outcome. Exit: 0 when any organization has a rate, otherwise the first organization's code.
 */
function renderEach(ctx, answers, projectKey, ref, window, windowCommits, opts) {
    const rendered = [];
    for (const a of answers) {
        const buf = bufferStream();
        const exit = renderPayload({ ...ctx, stdout: buf.stream }, a.payload, projectKey, ref, window, windowCommits, { ...opts, header: null });
        if (exit === EXIT.failure) {
            ctx.stdout.write(buf.text()); // under --json `fail` wrote its one failure document to the (buffered) stdout; nothing of ours was printed before it
            return exit;
        }
        rendered.push({ org: a.org, out: buf.text(), exit });
    }
    const best = rendered.find((r) => r.exit === EXIT.ok) ?? rendered[0];
    if (opts.json) {
        const results = rendered.map((r) => {
            const { schema: _s, verb: _v, ...rest } = JSON.parse(r.out);
            return { org: r.org, ...rest };
        });
        const first = JSON.parse(best.out);
        ctx.stdout.write(`${JSON.stringify({ schema: 1, verb: "report", outcome: first.outcome, since: opts.since, org: null, results })}\n`);
        return best.exit;
    }
    // The window line is printed ONCE, above the organization headings (T16).
    const lines = opts.header === null ? [] : [opts.header, ""];
    const headings = orgHeadings(rendered.map((r) => r.org));
    rendered.forEach((r, i) => {
        if (i > 0)
            lines.push("");
        const heading = headings[i];
        lines.push(heading === null || heading === undefined ? "" : ORG_ANSWER.heading(heading), "");
        lines.push(r.out.replace(/\n$/, ""));
    });
    ctx.stdout.write(`${lines.join("\n")}\n`);
    return best.exit;
}
function renderPayload(ctx, payload, projectKey, ref, window, windowCommits, opts) {
    // STATE 4 — commits exist and we hold no session for any of them. The counted
    // commits are the whole difference from state 3.
    if (payload.edgesHeld === 0) {
        // ⚠ `edges_held` IS `0` HERE AND `null` IN STATE 3, and the difference is
        // the point: the server answered and said none, where state 3 never asked.
        // `percent` stays `null` because the denominator is zero — 0/0 is not 0%,
        // and printing `0` would be a coverage claim from no data.
        //
        // ⛔ `by_grade` IS ECHOED, NEVER WIDENED TO THE ENUM. `observed` has no
        // producer in any repo (D104 §2a), so a key the payload did not carry stays
        // absent rather than becoming a zero we never counted.
        if (opts.json) {
            emitJson(ctx.stdout, "report", "no_sessions", {
                since: opts.since,
                ref: payload.ref,
                window_commits: windowCommits,
                edges_held: 0,
                by_grade: payload.byGrade,
                reachable: null,
                exact_successors: payload.exactSuccessors,
                counted: null,
                percent: null,
                probable_count: payload.probableCount,
            });
            return EXIT.empty;
        }
        return absence(ctx, ABSENCE.reportNoSessions.what(String(windowCommits), window), ABSENCE.reportNoSessions.why, ABSENCE.reportNoSessions.fix, [opts.rerun]);
    }
    // ⚠ THE CLIENT HALF OF D67's SPLIT. Reachability is a question about the
    // user's clone and the server has no repository, so it is asked here.
    let reachable = 0;
    for (const sha of payload.capturedShas) {
        const answer = isReachable(projectKey, sha, ref);
        // ⚠ FAILS CLOSED. An unanswerable probe is not a "no": counting it as
        // unreachable would DEFLATE the rate and present a smaller number as a
        // complete one, which is D98's class on the number that matters most.
        // 0.17.5 item 1 (P7 FINAL): split by cause. Every clone here is complete (the shallow refusal ran first), so `git fetch --unshallow`
        // failed wherever it was printed. A sha not in this clone: `git fetch`, and the why says what a fetch cannot bring back (Q1.1 option
        // (a): keep refusing; a labelled not-counted line is TODOS [267], Alexander's). git not answering: the command as typed.
        if (answer === "absent") {
            return fail(ctx, opts.json, {
                code: "REPORT_REACHABILITY_UNKNOWN",
                what: REPORT.unknownReachabilityWhat,
                why: [REPORT.notInCloneWhy, REPORT.notInCloneUnfetchableWhy],
                fixLabel: REPORT.notInCloneFix,
                fixes: [REPORT.fetchCommand],
            }, EXIT.failure);
        }
        if (answer === null) {
            return fail(ctx, opts.json, errorCopy("REPORT_REACHABILITY_UNKNOWN", REPORT.unknownReachabilityWhat, REPORT.unknownReachabilityWhy, REPORT.unknownReachabilityFix, opts.rerun), EXIT.failure);
        }
        if (answer === true)
            reachable += 1;
    }
    // rv175-P1 (P6, 2026-11-24): a ref git did not answer for at the top (`refResolved` false) is asked again here when no recorded commit put a
    // question to git. Every answer the loop counted implies the ref resolved (`merge-base` exit 0, or `isReachable`'s own `resolvesToCommit`),
    // so only an empty `captured_shas` beside held edges reaches here unverified, and the share would then be a claim over a ref git never
    // resolved. Still no answer (or a no) refuses, fail closed; its rerun asks both again.
    if (!opts.refResolved && payload.capturedShas.length === 0 && resolvesToCommit(projectKey, ref) !== true) {
        return fail(ctx, opts.json, errorCopy("REPORT_REACHABILITY_UNKNOWN", REPORT.unknownReachabilityWhat, REPORT.unknownReachabilityWhy, REPORT.unknownReachabilityFix, opts.rerun), EXIT.failure);
    }
    // ⚠ ONLY EXACT SUCCESSORS JOIN THE NUMERATOR (D67). A commit that was
    // rewritten is still reachable through the successor we hold a recorded row
    // for; a patch-id guess is NOT, and it renders on its own line instead.
    const numerator = reachable + (payload.exactSuccessors ?? 0); // null = unknown, counted as nothing and said so on the screen
    if (numerator > payload.edgesHeld) {
        // The payload disagrees with the clone about its own totals. A rate over
        // 100% is not a number to print, and clamping it would hide the disagreement
        // behind a plausible figure.
        return fail(ctx, opts.json, errorCopy("RECORD_ANSWER_UNREADABLE", WHY.malformedWhat, WHY.malformedWhy, WHY.readFix, opts.rerun), EXIT.failure);
    }
    const percent = Math.round((numerator / payload.edgesHeld) * 100);
    // §13.3 — the machine surface, and THE ONE PLACE THE GRADE MIX IS READABLE AS
    // GRADES. `coverageScreen` renders D67's three-part unit through the copy
    // labels and prints no grade word at all; here the wire's own map is echoed.
    //
    // ⚠ `reachable` and `exact_successors` are reported SEPARATELY as well as in
    // `counted`, because D67 forbids folding a patch-id guess into the rate and a
    // consumer that only saw the total could not tell the halves apart.
    // `probable_count` rides alongside for the same reason and is never added in.
    if (opts.json) {
        emitJson(ctx.stdout, "report", "coverage", {
            since: opts.since,
            ref: payload.ref,
            window_commits: windowCommits,
            edges_held: payload.edgesHeld,
            by_grade: payload.byGrade,
            reachable,
            exact_successors: payload.exactSuccessors,
            // null = not known (json.ts): with the exact-successor count unknown the numerator is not the figure the screen's rate is made of
            counted: payload.exactSuccessors === null ? null : numerator,
            percent: payload.exactSuccessors === null ? null : percent,
            probable_count: payload.probableCount,
        });
        return EXIT.ok;
    }
    writeLines(ctx.stdout, opts.header === null ? coverageScreen(payload, numerator, percent) : [opts.header, "", ...coverageScreen(payload, numerator, percent)]);
    return EXIT.ok;
}
//# sourceMappingURL=report.js.map