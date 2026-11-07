/**
 * `vibecommit finalize` — the CALLER asserts a session is over (`TODOS[146]`, VD decision 5).
 *
 * ## ⛔ THE DEFECT, AND WHY THE ANSWER IS A VERB
 *
 * The server holds the last turn of a delta as a tentative tail, because a chunk boundary is not a turn
 * boundary, and seals a turn when a following prompt opens the next one — or when the caller says the session is
 * over. A session that is never followed by another prompt (a one-shot `claude -p`, the last turn of any session
 * that is not resumed) seals NOTHING without that: no capture, no turn, no commit edge, however many commits it made.
 *
 * Since the last-turn seal release the upload worker says it for a session whose end hook fired: `SessionEnd` says
 * THIS process wrote its last record (its `reason` is `"other"` whether or not a resume follows, so the seal never
 * reads it; it reads the log and the bytes that grew after the hook instead), and the worker's seal phase and idle
 * drain call `closeSession`, the code below. This verb remains for what they cannot reach: a session killed outright
 * (no end hook fires), and a script that wants a confirmed exit code. A script that just ran `claude -p` still knows it is done.
 *
 * This verb sends that assertion as `X-Session-Final: 1` on the session's MAIN stream and keeps what the
 * server answers: `sealed` (the last turn is now recorded), `already` (nothing was left open — a repeat is
 * a no-op), or silence (an older server, which ignores the header). ⛔ Silence is NOT success, and has its
 * own exit code: a script must be able to separate a close that was confirmed from a delivery that merely hoped.
 *
 * ## What it reuses, and why it is not a second pipeline
 *
 * The same consent gate, credential, spool, pending-promotion and rewrite-spool as a `Stop` hook, so a
 * commit the hook was holding rides THIS request and binds on the turn it seals. Sub-agent streams go
 * FIRST: the server folds them into the parent turn when it seals it, so sealing before they arrive would
 * seal a poorer turn.
 *
 * ## What it refuses to do
 *
 * - Guess. `--latest` closes the ONE session that delivered in the last 24 hours and lists them when there
 *   are several — the attribution ladder's rule: ambiguity is named, never picked.
 * - Touch a session this repo never captured, or one still being written (`--force` overrides the second:
 *   closing a live session seals a turn that is not complete, and a later resume opens a new turn rather
 *   than extending it).
 * - Read anywhere but the agent's own transcript root (`admitsTranscript`, the same confinement as a hook).
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_AGENT_ID, admitsTranscript, transcriptRoots } from "../agents/registry.js";
import { BACKFILL, COMMANDS, ERRORS, FINALIZE } from "../copy/index.js";
import { renderVerbHelp } from "../verb_help.js";
import { hasAnyConsent, isCaptureAllowed } from "../consent.js";
import { authCommandFor, channelCommand, connectCommandFor } from "../install.js";
import { loadCredential } from "../credential.js";
import { EXIT } from "../exit.js";
import { onceRepoSlug, onceStrictRepoSlug } from "../git.js";
import { confinementRoots, fileSize, sendTimeoutMs, wait } from "../hooks/entry.js";
import { STALE_MARGIN_MS, claimSessionWriter } from "../hooks/fire_lock.js";
import { firingSessions, readFirings } from "../firing.js";
import { identityDigest } from "../identity.js";
import { REQUEST_TIMEOUT_MS, replayAllUnderLock } from "../replay.js";
import { FOLDER_REPOSITORY_FORBIDDEN } from "../policy.js";
import { LockLostError, dialectIsolates, resolveTargets, stopKeyOf, stopTarget } from "../session_targets.js";
import { repoSessionsDir, sessionStatePath } from "../paths.js";
import { ingestUrl } from "../post.js";
import { resolveProjectKeys } from "../project.js";
import { loadSessionState } from "../state.js";
import { renderErrorBlock, wrap } from "../term.js";
import { notAGitRepoBlock, writeFailure, writeLines } from "./context.js";
import { credentialProblem } from "./credential_problem.js";
import { SEND_BUDGET_MS, closeSession, closeSpecOf } from "../close_session.js";
/** A transcript modified this recently is a session still being written. */
const STILL_WRITING_MS = 5_000;
// U6b (found by U8's C26): the check reads a FRESH `ctx.now()`. It used the `nowMs` taken when the verb started, BEFORE the wait for the session's writer
// lock, so after a 150 s wait behind a killed worker's lock a transcript minutes old was refused as 'changed a moment ago'.
/** `--latest` considers sessions that delivered inside this window. */
const LATEST_WINDOW_MS = 24 * 60 * 60 * 1000;
/** The id becomes a filename component; keep it to what a session id is. */
const SESSION_ID = /^[A-Za-z0-9._-]{1,128}$/;
function parseArgs(argv) {
    let session = null;
    let latest = false;
    let force = false;
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === "--latest")
            latest = true;
        else if (a === "--force")
            force = true;
        else if (a === "--session") {
            const v = argv[i + 1];
            if (v === undefined)
                return null;
            session = v;
            i += 1;
        }
        else if (a.startsWith("--session="))
            session = a.slice("--session=".length);
        else
            return null;
    }
    if ((session === null) === !latest)
        return null; // exactly one of the two
    return { session, latest, force };
}
/**
 * How long the verb waits for another writer of the same session before it says so and stops. The upload worker can hold a session for one
 * IN-FLIGHT REQUEST (`REQUEST_TIMEOUT_MS`), and yields between deltas only by sleeping longer than the 20 ms poll, so the wait must outlast a
 * request or `finalize` would give up on exactly the session the worker is busy with. (It was 30 s when the longest holder was a hook.)
 */
