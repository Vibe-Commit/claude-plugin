/**
 * THE IDLE-SESSION DRAIN, WORKER SIDE — U5c of the detached uploader (plan §3.9 "Idle drain cap", §3.3 fairness).
 *
 * A session whose last firing ran with bytes still behind (a multi-repo session at `SessionEnd`, a repo found late in a long one) has no
 * next hook of its own. The hook used to finish such sessions with the leftover of its one deadline (`drainIdleSessions`, `entry.ts`); U6
 * removes that from the hook, and this is where it lives. The worker calls `drainIdleStep` when it has no live firing to serve, so
 * **live firings always outrank the drain** and the queue is looked at again between deltas.
 *
 * ## What a step is
 * ONE delta for the first idle session that has something to send, under THAT session's writer lock (never waited for: a busy session is
 * skipped), consent re-checked by the resolver, discovery continued (`resolveTargets` with `drain: true`: ≤8 MiB and ≤8 roots per call).
 *
 * ## What bounds it
 *  - **64 MiB per worker life** (`DRAIN_CAP_BYTES`, plan §3.9, a starting value, unmeasured). Without a deadline the drain would otherwise
 *    send every idle session's backlog on the worker's first run and flood the shared-cpu VM. U8 measures the Stop-to-`capture_turns` lag.
 *  - Sessions are served OLDEST first and a session that cannot be acted on moves to the back of the line (`rotate`), so forty unactionable
 *    records at the front cannot starve a live owed session behind them (C18 #7).
 *  - Only sessions idle for 10 minutes (`DRAIN_IDLE_MS`) and with NO unconsumed firing: a session with a firing waiting is a live session.
 *
 * ## ⛔ Identity (plan §3.13): "a worker serves only firings of its own identity, in the idle drain as well"
 * The target record names no credential, so the identity is read from the session's firing log: the last firing's `id` must be ours. A
 * session with NO firing log is a LEGACY one (recorded by a hook before U6) and is served only by a worker using the saved credential
 * (`VIBECOMMIT_TOKEN` unset), which is the credential those hooks used unless the user said otherwise. A worker running on an environment
 * token never drains a session it cannot prove is its own.
 *
 * ## ⛔ A drain delivery is not a hook's: it stamps NO liveness (`byHook: false`, no `liveAtMs`). The old hook drain stamped "now" on
 * every idle session it touched, which kept a finished session live for a window it did not earn; that was a defect and is not carried.
 */
import { existsSync, rmSync, statSync, utimesSync } from "node:fs";
import { admitsTranscript, canonicalHookEvent, dialectFor } from "./agents/registry.js";
import { loadCredential } from "./credential.js";
import { forgetFirings, readCursor, readFirings } from "./firing.js";
import { CAPTURE_NOT_APPROVED } from "./post.js";
import { DRAIN_EXAMINE_MAX, DRAIN_FORGET_MS, deliverFiring, fileSize, findSubagentFiles, wait, writeOffOwed, } from "./hooks/entry.js";
import { claimSessionWriter } from "./hooks/fire_lock.js";
import { DRAIN_IDLE_MS } from "./policy.js";
import { SESSION_END_EVENT } from "./hooks/session_end.js";
import { sessionFileStem } from "./paths.js";
import { REQUEST_TIMEOUT_MS, SESSION_BEAT_MS, SESSION_LOCK_STALE_MS, closeForSeal, sealGuardAllows, sealOutcome } from "./replay.js";
import { dialectIsolates, listTargetRecords, resolveTargets, stopKeyOf, LockLostError } from "./session_targets.js";
import { fileState, loadSessionState, pruneDeliveredEndHold, sealIsCurrent } from "./state.js";
/** Bytes the drain may send in one worker's life (plan §3.9). */
export const DRAIN_CAP_BYTES = 64 * 1024 * 1024;
/** Total bytes acknowledged across a session's ledgers: the measure of what a step moved. */
function sentBytes(cfg, targets, sessionId, subFiles) {
    let total = 0;
    for (const target of targets) {
        const state = loadSessionState(cfg.home, { repoKey: target.ledgerKey, sessionId });
        total += fileState(state, "main").sentOffset;
        for (const file of subFiles)
            total += fileState(state, file.fileKey).sentOffset;
    }
    return total;
}
/** Does this session owe a firing, of any identity? Then it is live work, not idle work. */
function hasFiring(cfg, sessionId) {
    const stem = sessionFileStem(sessionId);
    return readFirings(cfg.home, stem, readCursor(cfg.home, stem).offset).firings.length > 0;
}
/** May THIS worker's credential serve this session? See the module doc. */
function ours(cfg, sessionId) {
    const stem = sessionFileStem(sessionId);
    const last = readFirings(cfg.home, stem, 0).firings.at(-1)?.firing;
    if (last !== undefined)
        return last.id === cfg.identity;
    const token = cfg.env.VIBECOMMIT_TOKEN?.trim() ?? "";
    return token === "";
}
/**
 * R8 · THE DRAIN SEAL'S PRECONDITIONS. A session the worker's own seal missed: it ended (the LAST firing is a `SessionEnd`, so no resume is known to the log),
 * every live target is not yet sealed by the `state.ts` comparison (no receipt at or after the last delivery), the transcript has been quiet for
 * `DRAIN_IDLE_MS`, and the TRANSCRIPT's dialect says what grew since that firing is not a conversation (`growthAllowsSeal`). A session whose last firing is a
 * `Stop` is NOT sealed here, however long it has been idle: that is the rejected "idle seal" (D2), which would split the turn of a live session that wakes.
 * Pure but for reads. `null` when any condition fails: the drain does what it always did.
 */
