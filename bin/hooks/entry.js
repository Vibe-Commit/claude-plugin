/**
 * The hook client — and the enforcement of the hook half of the exit contract.
 *
 * DESIGN.md §13.7, restated because every line below exists to hold it:
 *
 *   exit        ALWAYS 0. Every path: success, 401, 403, network failure,
 *               uncaught exception, unsupported Node, signal.
 *   stderr      ALWAYS empty.
 *   wall clock  ALWAYS under the hooks.json timeout for that event.
 *   stdout      At most one well-formed JSON object carrying `systemMessage`;
 *               otherwise empty. If JSON construction fails for ANY reason →
 *               empty stdout. The fallback is always silence.
 *
 * ⚠ **That stdout line reads "EMPTY on the happy path" in DESIGN.md §13.7, and
 * as of `CR-023d` it is no longer true.** Style guide §10.1's fourth state
 * (`capture confirmed`) fires on a successful send, once per `(repo, day)` — so
 * a populated stdout no longer implies something went wrong. §13.7 and §10.1
 * disagreed on this before this task; the code now follows §10.1, which D65
 * records as the executed ruling. DESIGN.md is orchestrator-owned (D66 §3), so
 * the amendment there is reported, not made here.
 *
 * **A hook that exits non-zero feeds stderr back into the user's agent and
 * derails the task they were actually doing.** That is the whole reason.
 *
 * ## Read this before trusting a green contract test
 *
 * `silenceStderr()` makes the stderr-empty assertion true STRUCTURALLY. That is
 * the correct engineering choice — it is the only thing that holds when a
 * dependency three levels down decides to warn — but it also means a green
 * "stderr is empty" proves the hook never speaks, and proves **nothing** about
 * whether the credential is handled carefully. The credential's own control is
 * separate and lives in `credential.ts` (opaque wrapper + redaction), with its
 * own red-proof in `test/credential.test.ts`. Do not read one as evidence for
 * the other.
 */
