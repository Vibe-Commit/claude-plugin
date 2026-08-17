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
 * **`commit_coverage` ACCEPTS NO WINDOW.** Its input schema is `{repo |
 * repository_id, ref}` and `ref` is the only required field; there is no
 * `since`. So the server's `edges_held` and `captured_shas` are
 * **repository-wide**, and the rate computed from them is repository-wide too.
 *
 * `--since` therefore bounds **the local half only** — the commit list this
 * module reads out of the user's own clone, which is what selects the two empty
 * states (both of which name the window, because both are local facts). **The
 * rate's sentence claims no window, deliberately**, because claiming one would
 * be the plausible-wrong-answer class (D98) on the product's most load-bearing
 * number.
 *
 * That split is a real gap, it is reported rather than smoothed, and closing it
 * needs a `since` on the server tool — a row in a repo this task may not write.
 *
 * @provenance vibecommit-mcp src/read/coverage.ts — the payload shape, retyped
 */
import { ABSENCE, COMMANDS, ERRORS, REPORT, SIGNIN, WHY, } from "../copy/index.js";
import { EXIT } from "../exit.js";
import { currentBranch, gitProbe, isReachable, isShallowClone, resolveRepoSlug } from "../git.js";
import { emitJson } from "../json.js";
import { mcpUrl } from "../oauth/discovery.js";
import { readWithSession } from "../oauth/signin.js";
import { resolveProjectKey } from "../project.js";
import { renderErrorBlock, wrap } from "../term.js";
import { writeLines } from "./context.js";
/** §10.3 indents the body two columns, the same as `why`'s screens. */
const BODY_INDENT = 2;
/** One read, one POST. Generous because it contains a server-side join. */
const READ_TIMEOUT_MS = 15_000;
/** `--since` is a calendar date and nothing else — see `parseArgs`. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const isRecord = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
function asCount(value) {
    return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}
/** The whole document. `null` means malformed, and malformed renders as malformed. */
export function parseCoveragePayload(document) {
    if (!isRecord(document))
        return null;
    const ref = document.ref;
    if (typeof ref !== "string" || ref.trim() === "")
        return null;
    const edgesHeld = asCount(document.edges_held);
    const exactSuccessors = asCount(document.exact_successors);
    if (edgesHeld === null || exactSuccessors === null)
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
    const probableCount = asCount(document.probable_line.count);
    if (probableCount === null)
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
 * `--since <YYYY-MM-DD> [--ref <ref>]`.
 *
 * There is no argument parser in this package and `why` deliberately did not
 * add one; this matches that restraint — two flags, read positionally after
 * their names, and anything else is a usage error.
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
        if (arg === "--since") {
            const value = argv[i + 1];
            if (value === undefined || value.startsWith("-"))
                return "usage";
            since = value;
            i += 1;
        }
        else if (arg === "--ref") {
            const value = argv[i + 1];
            if (value === undefined || value.startsWith("-"))
                return "usage";
            ref = value;
            i += 1;
        }
        else if (!arg.startsWith("-")) {
            // A bare positional is not part of this verb's grammar, and accepting one
            // would let `report 2026-07-08` look like it worked.
            return "usage";
        }
    }
    if (since === null)
        return "usage";
    return ISO_DATE.test(since) ? { since, ref } : "bad-date";
}
// ---------------------------------------------------------------------------
// Rendering.
// ---------------------------------------------------------------------------
function errorCopy(what, why, fixLabel, fix) {
    return { what, why: [why], fixLabel, fixes: [fix] };
}
function fail(ctx, copy, code) {
    writeLines(ctx.stderr, renderErrorBlock({ kind: "bad", ...copy }, ctx.colour));
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
        ? { kind: "warn", what, why: [why], fixLabel, fixes }
        : { kind: "warn", what, why: [why] };
    const lines = [...renderErrorBlock(block, ctx.colour)];
    if (fixes.length === 0)
        lines.push("", ...wrap(fixLabel, 4));
    writeLines(ctx.stdout, lines);
    return EXIT.empty;
}
/** `notAuthorized`'s six outcomes, the same six `why` renders. */
function notAuthorized(ctx, authorized) {
    switch (authorized.kind) {
        case "no-session":
            return fail(ctx, errorCopy(WHY.signedOutWhat, WHY.signedOutWhy, WHY.signedOutFix, COMMANDS.signIn), EXIT.notConnected);
        case "expired":
            return fail(ctx, errorCopy(SIGNIN.expiredWhat, SIGNIN.expiredWhy, SIGNIN.expiredFix, COMMANDS.signIn), EXIT.notConnected);
        case "busy":
            return fail(ctx, errorCopy(SIGNIN.busyWhat, SIGNIN.busyWhy, SIGNIN.busyFix, COMMANDS.report), EXIT.failure);
        case "unreachable":
            return fail(ctx, errorCopy(WHY.unreachableWhat, WHY.unreachableWhy, WHY.readFix, COMMANDS.report), EXIT.failure);
        case "malformed":
        case "ok":
            // `ok` is unreachable by construction — `readWithSession` only wraps a
            // NON-ok outcome. Rendered rather than thrown: a crash here would be a
            // worse answer than an honest failure.
            return fail(ctx, errorCopy(WHY.malformedWhat, WHY.malformedWhy, WHY.readFix, COMMANDS.report), EXIT.failure);
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
        ...wrap(REPORT.definition(payload.ref), BODY_INDENT),
        "",
        ...wrap(REPORT.rate(String(reachable), String(payload.edgesHeld), payload.ref, String(percent)), BODY_INDENT),
    ];
    const parts = GRADE_ORDER.filter((g) => (payload.byGrade[g] ?? 0) > 0).map((g) => REPORT.gradeCount(String(payload.byGrade[g]), GRADE_LABEL[g]));
    if (parts.length > 0) {
        lines.push(...wrap(`${REPORT.gradeMixIntro} ${parts.join(", ")}.`, BODY_INDENT));
    }
    // ⚠ ITS OWN LINE, IN OUR WORDS, NEVER ADDED TO THE RATE ABOVE (D67).
    if (payload.probableCount > 0) {
        const text = payload.probableCount === 1 ? REPORT.probableOne : REPORT.probable(String(payload.probableCount));
        lines.push("", ...wrap(text, BODY_INDENT));
    }
    return lines;
}
export async function report(ctx, argv, deps = {}) {
    // §13.3 — `--json` emits nothing but the JSON document on stdout, and D122 §2
    // rules that §13.3 REQUIRES it here. Every FAILURE below is unchanged (§13.6
    // to stderr, nothing on stdout); the three ANSWER states branch.
    const json = argv.includes("--json");
    const args = parseArgs(argv);
    if (args === "usage") {
        return fail(ctx, errorCopy(REPORT.usageWhat, REPORT.usageWhy, REPORT.usageFix, COMMANDS.report), EXIT.usage);
    }
    if (args === "bad-date") {
        return fail(ctx, errorCopy(REPORT.sinceWhat, REPORT.sinceWhy, REPORT.sinceFix, COMMANDS.report), EXIT.usage);
    }
    const projectKey = resolveProjectKey(ctx.cwd);
    if (projectKey === null) {
        writeLines(ctx.stderr, renderErrorBlock({ kind: "bad", what: ERRORS.notAGitRepo, why: [] }, ctx.colour));
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
        return fail(ctx, errorCopy(REPORT.shallowWhat, REPORT.shallowWhy, WHY.shallowFix, WHY.shallowFixCommand), EXIT.failure);
    }
    const ref = args.ref ?? currentBranch(projectKey);
    if (ref === null) {
        return fail(ctx, errorCopy(REPORT.refWhat, REPORT.refWhy, REPORT.refFix, COMMANDS.reportRef), EXIT.usage);
    }
    // ⚠ THE WINDOW IS A LOCAL FACT, and so are both empty states. `git log`
    // answers "what commits are on this ref in this window" without a server,
    // which is what lets state 3 render before anything is read.
    const log = gitProbe(projectKey, ["log", "--format=%H", `--since=${args.since}`, ref, "--"]);
    if (log === null) {
        return fail(ctx, errorCopy(REPORT.refWhat, REPORT.refWhy, REPORT.refFix, COMMANDS.reportRef), EXIT.usage);
    }
    const windowShas = log.split("\n").filter((line) => line.trim() !== "");
    const window = REPORT.window(args.since);
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
                since: args.since,
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
        return absence(ctx, ABSENCE.reportNoCommits.what(ref, window), ABSENCE.reportNoCommits.why(ref), ABSENCE.reportNoCommits.fix, [COMMANDS.report]);
    }
    const endpoint = mcpUrl(ctx.env);
    if (endpoint === null) {
        return fail(ctx, errorCopy(SIGNIN.noServerWhat, SIGNIN.noServerRefusedWhy, WHY.readFix, COMMANDS.report), EXIT.failure);
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
        since: args.since,
    });
}
/** Every arm of `Read`, and every arm of `Authorized` inside one of them. */
function render(ctx, outcome, projectKey, ref, window, windowCommits, opts) {
    switch (outcome.kind) {
        case "not-authorized":
            return notAuthorized(ctx, outcome.authorized);
        case "unauthorized":
            return fail(ctx, errorCopy(WHY.signedOutWhat, WHY.signedOutWhy, WHY.signedOutFix, COMMANDS.signIn), EXIT.notConnected);
        case "unreachable":
            return fail(ctx, errorCopy(WHY.unreachableWhat, WHY.unreachableWhy, WHY.readFix, COMMANDS.report), EXIT.failure);
        case "rpc-error":
            // ⚠ Never a bare HTTP status or a raw JSON-RPC code on screen (§13.6).
            return fail(ctx, errorCopy(WHY.serverErrorWhat, WHY.serverErrorWhy, WHY.readFix, COMMANDS.report), EXIT.failure);
        case "malformed":
            return fail(ctx, errorCopy(WHY.malformedWhat, WHY.malformedWhy, WHY.readFix, COMMANDS.report), EXIT.failure);
        case "ok": {
            // ⚠ `isError` rides the SAME envelope as a success. A caller that only
            // branched on the transport would read a tool failure as a record.
            if (outcome.isError) {
                return fail(ctx, errorCopy(WHY.serverErrorWhat, WHY.serverErrorWhy, WHY.readFix, COMMANDS.report), EXIT.failure);
            }
            const payload = parseCoveragePayload(outcome.document);
            if (payload === null) {
                return fail(ctx, errorCopy(WHY.malformedWhat, WHY.malformedWhy, WHY.readFix, COMMANDS.report), EXIT.failure);
            }
            return renderPayload(ctx, payload, projectKey, ref, window, windowCommits, opts);
        }
    }
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
        return absence(ctx, ABSENCE.reportNoSessions.what(String(windowCommits), window), ABSENCE.reportNoSessions.why, ABSENCE.reportNoSessions.fix, [COMMANDS.report]);
    }
    // ⚠ THE CLIENT HALF OF D67's SPLIT. Reachability is a question about the
    // user's clone and the server has no repository, so it is asked here.
    let reachable = 0;
    for (const sha of payload.capturedShas) {
        const answer = isReachable(projectKey, sha, ref);
        // ⚠ FAILS CLOSED. An unanswerable probe is not a "no": counting it as
        // unreachable would DEFLATE the rate and present a smaller number as a
        // complete one, which is D98's class on the number that matters most.
        if (answer === null) {
            return fail(ctx, errorCopy(REPORT.unknownReachabilityWhat, REPORT.unknownReachabilityWhy, REPORT.unknownReachabilityFix, WHY.shallowFixCommand), EXIT.failure);
        }
        if (answer)
            reachable += 1;
    }
    // ⚠ ONLY EXACT SUCCESSORS JOIN THE NUMERATOR (D67). A commit that was
    // rewritten is still reachable through the successor we hold a recorded row
    // for; a patch-id guess is NOT, and it renders on its own line instead.
    const numerator = reachable + payload.exactSuccessors;
    if (numerator > payload.edgesHeld) {
        // The payload disagrees with the clone about its own totals. A rate over
        // 100% is not a number to print, and clamping it would hide the disagreement
        // behind a plausible figure.
        return fail(ctx, errorCopy(WHY.malformedWhat, WHY.malformedWhy, WHY.readFix, COMMANDS.report), EXIT.failure);
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
            counted: numerator,
            percent,
            probable_count: payload.probableCount,
        });
        return EXIT.ok;
    }
    writeLines(ctx.stdout, coverageScreen(payload, numerator, percent));
    return EXIT.ok;
}
//# sourceMappingURL=report.js.map