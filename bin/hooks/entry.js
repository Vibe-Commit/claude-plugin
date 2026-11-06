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
import { closeSync, existsSync, openSync, readSync, statSync, writeSync, } from "node:fs";
import { spawn } from "node:child_process";
import { basename, dirname } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { grantsUnreadable, hasAnyConsent, isCaptureAllowed, isLocalSlug, normalizeSlug } from "../consent.js";
import { endingSoon, metaFor } from "../credential_meta.js";
import { loadCredential } from "../credential.js";
import { EXIT } from "../exit.js";
import { headRef, onceRepoSlug } from "../git.js";
import { redactSpan, rulesForTranscript } from "../redact.js";
import { authCommandFor, connectCommandFor } from "../install.js";
import { installOnce, sessionStartPayload } from "./session_start.js";
import { CAPTURE_NOT_APPROVED, credentialFingerprint, deliver, ingestUrl } from "../post.js";
import { FOLDER_REPOSITORY_FORBIDDEN, markSkipped, replayDecision } from "../policy.js";
import { dialectIsolates, evidenceSpecFor, findSubagentTranscripts, isolationOf, loadTargetRecord, pastCursorOf, redactionScopeFor, stopTarget, } from "../session_targets.js";
import { readSpoolUnion } from "../spool_union.js";
import { fileState, loadSessionState, saveSessionState, withFileState } from "../state.js";
import { admitsTranscript, agentForTranscript, canonicalHookEvent, dialectFor, } from "../agents/registry.js";
import { FIRING_VERSION, MAX_FIRING_SUB_FILES, recordFiring, liveAtOf, liveStampKeys, stampLive } from "../firing.js";
import { identityDigest } from "../identity.js";
import { readUploaderStatus } from "../uploader_status.js";
import { uploaderAlive } from "./fire_lock.js";
import { announcedSubagentFileKey, sessionFileStem, sessionLivePath, sessionStatePath, subagentFileKey, } from "../paths.js";
import { resolveProjectKeys } from "../project.js";
export { confinementRoots } from "../project.js";
import { startSpawnBudget } from "../spawn_budget.js";
import { turnStart } from "../pending_bound.js";
import { recordInferredSkipped } from "../inferred_tally.js";
import { pruneOrphanPending } from "../pending_prune.js";
import { SESSION_LIVE_WINDOW_MS, pendingModeFor, promotePending, pruneExpiredInferred, readPending } from "../spool.js";
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
    // --- U6: THE HOOK RECORDS A FIRING AND RETURNS (plan §3.1). It never waits for the network again. ---
    //
    // What used to happen here (claim the firing, wait for the session's writer lock, settle, resolve targets, promote, read the spool, deliver, stamp
    // gaps, drain idle sessions) is the upload worker's now, replayed from the line this appends (`replay.ts`, `drain.ts`). The motivating incident: the
    // hook's 3 s attempt timeout abandoned requests the server then applied, which forked versions and starved the VM.
    //
    // ⛔ The hook holds NO lock. Duplicate firings (Cursor fires one event twice) are two lines, and the second is a no-op by `replayDecision`.
    const load = loadCredential({ env: ctx.env, home: ctx.home });
    if (load.kind !== "ok") {
        // Absent or unusable: write nothing and spawn nothing. The notice's old condition was `resolution.targets.length > 0`, which the hook no longer
        // computes; it is now "the turn-end repo is allowed, or the session's own record already names a target". A parent-folder session with no record
        // stays silent on its first turn, which is the quiet direction.
        const named = turnEndAllowed || (loadTargetRecord(ctx.home, input.sessionId)?.targets.length ?? 0) > 0;
        return named ? notice("not_connected") : null;
    }
    const eof = fileSize(input.transcriptPath);
    if (eof === null)
        return null;
    const identity = identityDigest({ url, env: ctx.env });
    // Liveness (plan §3.5): READ BEFORE STAMPING, so the worker can judge `pendingModeFor` as the hook saw it; then stamp `.live`, hook-only.
    const record = loadTargetRecord(ctx.home, input.sessionId);
    const stampKeys = liveStampKeys({
        isolates: dialectIsolates(ctx.home, ctx.env, input.transcriptPath),
        turnEnd: turnEndAllowed && keys !== null ? keys.worktree : null,
        recordLedgerKeys: record === null ? [] : record.targets.map((target) => target.ledgerKey),
    });
    const prior = {};
    for (const key of stampKeys) {
        const before = priorLivenessOf(ctx.home, { repoKey: key, sessionId: input.sessionId });
        if (before !== undefined)
            prior[key] = before;
    }
    const firedAt = Date.now();
    // `slug` only when step 3 got a REAL one, never the `local:` fallback: what the worker passes the resolver becomes a target's sticky identity.
    const turnEndSlug = keys !== null && slugOf !== null ? slugOf() : null;
    const firing = {
        v: FIRING_VERSION,
        at: firedAt,
        sid: input.sessionId,
        event: input.eventName,
        eof,
        transcript: input.transcriptPath,
        cwd: input.cwd,
        ...(keys === null ? {} : { keys: { worktree: keys.worktree, consent: keys.consent } }),
        ...(turnEndSlug === null || isLocalSlug(turnEndSlug) ? {} : { slug: turnEndSlug }),
        agent: ctx.agentId,
        id: identity,
        prior,
        ...(input.agentTranscriptPath === undefined ? {} : { announced: input.agentTranscriptPath }),
        ...subSizesOf(ctx, input),
    };
    recordFiring(ctx.home, input.sessionId, firing);
    // Appended FIRST, stamped second, lock read third: the worker releases THEN looks at the queue, so one side always sees the other.
    for (const key of stampKeys)
        stampLive(ctx.home, { repoKey: key, sessionId: input.sessionId }, firedAt);
    // --- NOTICES come from the worker's status file (plan §3.7): the hook cannot see this firing's outcome, only earlier ones. ---
    const status = readUploaderStatus(ctx.home, identity);
    const payload = (() => {
        // `fatal`: a hook that stays silent about a revoked credential captures nothing forever. QUIET DURING ROTATION (`11A`): only about the credential this
        // hook is about to use; if `auth` has replaced the one the worker was rejected with, there is nothing to tell the user.
        if (status?.rejected !== undefined && status.rejected.fingerprint === credentialFingerprint(load.credential)) {
            return notice("credential_revoked", null, load.credential);
        }
        // `CR-234d` (12A): the worker remembered where the credential stands in the SIDECAR; from 14 days before the end, say so once per machine per day.
        // It outranks the positive message: that one repeats daily, this one is the only way a person learns capture will stop.
        const endsAt = endingSoon(metaFor(ctx.home, credentialFingerprint(load.credential)), firedAt);
        if (endsAt !== null) {
            const ending = notice("credential_ending", null, load.credential, endsAt);
            if (ending !== null)
                return ending;
        }
        if (firstStop?.state != null) {
            const install = notice(firstStop.state, null, undefined, undefined, firstStop.cloneKey);
            if (install !== null)
                return install;
        }
        // `capture_confirmed`: one turn later, and only on a hook of the session the outcome NAMES, still claimed once per (repo, day). The copy says
        // "captured this session", so showing it in another session, possibly in a declined repo, would be false and would use up the claim.
        const stem = sessionFileStem(input.sessionId);
        if (turnEndAllowed && keys !== null && status !== null && status.outcomes.some((o) => o.session === stem && o.class === "done:delivered")) {
            return notice("capture_confirmed", keys.worktree);
        }
        return null;
    })();
    // Spawn the worker if none is alive for this identity. A failed spawn is silent and leaves the firing for the next hook.
    if (!uploaderAlive(ctx.home, identity))
        spawnWorker(ctx);
    return payload;
}
/**
 * U6b (F5, C33) — each sub-agent file's size NOW, for `Firing.sub`: what the worker may send of it when it replays this firing. The same two
 * discoveries `deliverSubagents` makes (the dialect's glob and the announced path), so a stream the delivery would send has a ceiling here. Empty
 * map when there are none (a file that appears later is the NEXT firing's). `{}` (no key) when the list is too long to record: uncapped, as before.
 * Never throws: a hook must not.
 */