import { closeSync, openSync, readdirSync, readSync, realpathSync, statSync, writeSync, } from "node:fs";
import { basename, isAbsolute, join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { isProjectAllowed } from "../consent.js";
import { loadCredential } from "../credential.js";
import { EXIT } from "../exit.js";
import { gitProbe, headRef, resolveRepoSlug } from "../git.js";
import { redactSpan, rulesForTranscript } from "../redact.js";
import { deliver, ingestUrl } from "../post.js";
import { markSkipped } from "../policy.js";
import { fileState, loadSessionState, saveSessionState, withFileState } from "../state.js";
import { SESSION_END_EVENT, settleDelayMs, settledSize, } from "./session_end.js";
import { admitsTranscript, agentForTranscript, canonicalHookEvent, dialectFor, transcriptRoots, } from "../agents/registry.js";
import { claimFiring, fireLockPath } from "./fire_lock.js";
import { announcedSubagentFileKey, isInsideAny, subagentFileKey, subagentsDir, } from "../paths.js";
import { resolveProjectKeys } from "../project.js";
import { startSpawnBudget } from "../spawn_budget.js";
import { capSpool, capSuccessors, promotePending, readRewrites, readSpool } from "../spool.js";
import { meetsNodeFloor } from "../runtime.js";
import { renderNotice } from "../system_message.js";
/**
 * Default wall-clock budget. `CR-028` sets the real per-event `timeout` in
 * `claude-plugin/hooks/hooks.json`; this is the client-side backstop, which must
 * be the SMALLER of the two or the backstop never fires.
 *
 * ⚠ **That relation was prose and was checked by nothing until `CR-183`.** It is
 * now asserted for every event of every dialect in `test/agent-registry.test.ts`,
 * which also pins this constant against the `claude-code` dialect's own entry.
 */
export const DEFAULT_HOOK_BUDGET_MS = 5_000;
/** The subset of the network budget one attempt may take. */
const SEND_BUDGET_FRACTION = 0.6;
/**
 * A floor under the send timeout, for the case the budget arithmetic cannot
 * cover: `consumedMs` is MEASURED, not planned, so a scheduler stall during the
 * settle can overshoot the budget outright and leave nothing to divide.
 * `settleDelayMs`'s cap bounds the plan; this bounds reality.
 *
 * When it binds, the outer watchdog is already the real limit — it fires at
 * `budgetMs` regardless — so a small positive timeout here costs nothing and a
 * zero or negative one would abort the send before it was attempted.
 */
const MIN_SEND_TIMEOUT_MS = 50;
/**
 * What one send attempt may take, after the settle has taken its share.
 *
 * `consumedMs` is 0 on every event but `SessionEnd`, and at 0 this is exactly
 * the expression that was inline here before `CR-020d`
 * (`Math.floor(budgetMs * SEND_BUDGET_FRACTION)`) for any budget above ~84 ms —
 * so `Stop` and `PreCompact` are unchanged in both timing and code path.
 */
export function sendTimeoutMs(budgetMs, consumedMs) {
    const remaining = Math.max(0, budgetMs - consumedMs);
    return Math.max(MIN_SEND_TIMEOUT_MS, Math.floor(remaining * SEND_BUDGET_FRACTION));
}
/** A promise that resolves after `ms`. The one clock the settle path needs. */
function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
/**
 * Below this much REMAINING budget, stop starting sub-agent files — `CR-124`,
 * D95.
 *
 * This, not a file count, is the real bound. `sendTimeoutMs` gives each attempt
 * 0.6 of what is LEFT, so the remainder decays geometrically (5000 → 2000 → 800
 * → …) and the sum can never reach the budget however many files there are. What
 * a floor adds is refusing to START an attempt so small it can only time out:
 * a 200 ms send against a slow server burns the wall clock and delivers nothing,
 * and the file's offset would have been held anyway.
 *
 * The leftovers are not lost. Their offsets simply do not advance, and the next
 * hook picks them up — except on `SessionEnd`, where there is no next hook and
 * they stamp a gap instead (D95).
 */
const MIN_SUBAGENT_BUDGET_MS = 400;
/**
 * A hard backstop on files attempted per invocation.
 *
 * The floor above is the bound that binds when the server is slow; this one
 * bounds the pathological shape the floor cannot see — a directory with
 * hundreds of entries answering instantly, where the loop would spend its time
 * in `stat` rather than in sends. The busiest session measured on this machine
 * has 27 sub-agent files, so eight per invocation clears it in four Stop hooks,
 * and a session that spawned 27 delegated agents will fire far more than four.
 */
const MAX_SUBAGENT_FILES = 8;
/**
 * What `stampGaps` gets to keep, carved OUT of the send budget on `SessionEnd`
 * — `CR-182`.
 *
 * ## The defect, and why it is "starved" rather than "never runs"
 *
 * `stampGaps` is called AFTER the send loop, and the watchdog fires at
 * `budgetMs` regardless. The loop's own arithmetic does leave it something: each
 * attempt takes 0.6 of what REMAINS, so the last one starts with at least
 * `MIN_SUBAGENT_BUDGET_MS` and returns with 0.4 of that — 160 ms — still on the
 * clock. But that 160 ms is measured from `startedAt`, which is the settle, and
 * **the watchdog is measured from `runHook`**. Everything before the settle —
 * the stdin read, the consent gate's `git rev-parse`, the credential load — is
 * time the loop never sees and the watchdog already spent. `CR-126` measured a
 * comparable pre-entry interval at p99 392 ms idle and 184 ms under load, so the
 * 160 ms cushion is routinely already gone.
 *
 * MEASURED against the unmodified client (12 delegated files, hung ingest
 * server, `SessionEnd`): idle, every run stamped. Under CPU saturation, a
 * 2200 ms budget produced **one state cell and zero gaps** — the loop's last
 * send overshot and the process was cut off before it could record anything.
 * That is D56 §D8's quietly-short record, which is the one outcome this client
 * may not produce.
 *
 * ## Why 150 ms, and why a fixed number is honest here
 *
 * `stampGaps` is pure synchronous fs — one `loadSessionState` + `saveSessionState`
 * pair per undelivered stream, bounded by `MAX_SUBAGENT_FILES + 1` (9) — with no
 * network, no spawn and no timer in it. So unlike a send, its cost does not
 * depend on anything outside this process, and a fixed reserve is a real bound
 * rather than a guess dressed as one. 150 ms is ~17 ms per stream at the cap on
 * a machine where the whole 9-file loop measures under 5 ms, i.e. an order of
 * magnitude of margin over the effect — the same ratio `SESSION_END_SETTLE_DELAY_MS`
 * is set at, and small enough that it costs the send 90 ms of 2850 on the
 * default budget.
 *
 * ## ⛔ THE RESERVE WAS NOT ACTUALLY RESERVED UNTIL `CR-195/U2` — the two clocks
 * started at different instants
 *
 * Everything above this paragraph diagnosed the defect correctly and then
 * subtracted the reserve from the WRONG ORIGIN. `budgetMs - 150` is a bound on
 * the loop's own clock, which starts at `settleStart`; the watchdog's clock
 * starts in `runHook`, before stdin is read. So the loop was permitted to spend
 * until `budgetMs` *measured from the settle* — already past the watchdog's
 * deadline by exactly the pre-entry interval this docblock names — and the
 * watchdog then fired MID-SEND. `stampGaps` runs after the loop, so it did not
 * run at all, and the held spans stayed held.
 *
 * ⛔ **That is the G6 flake, and it was a real product defect rather than a
 * timing-sensitive assertion.** `test/session-end-gaps.test.ts` caught it as
 * `held: [[0, 39]]` where a stamped gap belonged: on `SessionEnd` — which has no
 * next invocation — a hole that is held rather than stamped is the final turn
 * recorded as delivered-so-far instead of as short. `sendBudgetMs` now takes the
 * elapsed time since `runHook` armed the watchdog and charges it, so the reserve
 * is measured against the deadline that can actually end the process.
 *
 * ⚠ **Still a mitigation, not a guarantee.** Enough scheduler pressure defeats
 * any fixed reserve, exactly as it defeats the watchdog itself — a timer cannot
 * fire while the event loop is blocked. What changed is that the reserve now
 * survives the ordinary case it was written for; before, the ordinary case is
 * precisely what consumed it.
 *
 * ⛔ Zero on every other event: `stampGaps` runs on `SessionEnd` alone, so
 * reserving elsewhere would shrink `Stop`'s send for a stamp that never happens.
 */
const GAP_STAMP_RESERVE_MS = 150;
/**
 * The budget the SENDS may spend — the whole budget, less the stamp's share.
 *
 * A function, and exported, for the reason `sendTimeoutMs` is: the carve-out is
 * the thing this task changes, and a wall-clock test cannot pin it. Every
 * discriminator that distinguishes reserve from no-reserve through a real
 * process turned out to slide with per-send overhead — a 149 ms window that
 * moves by 25 ms for every 10 ms of connect-and-compress cost — so pinning it
 * there would be tuning a constant to one machine. Here it is arithmetic.
 *
 * ⛔ `budgetMs` itself still governs the SETTLE and the WATCHDOG. Only the sends
 * are carved.
 */
/**
 * ⛔ **TAKES THE RESOLVED EVENT, NEVER THE RAW `hook_event_name` (`CR-195`).**
 *
 * It used to take a `string`, and that is precisely how Cursor's `sessionEnd`
 * bought a full-budget send with no reserve: the comparison was against
 * `"SessionEnd"`, so an unrecognised spelling was `false` rather than an error.
 * `HookEventName | null` makes the resolution a thing the CALLER must already
 * have done — `null` is the honest "none of the three", and an unresolved wire
 * string is no longer expressible here at all.
 */
export function sendBudgetMs(budgetMs, event, sinceHookStartMs = 0) {
    const reserve = event === SESSION_END_EVENT ? GAP_STAMP_RESERVE_MS : 0;
    // ⛔ FLOORED AT ZERO. A negative would reach `sendTimeoutMs`, whose own
    // `Math.max(0, budgetMs - consumedMs)` turns a negative budget into a POSITIVE
    // remaining — a blown clock reading as fresh time.
    return Math.max(0, budgetMs - sinceHookStartMs - reserve);
}
/**
 * Parse hook stdin. Claude Code supplies `{ session_id, transcript_path, cwd,
 * hook_event_name }` on stdin — NOT in the environment.
 *
 * ⚠ **And an `announce` dialect adds `agent_transcript_path` (`CR-196`).** It is
 * OPTIONAL in both directions: a `discover` install never sends it, and reading
 * it here rather than in a Cursor-specific parser is deliberate — stdin has one
 * shape and one parser, and a second one would be a second place for the
 * confinement boundary to be forgotten.
 *
 * Returns null on anything malformed. A hook cannot report a parse error (stderr
 * is empty by contract), so the only honest response is to do nothing. ⚠ A
 * malformed `agent_transcript_path` is NOT malformed input: it is dropped and
 * the main transcript still goes, because losing the whole capture over a
 * delegated extra would be the larger loss.
 */
export function parseHookInput(raw) {
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return null;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
        return null;
    const o = parsed;
    const sessionId = o.session_id;
    const transcriptPath = o.transcript_path;
    const cwd = o.cwd;
    const eventName = o.hook_event_name;
    if (typeof sessionId !== "string" || sessionId === "")
        return null;
    if (typeof transcriptPath !== "string" || transcriptPath === "")
        return null;
    const announced = o.agent_transcript_path;
    return {
        sessionId,
        transcriptPath,
        cwd: typeof cwd === "string" && cwd !== "" ? cwd : process.cwd(),
        eventName: typeof eventName === "string" ? eventName : "",
        ...(typeof announced === "string" && announced !== ""
            ? { agentTranscriptPath: announced }
            : {}),
    };
}
/**
 * Replace stderr with a sink for the rest of the process.
 *
 * Node writes uncaught exceptions, unhandled rejections and process warnings to
 * `process.stderr`, so overriding `write` is what makes the contract hold on the
 * paths we do not control. The handlers below stop the non-zero exit; this stops
 * the bytes.
 */
export function silenceStderr() {
    const sink = (_chunk, encodingOrCallback, callback) => {
        const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
        if (typeof done === "function")
            done();
        return true;
    };
    // The cast is unavoidable: `Writable.write` is overloaded and the sink
    // satisfies every overload's contract without matching any one signature.
    process.stderr.write = sink;
}
/**
 * Write the single stdout payload and exit 0.
 *
 * `writeSync(1, …)` rather than `process.stdout.write`: stdout to a pipe is
 * asynchronous, and `process.exit` does not flush it. A `systemMessage` lost to a
 * truncated write is the silent-unconfigured failure DX3 exists to kill.
 */
function finish(payload) {
    // ⛔ RELEASED HERE, AND HERE IS THE ONLY PLACE THAT COVERS EVERY EXIT
    // (`CR-195`/U4a). A `try/finally` around `hookBody` would look tidier and
    // would leak the lock on the one path that matters most: the WATCHDOG calls
    // this function directly, and the signal handlers do too, so neither unwinds
    // `hookBody` at all. A lock leaked there survives until it goes stale, and
    // until then it suppresses the next firing of that event — turning a guard
    // against duplicates into a guard against captures.
    releaseFiring();
    if (payload !== null) {
        try {
            writeSync(1, `${payload}\n`);
        }
        catch {
            // Silence is the fallback, always.
        }
    }
    process.exit(EXIT.ok);
}
/**
 * The firing this process claimed, if it claimed one.
 *
 * ⚠ **Module state, deliberately, and it is the narrow case that justifies it.**
 * This process handles exactly ONE hook invocation and then exits; `finish` is
 * its single exit point and is reached from paths that never return through
 * `hookBody`. Threading a claim out to those paths is not possible — the
 * watchdog holds no reference to the body's locals.
 */
let firingClaim = null;
/** Idempotent, and never throws: the hook contract forbids saying anything. */
function releaseFiring() {
    const claim = firingClaim;
    firingClaim = null;
    try {
        claim?.release();
    }
    catch {
        // A lock we could not release goes stale on its own; the bound is derived
        // from the budget precisely so a lost release costs one invocation, once.
    }
}
/**
 * Install every contract guard, then run the body.
 *
 * Guards go in FIRST, before any work, because the paths they cover include
 * "the body threw on its first line".
 */
export async function runHook(ctx) {
    silenceStderr();
    const budgetMs = hookBudgetMs(ctx.env, ctx.agentId);
    // ⛔ THE WATCHDOG'S OWN ORIGIN, read on the line that arms it (`CR-195/U2`).
    // Every other deadline in this process is derived from this instant, because
    // this is the one that can actually end it. Taken here rather than passed in
    // so the two cannot drift: a caller-supplied start could be older than the
    // timer, which would UNDER-charge the send loop and reopen the G6 defect from
    // the other side.
    const hookStartedAt = Date.now();
    // The watchdog covers the wall-clock clause on paths no `await` can reach: a
    // socket that never settles, a promise that never resolves. `unref` so it
    // never itself keeps the process alive.
    const watchdog = setTimeout(() => finish(null), budgetMs);
    watchdog.unref();
    // ⛔ AND THE HALF THE WATCHDOG CANNOT COVER (`TODOS[87]`). A timer cannot fire
    // while the event loop is BLOCKED, and `execFileSync` blocks it by definition
    // — so a git binary that never returns is an unbounded hang, not a slow hook,
    // and no amount of watchdog fixes it. Armed HERE, from the same `budgetMs`, so
    // the two halves of one bound cannot drift apart.
    startSpawnBudget(budgetMs);
    process.on("uncaughtException", () => finish(null));
    process.on("unhandledRejection", () => finish(null));
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
        process.on(signal, () => finish(null));
    }
    let payload = null;
    try {
        payload = await hookBody(ctx, budgetMs, hookStartedAt);
    }
    catch {
        payload = null;
    }
    finish(payload);
}
/**
 * The wall clock this invocation gets.
 *
 * ⛔ **THE TIGHTEST BUDGET THE DIALECT REGISTERS, and the reason is the ORDER
 * things happen in `runHook`** — the watchdog is armed BEFORE stdin is read, so
 * the event name is not known yet and a per-event budget cannot be applied here
 * without re-arming the guard. Taking the minimum is the direction that is safe
 * to be wrong in: it can only finish early, never overrun a registered timeout
 * and let the agent kill the process instead.
 *
 * ⚠ **Claude Code is unchanged, arithmetically** — its three events all carry
 * `DEFAULT_HOOK_BUDGET_MS`, so the minimum IS that constant. What this costs is
 * an agent whose events differ: it runs every event at its tightest one, which
 * under-uses the wide ones. Stated rather than smuggled; widening it means
 * re-arming the watchdog after the parse, which is its own change.
 *
 * `VIBECOMMIT_HOOK_TIMEOUT_MS` still wins outright, as it always has.
 */