const WRITER_WAIT_MS = REQUEST_TIMEOUT_MS + 30_000;
/** How often the verb re-stamps the session lock it holds, from a timer (F4): well inside `holderStaleMs()`. */
export const LOCK_BEAT_MS = 15_000;
/**
 * ⛔ HOW LONG THE VERB'S WRITER LOCK MAY SIT UNTOUCHED before another writer may take it from a holder presumed dead (C25).
 *
 * The verb HEARTBEATS the lock (`FireClaim.refresh`, same nonce) before every request, every delegated file, every target and every
 * root the resolver names, so what matters is the LONGEST GAP between two heartbeats, not the length of the job. That gap is one
 * request (`sendTimeoutMs(SEND_BUDGET_MS, 0)` = 36 s at most) or one root's naming (a few git calls at 5 s each, one ssh at 2 s),
 * plus the local read, redaction and compression of one delta: well under a minute. The bound is TWICE the request gap plus the
 * hook margin (76 s): slack for a slow disk without leaving a dead holder's lock in the way for long. It is stamped into the lock
 * (C18 #2), so a hook contender honours it instead of its own seven seconds, and `fire_lock.ts` caps it at ten minutes whatever
 * a file claims. It used to be the whole send budget plus the margin (62 s) with NO heartbeat, so a session that took longer than
 * that, a long backfill of a large transcript, was reclaimed while its holder was still sending, and two writers ran at once.
 */
function holderStaleMs() {
    return 2 * (sendTimeoutMs(SEND_BUDGET_MS, 0) + STALE_MARGIN_MS);
}
/** Resolver calls one `finalize` makes while discovery is still moving (each reads a bounded window). */
/**
 * A SAFETY bound on the interactive resolver loop, not a limit anyone should meet (C18 #11). The loop ends when discovery is settled or
 * a round changes nothing the resolver keeps; every round either advances a scan cursor, resolves a root, or counts a bounded failure,
 * so it is finite. A fixed 16 meant a transcript naming more than 128 repositories returned unsettled and uploaded only some targets.
 */
const RESOLVE_ROUNDS_MAX = 100_000;
/**
 * U5b — TAKE THE SESSION'S ONE WRITER LOCK, THEN REPLAY ITS UNCONSUMED FIRINGS under it. Shared by `finalize` and `backfill`, and called BEFORE
 * either reads the spool union or asks whether the session exists: after U6 the hook records a firing and writes nothing else, so a one-shot
 * session's pending commit line is promoted, and its state file created, only by a replay. The release goes into `releases` either way.
 *
 * `busy`: another writer held the session for the whole wait. `replay-stopped`: a firing was left unconsumed (see `replayAllUnderLock`), and
 * the caller must report it and send NO `final`. `replay` absent: nothing is replayed (no usable credential or ingest address yet; the caller
 * answers that its own way).
 */