function sealCandidate(cfg, record, transcript, size, live, nowMs) {
    const last = readFirings(cfg.home, sessionFileStem(record.sessionId), 0).firings.at(-1)?.firing;
    if (last === undefined || last.id !== cfg.identity || last.transcript !== transcript)
        return null;
    if (canonicalHookEvent(dialectFor(last.agent), last.event) !== SESSION_END_EVENT)
        return null;
    let modifiedAt;
    try {
        modifiedAt = statSync(transcript).mtimeMs;
    }
    catch {
        return null;
    }
    if (nowMs - modifiedAt < DRAIN_IDLE_MS)
        return null;
    const owed = live.some((target) => !sealIsCurrent(loadSessionState(cfg.home, { repoKey: target.ledgerKey, sessionId: record.sessionId })));
    if (!owed)
        return null;
    if (!sealGuardAllows(cfg, transcript, last.eof, size))
        return null;
    return { at: last.at, agent: last.agent };
}
export async function drainIdleStep(cfg, state, nowMs = Date.now) {
    if (state.bytes >= DRAIN_CAP_BYTES)
        return { kind: "idle" };
    const candidates = listTargetRecords(cfg.home)
        .sort((a, b) => a.mtimeMs - b.mtimeMs)
        .slice(0, DRAIN_EXAMINE_MAX);
    for (const { path, record } of candidates) {
        const now = nowMs();
        if (now - record.firedAt < DRAIN_IDLE_MS)
            continue;
        if (hasFiring(cfg, record.sessionId))
            continue;
        const rotate = () => {
            try {
                utimesSync(path, new Date(), new Date());
            }
            catch {
                // Ordering only.
            }
        };
        const forgetIfOld = () => {
            if (now - record.firedAt > DRAIN_FORGET_MS) {
                try {
                    rmSync(path);
                    forgetFirings(cfg.home, record.sessionId);
                }
                catch {
                    // A record we could not delete is just examined again.
                }
            }
            else {
                rotate();
            }
        };
        if (record.transcriptPath === null) {
            rotate();
            continue;
        }
        const transcript = record.transcriptPath;
        if (!ours(cfg, record.sessionId)) {
            rotate();
            continue;
        }
        // C28: a dialect that cannot isolate is never owed; it delivers only the repo each turn ends in, on that turn's own firing.
        if (!dialectIsolates(cfg.home, cfg.env, transcript)) {
            forgetIfOld();
            continue;
        }
        // Confinement again (`/cso` finding 1): this path was read from a record, and it reaches a read whose result is uploaded.
        if (existsSync(transcript) && !admitsTranscript(cfg.home, cfg.env, transcript)) {
            rotate();
            continue;
        }
        // `agentId` is a placeholder: the drain also serves Codex and Cursor sessions, and delivery takes the dialect and the scrubber from the
        // transcript path, not from this field (the hook drain this replaces used whichever hook happened to be running).
        const ctx = { env: cfg.env, home: cfg.home, nodeVersion: cfg.nodeVersion, ...(cfg.selfPath === undefined ? {} : { selfPath: cfg.selfPath }), agentId: "claude-code", readStdin: () => Promise.resolve("") };
        const size = fileSize(transcript);
        if (size === null) {
            // The transcript is gone: what is owed becomes a gap now (`writeOffOwed`), a write, so under the session's lock, never waited for.
            const writeOff = await claimSessionWriter(cfg.home, record.sessionId, { staleAfterMs: SESSION_LOCK_STALE_MS, deadlineAtMs: 0, wait });
            if (writeOff === null) {
                rotate();
                continue;
            }
            try {
                writeOffOwed(cfg.home, record, now);
            }
            finally {
                writeOff.release();
            }
            forgetIfOld();
            continue;
        }
        const live = record.targets.filter((target) => record.stopped[stopKeyOf(target)] === undefined);
        const subFiles = findSubagentFiles(ctx, transcript);
        const behind = live.some((target) => {
            const ledger = loadSessionState(cfg.home, { repoKey: target.ledgerKey, sessionId: record.sessionId });
            return (ledger.endHold !== null ||
                fileState(ledger, "main").sentOffset < size ||
                subFiles.some((file) => fileState(ledger, file.fileKey).sentOffset < file.size));
        });
        // R8: an ended session the worker's seal missed is sealed here, even when nothing is behind.
        const sealing = sealCandidate(cfg, record, transcript, size, live, now);
        if (!behind && record.settled && sealing === null) {
            rotate();
            continue;
        }
        const claim = await claimSessionWriter(cfg.home, record.sessionId, { staleAfterMs: SESSION_LOCK_STALE_MS, deadlineAtMs: 0, wait });
        if (claim === null) {
            rotate();
            continue;
        }
        const startedAt = nowMs();
        // The lock goes stale in four beats, not in a request timeout: a timer keeps it alive through a long request (as `replayStep`'s does).
        const beat = setInterval(() => claim.refresh(), SESSION_BEAT_MS);
        beat.unref();
        try {
            const load = loadCredential({ env: cfg.env, home: cfg.home });
            if (load.kind !== "ok")
                return { kind: "fatal", elapsedMs: 0 };
            const heartbeat = () => claim.refresh();
            let resolution;
            try {
                resolution = resolveTargets({
                    home: cfg.home,
                    env: cfg.env,
                    sessionId: record.sessionId,
                    transcriptPath: transcript,
                    turnEndCwd: null,
                    mode: "turn",
                    nowMs: nowMs(),
                    drain: true,
                    heartbeat,
                });
            }
            catch (error) {
                if (error instanceof LockLostError)
                    continue;
                throw error;
            }
            if (resolution.targets.length === 0) {
                rotate();
                continue;
            }
            const input = { sessionId: record.sessionId, transcriptPath: transcript, cwd: "", eventName: "Stop" };
            const subs = findSubagentFiles(ctx, transcript);
            const before = sentBytes(cfg, resolution.targets, record.sessionId, subs);
            if (sealing !== null) {
                // `closeSession(seal)` IN PLACE OF `deliverFiring`: the `final` rides the delivery that clears any debt (bytes behind, a repo approved after the session
                // ended, a `never` or thrown skip), sub-agent streams first, the commits pinned to the end firing's time. The resolver ran first, so a withdrawn grant
                // made no request. A step is one session; the rest of the line waits for the next step.
                let unacknowledged = false;
                let requested = false;
                for (const target of resolution.targets) {
                    const closed = await closeForSeal({
                        cfg,
                        target,
                        resolution,
                        sessionId: record.sessionId,
                        transcript,
                        size,
                        at: sealing.at,
                        cwd: "",
                        agent: sealing.agent,
                        credential: load.credential,
                        allowNeverCaptured: true,
                        heartbeat,
                    });
                    if (closed.kind === "unacknowledged") {
                        unacknowledged = true;
                        requested = true;
                        continue;
                    }
                    const o = sealOutcome(closed);
                    if (o === null)
                        continue;
                    if (o.kind === "sealed") {
                        requested = true;
                        continue;
                    }
                    if (o.kind === "fatal")
                        return { kind: "fatal", elapsedMs: nowMs() - startedAt };
                    if (o.kind === "lost")
                        break;
                    // later, or a read/write failure: to the back of the line, retried on the worker's backoff.
                    rotate();
                    return { kind: "later", session: record.sessionId, elapsedMs: nowMs() - startedAt, ...(o.kind === "later" && o.retryAfterMs !== undefined ? { retryAfterMs: o.retryAfterMs } : {}) };
                }
                const movedBySeal = Math.max(0, sentBytes(cfg, resolution.targets, record.sessionId, subs) - before);
                state.bytes += movedBySeal;
                // A15: always to the back. A server that does not acknowledge leaves the condition true for ever; the worker backs the drain off, so it does not spin.
                rotate();
                if (unacknowledged)
                    return { kind: "held", session: record.sessionId, elapsedMs: nowMs() - startedAt };
                if (requested)
                    return { kind: "delivered", bytes: movedBySeal, elapsedMs: nowMs() - startedAt };
                continue;
            }
            const results = await deliverFiring({
                ctx,
                input,
                url: cfg.url,
                credential: load.credential,
                resolution,
                eof: size,
                event: null,
                isSessionEnd: false,
                pace: { kind: "unbounded", timeoutMs: cfg.requestTimeoutMs ?? REQUEST_TIMEOUT_MS },
                // R9: a drain delivery leaves the end mark standing: it proves nothing about whether the session ended, and `status` must keep naming one the seal could not close.
                keepEndMark: true,
                heartbeat,
            });
            for (const target of resolution.targets)
                pruneDeliveredEndHold(cfg.home, { repoKey: target.ledgerKey, sessionId: record.sessionId });
            const moved = Math.max(0, sentBytes(cfg, resolution.targets, record.sessionId, subs) - before);
            state.bytes += moved;
            const deliveries = results.flatMap((r) => [r.delivery, ...r.subagents.deliveries]);
            if (results.some((r) => r.reason.kind === "fatal") || deliveries.some((d) => d.kind === "attempted" && d.disposition === "fatal")) {
                return { kind: "fatal", elapsedMs: nowMs() - startedAt };
            }
            if (results.some((r) => r.reason.kind === "later") || deliveries.some((d) => d.kind === "attempted" && d.disposition === "later" && d.detail?.code !== CAPTURE_NOT_APPROVED)) {
                // To the back of the line: a session that keeps failing must not stand in front of the ones behind it.
                rotate();
                const waits = deliveries.flatMap((d) => (d.kind === "attempted" && d.disposition === "later" && d.retryAfterMs !== undefined ? [d.retryAfterMs] : []));
                return { kind: "later", session: record.sessionId, elapsedMs: nowMs() - startedAt, ...(waits.length === 0 ? {} : { retryAfterMs: Math.max(...waits) }) };
            }
            if (moved > 0)
                return { kind: "delivered", bytes: moved, elapsedMs: nowMs() - startedAt };
            // Nothing moved and nothing failed. If a request WAS made, the server held this session (403 capture_not_approved): rotate it to the back
            // and RETURN, so one step is one request (F2a: the old loop went on to the next held session inside the same step, up to
            // DRAIN_EXAMINE_MAX back-to-back requests, re-sent on every worker life). If nothing was sent at all, move on without cost.
            rotate();
            if (deliveries.some((d) => d.kind === "attempted"))
                return { kind: "held", session: record.sessionId, elapsedMs: nowMs() - startedAt };
        }
        finally {
            clearInterval(beat);
            claim.release();
        }
    }
    return { kind: "idle" };
}
//# sourceMappingURL=drain.js.map