export function hookBudgetMs(env, agentId) {
    const raw = env.VIBECOMMIT_HOOK_TIMEOUT_MS;
    if (raw === undefined)
        return dialectBudgetMs(agentId);
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : dialectBudgetMs(agentId);
}
/** The smallest `clientBudgetMs` across a dialect's events. */
function dialectBudgetMs(agentId) {
    const budgets = Object.values(dialectFor(agentId).events).map((e) => e.clientBudgetMs);
    return Math.min(...budgets);
}
/**
 * The hook body. Returns the stdout payload, or null for silence.
 *
 * Ordering is load-bearing in two places:
 *   1. the Node floor is checked FIRST, because everything below it may use
 *      syntax or APIs the old runtime lacks;
 *   2. the CONSENT GATE runs BEFORE `transcript_path` is opened (D56 §D19). A
 *      gate that runs after the read has already read the thing it was gating.
 */
async function hookBody(ctx, budgetMs, hookStartedAt) {
    const raw = await ctx.readStdin();
    const input = parseHookInput(raw);
    if (input === null)
        return null;
    // `repoKey` is passed per call rather than captured, because the three
    // session-keyed states can fire BEFORE a project has been resolved at all —
    // `unsupported_runtime` fires before anything else runs. Only
    // `capture_confirmed` needs one, and only it supplies one.
    const notice = (state, repoKey = null) => renderNotice({
        home: ctx.home,
        sessionId: input.sessionId,
        nodeVersion: ctx.nodeVersion,
        repoKey,
        now: () => new Date(),
    }, state);
    if (!meetsNodeFloor(ctx.nodeVersion))
        return notice("unsupported_runtime");
    // --- CONSENT GATE. Nothing above this line has opened the transcript. ---
    // The null arm is not new behaviour — `isProjectAllowed(home, null)` is already
    // false, so a `cwd` outside a work tree already stopped here. It is stated
    // separately because `CR-017d` makes this value half the delivery key as well
    // as the consent key, and a key the compiler cannot prove is present is one
    // some later edit supplies a placeholder for.
    //
    // ⛔ THE GATE CHECKS `keys.consent` — THE GIT COMMON DIR (`D184 §1`).
    //
    // It is shared by a main clone and every worktree linked to it, which is the
    // whole point. Consent was keyed on `--show-toplevel`, that differs per
    // worktree, and absence means no — so an agent session inside a `git worktree`
    // captured NOTHING, silently, under the house convention (`D19`) of one
    // worktree per builder.
    //
    // ⛔⛔ AND THIS IS ONE OF FOUR SITES, ALL OF WHICH NOW AGREE. `D184 §9`: this
    // READ gate, `post_commit.ts` (the COMMIT gate), `commands/connect.ts`
    // (`grantProject`, the WRITE side and the ONLY writer of the allow list) and
    // `commands/status.ts` (`revokeProject`, the REVOKE side). If any one of them
    // keyed on the toplevel while the others used the common dir, the allow list
    // would never match: the null arm below returns silently BY DESIGN, so every
    // session in every repository would capture nothing, with no notice — strictly
    // worse than the worktree blackout this change exists to fix.
    //
    // ⚠ AND IT WOULD FAIL GREEN. The suite's fixtures hand-write `projects.json`,
    // deliberately, so every cell agrees with this gate whichever key both use —
    // the asymmetry is only visible END TO END, through the real `connect` path
    // and a real session in a real worktree. `test/consent-key-end-to-end.test.ts`
    // is that cell, and under a mutation that grants the toplevel here **135
    // existing cells stay green and only those two red**.
    //
    // ⛔ THAT CELL ASSERTS CONTENT, NOT ONLY ADMISSION, and the distinction is
    // `D184 §3`: a session admitted by this gate whose confinement root set has
    // collapsed delivers a payload of redaction markers. The request arrives, the
    // byte accounting is intact, and the content is gone. Anything asserting only
    // that a worktree session was admitted passes on an empty payload.
    //
    // ⚠ `resolveProjectKeys` is called once, not twice: the redaction root set
    // needs the common dir too, and a second resolution could disagree with the
    // one consent was checked against. It is stricter than `resolveProjectKey` in
    // one way — the common dir must also resolve and hold a `HEAD` — which fails
    // closed, silently, exactly as this gate already does.
    const keys = resolveProjectKeys(input.cwd);
    if (keys === null || !isProjectAllowed(ctx.home, keys.consent)) {
        // Unconsented is not "not connected": say nothing at all. A machine with no
        // credential says state 1 below; a repo the user declined stays silent,
        // because nagging about a decision the user already made is the tool noise
        // DX3's one-line rule exists to avoid.
        return null;
    }
    // The THREE roles that never move (`D184 §1`) — the session-state bucket
    // (`D58`/`CR-017d`), the `resolveRepoSlug` input, and a directory to run git
    // in — under the name every site below already uses for them. Renaming them
    // would be churn across a file this change has no other reason to touch, and
    // `report.ts:343` is the standing proof that the NAME is not what tells you
    // which role a site wants.
    const projectKey = keys.worktree;
    const load = loadCredential({ env: ctx.env, home: ctx.home });
    switch (load.kind) {
        case "absent":
            return notice("not_connected");
        case "wrong-class":
        case "insecure-file":
        case "unreadable":
            // Interactive verbs print four different fixes for these (§13.6). A hook
            // has one channel and a one-line budget, so they collapse to the state
            // whose fix — `vibecommit connect` — is the same for all four.
            return notice("not_connected");
        case "ok":
            break;
    }
    // --- PATH CONFINEMENT. `/cso` finding 1, HIGH. ---
    // `transcript_path` is attacker-influenced in the one way that matters: it
    // reaches a read whose result is uploaded. Confining it to the directories the
    // agents in the registry actually write transcripts to is what stops this verb
    // being a silent arbitrary-file exfiltrator. Silent refusal, per the contract.
    //
    // ⛔ THE ROOTS COME FROM THE REGISTRY, NEVER FROM `input` (`CR-183`, D164 §5).
    // The union is deliberately independent of `ctx.agentId`: the flag comes from
    // an install that may have got it wrong, and a wrong SELECTION must not be able
    // to widen the boundary — at most it picks a suboptimal redaction profile.
    //
    // ⛔ AND THE FILE GATE, ADDED HERE BY `CR-193` (D177 §2). The boundary answers
    // "may this path be read"; it does not answer "is this a transcript", and
    // under Cursor's root those are different questions — `find -type f` there
    // returns 113 files and exactly ONE is a transcript. A narrowing over an
    // already-computed boundary, so it can only refuse. See `admitsTranscript`.
    if (!admitsTranscript(ctx.home, ctx.env, input.transcriptPath))
        return null;
    const url = ingestUrl(ctx.env);
    // `/cso` finding 2: a rejected override is a silent no-send, not a fallback to
    // the default. Falling back would send the credential somewhere the operator
    // did not ask for, which is the opposite of what the check is for.
    if (url === null)
        return null;
    // CR-016's bootstrap re-sent the whole file from byte 0 every time. CR-018
    // replaces it, because `later` (hold the offset) and `never` (advance past the
    // failing bytes) are both defined in terms of an offset and mean nothing
    // without one. `CR-017d` widened the key that offset is kept under to
    // `(repo, session)`; `CR-124` (W6) owns globbing
    // `<session-dir>/subagents/agent-*.jsonl` — this sends the `main` file only.
    //
    // ⚠ The attribution above said `CR-020` until `CR-020d`. It was wrong, and D76
    // says so by name: `CR-020`'s finding (D57 §DX7) is SessionEnd timing only and
    // says nothing about sub-agent files. Corrected in passing rather than left to
    // send the next reader after work that lives in another task.
    //
    // `SessionEnd` SETTLES FIRST (D57 §DX7). Every other event has a next
    // invocation to pick up a lagging write; this one does not, so bytes missed
    // here are the final turn, lost permanently.
    // ⛔ RESOLVED THROUGH THE DIALECT BEFORE EITHER BRANCH READS IT (`CR-195`,
    // D205). `input.eventName` is the agent's own spelling — Cursor sends
    // `sessionEnd`, not `SessionEnd` — and both lines below used to compare the
    // raw string against this client's vocabulary. That comparison did not fail
    // loudly for Cursor; it returned `false`, which cost the final turn every
    // session and carved no reserve.
    //
    // ⚠ Keyed on `ctx.agentId`, deliberately, and this is NOT the `CR-204`
    // root-derived selection used for redaction and delegated transcripts. The
    // event vocabulary is a property of the process that INVOKED us, and
    // `--agent=` is the value WE write into that agent's own hook config — so it
    // is the one selector that is not attacker-influenced input. `dialectBudgetMs`
    // already keys the budget off it for the same reason.
    const event = canonicalHookEvent(dialectFor(ctx.agentId), input.eventName);
    const isSessionEnd = event === SESSION_END_EVENT;
    // ⛔ ONE FIRING, ONE PROCESS — `CR-195`/U4a. Claimed BEFORE the settle, so a
    // duplicate costs nothing rather than spending the budget to discover it is
    // redundant.
    //
    // ⛔ KEYED ON THE CANONICAL EVENT, NOT `input.eventName`. The two racers do
    // not necessarily agree on the wire spelling — that is the whole shape of this
    // defect: one invocation comes from Cursor's own config and one from Claude's,
    // mapped, and they carry different `--agent=` flags. Resolving first is what
    // makes both compute the SAME key; keying on the raw string would give them
    // two keys and let both run, which is the failure this guards.
    //
    // ⚠ The raw name is the fallback for an event we could not resolve. Such an
    // invocation does almost nothing, but two of them are still two writers.
    const fireKey = {
        repoKey: projectKey,
        sessionId: input.sessionId,
        event: event ?? input.eventName,
    };
    // ⛔ `claimFiring` RETURNS `null` FOR TWO DIFFERENT REASONS, and conflating
    // them would turn this guard into a silent capture outage. One means *another
    // process holds this firing* — bow out. The other means *no lock path could be
    // built at all*, and treating that as a duplicate would refuse EVERY
    // invocation, permanently and silently.
    //
    // ⚠ It is currently unreachable — `resolveProjectKeys` returns `null` rather
    // than an empty toplevel, and the consent gate above has already returned on
    // that. It is distinguished anyway because the two errors are not the same
    // size: an unlockable firing that runs is one possible duplicate, and an
    // unlockable firing that bows out is total silence. So the lock FAILS OPEN.
    const lockable = fireLockPath(ctx.home, fireKey) !== null;
    firingClaim = claimFiring(ctx.home, fireKey, budgetMs);
    if (firingClaim === null && lockable) {
        // Another process holds this exact firing. ⛔ Silent and exit 0: there is
        // nothing to report, and a `systemMessage` here would put a line in the
        // user's turn for a duplicate they did not cause. `finish` releases nothing
        // because we hold nothing.
        return null;
    }
    const settleFor = isSessionEnd ? settleDelayMs(ctx.env, budgetMs) : 0;
    // `CR-182`. Carved OUT of the budget, never added on top — the same shape the
    // settle takes, and for the same reason: the watchdog does not move.
    //
    // ⛔ AND THE PRE-ENTRY COST IS CHARGED HERE (`CR-195/U2`, the G6 defect). The
    // send loop measures its own consumption from `settleStart`, one line below;
    // the watchdog has been running since `runHook`. The stdin read, the consent
    // gate's `git rev-parse` spawn and the credential load all happened in
    // between, and `CR-126` measured that interval at p99 392 ms — more than the
    // whole 150 ms reserve. Passing it in is what makes the reserve a reserve
    // against the deadline that can actually end the process, rather than against
    // a clock that starts later than the one holding the gun.
    const settleStart = Date.now();
    const sendBudget = sendBudgetMs(budgetMs, event, settleStart - hookStartedAt);
    const eof = settleFor > 0
        ? await settledSize(() => fileSize(input.transcriptPath), wait, settleFor)
        : fileSize(input.transcriptPath);
    if (eof === null)
        return null;
    // MEASURED, not assumed to be `settleFor`: the wait can overshoot under load,
    // and the budget cares about the time actually spent.
    const consumedMs = settleFor > 0 ? Date.now() - settleStart : 0;
    // The WIRE identity — `owner/repo` when `origin` is GitHub, `host/owner/repo`
    // for any other host, else `local:<hash>`. Required by the merged server
    // (`CR-019b`), which 400s a delta without it rather than writing a row nobody
    // can read (D57 §OV1).
    //
    // ⛔ RESOLVED EXACTLY ONCE PER HOOK (`TODOS[87]`). It spawns
    // `git remote get-url origin`, and it used to be called here AND once per
    // sub-agent file — up to nine spawns for a value that cannot change within an
    // invocation, since `projectKey` is fixed by the consent gate above. Passing
    // it down rather than re-deriving it is also what keeps the two paths from
    // ever disagreeing about which repository this is.
    const repoSlug = resolveRepoSlug(projectKey);
    // ⛔ THE ONE NEW SPAWN `CR-170` ADDS TO THIS PATH, and it is for REF MOVES,
    // not commits. `post-commit` observes commits; it cannot see a `pull`, a
    // `checkout` or a `reset --hard`, because those move a ref WITHOUT creating a
    // commit and no commit hook fires. A direct look at `HEAD` is the only record.
    //
    // ⚠ It shares `CR-169`'s spawn budget like every other probe, so a hung git
    // here is bounded and cannot defeat the watchdog. Null on an empty repository
    // (`rev-parse HEAD` exits 128 there) — a state, not an error.
    const head = headRef(projectKey);
    // Commits OBSERVED since the last delivery. Capped, with the remainder left in
    // the spool for the next hook rather than dropped.
    const spoolKey = { repoKey: projectKey, sessionId: input.sessionId };
    // ⛔ PROMOTE FIRST (`CR-195`/D208). A commit made during this session's FIRST
    // turn was recorded uncorroborated, because `Stop` fires at the end of a turn
    // and no state file existed when `post-commit` ran. By the time this hook is
    // executing, that state file is this session's own — which is exactly the
    // corroboration rung 1 requires — so the observation becomes deliverable now
    // rather than being lost. Before this line, every first-turn commit was
    // dropped: MEASURED as commit `f1608bc`, spooled nowhere.
    // ⛔ The corroboration is THIS CALL SITE: `spoolKey.sessionId` is
    // `input.sessionId`, the session whose hook is executing. See `promotePending`
    // for why a state-file test is the wrong one and fails the first turn.
    promotePending(ctx.home, spoolKey, "this-session-is-running");
    const spooled = capSpool(readSpool(ctx.home, spoolKey));
    // ⛔ REWRITES ARE THEIR OWN FILE WITH THEIR OWN CAP (`T5`). The units differ —
    // 41 bytes for a sha, 82 for an `ancestor:successor` pair — so one constant
    // sized against the other would make one of the two headers wrong.
    const rewritten = capSuccessors(readRewrites(ctx.home, spoolKey));
    // ⛔ THE REDACTION BOUNDARY, and it is NOT the consent key (`D184 §3`).
    // Resolved here rather than at the gate so the derivation's one spawn is not
    // paid by the invocations that return above without reading a byte.
    const redactionRoots = confinementRoots(keys);
    const delivery = await deliver({
        home: ctx.home,
        env: ctx.env,
        url,
        credential: load.credential,
        // The consent gate's key, reused rather than re-resolved: a second
        // `git rev-parse` could disagree with the one consent was checked against.
        repoKey: projectKey,
        repoSlug,
        sessionId: input.sessionId,
        fileKey: "main",
        // ⛔ THE PATH, so `deliver()` can derive `X-Agent` from the root that
        // contains it (`CR-204`, D177 §7). Deliberately the same expression the
        // `readBody` closure below takes, so the bytes and the producer can never
        // describe two different files.
        transcriptPath: input.transcriptPath,
        // ⛔ `sendBudget`, not `budgetMs`. The main send is the single largest
        // consumer on this path, so a reserve the loop honours and this does not
        // is one the biggest spender walks straight through (`CR-182`).
        timeoutMs: sendTimeoutMs(sendBudget, consumedMs),
        nowMs: Date.now(),
        // ⛔ THE MAIN DELIVERY ONLY. Sub-agent deliveries below leave all three
        // unset: each is its own `capture_id`, and `capture_commits`' PK is
        // `(org_id, capture_id, commit_sha)`, so attaching these to all nine
        // deliveries would admit nine legal, permanent rows for one commit — the
        // objection that killed the polling design (D154).
        head,
        // ⛔ THE WHOLE OBJECT, NOT `spooled.shas` (`T5`, `D190 §1`). The shas and
        // their rungs are only safe as a pair — `parseObservedCommits` drops the
        // ENTIRE BATCH when the two lists differ in length — and `count` is the
        // number of spool LINES consumed, which is what the 2xx truncates by. A
        // held entry is consumed without being sent, so `shas.length` is the wrong
        // number for that and passing the pieces separately is how they diverge.
        commits: spooled,
        rewrites: rewritten.pairs,
    }, eof, 
    // ⛔ THE ROOT SET, AND IT IS NOT THE VALUE THE CONSENT GATE APPROVED.
    // Those were one value until `D184`, and this line is where the difference
    // becomes observable: redaction is measured against `[worktree,
    // mainToplevel]`, never against the git common dir. If it followed the
    // consent key there, `isInside` would fail-close every file of an external
    // worktree to "outside the main clone" and hand the server a span of
    // markers — a capture that succeeds, with turn counts that look right and
    // no content in it (`D184 §3`).
    (from, to) => readSpan(input.transcriptPath, from, to, redactionRoots, ctx.home, ctx.env));
    // --- DELEGATED WORK. `CR-124`, D76. ---
    // Claude Code writes sub-agent transcripts to `<session>/subagents/`, which
    // `transcript_path` never names: ~16% of transcript volume, and the work a
    // reviewer most wants attributed. MAIN WENT FIRST, deliberately (D95) — the
    // content most likely to matter is the content most likely to fit.
    const delegated = await deliverSubagents({
        ctx,
        input,
        url,
        credential: load.credential,
        projectKey,
        redactionRoots,
        repoSlug,
        startedAt: settleStart,
        sendBudget,
    });
    // --- THE HONEST HOLE. D95, widened to `main` by `CR-182`. ---
    //
    // ⛔ AFTER EVERY SEND, AND IT CANNOT MOVE. `markSkipped` sets
    // `sentOffset = to`, so stamping first would leave `nextSpan` nothing to
    // return for any stream — it would gap the whole session and send none of it.
    //
    // ⛔ AND IT CANNOT HANG OFF `finish()`, which the signal handlers reach and
    // which must stay minimal.
    //
    // It sits here rather than inside `deliverSubagents` because that function
    // returns early when there are no delegated files at all — and the MAIN
    // transcript's gap must not be conditional on a `subagents/` directory
    // existing. `eof`, not a fresh `statSync`: the gap records what this
    // invocation COMMITTED to sending and could not, which is exactly what
    // `SubagentFile.size` is for the delegated streams.
    if (isSessionEnd) {
        stampGaps(ctx, input, projectKey, [{ fileKey: "main", size: eof }, ...delegated]);
    }
    // The three classes are decided in `policy.ts` and applied in `post.ts`. Two
    // of the four outcomes reach a human.
    //
    // `fatal`: a hook that stays silent about a revoked credential captures
    // nothing forever. `later` and `never` say nothing — a hook has one line per
    // session and spending it on a condition that resolves itself next turn is the
    // tool noise D57 §DX3 exists to avoid.
    //
    // `ok`: the fourth state (`CR-023d`), and the FIRST time this hook has ever
    // spoken on success. Its `(repo, day)` claim is what keeps it to once — no
    // "have I already said this today" check belongs here, because the atomic `wx`
    // claim already is that check, and a second one could disagree with it.
    if (delivery.kind === "attempted") {
        if (delivery.disposition === "fatal")
            return notice("credential_revoked");
        if (delivery.disposition === "ok")
            return notice("capture_confirmed", projectKey);
    }
    return null;
}
/**
 * Send whatever delegated transcripts fit in what is left of the budget.
 *
 * ## Why this is bounded and not a loop over the directory
 *
 * `entry.ts` gets ONE wall clock (DESIGN.md §13.7) and the watchdog cuts the
 * process off at `budgetMs` regardless. A real session on this machine has 27
 * sub-agent files; twenty-seven sends cannot each have a share of five seconds.
 * D95 settles the shape: one MEASURED deadline, the running elapsed handed to
 * `sendTimeoutMs` so file N gets the real remainder, and a floor below which no
 * new file is started.
 *
 * Nothing is lost by stopping early. An unattempted file's offset does not
 * advance, so the next hook picks it up — the same property `CR-018`'s failure
 * classes already rely on.
 *
 * **Except on `SessionEnd`, where there is no next hook.** There, an undelivered
 * file STAMPS A GAP (D95): the offset advances and the hole is recorded, because
 * a record that says what it could not send is honest and one that is quietly
 * short is not. That is D56 §D8's own shape, applied to the one event where
 * advance-regardless would otherwise lose the bytes silently. The stamp itself
 * is the CALLER's, not this function's (`CR-182`) — it covers the main
 * transcript too, and must therefore happen whether or not this ran.
 *
 * Serial, never `Promise.all`: each `deliver()` does load-modify-save on one
 * JSON file and claims `session.seq + 1`, so concurrent calls would lose seq
 * updates to each other and the server would read a replay.
 *
 * Returns every delegated file it DISCOVERED, attempted or not — the caller
 * stamps against that set, and an unattempted file is precisely the one most in
 * need of a hole.
 */