function subSizesOf(ctx, input) {
    try {
        const sub = {};
        for (const file of [...findSubagentFiles(ctx, input.transcriptPath), ...announcedSubagentFiles(ctx, input)])
            sub[file.fileKey] = file.size;
        return Object.keys(sub).length > MAX_FIRING_SUB_FILES ? {} : { sub };
    }
    catch {
        return {};
    }
}
/**
 * U6 — the liveness the hook read BEFORE it stamped (plan §3.4, P2 point 4), in `Firing.prior`'s three states: a number (the later of the state
 * file's `liveAt` and the `.live` stamp), `null` (a state file exists with NO `liveAt`: what `finalize` and `backfill` leave), or `undefined` (no
 * state file at all, which reads as `first-turn`). A plain number-or-omitted map would read a resumed session as `first-turn`.
 */
function priorLivenessOf(home, key) {
    const statePath = sessionStatePath(home, key);
    if (statePath === null)
        return undefined;
    const stamped = liveAtOf(null, sessionLivePath(home, key));
    if (!existsSync(statePath))
        return stamped ?? undefined;
    return liveAtOf(loadSessionState(home, key).liveAt, sessionLivePath(home, key));
}
/**
 * U6 — spawn the detached worker (plan §3.9): `stdio: "ignore"` so the hook's pipes are not held open, `cwd: home` so it pins no worktree or temp dir, the
 * hook's own environment so `VIBECOMMIT_TOKEN` and the ingest override reach it. Node's documented background pattern. `selfPath` is `process.argv[1]`,
 * so both channels (npm and the plugin's vendored bin) respawn themselves. Never throws, never waits.
 */