export async function takeSessionLock(env, sessionId, releases, replay) {
    const claim = await claimSessionWriter(env.home, sessionId, {
        staleAfterMs: holderStaleMs(),
        deadlineAtMs: Date.now() + WRITER_WAIT_MS,
        wait,
    });
    if (claim === null)
        return { kind: "busy" };
    // ⛔ U6b (F4): A TIMER BEAT FOR THE WHOLE TIME THE VERB HOLDS THE LOCK. The replay's requests run up to `REQUEST_TIMEOUT_MS` (120 s) and
    // `replayAllUnderLock` beats only between requests, while this lock's stale bound is `holderStaleMs()` (76 s): the worker could reclaim the session
    // under a live holder and re-send the same span under a second seq. The beat is cleared with the release.
    const beat = setInterval(() => claim.refresh(), LOCK_BEAT_MS);
    beat.unref();
    releases.push(() => {
        clearInterval(beat);
        claim.release();
    });
    if (replay !== undefined) {
        const replayed = await replayAllUnderLock(replay, sessionId, claim);
        if (replayed.kind === "stopped")
            return replayed.step.kind === "lost" ? { kind: "busy" } : { kind: "replay-stopped", step: replayed.step };
    }
    return { kind: "held", held: { refresh: () => claim.refresh() } };
}
/**
 * Take the session's one writer lock (O5) and resolve every target the session names, as a session that is OVER (`end` mode, the
 * only mode that may decide a folder target). The lock is released by the caller's `releases`, after the sends. Shared by
 * `finalize` and `backfill`: one resolver loop, so a session is judged the same whichever verb closes it.
 * `busy`: another writer held the session for the whole wait.
 */