async function deliverSubagents(opts) {
    const { ctx, input, url, credential, projectKey, redactionRoots, repoSlug, startedAt, sendBudget } = opts;
    // ⛔ TWO MECHANISMS, NEVER BOTH AT ONCE — `CR-196`, D177 §9. Each of these
    // returns `[]` unless the CONTAINING ROOT's dialect declares its own
    // mechanism, so the concatenation is a union of two disjoint sets rather than
    // a fallback chain. Written this way so `findSubagentFiles` is byte-unchanged
    // and `CR-204`'s root-derived gating (pinned by `test/wire-agent.test.ts` G4)
    // keeps its meaning.
    const files = [
        ...findSubagentFiles(ctx, input.transcriptPath),
        ...announcedSubagentFiles(ctx, input),
    ];
    if (files.length === 0)
        return files;
    // ⚠ SKIP WHAT HAS NOTHING PENDING, BEFORE THE CAP APPLIES — and this is not an
    // optimisation, it is what stops the tail starving.
    //
    // The order is by mtime, which is STABLE: delivering a file does not touch it.
    // So a cap counting ATTEMPTS re-attempts the same eight oldest files on every
    // invocation, each returning `nothing-to-send`, and files nine and up are
    // never reached at all. Caught by the test that runs two invocations and
    // expects the second to make progress; it did not.
    //
    // Filtering on pending bytes makes the cap count WORK rather than calls, so
    // each invocation starts where the last one stopped.
    const key = { repoKey: projectKey, sessionId: input.sessionId };
    const before = loadSessionState(ctx.home, key);
    const pending = files.filter((f) => fileState(before, f.fileKey).sentOffset < f.size);
    if (pending.length === 0)
        return files;
    for (const file of pending.slice(0, MAX_SUBAGENT_FILES)) {
        const consumedMs = Date.now() - startedAt;
        if (sendBudget - consumedMs < MIN_SUBAGENT_BUDGET_MS)
            break;
        await deliver({
            home: ctx.home,
            env: ctx.env,
            url,
            credential,
            repoKey: projectKey,
            repoSlug,
            sessionId: input.sessionId,
            fileKey: file.fileKey,
            // ⛔ THE DELEGATED FILE'S OWN PATH, not the main transcript's. Each
            // sub-agent stream is its own `capture_id` and its own row; the root
            // that contains IT is what names its producer.
            transcriptPath: file.path,
            // The remainder, MEASURED. This is what keeps N files inside one budget.
            timeoutMs: sendTimeoutMs(sendBudget, consumedMs),
            nowMs: Date.now(),
        }, file.size, 
        // The SAME reader as the main transcript, so `CR-024d`'s redaction and
        // `/cso` finding 1's confinement both apply. A delegated agent reading a
        // third party's file is exactly as out-of-tree as the main thread doing it.
        (from, to) => readSpan(file.path, from, to, redactionRoots, ctx.home, ctx.env));
    }
    return files;
}
/**
 * On `SessionEnd`, record what could not be sent rather than losing it quietly.
 *
 * Covers both the files never started and the ones whose send was held: after
 * this event there is no invocation to retry either, so both are permanently
 * undelivered and both deserve the same honest hole.
 *
 * ## The MAIN transcript is one of them now — `CR-182`
 *
 * D95 scoped this to `subagents/` and its own note recorded the cost: *"the main
 * transcript's own failed send on `SessionEnd` is equally permanent and stamps
 * nothing."* That note is load-bearing rather than tidy, because the span caps
 * make the main file's remainder something a single `SessionEnd` routinely
 * cannot finish — so the widest, most-read stream was the one going quietly
 * short.
 *
 * ⚠ **WHAT THIS COSTS, stated rather than smuggled.** `stampGaps` decides on
 * `sentOffset < size` and cannot tell WHY a stream is behind, so the main
 * transcript now inherits both cases D99 §1 measured for delegated streams: a
 * `403 capture_not_approved` — which means org-approval-PENDING, i.e. later —
 * and a `401` `fatal`, whose own comment in `post.ts` says the offset does not
 * advance because *"these bytes are fine"*. On `SessionEnd` neither has a next
 * invocation to be right about, so both are written off. Whether a refusal
 * should stamp at all is `TODOS[93]`, still open and still not decided here;
 * what changed is only that it now reaches `main` as well.
 */