function spawnWorker(ctx) {
    const self = ctx.selfPath;
    if (self === undefined || self === "")
        return;
    try {
        const child = spawn(process.execPath, [self, "__upload-worker"], { detached: true, stdio: "ignore", windowsHide: true, cwd: ctx.home, env: ctx.env });
        child.on("error", () => {
            // A worker that could not start leaves the firing for the next hook.
        });
        child.unref();
    }
    catch {
        // Silent, per the hook contract.
    }
}
/** Pure. The reason for one target from its delivery and where its main ledger stands against the `eof` it was asked to reach. */
export function targetReason(delivery, sentOffset, eof, stopped) {
    if (stopped)
        return { kind: "held", why: "folder-forbidden" };
    switch (delivery.kind) {
        case "stopped":
            return { kind: "held", why: "stopped" };
        case "no-repo":
            return { kind: "never" };
        case "nothing-to-send":
            if (delivery.why === "lock-lost")
                return { kind: "lock-lost" };
            if (delivery.why === "read-failed" || delivery.why === "unwritable")
                return { kind: "not-progressed", why: delivery.why };
            if (delivery.why === "unterminated")
                return { kind: "held", why: "unterminated" };
            return sentOffset >= eof ? { kind: "caught-up" } : { kind: "not-progressed", why: "read-failed" };
        case "attempted":
            switch (delivery.disposition) {
                case "fatal":
                    return { kind: "fatal" };
                case "never":
                    return { kind: "never" };
                case "later":
                    return delivery.detail?.code === CAPTURE_NOT_APPROVED ? { kind: "held", why: "capture-not-approved" } : { kind: "later" };
                case "ok":
                    return sentOffset >= eof ? { kind: "caught-up" } : { kind: "more-owed" };
            }
    }
}
/**
 * U4 — DELIVER ONE FIRING TO ITS RESOLVED TARGETS. The loop `hookBody` always ran inline, callable by the upload worker with a replay's
 * as-of inputs and no wall clock. Behaviour for the inline hook is unchanged: `pace.kind === "hook"` and no `asOf` is the old code.
 *
 * Order and fairness are as before: least-recently-sent target first, so a 20 MB backlog on one cannot starve the rest.
 */
