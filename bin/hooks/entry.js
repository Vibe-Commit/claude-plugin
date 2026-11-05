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
import { closeSync, existsSync, openSync, readSync, rmSync, statSync, utimesSync, writeSync, } from "node:fs";
import { basename, dirname } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { grantsUnreadable, hasAnyConsent, isCaptureAllowed, isLocalSlug, normalizeSlug } from "../consent.js";
import { endingSoon, noteCredentialExpiry } from "../credential_meta.js";
import { loadCredential } from "../credential.js";
import { EXIT } from "../exit.js";
import { headRef, onceRepoSlug, onceStrictRepoSlug } from "../git.js";
import { redactSpan, rulesForTranscript } from "../redact.js";
import { authCommandFor, connectCommandFor } from "../install.js";
import { installOnce, sessionStartPayload } from "./session_start.js";
import { credentialFingerprint, deliver, ingestUrl } from "../post.js";
import { FOLDER_REPOSITORY_FORBIDDEN, markSkipped } from "../policy.js";
import { dialectIsolates, evidenceSpecFor, findSubagentTranscripts, isolationOf, listTargetRecords, pastCursorOf, redactionScopeFor, resolveTargets, stopKeyOf, stopTarget, } from "../session_targets.js";
import { readSpoolUnion } from "../spool_union.js";
import { fileState, loadSessionState, pruneDeliveredEndHold, saveSessionState, withFileState } from "../state.js";
import { SESSION_END_EVENT, settleDelayMs, settledSize, } from "./session_end.js";
import { admitsTranscript, agentForTranscript, canonicalHookEvent, dialectFor, } from "../agents/registry.js";
import { claimFiring, claimSessionWriter, fireLockPath, SESSION_SCOPE, STALE_MARGIN_MS } from "./fire_lock.js";
import { announcedSubagentFileKey, subagentFileKey, } from "../paths.js";
import { resolveProjectKeys } from "../project.js";
export { confinementRoots } from "../project.js";
import { startSpawnBudget } from "../spawn_budget.js";
import { turnStart } from "../pending_bound.js";
import { recordInferredSkipped } from "../inferred_tally.js";
import { pruneOrphanPending } from "../pending_prune.js";
import { pendingModeFor, promotePending, pruneExpiredInferred, readPending } from "../spool.js";
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
export function wait(ms) {
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
 * ⚠ **Since `CR-228` the reserve pays for a HOLD record too.** A held stream is
 * no longer stamped, but `SessionState.endHold` is written for it — and a hook
 * cut off before that write leaves the bytes held with nothing saying the
 * session ended owing them, which `status` cannot see. Same reserve, same cost.
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
const heldClaims = [];
/** Idempotent, and never throws: the hook contract forbids saying anything. Releases EVERY lock this process holds. */
function releaseFiring() {
    const claims = heldClaims.splice(0, heldClaims.length);
    for (const claim of claims) {
        try {
            claim.release();
        }
        catch {
            // A lock we could not release goes stale on its own; the bound is derived
            // from the budget precisely so a lost release costs one invocation, once.
        }
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
 *   2. CONSENT runs BEFORE `transcript_path` is opened (D56 §D19). A gate that
 *      runs after the read has already read the thing it was gating. Since any-folder
 *      capture the question is no longer "is the one repo the turn ended in granted?"
 *      but "has this machine granted anything at all" (`hasAnyConsent`), asked before
 *      the read, and then, per target, "is THIS repo (or folder) granted"
 *      (`isCaptureAllowed`), asked by the resolver. A turn that ended in a folder that
 *      is not a work tree no longer ends the hook; the session's own records may name
 *      granted repos, and the resolver decides which.
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
    const notice = (state, repoKey = null, rejected, endsAt, cloneKey, account) => renderNotice({
        home: ctx.home,
        sessionId: input.sessionId,
        nodeVersion: ctx.nodeVersion,
        repoKey,
        ...(cloneKey === undefined ? {} : { cloneKey }),
        // State 1 names the channel's `connect` (the same rule as state 2's `auth`): a plugin-only machine has no `vibecommit` on PATH.
        ...(state === "not_connected" ? { connectCommand: connectCommandFor(ctx.env, ctx.selfPath ?? "") } : {}),
        // State 10: the epoch keys its once-per-epoch claim; the count is the sentence.
        ...(account === undefined ? {} : { accountEpoch: account.epoch, unnamedOwners: account.owners, unnamedRepos: account.repos }),
        now: () => new Date(),
        // `11A`: states 2 and 5 carry a credential. The command is the channel's, and the claim is
        // keyed by the credential, so replacing it re-arms the message.
        ...(rejected === undefined
            ? {}
            : {
                authCommand: authCommandFor(ctx.env, ctx.selfPath ?? ""),
                fingerprint: credentialFingerprint(rejected),
            }),
        ...(endsAt === undefined ? {} : { endsAt }),
    }, state);
    if (!meetsNodeFloor(ctx.nodeVersion))
        return notice("unsupported_runtime");
    // ⛔ THE EVENT IS RESOLVED HERE, AHEAD OF THE GATE (0.7.0, eng review D3 · A) — it used to be resolved after
    // the transcript confinement check, inside the path that reads and sends the file. `SessionStart` must never
    // reach that path: it branches off to its own handler, which installs git hooks and says so, opens no
    // transcript and makes no request. Keyed on `ctx.agentId` for the reason the comment further down gives.
    const event = canonicalHookEvent(dialectFor(ctx.agentId), input.eventName);
    if (event === "SessionStart") {
        return sessionStartPayload({
            agentId: ctx.agentId,
            env: ctx.env,
            home: ctx.home,
            selfPath: ctx.selfPath ?? "",
            cwd: input.cwd,
            notice,
            // The one bounded GET is limited by what is left of this hook's own wall clock as well as by its 1,000 ms.
            budgetLeftMs: () => budgetMs - (Date.now() - hookStartedAt),
        });
    }
    // --- WHAT DOES THIS SESSION BELONG TO? (any-folder capture, R1 · R2 · R5) ---
    //
    // This replaces the consent gate that decided ONE target from the cwd the turn ENDED in. That cwd is wrong for most sessions:
    // Claude Code's Bash tool resets the shell to the launch folder, so 93% of turn-ends were in a parent folder that is not a
    // work tree, and the old gate returned null, silently, for every one of them (measured, 154 hooks, 143 in the parent).
    // `session_targets.resolveTargets` now decides, from the turn-end folder AND what the session's own records name, which
    // granted repos (and, only at the end of a repo-free session, which granted folder) this session's bytes go to. The old
    // single-target derivation is DELETED here, not kept beside it (A4: two ways to do one task).
    //
    // ⛔ NOTHING IS READ FOR A MACHINE THAT HAS GRANTED NOTHING. `hasAnyConsent` is checked before a transcript is opened or a byte
    // of state is written: widening what a hook reads must never widen WHO it reads for.
    //
    // ⛔ The turn-end repo is still resolved ONCE here (`resolveProjectKeys`), for the notices that name it and for Cursor's
    // first-`Stop` install; consent for it is the resolver's call, through the same `isCaptureAllowed`.
    const keys = resolveProjectKeys(input.cwd);
    const slugOf = keys === null ? null : onceRepoSlug(keys.worktree);
    if (!hasAnyConsent(ctx.home))
        return null;
    // The turn-end repo's OWN consent, decided exactly where the old gate decided it, before anything touches the transcript. It
    // no longer ends the hook (another repo the session named may be granted); it decides the two things that were always tied
    // to it. ⛔ THIS IS THE SAME `isCaptureAllowed` (one admission decision, and a slug thunk that spawns only when asked).
    const turnEndAllowed = keys !== null && slugOf !== null && isCaptureAllowed(ctx.home, keys, slugOf);
    // State 9 (0.7.0, spec review R3-14): an unreadable `grants.json` is the one denial a hook can say out loud, once per machine
    // and day, and it must come from here because the plugin channel and Cursor never register `SessionStart`. Only for a repo
    // this client WOULD have captured (a remote, so not `local:`), never for a folder that is not a work tree. With the file
    // unreadable every slug-bearing repo is denied, so no target could exist and nothing is lost by saying so now.
    if (!turnEndAllowed && keys !== null && slugOf !== null && grantsUnreadable(ctx.home) && !isLocalSlug(slugOf())) {
        return notice("grants_unreadable");
    }
    // ⛔ CURSOR'S FIRST-`Stop` INSTALL (0.7.0, Open Question 1). `sessionStart` was only READ out of the shipped bundle (STATIC,
    // NOT OBSERVED) and has no field a user sees, so the same marker-gated, plain-write-only install also runs on a Cursor
    // `stop`, and its one notice rides this hook's payload below. Once per clone either way. Where the gate always put it:
    // before the transcript, the credential and the network.
    const firstStop = ctx.agentId === "cursor" && event === "Stop" && turnEndAllowed && keys !== null
        ? installOnce({ env: ctx.env, home: ctx.home, selfPath: ctx.selfPath ?? "" }, keys)
        : null;
    // --- PATH CONFINEMENT. `/cso` finding 1, HIGH. ---
    // `transcript_path` is attacker-influenced in the one way that matters: it reaches a read whose result is uploaded.
    // ⛔ THE ROOTS COME FROM THE REGISTRY, NEVER FROM `input` (`CR-183`, D164 §5), independent of `ctx.agentId`, and the file gate
    // (`CR-193`, D177 §2) narrows them. It can only refuse. Silent refusal, per the contract.
    if (!admitsTranscript(ctx.home, ctx.env, input.transcriptPath))
        return null;
    const url = ingestUrl(ctx.env);
    // `/cso` finding 2: a rejected override is a silent no-send, not a fallback to the default.
    if (url === null)
        return null;
    // `SessionEnd` SETTLES FIRST (D57 §DX7): every other event has a next invocation to pick up a lagging write; this one does
    // not. Resolved through the dialect (`CR-195`, D205): Cursor sends `sessionEnd`.
    const isSessionEnd = event === SESSION_END_EVENT;
    // --- TWO LOCKS, and they are different questions (O5). ---
    //
    // 1. `claimFiring`: "is this exact firing already running?" ONE FIRING, ONE PROCESS (`CR-195`/U4a): claimed BEFORE the settle
    //    so a duplicate costs nothing; keyed on the canonical event; the loser BOWS OUT. It lives beside the turn-end repo's state
    //    exactly as before, or beside the turn-end folder when the turn ended outside any work tree. ⚠ `claimFiring` returns
    //    `null` for two reasons (held by another, or no lock path at all) and only the first may bow out: an unlockable firing
    //    FAILS OPEN, because bowing out of every invocation would be a total silent outage.
    // 2. `claimSessionWriter`: "is another writer touching THIS SESSION right now?": ONE LOCK PER `sessionId`, whatever repo each
    //    writer stands in, serialising the target record, every ledger and every spool against Stop, PreCompact, SessionEnd,
    //    `finalize` and `backfill`. A different event WAITS inside this hook's own budget and gives up with `null` (its bytes ride
    //    the next firing or the idle drain), never holding the watchdog hostage.
    const fireKey = {
        repoKey: SESSION_SCOPE,
        sessionId: input.sessionId,
        event: event ?? input.eventName,
    };
    const lockable = fireLockPath(ctx.home, fireKey) !== null;
    const firing = claimFiring(ctx.home, fireKey, budgetMs);
    if (firing === null && lockable) {
        // Another process holds this exact firing. ⛔ Silent and exit 0: a `systemMessage` here would put a line in the user's turn
        // for a duplicate they did not cause. `finish` releases nothing because we hold nothing.
        return null;
    }
    if (firing !== null)
        heldClaims.push(firing);
    const writer = await claimSessionWriter(ctx.home, input.sessionId, {
        staleAfterMs: budgetMs + STALE_MARGIN_MS,
        deadlineAtMs: hookStartedAt + Math.floor(budgetMs * WRITER_WAIT_FRACTION),
        wait,
    });
    if (writer === null)
        return null;
    heldClaims.push(writer);
    const settleFor = isSessionEnd ? settleDelayMs(ctx.env, budgetMs) : 0;
    // `CR-182`. Carved OUT of the budget, never added on top. ⛔ AND THE PRE-ENTRY COST IS CHARGED HERE (`CR-195/U2`, the G6
    // defect): the stdin read, the gate's spawn, the credential load AND NOW the writer-lock wait all happened between the
    // watchdog starting and this line, and the reserve must be measured against the clock that can actually end the process.
    const settleStart = Date.now();
    const sendBudget = sendBudgetMs(budgetMs, event, settleStart - hookStartedAt);
    const eof = settleFor > 0
        ? await settledSize(() => fileSize(input.transcriptPath), wait, settleFor)
        : fileSize(input.transcriptPath);
    if (eof === null)
        return null;
    // MEASURED, not assumed to be `settleFor`: the wait can overshoot under load, and the budget cares about the time spent.
    const consumedMs = settleFor > 0 ? Date.now() - settleStart : 0;
    const resolution = resolveTargets({
        home: ctx.home,
        env: ctx.env,
        sessionId: input.sessionId,
        transcriptPath: input.transcriptPath,
        turnEndCwd: input.cwd,
        mode: isSessionEnd ? "end" : "turn",
        nowMs: Date.now(),
        // ⛔ The RESOLVER gets a STRICT thunk (C17 #13b): `slugOf` above falls back to `local:<hash>` on a timeout, and what the resolver is given
        // becomes the target's sticky identity. The consent gate keeps `slugOf`.
        ...(keys !== null && slugOf !== null ? { known: { keys, slugOf: onceStrictRepoSlug(keys.worktree) } } : {}),
    });
    if (resolution.targets.length === 0) {
        // Nothing granted was named (R8 · D11 · B): the hook stays SILENT, as it always was for an unconsented repo. A repo or
        // folder the session named that nobody decided about is recorded BY NAME for `vibecommit status` to list.
        //
        // But D22 says ANY later firing drains idle sessions, and a session that names nothing granted (common in a parent folder)
        // is exactly the firing that has the whole deadline spare. So: load the credential SILENTLY (no notice, ever: this session
        // has nothing to say), and if it is usable, spend the leftover on others' owed bytes.
        const quiet = loadCredential({ env: ctx.env, home: ctx.home });
        if (quiet.kind === "ok") {
            try {
                await drainIdleSessions({
                    ctx,
                    url,
                    credential: quiet.credential,
                    currentSessionId: input.sessionId,
                    settleStart,
                    sendBudget,
                    staleAfterMs: budgetMs + STALE_MARGIN_MS,
                });
            }
            catch {
                // A hook cannot report an error.
            }
        }
        return null;
    }
    const load = loadCredential({ env: ctx.env, home: ctx.home });
    switch (load.kind) {
        case "absent":
            return notice("not_connected");
        case "wrong-class":
        case "insecure-file":
        case "unreadable":
            // Interactive verbs print four different fixes for these (§13.6). A hook has one channel and a one-line budget, so they
            // collapse to the state whose fix, `vibecommit connect`, is the same for all four.
            return notice("not_connected");
        case "ok":
            break;
    }
    // --- ONE SESSION, N TARGETS, ONE DEADLINE (A2). ---
    // Least-recently-sent first, so a target with a 20 MB backlog cannot starve the others forever: it spends the firing, its
    // `lastSentAt` moves, and the NEXT firing serves the one that waited. Each target's own sends still honour the shared
    // deadline (`deadlineAtMs`), so the whole firing stays inside the one budget.
    const ordered = leastRecentlySentFirst(ctx.home, input.sessionId, resolution.targets);
    // ⛔ D95 STAYS, exactly as written, for the one case R14 protects: a session whose turns end in ONE granted work tree and
    // which names nothing else granted. Every other session (several targets, a target found only by evidence, a folder target)
    // has later firings that can finish it, so a shortfall at SessionEnd is OWED there, not written off (R19 · D22).
    const writeOffAtSessionEnd = ordered.length === 1 && ordered[0].kind === "repo" && resolution.turnEndSlug === normalizeSlug(ordered[0].slug);
    const deadline = settleStart + sendBudget;
    const results = [];
    for (const target of ordered) {
        const result = await deliverTarget({
            ctx,
            input,
            url,
            credential: load.credential,
            target,
            eof,
            event,
            isSessionEnd,
            settleStart,
            sendBudget,
            consumedMs: results.length === 0 ? consumedMs : Date.now() - settleStart,
            // A target reached with the deadline already spent sends nothing this firing but is still STAMPED at SessionEnd.
            skipSend: results.length > 0 && Date.now() >= deadline,
            owedAtSessionEnd: !writeOffAtSessionEnd,
            scanned: scannedOffsets(resolution.record.scan),
            record: resolution.record,
        });
        results.push(result);
    }
    // The three classes are decided in `policy.ts` and applied in `post.ts`. Two of the four outcomes reach a human.
    //
    // `fatal`: a hook that stays silent about a revoked credential captures nothing forever. `later` and `never` say nothing: a
    // hook has one line per session and spending it on a condition that resolves itself next turn is the tool noise D57 §DX3
    // exists to avoid. `ok`: the fourth state (`CR-023d`), and its `(repo, day)` claim is what keeps it to once.
    //
    // With N targets the answer is ONE: any `fatal` wins (it is credential-wide by definition), else the first target that
    // delivered speaks. A per-target stop (C3) is never `fatal` and is never a notice: `status` names it.
    const fatal = results.find((r) => r.stopped === false && r.delivery.kind === "attempted" && r.delivery.disposition === "fatal");
    const payload = (() => {
        if (fatal !== undefined && fatal.delivery.kind === "attempted") {
            // ⛔ QUIET DURING ROTATION (`11A`). This hook loaded its credential before an `auth` replaced the file; its 401 is about a
            // credential that is already gone. If what is on disk NOW is a different credential, there is nothing to tell the user.
            const current = loadCredential({ env: ctx.env, home: ctx.home });
            if (current.kind === "ok" && credentialFingerprint(current.credential) !== credentialFingerprint(load.credential)) {
                return null;
            }
            return notice("credential_revoked", null, load.credential);
        }
        const ok = results.find((r) => r.delivery.kind === "attempted" && r.delivery.disposition === "ok");
        if (ok === undefined || ok.delivery.kind !== "attempted")
            return null;
        // `CR-234d` (12A): a 2xx carries where the credential stands (`X-Credential-Expires`). Remember it in the SIDECAR (never in
        // `credentials.json`, which a hook must not rewrite, R10) and, from 14 days before the end, say so once per machine per day.
        // It outranks the positive message: that one repeats daily, this one is the only way a person learns capture will stop.
        if (ok.delivery.credentialExpires != null) {
            const meta = noteCredentialExpiry(ctx.home, ctx.env, credentialFingerprint(load.credential), ok.delivery.credentialExpires, new Date());
            const endsAt = endingSoon(meta, Date.now());
            if (endsAt !== null) {
                const ending = notice("credential_ending", null, load.credential, endsAt);
                if (ending !== null)
                    return ending;
            }
        }
        return ((firstStop?.state == null ? null : notice(firstStop.state, null, undefined, undefined, firstStop.cloneKey)) ??
            notice("capture_confirmed", ok.target.ledgerKey));
    })();
    // The leftover of the one deadline goes to sessions that have had no firing for 10 minutes (R19 · D22): never throws.
    try {
        await drainIdleSessions({
            ctx,
            url,
            credential: load.credential,
            currentSessionId: input.sessionId,
            settleStart,
            sendBudget,
            staleAfterMs: budgetMs + STALE_MARGIN_MS,
        });
    }
    catch {
        // A hook cannot report an error, and a drain that failed leaves every session exactly as it was.
    }
    return payload;
}
/**
 * How much of the hook's budget a firing may spend WAITING for another writer of the same session before it gives up. Most of it (0.8): a different event is serialised behind the holder, and the holder's own send can run to its timeout before it lets go, so a shorter
 * window would give up on exactly the overlapping Stop/SessionEnd case (`session-end-gaps` U4a). The
 * rest must still cover the settle, the send and (`SessionEnd`) the gap stamp. A waiter that gives up loses nothing: its bytes
 * ride the next firing, or the idle drain.
 */
const WRITER_WAIT_FRACTION = 0.8;
/**
 * Targets in the order they are served: the one that sent LEAST recently first (A2). `lastSentAt` is the latest successful send
 * across the target's ledger's streams, 0 for "never", so a target that has never been served goes first and a target that just
 * spent a firing on a big backlog goes last. Stable, so equal targets keep the resolver's order.
 */
function leastRecentlySentFirst(home, sessionId, targets) {
    const lastSent = (target) => {
        const state = loadSessionState(home, { repoKey: target.ledgerKey, sessionId });
        return Math.max(0, ...Object.values(state.files).map((file) => file.lastSentAt));
    };
    return targets
        .map((target, index) => ({ target, index, at: lastSent(target) }))
        .sort((a, b) => a.at - b.at || a.index - b.index)
        .map((entry) => entry.target);
}
/**
 * Deliver ONE target of ONE session: what `hookBody` used to do inline for its single repo, now per target.
 *
 *   promote and prune the target's pending commits, read its spool UNION, deliver `main`, then its sub-agents, then (on
 *   `SessionEnd`) stamp the honest hole. The order is the old one and every comment on it still holds: promote first (`CR-195`/
 *   D208), main before sub-agents (D95), the stamp AFTER every send because `markSkipped` sets `sentOffset = to`.
 *
 * ⛔ **Per target, never shared:** the ledger (`target.ledgerKey`, one per (slug, session), R5), the slug, the redaction roots
 * and the spool sources. A session that worked in two granted repos sends each its own copy through its own ledger, so neither
 * stream's offset can rewind the other's.
 */
async function deliverTarget(opts) {
    const { ctx, input, url, credential, target, event, isSessionEnd, settleStart, sendBudget, consumedMs } = opts;
    // ⛔ A FOLDER stream delivers only up to what the resolver has SCANNED (P1, A-T3 requirement b): bytes appended between the scan
    // and this read were never checked for repo evidence, and a repo they name would end the folder rule. A repo target has no such
    // limit: its bytes are its own whatever else the session named.
    // C42: a REPO copy of a dialect that isolates records may deliver past the scan cursor. Every per-record decision there is exact (the record's own
    // cwd, the path rule, the always-withheld types); the two facts the checkpoint cannot hold are learned IN-SPAN, in order (`pastCursorOf`).
    const folderCap = target.kind === "folder" ? (opts.scanned ?? {}) : undefined;
    const eof = folderCap === undefined ? opts.eof : Math.min(opts.eof, folderCap.main ?? 0);
    const baseIsolation = isolationOf(target, opts.record);
    const isolation = opts.record !== undefined && opts.scanned !== undefined && dialectIsolates(ctx.home, ctx.env, input.transcriptPath)
        ? { ...baseIsolation, past: pastCursorOf(baseIsolation, opts.scanned, { deadlineAtMs: settleStart + sendBudget }) }
        : baseIsolation;
    const sessionId = input.sessionId;
    const ledgerKey = target.ledgerKey;
    const sourceKeys = [ledgerKey, ...target.worktrees.filter((worktree) => worktree !== ledgerKey)];
    // ⛔ PROMOTE FIRST (`CR-195`/D208), for every work tree whose spool this target reads. A commit made during this session's
    // FIRST turn was recorded uncorroborated, because `Stop` fires at the end of a turn and no state file existed when
    // `post-commit` ran. The corroboration is THIS CALL SITE: `sessionId` is the session whose hook is executing.
    // ⛔ `TODOS[176]` — THE PROMOTION BOUND applies to every promotion; ⛔ `TODOS[175]` — orphan pending files are swept on Stop and
    // SessionEnd only, never from `post-commit` and never from `status`. The `TODOS[177]` follow-up (VL, 2026-10-08): the sweep's
    // return value is NOT discarded, it feeds the durable `set_aside` tally.
    for (const projectKey of sourceKeys) {
        const spoolKey = { repoKey: projectKey, sessionId: input.sessionId };
        const pendingMode = pendingModeFor(ctx.home, spoolKey);
        const bound = promotionBound(ctx.home, spoolKey, input.transcriptPath, Date.now());
        promotePending(ctx.home, spoolKey, "this-session-is-running", bound, pendingMode);
        if (event === "Stop" || isSessionEnd) {
            pruneOrphanPending(ctx.home, projectKey, Date.now());
            const prunedInferred = pruneExpiredInferred(ctx.home, projectKey, Date.now());
            if (prunedInferred.pairs > 0)
                recordInferredSkipped(ctx.home, projectKey, "pruned", Date.now(), prunedInferred.pairs);
        }
    }
    let delivery = { kind: "nothing-to-send" };
    let subagents = { files: [], held: false, deliveries: [] };
    let stopped = false;
    if (!opts.skipSend) {
        // ⛔ THE UNION, acknowledged per source (O7): commits, rewrites and inferred squashes of every work tree of this repo for this
        // session. A single-worktree target reads exactly the three calls the hook always made.
        const union = readSpoolUnion(ctx.home, sessionId, ledgerKey, target.worktrees);
        // ⛔ THE ONE NEW SPAWN `CR-170` ADDED, for REF MOVES, not commits: a direct look at `HEAD` is the only record of a `pull`,
        // `checkout` or `reset --hard`. Null on an empty repository. A FOLDER has no HEAD: no spawn.
        const head = target.kind === "repo" ? headRef(ledgerKey) : null;
        delivery = await deliver({
            home: ctx.home,
            env: ctx.env,
            url,
            credential,
            repoKey: ledgerKey,
            repoSlug: target.slug,
            sessionId,
            fileKey: "main",
            // ⛔ THE PATH, so `deliver()` can derive `X-Agent` from the root that contains it (`CR-204`, D177 §7).
            transcriptPath: input.transcriptPath,
            // ⛔ `sendBudget`, not `budgetMs`: the main send is the single largest consumer on this path (`CR-182`).
            timeoutMs: sendTimeoutMs(sendBudget, consumedMs),
            // PR 4a: WHEN THE SENDS MUST STOP. Shared by every target of the firing, so the rest waits for the next event.
            deadlineAtMs: settleStart + sendBudget,
            nowMs: Date.now(),
            byHook: true,
            // ⛔ THE MAIN DELIVERY ONLY. Sub-agent deliveries leave all three unset: each is its own `capture_id`, and
            // `capture_commits`' PK is `(org_id, capture_id, commit_sha)`, so attaching these to all of them would admit several
            // legal, permanent rows for one commit (D154).
            head,
            // ⛔ THE WHOLE OBJECT, NOT `spooled.shas` (`T5`, `D190 §1`): shas and rungs are only safe as a pair, and `count` is the
            // number of spool LINES consumed, which is what a 2xx truncates by.
            commits: union.commits,
            // E8: this target IS a granted repo (the resolver only returns granted targets); a folder has no commits to describe.
            commitFiles: target.kind === "repo",
            rewrites: union.rewrites.pairs,
            inferredRewrites: union.inferred.pairs,
            inferredGroups: union.inferred.groups,
            spoolSources: union.sources,
        }, eof, 
        // ⛔ THE ROOT SET, AND IT IS NOT THE VALUE THE CONSENT GATE APPROVED (`D184 §3`): redaction is measured against this
        // target's own roots, never against the git common dir, or `isInside` would fail-close every file of an external worktree.
        (from, to) => readSpan(input.transcriptPath, from, to, target.redactionRoots, ctx.home, ctx.env, isolation), recordCutter(input.transcriptPath));
        // C3: the server refused THIS target for good. It is `never` (the span is advanced past, never held), and it is recorded as
        // a per-target stop so the next firing does not ask again. Never credential-wide, never `fatal`.
        if (delivery.kind === "attempted" && delivery.detail?.code === FOLDER_REPOSITORY_FORBIDDEN) {
            stopTarget(ctx.home, sessionId, target, FOLDER_REPOSITORY_FORBIDDEN, Date.now());
            return { target, delivery, subagents, stopped: true };
        }
        // --- DELEGATED WORK. `CR-124`, D76. ---
        // Claude Code writes sub-agent transcripts to `<session>/subagents/`, which `transcript_path` never names: ~16% of
        // transcript volume. MAIN WENT FIRST, deliberately (D95).
        subagents = await deliverSubagents({
            ctx,
            input,
            url,
            credential,
            projectKey: ledgerKey,
            redactionRoots: target.redactionRoots,
            repoSlug: target.slug,
            startedAt: settleStart,
            sendBudget,
            byHook: true,
            ...(folderCap === undefined ? {} : { sizeCap: folderCap }),
            isolation,
        });
    }
    else {
        subagents = { files: findSubagentFiles(ctx, input.transcriptPath), held: false, deliveries: [] };
    }
    // --- THE HONEST HOLE. D95, widened to `main` by `CR-182`. ---
    // ⛔ AFTER EVERY SEND, AND IT CANNOT MOVE: `markSkipped` sets `sentOffset = to`, so stamping first would leave `nextSpan`
    // nothing to return. ⛔ And `CR-228` (`TODOS[142]`): it writes off only what nothing explains. `held` is whether ANY delivery
    // of this target ended `later`/`fatal`, or was refused by a standing stop. R19 · D22 adds the other case that is HELD, not
    // written off: `owedAtSessionEnd`, a session other than the one-target in-repo case, whose later firings can finish it.
    if (isSessionEnd) {
        stampGaps(ctx, input, ledgerKey, [{ fileKey: "main", size: eof }, ...subagents.files], endedHeld(delivery) || subagents.held || opts.owedAtSessionEnd, Date.now());
    }
    return { target, delivery, subagents, stopped };
}
/** The resolver's scanned offset per stream, for the folder cap. */
function scannedOffsets(scan) {
    return Object.fromEntries(Object.entries(scan).map(([fileKey, cursor]) => [fileKey, cursor.offset]));
}
/** A session with no firing of its own for this long is IDLE: another session's firing may finish its owed bytes (R19 · D22). */
const DRAIN_IDLE_MS = 10 * 60_000;
/** Session records one firing looks at. Examined ones move to the back of the line (their mtime moves), so none starves. */
const DRAIN_EXAMINE_MAX = 40;
/** A record whose transcript is gone and that owes nothing is forgotten after this long. */
const DRAIN_FORGET_MS = 30 * 24 * 3600_000;
/** Do not START another session with less than this left of the shared deadline: its first request could not finish. */
const DRAIN_MIN_LEFT_MS = 250;
/**
 * An owed target whose transcript is GONE (Claude Code deletes transcripts ~30 days on) can never be sent: its hold becomes the
 * honest gap now (R19 · D22), and the hold is cleared. Whatever was already delivered is untouched.
 */
function writeOffOwed(home, record, nowMs) {
    for (const target of record.targets) {
        const key = { repoKey: target.ledgerKey, sessionId: record.sessionId };
        let session = loadSessionState(home, key);
        if (session.endHold === null)
            continue;
        for (const [fileKey, eof] of Object.entries(session.endHold.eof)) {
            const current = fileState(session, fileKey);
            if (current.sentOffset < eof)
                session = withFileState(session, fileKey, markSkipped(current, current.sentOffset, eof));
        }
        saveSessionState(home, key, { ...session, endHold: null, liveAt: session.liveAt });
        void nowMs;
    }
}
/**
 * ⛔ THE IDLE-SESSION DRAIN (R19 · D22 · A). What finishes a session's unsent bytes after its LAST hook.
 *
 * Each hook run can send a few megabytes, and a session whose last hook ran with bytes still behind (a multi-repo session at
 * `SessionEnd`, a repo found late in a long one) has no next hook of its own. So any later `Stop`, `PreCompact` or `SessionEnd`
 * on this machine, AFTER its own session's targets and inside the SAME one deadline, finishes sessions that have had no firing
 * for 10 minutes: oldest first, each under THAT session's writer lock (never waited for: a busy session is skipped), consent
 * re-checked by the resolver, and its discovery continued (≤8 MiB and ≤8 roots per firing, R16), which can add repo targets.
 *
 *   - A session is RETIRED from the drain once its discovery is settled and nothing is behind: it costs a stat and moves to the
 *     back of the line. Discovery stopping never stops a repo target delivering owed bytes.
 *   - A folder decision is exactly R18's (`unknown` stays unknown here; backfill offers it); only an ALREADY-sticky folder target
 *     delivers, and only up to what was scanned.
 *   - An owed target whose transcript is gone becomes a gap then (`writeOffOwed`).
 *
 * ⛔ It spends only the LEFTOVER of the one deadline (`settleStart + sendBudget`): the deliveries below honour the same
 * `deadlineAtMs`, and no new session starts with under `DRAIN_MIN_LEFT_MS` left. Never throws: a hook cannot say anything.
 */
async function drainIdleSessions(opts) {
    const { ctx, url, credential, settleStart, sendBudget } = opts;
    const deadline = settleStart + sendBudget;
    const candidates = listTargetRecords(ctx.home)
        .filter(({ record }) => record.sessionId !== opts.currentSessionId)
        .sort((a, b) => a.mtimeMs - b.mtimeMs)
        .slice(0, DRAIN_EXAMINE_MAX);
    for (const { path, record } of candidates) {
        if (deadline - Date.now() < DRAIN_MIN_LEFT_MS)
            return;
        const now = Date.now();
        if (now - record.firedAt < DRAIN_IDLE_MS)
            continue;
        // ⛔ A record the drain cannot act on (no transcript path, a transcript gone, a path confinement refuses) must still MOVE to the
        // back of the line (C18 #7): the candidates are the oldest records by mtime, and forty of these at the front would otherwise be
        // re-examined first on every firing and starve a live owed session behind them.
        const rotate = () => {
            try {
                utimesSync(path, new Date(), new Date());
            }
            catch {
                // Ordering only.
            }
        };
        if (record.transcriptPath === null) {
            rotate();
            continue;
        }
        const transcript = record.transcriptPath;
        // ⛔ C28: A SESSION OF A DIALECT THAT CANNOT ISOLATE IS NEVER OWED (Cursor; Codex until its own isolation is built). It delivers only
        // the repo each turn ends in, on that turn's own firing; there is no later firing to finish for it and no discovery to continue, so
        // the drain neither delivers nor writes off for it. It still moves to the back of the line, and the record is forgotten on the
        // usual schedule (a session that has not fired for that long is over).
        if (!dialectIsolates(ctx.home, ctx.env, transcript)) {
            if (now - record.firedAt > DRAIN_FORGET_MS) {
                try {
                    rmSync(path);
                }
                catch {
                    // A record we could not delete is just examined again.
                }
            }
            else {
                rotate();
            }
            continue;
        }
        // ⛔ CONFINEMENT, AGAIN (`/cso` finding 1): this path was read from a state file, not handed over by a gated hook input, and it
        // reaches a read whose result is UPLOADED. A path admitted weeks ago can since have become a symlink out of the agent roots,
        // and the record is only as trustworthy as the state directory. A file that is not there is not read, so it needs no gate
        // (the write-off below touches no bytes).
        if (existsSync(transcript) && !admitsTranscript(ctx.home, ctx.env, transcript)) {
            rotate();
            continue;
        }
        const size = fileSize(transcript);
        if (size === null) {
            // ⛔ THE WRITE-OFF IS A WRITE TO THE SESSION'S LEDGERS, so it takes the session's one writer lock like every other writer
            // (C18 #6), never waiting: a session a delivery holds right now is skipped and examined on a later firing.
            const writeOff = await claimSessionWriter(ctx.home, record.sessionId, { staleAfterMs: opts.staleAfterMs, deadlineAtMs: 0, wait });
            if (writeOff === null) {
                rotate();
                continue;
            }
            try {
                writeOffOwed(ctx.home, record, now);
            }
            finally {
                writeOff.release();
            }
            if (now - record.firedAt > DRAIN_FORGET_MS) {
                try {
                    rmSync(path);
                }
                catch {
                    // A record we could not delete is just examined again.
                }
            }
            else {
                rotate();
            }
            continue;
        }
        const live = record.targets.filter((target) => record.stopped[stopKeyOf(target)] === undefined);
        const subFiles = findSubagentFiles(ctx, transcript);
        const behind = live.some((target) => {
            const state = loadSessionState(ctx.home, { repoKey: target.ledgerKey, sessionId: record.sessionId });
            return (state.endHold !== null ||
                fileState(state, "main").sentOffset < size ||
                subFiles.some((file) => fileState(state, file.fileKey).sentOffset < file.size));
        });
        if (!behind && record.settled) {
            // Retired: nothing to send and nothing left to discover. Move it to the back of the line.
            try {
                utimesSync(path, new Date(), new Date());
            }
            catch {
                // Ordering only.
            }
            continue;
        }
        const claim = await claimSessionWriter(ctx.home, record.sessionId, { staleAfterMs: opts.staleAfterMs, deadlineAtMs: 0, wait });
        // ⛔ C29 (iii): a writer is on it right now: not ours to wait for, but it MOVES to the back of the line like every other record the
        // drain cannot act on (C18 #7). Left in place, forty busy records at the front would be re-examined first on every firing.
        if (claim === null) {
            rotate();
            continue;
        }
        try {
            const resolution = resolveTargets({
                home: ctx.home,
                env: ctx.env,
                sessionId: record.sessionId,
                transcriptPath: transcript,
                turnEndCwd: null,
                mode: "turn",
                nowMs: Date.now(),
                drain: true,
            });
            const input = { sessionId: record.sessionId, transcriptPath: transcript, cwd: "", eventName: "Stop" };
            for (const target of leastRecentlySentFirst(ctx.home, record.sessionId, resolution.targets)) {
                if (deadline - Date.now() < DRAIN_MIN_LEFT_MS)
                    break;
                await deliverTarget({
                    ctx,
                    input,
                    url,
                    credential,
                    target,
                    eof: size,
                    event: null,
                    isSessionEnd: false,
                    settleStart,
                    sendBudget,
                    consumedMs: Date.now() - settleStart,
                    skipSend: false,
                    owedAtSessionEnd: false,
                    scanned: scannedOffsets(resolution.record.scan),
                    record: resolution.record,
                });
                pruneDeliveredEndHold(ctx.home, { repoKey: target.ledgerKey, sessionId: record.sessionId });
            }
        }
        finally {
            claim.release();
        }
    }
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
 * ⛔ **Only when nothing explains the shortfall (`CR-228`).** If any send this
 * loop made ended held, the files it never reached are behind because of that
 * failure, not because of the budget — and `held` is how the caller learns it.
 *
 * Serial, never `Promise.all`: each `deliver()` does load-modify-save on one
 * JSON file and claims `session.seq + 1`, so concurrent calls would lose seq
 * updates to each other and the server would read a replay.
 *
 * Returns every delegated file it DISCOVERED, attempted or not — the caller
 * stamps against that set, and an unattempted file is precisely the one most in
 * need of a hole.
 */
export async function deliverSubagents(opts) {
    const { ctx, input, url, credential, projectKey, redactionRoots, repoSlug, startedAt, sendBudget, byHook } = opts;
    // ⛔ TWO MECHANISMS, NEVER BOTH AT ONCE — `CR-196`, D177 §9. Each of these
    // returns `[]` unless the CONTAINING ROOT's dialect declares its own
    // mechanism, so the concatenation is a union of two disjoint sets rather than
    // a fallback chain. Written this way so `findSubagentFiles` is byte-unchanged
    // and `CR-204`'s root-derived gating (pinned by `test/wire-agent.test.ts` G4)
    // keeps its meaning.
    const discovered = [
        ...findSubagentFiles(ctx, input.transcriptPath),
        ...announcedSubagentFiles(ctx, input),
    ];
    const cap = opts.sizeCap;
    const files = cap === undefined ? discovered : discovered.map((f) => ({ ...f, size: Math.min(f.size, cap[f.fileKey] ?? 0) }));
    if (files.length === 0)
        return { files, held: false, deliveries: [] };
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
        return { files, held: false, deliveries: [] };
    let held = false;
    const deliveries = [];
    for (const file of pending.slice(0, MAX_SUBAGENT_FILES)) {
        const consumedMs = Date.now() - startedAt;
        if (sendBudget - consumedMs < MIN_SUBAGENT_BUDGET_MS)
            break;
        if (opts.heartbeat !== undefined && !opts.heartbeat())
            break;
        const delivery = await deliver({
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
            // PR 4a: the same origin `consumedMs` is measured from (`startedAt` is the main delivery's `settleStart`).
            deadlineAtMs: startedAt + sendBudget,
            nowMs: Date.now(),
            byHook,
            ...(opts.heartbeat === undefined ? {} : { beforeRequest: opts.heartbeat }),
        }, file.size, 
        // The SAME reader as the main transcript, so `CR-024d`'s redaction and
        // `/cso` finding 1's confinement both apply. A delegated agent reading a
        // third party's file is exactly as out-of-tree as the main thread doing it.
        (from, to) => readSpan(file.path, from, to, redactionRoots, ctx.home, ctx.env, opts.isolation ?? { kind: "repo", ownRoots: redactionRoots }, file.fileKey), recordCutter(file.path));
        deliveries.push(delivery);
        if (endedHeld(delivery))
            held = true;
    }
    return { files, held, deliveries };
}
/**
 * Did this delivery end with the failure policy KEEPING its bytes?
 *
 * `later` and `fatal` both `markHeld` (`post.ts`), and `stopped` is a `fatal`
 * from earlier in the session refusing to try. ⚠ `never` is deliberately not
 * here: it already advanced past its own span, and a server that answered `400`
 * or `413` was answering — which is D95's premise for writing the rest off.
 */
function endedHeld(delivery) {
    if (delivery.kind === "stopped")
        return true;
    return (delivery.kind === "attempted" &&
        (delivery.disposition === "later" || delivery.disposition === "fatal"));
}
/**
 * On `SessionEnd`, decide — per stream still behind — between writing it off and
 * HOLDING it, and record either way so neither is silent.
 *
 * ## The MAIN transcript is one of them — `CR-182`
 *
 * D95 scoped this to `subagents/` and its own note recorded the cost: *"the main
 * transcript's own failed send on `SessionEnd` is equally permanent and stamps
 * nothing."* That note is load-bearing rather than tidy, because the span caps
 * make the main file's remainder something a single `SessionEnd` routinely
 * cannot finish — so the widest, most-read stream was the one going quietly
 * short.
 *
 * ## ⛔ `CR-228` (`TODOS[142]`): it no longer decides on `sentOffset < size` alone
 *
 * Until `CR-228` every stream behind was written off. That overrode the failure
 * policy on the one event with no next invocation to be right about: `later`
 * (`5xx`, `429`, `403` approval-pending, no response at all) and `fatal` (`401`,
 * whose own comment in `post.ts` says *"these bytes are fine"*) both HOLD bytes
 * on purpose, and this function discarded them on a byte comparison. MEASURED in
 * `CR-227` Gate A: an unreachable endpoint, 323,147 bytes, `gapCount: 1`, exit 0,
 * nothing on stderr, zero later network calls — and `status` said `ok`.
 * (`CR-182` widened that blind spot to `main`. This docblock used to point at
 * `TODOS[93]` for the open question; D168 records that pointer as wrong.)
 *
 * A stream is now HELD — `FileState` untouched, its EOF recorded in
 * `SessionState.endHold` — when either:
 *   - its own backlog is non-empty: the policy already decided to keep it, on
 *     this turn or an earlier one; or
 *   - any delivery in THIS invocation ended held. A stream the loop never
 *     reached has no backlog to explain it, but if the sends that DID run were
 *     failing, the budget did not run out against a server that was answering.
 *
 * Otherwise it is written off as before. That remainder is exactly D95's ruling
 * — the server answered, and there was not time for every file — unchanged.
 *
 * ⭐ **A HOLD DRAINS ON RESUME — MEASURED, not assumed** (VD, `CR-227`, on the
 * real `claude` binary). `--resume <id>` and `--continue` both fire this
 * session's hooks again under the SAME `session_id`, and the resumed run's first
 * firing saw the transcript at exactly the size the previous `SessionEnd` saw.
 * So the next `Stop` loads this state, `nextSpan` returns `{ heldOffset, newEof }`,
 * and the held bytes go out in the same request as the new ones.
 *
 * ⚠ **THE TWO LIMITS, stated here rather than discovered later:**
 *   - A session that is NEVER resumed never drains — a one-shot `claude -p` is
 *     the common case. Its bytes stay held (not shed: `enforceCaps` runs only
 *     inside `markHeld`, i.e. on a FAILED send) and `status` reports them as
 *     owed (`heldAtEndForRepo`). Reported and recoverable, not delivered.
 *   - If a resume's first send FAILS and the held span is older than the
 *     backlog's 24-hour age cap, `markHeld` → `enforceCaps` sheds it as a gap,
 *     as for any held span. A resume whose first send succeeds delivers it
 *     whatever its age — `markDelivered` applies no cap.
 *
 * ⚠ `SessionEnd` cannot tell which of these is coming: its `reason` was
 * `"other"` both for a session later resumed and for one that was not. The
 * discriminator is the NEXT `SessionStart`'s `source` (`"resume"`), so nothing
 * here branches on it.
 */
function stampGaps(ctx, input, projectKey, files, 
/** A delivery in THIS invocation ended held — see `endedHeld`. */
heldThisInvocation, nowMs) {
    const key = { repoKey: projectKey, sessionId: input.sessionId };
    const owed = {};
    // Re-read per file rather than once: each `deliver()` above saved, so a
    // snapshot taken before the loop would stamp gaps over work that succeeded.
    for (const file of files) {
        const session = loadSessionState(ctx.home, key);
        const current = fileState(session, file.fileKey);
        if (current.sentOffset >= file.size)
            continue;
        // ⛔ `CR-228`: BEHIND IS NOT ENOUGH. A span the failure policy HELD — now or
        // on an earlier turn — keeps its offset, and so does every stream left
        // behind in an invocation whose own sends were held. `FileState` is left
        // exactly as the policy left it: no `markSkipped`, and no `markHeld` either,
        // whose `enforceCaps` would make this a write-off on a 24-hour fuse.
        if (heldThisInvocation || current.backlog.length > 0) {
            owed[file.fileKey] = file.size;
            continue;
        }
        // D95's case, unchanged: the server was answering and the BUDGET ran out.
        saveSessionState(ctx.home, key, { ...withFileState(session, file.fileKey, markSkipped(current, current.sentOffset, file.size)), liveAt: nowMs });
    }
    // The positive record. Written when there is a hold to state OR an old one to
    // clear — a `SessionEnd` that owes nothing must not leave a previous one's
    // claim standing, and one that never held anything need not touch the file.
    const session = loadSessionState(ctx.home, key);
    const endHold = Object.keys(owed).length > 0 ? { at: nowMs, eof: owed } : null;
    // ⭐ `TODOS[146]`: also record THAT the session ended, so `status` can tell a turn that is open because the
    // session is live from one that is open because it is over. Only for a session that has done something
    // (`seq > 0`): a SessionEnd for a session that never delivered must not mint a state file, which would
    // make it "live" to the attribution ladder.
    if (endHold !== null || session.endHold !== null || session.seq > 0) {
        saveSessionState(ctx.home, key, { ...session, endHold, endedAt: nowMs, liveAt: nowMs });
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
    // ⛔ THE ONE COPY lives in `session_targets.ts` (`findSubagentTranscripts`), shared with the evidence reader so discovery and
    // delivery can never disagree about which files are a session's. Every rule above this line (the dialect's mechanism, the root
    // that selects it, `agent-*.jsonl` and never `agent-*`, confinement of every entry) is enforced there.
    return findSubagentTranscripts(ctx.home, ctx.env, transcriptPath).map((file) => ({ ...file, fileKey: file.fileKey }));
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
export function fileSize(path) {
    try {
        return statSync(path).size;
    }
    catch {
        return null;
    }
}
/** The stream a transcript path is: `main`, or the `agent-<id>` key of a delegated file under a `subagents/` directory. */
function streamKeyOf(path) {
    if (basename(dirname(path)) !== "subagents")
        return "main";
    return subagentFileKey(basename(path)) ?? "main";
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
 * ## ⛔ `isolation` — what a TARGET's stream may contain beyond the path rule (any-folder capture)
 *
 * R6 · R17. A session that worked in N granted repos uploads N copies, so the chokepoint also knows WHOSE copy it is cutting.
 * For a REPO target, a record whose `cwd` resolves inside a work tree other than the target's is withheld (length-preserving, the
 * same markers): another repo's commands and output must not reach this repo's readers. For a FOLDER target, anything inside a
 * git work tree nested in the folder is withheld (exclusion roots). Records run from the launch folder are kept in every copy;
 * that residual (prompts and prose from the parent folder) is stated in the README and the claims register. Absent: the
 * structured-path rule alone, exactly as before.
 *
 * EXPORTED for `connect`'s test capture (`CR-025`), which reads a transcript on
 * a path the hook never takes. It reuses this rather than opening one itself,
 * because a second reader would bypass both the confinement and the redaction —
 * exactly what the chokepoint note above warns about.
 */
export function readSpan(path, from, to, projectRoots, home, env, 
/** A-T4: the target's isolation (R17 record isolation for a repo, R6 exclusion roots for a folder). Absent: structured-path redaction only. */
isolation, 
/** The stream this file is. Default: derived from the path (Claude's `subagents/agent-<id>.jsonl`); a Codex delegated file is announced, not found by directory, so its caller says. */
streamKey) {
    let fd;
    try {
        fd = openSync(path, "r");
        const buf = Buffer.alloc(to - from);
        const read = readSync(fd, buf, 0, buf.length, from);
        const raw = read === buf.length ? buf : buf.subarray(0, read);
        const spec = isolation === undefined ? undefined : evidenceSpecFor(home, env, path);
        const fileKey = streamKey ?? streamKeyOf(path);
        // C42: a read that reaches past the scan cursor first observes whatever lies between the observed bytes and its start, then each record as it is cut.
        if (spec !== undefined)
            isolation?.past?.begin(spec, path, fileKey, from, to);
        const redacted = redactSpan(raw, projectRoots, rulesForTranscript(home, env, path), isolation === undefined || spec === undefined ? undefined : redactionScopeFor(isolation, spec.cwdKeys, { fileKey, trackCalls: spec.trackCalls === true, codex: spec.codexFolders === true }), from);
        isolation?.past?.end(fileKey, to);
        return zstdCompressSync(redacted.bytes);
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
/** How much `recordCutter` reads at a time while it looks for a newline. */
const CUT_BLOCK_BYTES = 1024 * 1024;
/**
 * PR 4a — where a transcript's records end, for `deliver()` to cut a delta on.
 *
 * ⛔ IT READS BYTES TO FIND A NEWLINE AND RETURNS AN OFFSET. No byte leaves this function, so it is not a second reader of
 * transcript content in the sense `readSpan`'s chokepoint note guards: redaction has nothing to act on, and the only thing
 * that can follow from what it sees is where a cut falls. The path is the one the caller already confined.
 *
 * It THROWS on a read error rather than answering `null`: `null` means "no newline here", and `deliver()` reads that as a
 * record too large to split, which skips it. A failed read must hold the delta instead (`deliver()` catches the throw).
 */
export function recordCutter(path) {
    const withFile = (use) => {
        const fd = openSync(path, "r");
        try {
            return use(fd);
        }
        finally {
            closeSync(fd);
        }
    };
    return {
        lastBoundary: (from, limit) => withFile((fd) => {
            const buf = Buffer.alloc(Math.min(CUT_BLOCK_BYTES, Math.max(0, limit - from)));
            for (let end = limit; end > from;) {
                const start = Math.max(from, end - buf.length);
                const read = readSync(fd, buf, 0, end - start, start);
                const at = buf.subarray(0, read).lastIndexOf(0x0a);
                if (at >= 0)
                    return start + at + 1;
                end = start;
            }
            return null;
        }),
        firstBoundary: (from) => withFile((fd) => {
            const buf = Buffer.alloc(CUT_BLOCK_BYTES);
            for (let pos = from;;) {
                const read = readSync(fd, buf, 0, buf.length, pos);
                if (read === 0)
                    return null;
                const at = buf.subarray(0, read).indexOf(0x0a);
                if (at >= 0)
                    return pos + at + 1;
                pos += read;
            }
        }),
    };
}
/**
 * `TODOS[176](b)` — the promotion bound for THIS hook, computed ONLY when there is something to promote. The turn-start scan
 * is the one transcript read on the promotion path (up to 8 MiB now that it reads in chunks) and `promotePending` returns at once
 * when the session has no pending line — the usual case on every Stop — so the scan is skipped then. `scan` is a test seam.
 */
export function promotionBound(home, key, transcriptPath, nowMs, scan = turnStart) {
    if (readPending(home, key).length === 0)
        return { kind: "none" };
    return scan(transcriptPath, fileState(loadSessionState(home, key), "main").sentOffset, nowMs);
}
//# sourceMappingURL=entry.js.map