function stampGaps(ctx, input, projectKey, files) {
    const key = { repoKey: projectKey, sessionId: input.sessionId };
    // Re-read per file rather than once: each `deliver()` above saved, so a
    // snapshot taken before the loop would stamp gaps over work that succeeded.
    for (const file of files) {
        const session = loadSessionState(ctx.home, key);
        const current = fileState(session, file.fileKey);
        // The offset is the only thing that decides this, which is why no record of
        // what was attempted is needed: a file the loop never reached and one whose
        // send was held are both simply behind, and both are equally permanent now.
        if (current.sentOffset >= file.size)
            continue;
        saveSessionState(ctx.home, key, withFileState(session, file.fileKey, markSkipped(current, current.sentOffset, file.size)));
    }
}
/**
 * Every `agent-*.jsonl` under this session's `subagents/`, oldest first.
 *
 * **`agent-*.jsonl`, never `agent-*`.** The directory carries an
 * `agent-<id>.meta.json` beside every transcript — 636 of each on this machine,
 * exactly 1:1 — so the looser glob would double every upload and send metadata
 * as transcript content.
 *
 * **Every path is confined.** `isInsideAny(transcriptRoots(...))` gates each
 * entry before it is opened, exactly as the main transcript is gated: this adds
 * a new SET of readers to the surface `/cso` finding 1 rated HIGH, and a
 * symlinked entry in `subagents/` must not walk out of the transcript roots.
 *
 * Oldest first, because it cannot starve. Ordering by pending bytes would let a
 * small file lose every round forever; by mtime, every file reaches the front.
 *
 * A missing or unreadable directory is simply "no sub-agents" — silent, per the
 * hook contract.
 */