export async function resolveSessionTargets(env, sessionId, transcriptPath, known, releases, options = {}) {
    let held = options.held;
    if (held === undefined) {
        const taken = await takeSessionLock(env, sessionId, releases, options.replay);
        if (taken.kind !== "held")
            return taken;
        held = taken.held;
    }
    const lock = held;
    const heartbeat = () => lock.refresh();
    const base = {
        home: env.home,
        env: env.env,
        sessionId,
        transcriptPath,
        turnEndCwd: env.turnEndCwd,
        mode: "end",
        nowMs: env.nowMs,
        heartbeat,
        ...(known === null ? {} : { known }),
    };
    // Each call reads one bounded window AND resolves at most a bounded number of roots, so a fully-scanned transcript can still have
    // a queue of unresolved roots (the granted repo may be the last of twenty). Keep going until discovery is SETTLED, and stop
    // only when a call changed nothing the resolver keeps: not the cursors, not the queue, not the roots, not the failure counts.
    //
    // ⛔ The queue's ORDER is not progress (C21 iv): failed roots rotate to the back, so a round in which every tried root fails again
    // changes only the order. `unresolved` is compared as a SET, and a root's failure counts once per invocation (`counted`), so each
    // round either moves a cursor, resolves a root, counts a NEW failure, or the loop stops. The record keeps its rotated order.
    const progress = (r) => JSON.stringify([
        r.record.scan,
        [...r.record.unresolved].sort(),
        Object.keys(r.record.roots),
        r.record.failures,
        r.record.oversize,
        r.targets.length,
    ]);
    const counted = new Set();
    const round0 = { ...base, countedThisInvocation: counted };
    let res;
    try {
        res = resolveTargets(round0);
        for (let round = 1; round < RESOLVE_ROUNDS_MAX && !res.settled; round += 1) {
            if (!heartbeat())
                return { kind: "busy" };
            const next = resolveTargets(round0);
            const same = progress(next) === progress(res);
            res = next;
            if (same)
                break;
        }
    }
    catch (error) {
        // C25: the lock was lost while naming a root, before the resolver wrote anything. Another writer has the session: stop.
        if (error instanceof LockLostError)
            return { kind: "busy" };
        throw error;
    }
    const record = res.record;
    const targets = res.targets.filter((target) => record.stopped[stopKeyOf(target)] === undefined);
    return {
        kind: "ok",
        targets,
        scan: Object.fromEntries(Object.entries(record.scan).map(([fileKey, cursor]) => [fileKey, cursor.offset])),
        record,
        capRepos: dialectIsolates(env.home, env.env, transcriptPath),
        heartbeat,
    };
}
export async function finalize(ctx, argv) {
    const releases = [];
    try {
        return await finalizeBody(ctx, argv, releases);
    }
    finally {
        for (const release of releases) {
            try {
                release();
            }
            catch {
                // A lock that cannot be released ages out by itself.
            }
        }
    }
}
async function finalizeBody(ctx, argv, releases) {
    // `TODOS[184]`. Check-first, before `parseArgs`/anything else — the ONE change this ticket makes to
    // `finalize`. Reads and writes nothing; every other line below (`parseArgs`, session resolution, the
    // seal call, the drain loop, every exit code and receipt string) is byte-identical to 0.4.4 for any
    // `argv` that does not literally contain `--help`/`-h` (pinned by T10's differential).
    if (argv.includes("--help") || argv.includes("-h")) {
        const helpVerb = "finalize"; // an identifier, not a literal, at the writer: `copy-inline-literals` follows argument positions
        writeLines(ctx.stdout, renderVerbHelp(helpVerb));
        return EXIT.ok;
    }
    const args = parseArgs(argv);
    if (args === null) {
        writeLines(ctx.stderr, renderErrorBlock({
            kind: "bad",
            code: "FINALIZE_NEEDS_TARGET",
            what: FINALIZE.needTarget,
            why: [],
            fixLabel: FINALIZE.needTargetFix,
            fixes: [FINALIZE.commandSessionAny, COMMANDS.finalize].map((fix) => channelCommand(ctx.env, ctx.selfPath, fix)),
        }, ctx.colour));
        return EXIT.usage;
    }
    const nowMs = ctx.now().getTime();
    const stillWriting = (sessionId) => {
        writeLines(ctx.stderr, renderErrorBlock({
            kind: "bad",
            code: "FINALIZE_STILL_WRITING",
            what: FINALIZE.stillWriting,
            why: [],
            fixLabel: FINALIZE.stillWritingFix,
            fixes: [channelCommand(ctx.env, ctx.selfPath, FINALIZE.commandSessionForce(sessionId))],
        }, ctx.colour));
        return EXIT.usage;
    };
    // ANY-FOLDER (A-T3): at the three places this verb used to refuse because the folder it ran in is not the session's repo, a
    // `--session <id>` whose transcript exists is resolved by the SAME resolver the hook uses. Only `--session`: `--latest` names a
    // session through THIS repo's ledgers, so it has nothing to look up elsewhere. No targets (or no transcript) leaves the
    // ORIGINAL refusal and its exit code exactly as they were.
    // C25: the heartbeat of the session lock `resolveSessionTargets` took, handed to every `closeSession`. Absent only when no resolver
    // ran (a plain in-repo close of a session picked by `--latest`), which holds no session lock to keep.
    let heartbeat;
    // U5b: the session's lock when it was taken EARLY (before the state-file check, so a replay can create the state file). Every later
    // `resolveSessionTargets` for the same session resolves under it instead of claiming a second time (a lock is not re-entrant).
    let held;
    /** What the session's recorded firings are replayed with; `undefined` when there is no usable credential or ingest address yet (the verb answers that its own way, below, with its own exit code). */
    const replayConfig = () => {
        const replayUrl = ingestUrl(ctx.env);
        if (replayUrl === null || loadCredential({ env: ctx.env, home: ctx.home }).kind !== "ok")
            return undefined;
        return { home: ctx.home, env: ctx.env, nodeVersion: ctx.nodeVersion, identity: identityDigest({ url: replayUrl, env: ctx.env }), url: replayUrl };
    };
    const prepareAnyFolder = async () => {
        if (args.session === null || !SESSION_ID.test(args.session))
            return { kind: "none" };
        const sessionId = args.session;
        // ⛔ NOTHING IS READ FOR A MACHINE THAT HAS GRANTED NOTHING (C18 #5): the resolver reads the transcript for evidence, so the same
        // gate the hook has comes first, before any transcript is looked for or opened and before any state is written.
        if (!hasAnyConsent(ctx.home))
            return { kind: "none" };
        const transcriptPath = findTranscript(ctx.home, ctx.env, sessionId);
        if (transcriptPath === null)
            return { kind: "none" };
        try {
            if (!args.force && ctx.now().getTime() - statSync(transcriptPath).mtimeMs < STILL_WRITING_MS)
                return { kind: "still-writing", sessionId };
        }
        catch {
            return { kind: "none" };
        }
        const eof = fileSize(transcriptPath);
        if (eof === null)
            return { kind: "none" };
        // ⛔ `turnEndCwd` is NULL (C18 #1): the CLI's cwd is where the person TYPED this, not where the session ended. Passing it made
        // `finalize --session S` run inside granted repo B create a B target for a session that never touched B. Which repos a session
        // belongs to comes from the session's own records only; the cwd repo's own close is the ledger-gated branch below.
        const replay = replayConfig();
        const resolved = await resolveSessionTargets({ home: ctx.home, env: ctx.env, nowMs: ctx.now().getTime(), turnEndCwd: null }, sessionId, transcriptPath, null, releases, {
            ...(replay === undefined ? {} : { replay }),
            ...(held === undefined ? {} : { held }),
        });
        if (resolved.kind === "busy")
            return { kind: "busy" };
        if (resolved.kind === "replay-stopped")
            return { kind: "replay-stopped", step: resolved.step };
        heartbeat = resolved.heartbeat;
        if (resolved.targets.length === 0)
            return { kind: "none" };
        return { kind: "ready", sessionId, transcriptPath, eof, specs: resolved.targets.map((target) => closeSpecOf(target, resolved.scan, resolved)) };
    };
    const busyBlock = () => {
        writeLines(ctx.stderr, renderErrorBlock({
            kind: "bad",
            code: "DELIVERY_FAILED",
            what: FINALIZE.notDelivered,
            why: [],
            fixLabel: FINALIZE.retryFix,
            fixes: [channelCommand(ctx.env, ctx.selfPath, args.session === null ? FINALIZE.commandSessionAny : FINALIZE.commandSession(args.session))],
        }, ctx.colour));
        return EXIT.failure;
    };
    /** U5b: a recorded firing could not be replayed, so NOTHING is sealed: the firings after it still owe their pending lines. */
    const replayStoppedBlock = (step) => {
        if (step.kind === "fatal" && step.why === "rejected") {
            writeLines(ctx.stderr, renderErrorBlock({
                kind: "bad",
                code: "CREDENTIAL_REJECTED",
                what: FINALIZE.credentialStopped,
                why: [],
                fixLabel: FINALIZE.credentialStoppedFix,
                fixes: [authCommandFor(ctx.env, ctx.selfPath)],
            }, ctx.colour));
            return EXIT.failure;
        }
        return busyBlock();
    };
    const refuseAnyFolder = (prepared) => {
        if (prepared.kind === "still-writing")
            return stillWriting(prepared.sessionId);
        if (prepared.kind === "busy")
            return busyBlock();
        if (prepared.kind === "replay-stopped")
            return replayStoppedBlock(prepared.step);
        return null;
    };
    let anyFolder = { kind: "none" };
    const keys = resolveProjectKeys(ctx.cwd);
    if (keys === null) {
        anyFolder = await prepareAnyFolder();
        const refused = refuseAnyFolder(anyFolder);
        if (refused !== null)
            return refused;
        if (anyFolder.kind !== "ready") {
            writeFailure(ctx, notAGitRepoBlock(ctx));
            return EXIT.failure;
        }
    }
    const projectKey = keys === null ? null : keys.worktree;
    const slugOf = projectKey === null ? null : onceRepoSlug(projectKey);
    if (keys !== null && slugOf !== null && !isCaptureAllowed(ctx.home, keys, slugOf)) {
        anyFolder = await prepareAnyFolder();
        const refused = refuseAnyFolder(anyFolder);
        if (refused !== null)
            return refused;
        if (anyFolder.kind !== "ready") {
            // "This repository is not allowed to be captured": the repo's own consent, not the machine's credential.
            writeLines(ctx.stderr, renderErrorBlock({
                kind: "bad",
                code: "NOT_CONNECTED",
                what: ERRORS.notConnected,
                why: [],
                fixLabel: ERRORS.notConnectedFix,
                fixes: [connectCommandFor(ctx.env, ctx.selfPath)],
            }, ctx.colour));
            return EXIT.notConnected;
        }
    }
    const load = loadCredential({ env: ctx.env, home: ctx.home });
    if (load.kind !== "ok") {
        // PR 7 (Q1): a credential that is PRESENT but unusable gets the precise block `status`, `connect` and `backfill` print
        // (the exit stays 3); no credential at all is `NO_CREDENTIAL`. A credential the SERVER rejects loads `ok` and reaches the
        // send, so it is not here — and no local "known rejected" check is added (that would turn exit 1 into exit 3).
        writeLines(ctx.stderr, load.kind === "absent"
            ? renderErrorBlock({
                kind: "bad",
                code: "NO_CREDENTIAL",
                what: BACKFILL.notConnectedWhat,
                why: [],
                fixLabel: BACKFILL.notConnectedFixLabel,
                fixes: [connectCommandFor(ctx.env, ctx.selfPath)],
            }, ctx.colour)
            : credentialProblem(load, ctx.colour, authCommandFor(ctx.env, ctx.selfPath)));
        return EXIT.notConnected;
    }
    const url = ingestUrl(ctx.env);
    if (url === null) {
        writeLines(ctx.stderr, ingestUrlUnavailableBlock(ctx));
        return EXIT.failure;
    }
    // ── Which session. ──
    let sessionId;
    let transcriptPath;
    let eof;
    let specs;
    if (anyFolder.kind === "ready") {
        ({ sessionId, transcriptPath, eof, specs } = anyFolder);
    }
    else {
        // Here the cwd IS an allowed repo (the two gates above passed), so `keys`, `projectKey` and `slugOf` exist.
        if (keys === null || projectKey === null || slugOf === null)
            return EXIT.failure;
        if (args.session !== null) {
            if (!SESSION_ID.test(args.session)) {
                writeLines(ctx.stderr, renderErrorBlock({ kind: "bad", code: "FINALIZE_BAD_SESSION_ID", what: FINALIZE.badSessionId, why: [] }, ctx.colour));
                return EXIT.usage;
            }
            sessionId = args.session;
        }
        else {
            const recent = recentSessions(ctx.home, projectKey, nowMs);
            if (recent.length === 0) {
                writeLines(ctx.stderr, renderErrorBlock({
                    kind: "bad",
                    code: "FINALIZE_NO_RECENT_SESSION",
                    what: FINALIZE.noRecentSession,
                    why: [],
                    fixLabel: FINALIZE.noRecentSessionFix,
                    fixes: [channelCommand(ctx.env, ctx.selfPath, FINALIZE.commandSessionAny)],
                }, ctx.colour));
                return EXIT.usage;
            }
            if (recent.length > 1) {
                writeLines(ctx.stderr, renderErrorBlock({
                    kind: "bad",
                    code: "FINALIZE_SEVERAL_RECENT",
                    what: FINALIZE.severalRecent,
                    why: recent.map((r) => FINALIZE.recentRow(r.id, Math.round((nowMs - r.at) / 60000))),
                    fixLabel: FINALIZE.severalRecentFix,
                    fixes: [channelCommand(ctx.env, ctx.selfPath, FINALIZE.commandSessionAny)],
                }, ctx.colour));
                return EXIT.usage;
            }
            sessionId = recent[0].id;
        }
        // ── U5b: THE SESSION'S RECORDED FIRINGS ARE REPLAYED FIRST, under its lock, before anything asks whether the session exists. After U6 the
        //    hook writes no state file and promotes nothing, so a session the worker has not reached has neither, and `--session` would answer
        //    FINALIZE_UNKNOWN_SESSION for it. A replay that stops early ends the verb here with no `final`. ──
        const early = await takeSessionLock({ home: ctx.home }, sessionId, releases, replayConfig());
        if (early.kind === "busy")
            return busyBlock();
        if (early.kind === "replay-stopped")
            return replayStoppedBlock(early.step);
        held = early.held;
        heartbeat = held.refresh;
        // ── The session must be one THIS repo captured (it has a state file here) and its transcript must be findable inside the agent's own root. ──
        const state = sessionStatePath(ctx.home, { repoKey: projectKey, sessionId });
        if (state === null || !existsSync(state)) {
            // A session this folder's repo never captured may still belong to other repos it named (any-folder capture).
            anyFolder = await prepareAnyFolder();
            const refused = refuseAnyFolder(anyFolder);
            if (refused !== null)
                return refused;
            if (anyFolder.kind !== "ready") {
                writeLines(ctx.stderr, renderErrorBlock({ kind: "bad", code: "FINALIZE_UNKNOWN_SESSION", what: FINALIZE.unknownSession(sessionId), why: [] }, ctx.colour));
                return EXIT.usage;
            }
        }
        if (anyFolder.kind === "ready") {
            ({ transcriptPath, eof, specs } = anyFolder);
        }
        else {
            const found = findTranscript(ctx.home, ctx.env, sessionId);
            if (found === null) {
                writeLines(ctx.stderr, renderErrorBlock({ kind: "bad", code: "FINALIZE_TRANSCRIPT_MISSING", what: FINALIZE.transcriptMissing(sessionId), why: [] }, ctx.colour));
                return EXIT.failure;
            }
            transcriptPath = found;
            try {
                if (!args.force && ctx.now().getTime() - statSync(transcriptPath).mtimeMs < STILL_WRITING_MS)
                    return stillWriting(sessionId);
            }
            catch {
                return EXIT.failure;
            }
            const size = fileSize(transcriptPath);
            if (size === null)
                return EXIT.failure;
            eof = size;
            // The session's other repos (parent-folder turns touched them too): resolved by the one resolver, under the one session lock.
            // This repo's own ledger target is closed exactly as before; a resolved target for the same repo REPLACES it (the hook's own
            // ledger choice), and a resolver that finds nothing leaves exactly today's single target.
            const resolved = await resolveSessionTargets({ home: ctx.home, env: ctx.env, nowMs: ctx.now().getTime(), turnEndCwd: null }, sessionId, transcriptPath, { keys, slugOf: onceStrictRepoSlug(keys.worktree) }, releases, { held });
            if (resolved.kind === "busy")
                return busyBlock();
            if (resolved.kind === "replay-stopped")
                return replayStoppedBlock(resolved.step);
            heartbeat = resolved.heartbeat;
            const own = resolved.targets.find((target) => target.worktrees.includes(projectKey) || target.ledgerKey === projectKey);
            const manual = {
                projectKey,
                redactionRoots: confinementRoots(keys),
                repoSlug: slugOf(),
                worktrees: [projectKey],
                allowNeverCaptured: false,
                target: null,
            };
            specs = [
                own === undefined ? manual : closeSpecOf(own, resolved.scan, resolved),
                ...resolved.targets.filter((target) => target !== own).map((target) => closeSpecOf(target, resolved.scan, resolved)),
            ];
        }
    }
    // ── Deliver: promote what was pending, then sub-agents FIRST, then the main stream with the assertion. ──
    // ⛔ NO PENDING-LINE PROMOTION HERE, deliberately: promotion keeps ONE call site (`deliverTarget`; `post-commit-spool.test.ts` pins it by name, so this comment must not spell it), and this verb reaches it only
    // through a REPLAY of the session's recorded firings (U5b, above). Before U6 every hook fire ran it inline and the session necessarily
    // had a state file, so a first-turn commit was promoted by the first `Stop` that wrote one; after U6 the hook records a firing and the
    // replay is what promotes. No firing means no promotion, so a dead session still never reaches it (`post-commit-spool.test.ts`, D208).
    const outcomes = [];
    // ⛔ LEAST RECENTLY SENT FIRST (C18 #8), as the hook orders its targets: resolver order is discovery order, and a session with many
    // targets would always serve the same first ones if the credential or the clock ran out part-way. Never-sent targets (0) go first.
    const lastSentAt = (spec) => {
        const state = loadSessionState(ctx.home, { repoKey: spec.projectKey, sessionId });
        return Math.max(0, ...Object.values(state.files).map((file) => file.lastSentAt));
    };
    specs = specs
        .map((spec, index) => ({ spec, index, at: lastSentAt(spec) }))
        .sort((a, b) => a.at - b.at || a.index - b.index)
        .map((entry) => entry.spec);
    for (const spec of specs) {
        const closedOne = await closeSession({
            home: ctx.home,
            env: ctx.env,
            nodeVersion: ctx.nodeVersion,
            agentId: ctx.agentId ?? DEFAULT_AGENT_ID,
            cwd: ctx.cwd,
            url,
            credential: load.credential,
            projectKey: spec.projectKey,
            redactionRoots: spec.redactionRoots,
            repoSlug: spec.repoSlug,
            sessionId,
            transcriptPath,
            eof: spec.sizeCap === undefined ? eof : Math.min(eof, spec.sizeCap.main ?? 0),
            seal: true,
            allowNeverCaptured: spec.allowNeverCaptured,
            completeSubagents: false,
            worktrees: spec.worktrees,
            ...(spec.sizeCap === undefined ? {} : { sizeCap: spec.sizeCap }),
            ...(spec.isolation === undefined ? {} : { isolation: spec.isolation }),
            ...(heartbeat === undefined ? {} : { heartbeat }),
        });
        // C25: the session's lock was taken from us. Stop BEFORE the next target's write; this outcome is the verb's answer.
        if (closedOne.kind === "lock-lost") {
            outcomes.push(closedOne);
            break;
        }
        // C3: the server refused THIS target for good. It is stopped (recorded, never retried), and it does not fail the others.
        if (spec.target !== null &&
            "delivery" in closedOne &&
            closedOne.delivery.kind === "attempted" &&
            closedOne.delivery.detail?.code === FOLDER_REPOSITORY_FORBIDDEN) {
            // C35 (iii): recording the stop is a WRITE, so only while the session is still ours. A lost lock reports the refusal and leaves it
            // for the next holder, who meets the same 403.
            if (heartbeat === undefined || heartbeat())
                stopTarget(ctx.home, sessionId, spec.target, FOLDER_REPOSITORY_FORBIDDEN, Date.now());
            continue;
        }
        outcomes.push(closedOne);
        if (closedOne.kind === "stopped")
            break; // a fatal class for the credential: no other target can send either
    }
    // ONE answer: the first target that did not close cleanly, else one line for all of them.
    const closed = outcomes.find((outcome) => outcome.kind !== "sealed" && outcome.kind !== "already") ??
        (outcomes.length === 0
            ? { kind: "never-captured" }
            : {
                ...(outcomes.find((outcome) => outcome.kind === "sealed") ?? outcomes[0]),
                setAsidePairs: outcomes.reduce((sum, outcome) => sum + ("setAsidePairs" in outcome ? outcome.setAsidePairs : 0), 0),
            });
    // ── What the server said. ──
    if (closed.kind === "stopped") {
        writeLines(ctx.stderr, renderErrorBlock({
            kind: "bad",
            code: "CREDENTIAL_REJECTED",
            what: FINALIZE.credentialStopped,
            why: [],
            fixLabel: FINALIZE.credentialStoppedFix,
            fixes: [authCommandFor(ctx.env, ctx.selfPath)],
        }, ctx.colour));
        return EXIT.failure;
    }
    if (closed.kind === "sealed" || closed.kind === "already") {
        writeLines(ctx.stdout, wrap(closed.kind === "sealed" ? FINALIZE.closed(sessionId) : FINALIZE.alreadyClosed(sessionId), 2));
        if (closed.setAsidePairs > 0)
            writeLines(ctx.stderr, wrap(FINALIZE.inferredSetAside(closed.setAsidePairs), 2));
        return EXIT.ok;
    }
    if (closed.kind === "refused") {
        writeLines(ctx.stderr, renderErrorBlock({
            kind: "bad",
            code: "FINALIZE_REFUSED",
            what: FINALIZE.refused,
            why: [],
            fixLabel: FINALIZE.retryFix,
            fixes: [channelCommand(ctx.env, ctx.selfPath, FINALIZE.commandSession(sessionId))],
        }, ctx.colour));
        return EXIT.failure;
    }
    if (closed.kind === "unacknowledged") {
        // 2xx and no acknowledgement: an older server. Delivered, NOT closed — and the exit code says so.
        writeLines(ctx.stderr, renderErrorBlock({ kind: "warn", what: FINALIZE.notAcknowledged, why: [] }, ctx.colour));
        return EXIT.unacknowledged;
    }
    // Anything else did not deliver (`not-delivered`, or `lock-lost` (C25: another writer took the session; the retry command is the
    // right advice and no new line is needed); `finalize` never asks for the outcomes only a backfill can get).
    writeLines(ctx.stderr, renderErrorBlock({
        kind: "bad",
        code: "DELIVERY_FAILED",
        what: FINALIZE.notDelivered,
        why: [],
        fixLabel: FINALIZE.retryFix,
        fixes: [channelCommand(ctx.env, ctx.selfPath, FINALIZE.commandSession(sessionId))],
    }, ctx.colour));
    return EXIT.failure;
}
/**
 * PR 7 (Q2): the ingest address in the environment is one this client refuses to send to. Shared with `backfill`, which
 * stops on the same condition. The fix names the variable to correct or unset — retrying cannot help.
 */