export async function deliverFiring(opts) {
    const { ctx, input, resolution, pace } = opts;
    const ordered = leastRecentlySentFirst(ctx.home, input.sessionId, resolution.targets);
    // ⛔ D95 STAYS, exactly as written, for the one case R14 protects: a session whose turns end in ONE granted work tree and
    // which names nothing else granted. Every other session (several targets, a target found only by evidence, a folder target)
    // has later firings that can finish it, so a shortfall at SessionEnd is OWED there, not written off (R19 · D22).
    const writeOffAtSessionEnd = ordered.length === 1 && ordered[0].kind === "repo" && resolution.turnEndSlug === normalizeSlug(ordered[0].slug);
    const deadline = pace.kind === "hook" ? pace.settleStart + pace.sendBudget : Infinity;
    const results = [];
    for (const target of ordered) {
        const result = await deliverTarget({
            ctx,
            input,
            url: opts.url,
            credential: opts.credential,
            target,
            eof: opts.eof,
            event: opts.event,
            isSessionEnd: opts.isSessionEnd,
            pace: pace.kind === "hook" ? { ...pace, consumedMs: results.length === 0 ? pace.consumedMs : Date.now() - pace.settleStart } : pace,
            // A target reached with the deadline already spent sends nothing this firing but is still STAMPED at SessionEnd.
            skipSend: results.length > 0 && Date.now() >= deadline,
            owedAtSessionEnd: !writeOffAtSessionEnd,
            scanned: scannedOffsets(resolution.record.scan),
            record: resolution.record,
            ...(opts.asOf === undefined ? {} : { asOf: opts.asOf }),
            ...(opts.heartbeat === undefined ? {} : { heartbeat: opts.heartbeat }),
        });
        results.push(result);
        if (result.reason.kind === "lock-lost")
            break;
    }
    return results;
}
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
 * U4 — `pendingModeFor`, answered from `firing.prior` (plan §3.4, P2 point 4). `prior` keeps `pendingModeFor`'s three outcomes:
 *  - a NUMBER is the stamp the hook read before it stamped: live within the window of `firing.at` is `first-turn`, older is `stale-own`;
 *  - an explicit `null` is a state file with NO `liveAt` (what `finalize` and `backfill` leave): `stale-own`;
 *  - an ABSENT key is no state file at hook time: `first-turn`. A key the hook did not record at all (a second work tree, a parent-folder
 *    repo on its first firing) falls back to `pendingModeFor` judged at `firing.at`, never `Date.now()`, which is safe because stamps arrive in
 *    firing order.
 * A plain number-or-omitted map would read a resumed session as `first-turn` and keep a lingering-id line.
 */