function findSubagentFiles(ctx, transcriptPath) {
    // ⛔ `CR-183` — THE GLOB IS THIS DIALECT'S MECHANISM, not the lane's. An agent
    // that ANNOUNCES its delegated transcript on stdin has no `subagents/` to read,
    // and running the glob against its layout would be a directory walk that can
    // only ever find nothing. Nothing parses an announced path yet, so an
    // announcing dialect delegates nothing today — stated, not disguised.
    //
    // ⛔ SELECTED BY THE CONTAINING ROOT, NOT BY `ctx.agentId` (`CR-204`,
    // D177 §7). Sub-agent LAYOUT is a property of the TRANSCRIPT, so the flag is
    // the wrong oracle for it in both directions — and both are live, not
    // theoretical. MEASURED on a no-flag install (`test/wire-agent.test.ts` G4):
    // a Codex-root transcript with a `subagents/` directory beside it had Claude's
    // glob run over it and UPLOADED what it found. The other direction is the one
    // D177 §7 names: a cross-fired hook globbing Claude's `agent-*.jsonl` under a
    // foreign root and silently finding nothing.
    //
    // ⚠ An unattributed path resolves `unknown`, and `dialectFor` falls back to
    // Claude — so it would glob. It cannot arrive here: confinement refuses
    // everything outside the union first, and `subagentsDir` returns null for
    // anything that is not a `.jsonl` anyway.
    if (dialectFor(agentForTranscript(ctx.home, ctx.env, transcriptPath)).delegatedTranscripts !==
        "discover") {
        return [];
    }
    const dir = subagentsDir(transcriptPath);
    if (dir === null)
        return [];
    const roots = transcriptRoots(ctx.home, ctx.env);
    let entries;
    try {
        entries = readdirSync(dir);
    }
    catch {
        return [];
    }
    const found = [];
    for (const entry of entries) {
        const fileKey = subagentFileKey(entry);
        if (fileKey === null)
            continue;
        const path = join(dir, entry);
        if (!isInsideAny(roots, path))
            continue;
        try {
            const stat = statSync(path);
            if (!stat.isFile() || stat.size === 0)
                continue;
            found.push({ path, fileKey: fileKey, size: stat.size, mtimeMs: stat.mtimeMs });
        }
        catch {
            // Vanished between readdir and stat. Not ours to report.
        }
    }
    return found.sort((a, b) => a.mtimeMs - b.mtimeMs);
}
/**
 * ⛔ **THE `announce` READER — the first one there has ever been.** `CR-196`,
 * D177 §9.
 *
 * `agents/types.ts` said `announce` *"has no reader yet"* from `CR-183` until
 * this function existed; that sentence is amended by this task rather than left
 * to rot. Until now a dialect declaring `announce` delegated nothing at all, so
 * `codex_cli` and `cursor` both had a discriminator whose only effect was to
 * SUPPRESS Claude's glob.
 *
 * ## ⛔ AN ANNOUNCED PATH IS INPUT, AND IS CONFINED EXACTLY AS THE GLOB'S ARE
 *
 * `findSubagentFiles` gates every entry it finds on `isInsideAny` plus the
 * `.jsonl` family test, and this gates on `admitsTranscript` — the same
 * registry-computed boundary plus the same file gate, in one call. ⚠ **Being
 * HANDED a path is not evidence about where it points.** A hook definition that
 * announced `~/.ssh/id_rsa` would otherwise get it read and uploaded under the
 * user's ingest credential, which is `/cso` finding 1 with the agent's help.
 *
 * ## Selected by the CONTAINING ROOT, like everything else since `CR-204`
 *
 * The main transcript's root names the producer, and the producer's dialect
 * says whether it announces. ⛔ Not `ctx.agentId`: no install passes the flag,
 * so a flag-gated reader would read announced paths for `claude-code` — a
 * dialect that declares `discover` and never announces anything — and ignore
 * them for the two that do.
 *
 * ## ⚠ NOT GATED ON THE EVENT NAME, and that is a decision about `D5`
 *
 * The plan's `D5` — the exact `hook_event_name` strings Cursor sends — is
 * founder-blocked and gates `CR-195`. `parseHookInput` falls back to `""` for a
 * non-string, so an unrecognised spelling is not an error but a value that
 * matches nothing; gating here on a guessed `subagentStop` spelling would make
 * this reader silently inert on the day the guess was wrong. The PRESENCE of
 * the field is the signal, and it is one the client can verify.
 *
 * ## ⚠ `M0.8` IS UNMEASURED, NOT ABSENT
 *
 * Two query forms — a path glob under the root and
 * `find ~/.cursor -type d -name subagents` — return **zero** `subagents`
 * directories on this machine. ⛔ **But no session here has ever spawned a
 * Cursor sub-agent**, so that is *"the producing event has not occurred"*, not
 * *"Cursor does not populate it."* The fixtures below it are therefore REAL IN
 * SHAPE AND SYNTHETIC IN CONTENT, and no cell claims otherwise
 * (`feedback_single_artifact_absence`).
 *
 * Returns at most one file: one `subagentStop`, one announced path. An array
 * rather than a nullable, so the caller's cap, ordering and gap-stamping treat
 * it identically to a globbed one.
 */