export function ingestUrlUnavailableBlock(ctx) {
    return renderErrorBlock({
        kind: "bad",
        code: "INGEST_URL_UNAVAILABLE",
        what: FINALIZE.ingestUrlWhat,
        why: [FINALIZE.ingestUrlWhy],
        fixLabel: FINALIZE.ingestUrlFix,
        fixes: [FINALIZE.ingestUrlCommand],
    }, ctx.colour);
}
/**
 * Sessions of this repo that were touched in the last 24 h, newest first. "Touched" is a state file, the hook's `.live` stamp, or a recorded
 * firing whose turn ended in this repo (U5b): after U6 a session the worker has not reached has no state file, and listing state files alone
 * would let `--latest` seal an OLDER session while the newest was invisible, where today it refuses with "several recent".
 */
function recentSessions(home, repoKey, nowMs) {
    const seen = new Map();
    const note = (id, at) => {
        if (nowMs - at <= LATEST_WINDOW_MS)
            seen.set(id, Math.max(seen.get(id) ?? 0, at));
    };
    const dir = repoSessionsDir(home, repoKey);
    let entries = [];
    try {
        if (dir !== null)
            entries = readdirSync(dir);
    }
    catch {
        entries = [];
    }
    for (const entry of entries) {
        const stem = entry.endsWith(".json") ? entry.slice(0, -".json".length) : entry.endsWith(".live") ? entry.slice(0, -".live".length) : null;
        if (stem === null || dir === null)
            continue;
        try {
            note(stem, statSync(join(dir, entry)).mtimeMs);
        }
        catch {
            /* a vanished file is not recent */
        }
    }
    for (const stem of firingSessions(home)) {
        const last = readFirings(home, stem, 0).firings.at(-1)?.firing;
        if (last !== undefined && last.keys?.worktree === repoKey)
            note(last.sid, last.at);
    }
    return [...seen].map(([id, at]) => ({ id, at })).sort((x, y) => y.at - x.at);
}
/** `<root>/<project dir>/<session>.jsonl` under any of the agents' transcript roots, confined as a hook's is. */
function findTranscript(home, env, sessionId) {
    for (const root of transcriptRoots(home, env)) {
        let dirs;
        try {
            dirs = readdirSync(root);
        }
        catch {
            continue;
        }
        for (const d of dirs) {
            const candidate = join(root, d, `${sessionId}.jsonl`);
            if (existsSync(candidate) && admitsTranscript(home, env, candidate))
                return candidate;
        }
    }
    return null;
}
//# sourceMappingURL=finalize.js.map