export function modeFromPrior(home, key, asOf) {
    const recorded = asOf.prior[key.repoKey];
    if (recorded === null)
        return "stale-own";
    if (recorded !== undefined)
        return asOf.at - recorded <= SESSION_LIVE_WINDOW_MS ? "first-turn" : "stale-own";
    return pendingModeFor(home, key, asOf.at);
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
    const { ctx, input, url, credential, target, event, isSessionEnd, pace, asOf, heartbeat } = opts;
    // U5: a holder that lost its lock writes nothing, not even a promotion.
    if (heartbeat !== undefined && !heartbeat()) {
        return { target, delivery: { kind: "nothing-to-send", why: "lock-lost" }, subagents: { files: [], held: false, deliveries: [] }, stopped: false, reason: { kind: "lock-lost" } };
    }
    // The hook's clock, when it has one. The worker has none: `undefined` all the way down, and a fixed timeout in its place.
    const hookClock = pace.kind === "hook" ? pace : null;
    const deadlineAtMs = hookClock === null ? undefined : hookClock.settleStart + hookClock.sendBudget;
    const requestTimeoutMs = hookClock === null ? pace.timeoutMs : sendTimeoutMs(hookClock.sendBudget, hookClock.consumedMs);
    // ⛔ A FOLDER stream delivers only up to what the resolver has SCANNED (P1, A-T3 requirement b): bytes appended between the scan
    // and this read were never checked for repo evidence, and a repo they name would end the folder rule. A repo target has no such
    // limit: its bytes are its own whatever else the session named.
    // C42: a REPO copy of a dialect that isolates records may deliver past the scan cursor. Every per-record decision there is exact (the record's own
    // cwd, the path rule, the always-withheld types); the two facts the checkpoint cannot hold are learned IN-SPAN, in order (`pastCursorOf`).
    const folderCap = target.kind === "folder" ? (opts.scanned ?? {}) : undefined;
    let eof = folderCap === undefined ? opts.eof : Math.min(opts.eof, folderCap.main ?? 0);
    // ⛔ U4, TRAP 1 — A REPLAYED FIRING NEVER GOES TO `nextSpan` WITH AN `eof` BEHIND `sentOffset`: that reads as "the file was replaced" and
    // resyncs the whole session from byte 0. Compare with the file's REAL size first (`replayDecision`): a rotation delivers to the real size,
    // an already-delivered firing (a duplicate, or one older than a `finalize`) is a no-op.
    let replayNoop = false;
    if (asOf !== undefined) {
        const real = fileSize(input.transcriptPath);
        if (real === null) {
            return { target, delivery: { kind: "nothing-to-send", why: "read-failed" }, subagents: { files: [], held: false, deliveries: [] }, stopped: false, reason: { kind: "not-progressed", why: "read-failed" } };
        }
        const sent = fileState(loadSessionState(ctx.home, { repoKey: target.ledgerKey, sessionId: input.sessionId }), "main").sentOffset;
        const decision = replayDecision(sent, eof, real);
        if (decision.kind === "noop")
            replayNoop = true;
        else
            eof = decision.eof;
    }
    const baseIsolation = isolationOf(target, opts.record);
    const isolation = opts.record !== undefined && opts.scanned !== undefined && dialectIsolates(ctx.home, ctx.env, input.transcriptPath)
        ? { ...baseIsolation, past: pastCursorOf(baseIsolation, opts.scanned, deadlineAtMs === undefined ? {} : { deadlineAtMs }) }
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
        // U4: a NO-OP firing (already delivered, or a duplicate) promotes nothing: its pending lines are judged by the firing that carries them.
        if (!replayNoop) {
            // A replay judges the session's liveness as the HOOK saw it before it stamped (`firing.prior`), not by the state file the worker
            // may have since written: stamping first would flip `stale-own` to `first-turn` and keep a lingering-id line (P2 point 4).
            const pendingMode = asOf === undefined ? pendingModeFor(ctx.home, spoolKey) : modeFromPrior(ctx.home, spoolKey, asOf);
            // The skew guard stays on `Date.now()`: on `firing.at`, a prompt written after the firing would read as `future` and keep any line.
            const bound = promotionBound(ctx.home, spoolKey, input.transcriptPath, Date.now());
            promotePending(ctx.home, spoolKey, "this-session-is-running", bound, pendingMode, asOf?.at);
        }
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
        // U4: a replay carries only the commits that existed when its hook fired (the pin). A no-op firing carries none.
        const union = readSpoolUnion(ctx.home, sessionId, ledgerKey, target.worktrees, asOf?.at);
        // ⛔ THE ONE NEW SPAWN `CR-170` ADDED, for REF MOVES, not commits: a direct look at `HEAD` is the only record of a `pull`,
        // `checkout` or `reset --hard`. Null on an empty repository. A FOLDER has no HEAD: no spawn.
        const head = target.kind === "repo" ? headRef(ledgerKey) : null;
        delivery = replayNoop ? { kind: "nothing-to-send" } : await deliver({
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
            timeoutMs: requestTimeoutMs,
            // PR 4a: WHEN THE SENDS MUST STOP. Shared by every target of the firing, so the rest waits for the next event. U4: the worker has none.
            ...(deadlineAtMs === undefined ? {} : { deadlineAtMs }),
            nowMs: Date.now(),
            ...(heartbeat === undefined ? {} : { beforeRequest: heartbeat }),
            // U5: the worker sends one delta and comes back (fairness and pacing); a hook loops to its budget.
            ...(hookClock === null ? { oneDelta: true } : {}),
            // U4: a replay is not a hook. It never stamps "now"; it stamps the moment its hook fired (`liveAtMs`, merged by `max`).
            byHook: asOf === undefined && hookClock !== null,
            ...(asOf === undefined ? {} : { liveAtMs: asOf.at }),
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
            return { target, delivery, subagents, stopped: true, reason: targetReason(delivery, 0, eof, true) };
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
            startedAt: hookClock?.settleStart ?? Date.now(),
            sendBudget: hookClock?.sendBudget ?? 0,
            byHook: asOf === undefined && hookClock !== null,
            ...(asOf === undefined ? {} : { liveAtMs: asOf.at }),
            ...(heartbeat === undefined ? {} : { heartbeat }),
            ...(hookClock === null ? { unboundedTimeoutMs: requestTimeoutMs } : {}),
            // F2d: one request at a time per machine. The main delta just went; the first sub-agent request waits the floor.
            ...(hookClock === null && delivery.kind === "attempted" ? { pauseFirstMs: UNBOUNDED_PACE_FLOOR_MS } : {}),
            ...(folderCap === undefined ? {} : { sizeCap: folderCap }),
            ...(asOf?.subCap === undefined ? {} : { firingCap: asOf.subCap }),
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
    //
    // ⛔ U5, D6 — THE WORKER HAS NO BUDGET TO RUN OUT, so it never writes off what is merely BEHIND:
    //  - a step that sent one delta and has more owed (`more`) stamps NOTHING: the next step continues, and stamping here would `markSkipped` the rest
    //    of a transcript over the delta cap while the server was answering (found by cell R18: the first step reported `done` with 2 MiB written off);
    //  - the final step records what is still behind as a HOLD (`endHold`), never as a gap: behind with an answering server just keeps sending, and
    //    what the server refused (`never`), an oversize record, a deleted transcript and the backlog caps stamp their gaps where they happen.
    if (isSessionEnd) {
        const moreOwed = hookClock === null && [delivery, ...subagents.deliveries].some((d) => d.kind === "attempted" && d.more === true);
        if (!moreOwed) {
            stampGaps(ctx, input, ledgerKey, [{ fileKey: "main", size: eof }, ...subagents.files], endedHeld(delivery) || subagents.held || opts.owedAtSessionEnd || hookClock === null, Date.now(), asOf?.at);
        }
    }
    return {
        target,
        delivery,
        subagents,
        stopped,
        reason: targetReason(delivery, fileState(loadSessionState(ctx.home, { repoKey: ledgerKey, sessionId }), "main").sentOffset, eof, stopped),
    };
}
/** The resolver's scanned offset per stream, for the folder cap. */
function scannedOffsets(scan) {
    return Object.fromEntries(Object.entries(scan).map(([fileKey, cursor]) => [fileKey, cursor.offset]));
}
/**
 * U6b (F2d): THE WORKER'S PACE BETWEEN REQUESTS (D9): sleep `max(250 ms, the request's own elapsed)`, capped at 30 s. It lives here, beside the delivery loops
 * that must honour it, because ONE worker step can put several requests on the wire (the main delta, then one per sub-agent file) and pacing only
 * after the whole step let a fast server take thirteen of them back to back.
 */
export const UNBOUNDED_PACE_FLOOR_MS = 250;
export const UNBOUNDED_PACE_CAP_MS = 30_000;
export function unboundedPaceMs(elapsedMs) {
    return Math.min(UNBOUNDED_PACE_CAP_MS, Math.max(UNBOUNDED_PACE_FLOOR_MS, elapsedMs));
}
/** A session with no firing of its own for this long is IDLE: another session's firing may finish its owed bytes (R19 · D22). */
export const DRAIN_IDLE_MS = 10 * 60_000;
/** Session records one firing looks at. Examined ones move to the back of the line (their mtime moves), so none starves. */
export const DRAIN_EXAMINE_MAX = 40;
/** A record whose transcript is gone and that owes nothing is forgotten after this long. */
export const DRAIN_FORGET_MS = 30 * 24 * 3600_000;
/**
 * An owed target whose transcript is GONE (Claude Code deletes transcripts ~30 days on) can never be sent: its hold becomes the
 * honest gap now (R19 · D22), and the hold is cleared. Whatever was already delivered is untouched.
 */
export function writeOffOwed(home, record, nowMs) {
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
    const fireCap = opts.firingCap;
    const files = cap === undefined && fireCap === undefined
        ? discovered
        : discovered.map((f) => ({
            ...f,
            size: Math.min(f.size, cap === undefined ? f.size : (cap[f.fileKey] ?? 0), fireCap === undefined ? f.size : (fireCap[f.fileKey] ?? 0)),
        }));
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
    let pauseNextMs = opts.unboundedTimeoutMs === undefined ? null : (opts.pauseFirstMs ?? null);
    for (const file of opts.unboundedTimeoutMs === undefined ? pending.slice(0, MAX_SUBAGENT_FILES) : pending) {
        if (pauseNextMs !== null)
            await wait(pauseNextMs);
        const requestStartedAt = Date.now();
        const consumedMs = Date.now() - startedAt;
        if (opts.unboundedTimeoutMs === undefined && sendBudget - consumedMs < MIN_SUBAGENT_BUDGET_MS)
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
            timeoutMs: opts.unboundedTimeoutMs ?? sendTimeoutMs(sendBudget, consumedMs),
            // PR 4a: the same origin `consumedMs` is measured from (`startedAt` is the main delivery's `settleStart`).
            ...(opts.unboundedTimeoutMs === undefined ? { deadlineAtMs: startedAt + sendBudget } : {}),
            nowMs: Date.now(),
            byHook,
            ...(opts.liveAtMs === undefined ? {} : { liveAtMs: opts.liveAtMs }),
            ...(opts.heartbeat === undefined ? {} : { beforeRequest: opts.heartbeat }),
            ...(opts.unboundedTimeoutMs === undefined ? {} : { oneDelta: true }),
        }, file.size, 
        // The SAME reader as the main transcript, so `CR-024d`'s redaction and
        // `/cso` finding 1's confinement both apply. A delegated agent reading a
        // third party's file is exactly as out-of-tree as the main thread doing it.
        (from, to) => readSpan(file.path, from, to, redactionRoots, ctx.home, ctx.env, opts.isolation ?? { kind: "repo", ownRoots: redactionRoots }, file.fileKey), recordCutter(file.path));
        deliveries.push(delivery);
        if (endedHeld(delivery))
            held = true;
        pauseNextMs = opts.unboundedTimeoutMs !== undefined && delivery.kind === "attempted" ? unboundedPaceMs(Date.now() - requestStartedAt) : null;
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
heldThisInvocation, nowMs, 
/**
 * ⛔ U6b (F1): the time a REPLAY is for (`firing.at`). A worker replays a SessionEnd hours late after an outage or a backlog, and `Date.now()` there
 * stamped an ended session LIVE now (`liveAt`) and ended now (`endedAt`), so a human's commit (no env session id) became `sole_live_session` for
 * a session that ended hours ago, and every `later` retry re-stamped it. A replay stamps the hook's time: `endedAt = at`, `liveAt = max(stored, at)`.
 * Absent for an inline caller, which IS now.
 */
replayAt) {
    const key = { repoKey: projectKey, sessionId: input.sessionId };
    const at = replayAt ?? nowMs;
    const liveAtOf = (stored) => (replayAt === undefined ? nowMs : Math.max(stored ?? 0, replayAt));
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
        saveSessionState(ctx.home, key, { ...withFileState(session, file.fileKey, markSkipped(current, current.sentOffset, file.size)), liveAt: liveAtOf(session.liveAt) });
    }
    // The positive record. Written when there is a hold to state OR an old one to
    // clear — a `SessionEnd` that owes nothing must not leave a previous one's
    // claim standing, and one that never held anything need not touch the file.
    const session = loadSessionState(ctx.home, key);
    const endHold = Object.keys(owed).length > 0 ? { at, eof: owed } : null;
    // ⭐ `TODOS[146]`: also record THAT the session ended, so `status` can tell a turn that is open because the
    // session is live from one that is open because it is over. Only for a session that has done something
    // (`seq > 0`): a SessionEnd for a session that never delivered must not mint a state file, which would
    // make it "live" to the attribution ladder.
    if (endHold !== null || session.endHold !== null || session.seq > 0) {
        saveSessionState(ctx.home, key, { ...session, endHold, endedAt: at, liveAt: liveAtOf(session.liveAt) });
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
export function findSubagentFiles(ctx, transcriptPath) {
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