function announcedSubagentFiles(ctx, input) {
    const announced = input.agentTranscriptPath;
    if (announced === undefined)
        return [];
    if (dialectFor(agentForTranscript(ctx.home, ctx.env, input.transcriptPath))
        .delegatedTranscripts !== "announce") {
        return [];
    }
    // ⛔ CONFINEMENT AND THE FILE GATE, over the ANNOUNCED path — not over the
    // main transcript, which was gated separately and says nothing about this one.
    if (!admitsTranscript(ctx.home, ctx.env, announced))
        return [];
    const fileKey = announcedSubagentFileKey(basename(announced));
    if (fileKey === null)
        return [];
    try {
        const stat = statSync(announced);
        if (!stat.isFile() || stat.size === 0)
            return [];
        return [
            { path: announced, fileKey: fileKey, size: stat.size, mtimeMs: stat.mtimeMs },
        ];
    }
    catch {
        // Vanished, or never there. Silent, per the hook contract.
        return [];
    }
}
/** Size in bytes, or null if it cannot be read. */
function fileSize(path) {
    try {
        return statSync(path).size;
    }
    catch {
        return null;
    }
}
/** The porcelain record's opening line — `worktree <absolute path>`. */
const WORKTREE_LINE = "worktree ";
/**
 * The MAIN work tree of the repository whose common dir this is, or **null**.
 *
 * ## ⛔ `rev-parse --show-toplevel` CANNOT ANSWER THIS, measured
 *
 * `D184 §4` mandates `git -C <common-dir> rev-parse --show-toplevel`. Measured
 * on git 2.39.5 against real repositories, that command exits **128** —
 * *"fatal: this operation must be run in a work tree"* — for **every shape a
 * consent key takes**, because a consent key is always a git DIRECTORY and
 * `--is-inside-work-tree` is `false` inside one:
 *
 * | `-C` | `--show-toplevel` |
 * |---|---|
 * | `<main>/.git` (main clone, and every worktree linked to it) | ⛔ ec 128 |
 * | `<repos>/project.git` (bare) | ⛔ ec 128 |
 *
 * Implemented literally, "a failure means no second root" would fire 100% of
 * the time: the set would be the singleton it is today, forever, and a
 * main-clone file read from a worktree session would come back a marker. The
 * whole change would pass its own tests while doing nothing.
 *
 * ## What answers instead, and why it is not a guess
 *
 * `git worktree list --porcelain` DOES run from a git dir and from a bare
 * directory, and its FIRST record is the main work tree. Bare repositories say
 * so in the record itself — `bare`, with no work tree of their own.
 *
 * ⛔ **The answer is then validated by CONTENT, never trusted by position:**
 * `realpath(<candidate>/.git)` must BE the consented common dir. That check is
 * independently fatal to every wrong answer this could produce — a bare repo
 * (`<repos>/.git` does not exist), a linked worktree returned first by some
 * future git (its `.git` is a FILE, so the realpath is the file, not the common
 * dir), a submodule work tree (same). `D184 §4`'s hazard is what it is for: in a
 * worktree of a bare repo the common dir is `…/repos/project.git`, whose parent
 * is **the folder holding every other repository on the machine**, and a root
 * derived by stripping a suffix would transmit every sibling repo's file
 * contents verbatim.
 *
 * Every failure yields NO SECOND ROOT. Never a fallback, never a parent, never a
 * suffix strip.
 */
function mainWorkTree(commonDir) {
    const out = gitProbe(commonDir, ["worktree", "list", "--porcelain"]);
    if (out === null)
        return null;
    const record = [];
    for (const line of out.split("\n")) {
        if (line === "")
            break;
        record.push(line);
    }
    // A BARE repository HAS no work tree, and git says so in the record itself.
    if (record.includes("bare"))
        return null;
    const first = record[0];
    if (first === undefined || !first.startsWith(WORKTREE_LINE))
        return null;
    const candidate = first.slice(WORKTREE_LINE.length);
    if (!isAbsolute(candidate))
        return null;
    try {
        return realpathSync(join(candidate, ".git")) === commonDir ? candidate : null;
    }
    catch {
        return null;
    }
}
/**
 * ⛔ **The redaction confinement ROOT SET — `D184 §3`.**
 *
 * ```
 * isInsideAny([worktree, mainToplevel], candidate)
 * ```
 *
 * ## Why it is a set, and why the common dir is not in it
 *
 * `D184` moved the consent key to the git common dir so that a session inside a
 * `git worktree` is admitted at all. ⛔ **The confinement root MUST NOT follow
 * it there.** `isInside` realpaths both sides and fail-closes anything it cannot
 * place to *outside* — which here means REDACT — so a root at `<main>/.git`
 * would judge every file of an external worktree to be outside the main clone
 * and replace its `content`, `oldString`, `newString` and `structuredPatch` with
 * markers. **The capture still succeeds. The turn counts still look right. The
 * content is gone**, and a test asserting *"worktree sessions capture now"*
 * passes on an empty payload.
 *
 * Two roots, because both are genuinely the user's own tree: the worktree the
 * session is running in, and the main clone it was cut from — a builder in a
 * worktree reads the main clone's files constantly.
 *
 * ## ⛔ The `paths.ts:487-489` prohibition, answered — `D184 §5`
 *
 * > *"`roots` comes from the REGISTRY. It must never be derived from input."*
 *
 * **That prohibition is about PROVENANCE, and both members have the right one.**
 * The named hazard is *anything on hook stdin* — attacker-supplied. Neither of
 * these is: `keys` can only be produced by `resolveProjectKeys`, which is git's
 * own answer about the directory the session runs in; `mainToplevel` is git's
 * answer about the repository **the consent gate already approved**, and it is
 * content-validated by `mainWorkTree` above. The worktree root has exactly the
 * same provenance and has been used this way since `CR-024d`.
 *
 * ⚠ **Provenance is the whole argument, so this code preserves it:** nothing
 * here is read from stdin, the derivation is validated by content, and a failure
 * yields no second root rather than a fallback. An empty set would refuse
 * everything (`paths.ts:491-492`), which is the correct direction — but this
 * function cannot return one, because `keys.worktree` is always a member.
 *
 * ⚠ The dedup is cosmetic. `isInsideAny` over a repeated root is a union with
 * itself; it is dropped so that a main-clone session reads as the single root it
 * has always had, and so a cell asserting "no second root" is asserting
 * something.
 */
export function confinementRoots(keys) {
    const main = mainWorkTree(keys.consent);
    return main === null || main === keys.worktree ? [keys.worktree] : [keys.worktree, main];
}
/**
 * Read `[from, to)` of the transcript, REDACT it, and compress it.
 *
 * The path is already confined to the Claude Code transcript root by the caller
 * (`/cso` finding 1) — this function must never be handed one that is not.
 * Returns null on any failure, because a hook cannot report a read error.
 *
 * ## The one chokepoint
 *
 * This is the single place transcript bytes become a request body, which is why
 * `CR-024d`'s redaction goes HERE and nowhere else — the same discipline
 * `post.ts` applies to `expose()`: one call site, greppable, reviewable. Any
 * future path that reads transcript bytes for upload must come through here or
 * it silently bypasses the confidentiality boundary.
 *
 * `redactSpan` is length-preserving BY CONTRACT (see `redact.ts`), which the
 * server's offset accounting depends on — so the compressed body still covers
 * exactly `[from, to)`.
 *
 * ## ⛔ The SCRUBBER is chosen HERE, from the path, and never from `ctx.agentId`
 *
 * `CR-185`, D164 §5. This function knows the file it is about to read, so it is
 * the one place that can answer *which registry root contains it* — and a
 * caller therefore cannot pick the wrong profile for a file it hands over. The
 * flag is not consulted: both no-flag install paths resolve to `claude-code`,
 * and running Claude's key set over a Codex record redacts NOTHING.
 *
 * ⚠ **`home` and `env` are here for that lookup and nothing else.** They are
 * passed rather than read from the process for the reason `paths.ts` states: a
 * module that reads the real HOME cannot be tested without touching the
 * developer's own transcripts.
 *
 * ## ⛔ `projectRoots` is a SET, and the consent key is not in it
 *
 * `D184 §3`. It was one string — the consented toplevel — while the consent key
 * and the confinement boundary were the same value. They are not any more:
 * `confinementRoots` above builds `[worktree, mainToplevel]` and the git common
 * dir the consent gate approved is deliberately absent from it. A single-element
 * set is the ordinary main-clone case and behaves exactly as the old parameter
 * did.
 *
 * EXPORTED for `connect`'s test capture (`CR-025`), which reads a transcript on
 * a path the hook never takes. It reuses this rather than opening one itself,
 * because a second reader would bypass both the confinement and the redaction —
 * exactly what the chokepoint note above warns about.
 */
export function readSpan(path, from, to, projectRoots, home, env) {
    let fd;
    try {
        fd = openSync(path, "r");
        const buf = Buffer.alloc(to - from);
        const read = readSync(fd, buf, 0, buf.length, from);
        const raw = read === buf.length ? buf : buf.subarray(0, read);
        return zstdCompressSync(redactSpan(raw, projectRoots, rulesForTranscript(home, env, path)).bytes);
    }
    catch {
        return null;
    }
    finally {
        if (fd !== undefined) {
            try {
                closeSync(fd);
            }
            catch {
                // Nothing useful to do, and nothing may be said.
            }
        }
    }
}
//# sourceMappingURL=entry.js.map