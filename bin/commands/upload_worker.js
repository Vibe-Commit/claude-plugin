/**
 * THE UPLOAD WORKER — U5a of the detached uploader (plan §3.3, §3.9, §3.12).
 *
 * `vibecommit __upload-worker`: a hidden verb (not in `VERBS`, not in help), spawned detached by the hook when it has recorded a firing and
 * no worker is alive (U6 spawns it; until then nothing does). ONE worker per machine and identity (`identity.ts`) holds
 * `uploader.<id>.lock`, walks every session that has a firing log, and replays each session's oldest unconsumed firing ALONE through
 * `replayStep`. The hook never waits for the network again; this process does, with a fixed request timeout and no deadline.
 *
 * ## What bounds it
 *  - **One request at a time**, and after each step that made requests a sleep of `max(250 ms, the step's elapsed time)` capped at 30 s
 *    (D9), so about half the wall clock is server work. A step is one delta per target, so it is a handful of requests at most.
 *  - **Backoff per session** on `later`: 5 s, doubling to 5 min, with jitter. Sessions back off independently; one failing session does not
 *    slow the rest.
 *  - **No idle linger.** It exits when nothing is owed (release the lock, look at the queue again, and take the lock back only if
 *    something arrived in between), after 30 min with no progress and after 60 min in all, so an upgrade takes effect and a stuck worker
 *    cannot live on. The next hook respawns it.
 *  - **It never waits for a session's writer lock** (a busy session is revisited) and sleeps at least 25 ms after every step that held one,
 *    longer than a waiting `finalize` polls, so a waiter can win.
 *  - **A newer firing version** stops it after the step in hand: a newer build owns those lines.
 *  - **A revoked or missing credential** stops it (`fatal`); the cursor stays, so nothing is lost and the next hook retries.
 *
 * ## What it reports: `uploader.<id>.status`
 * Counts, classes and times only: never a body, a path or a credential. Written atomically after every step. `status` reads it (U7), and
 * the hook reads it for notices (U6). "Behind" is NEVER taken from the worker's own claim; `status` recomputes it from the firing logs.
 *
 * ## ⛔ Static imports are the worker's own. `index.ts` loads this file with a dynamic `import()` that fails closed to exit 0.
 */
import { writeFileAtomic } from "../atomic_write.js";
import { drainIdleStep } from "../drain.js";
import { firingSessions, readCursor, readFirings } from "../firing.js";
import { unboundedPaceMs } from "../hooks/entry.js";
import { claimUploader, UPLOADER_BEAT_MS } from "../hooks/fire_lock.js";
import { identityDigest } from "../identity.js";
import { uploaderStatusPath } from "../paths.js";
import { ingestUrl } from "../post.js";
import { replayStep, REQUEST_TIMEOUT_MS } from "../replay.js";
/** Backoff on `later` (plan §3.12). */
export const BACKOFF_FIRST_MS = 5_000;
export const BACKOFF_MAX_MS = 5 * 60_000;
/** Pacing (D9): sleep after a step that made requests. The constants and `unboundedPaceMs` live in `hooks/entry.ts`, beside the loops that must honour them. */
/** Yield after a step that held a session lock: longer than `WRITER_POLL_MS` (20 ms) so a waiter can win. */
export const YIELD_MS = 25;
/** Lifetime bounds (plan §3.9). */
export const NO_PROGRESS_MS = 30 * 60_000;
export const TOTAL_MS = 60 * 60_000;
/** How long a pass with nothing to do but wait (busy sessions, backoff) sleeps before looking again. */
const IDLE_POLL_MS = 1_000;
/** The last outcomes kept in the status file. */
const OUTCOMES_KEPT = 20;
const realSleep = (ms) => new Promise((resolve) => {
    setTimeout(resolve, ms);
});
/** `5 s, 10 s, ... 5 min`, with ±25 % jitter. Pure given `random`. */
export function backoffMs(failures, random) {
    const base = Math.min(BACKOFF_MAX_MS, BACKOFF_FIRST_MS * 2 ** Math.max(0, failures - 1));
    return Math.floor(base * (0.75 + random() * 0.5));
}
/** `Retry-After` wins when it is longer than our own backoff, and nothing waits past the backoff ceiling. Pure. */
export function waitAfterLaterMs(failures, retryAfterMs, random) {
    return Math.min(BACKOFF_MAX_MS, Math.max(backoffMs(failures, random), retryAfterMs ?? 0));
}
/** The sleep after a step that made requests: `max(250 ms, elapsed)`, capped. Pure. */
export function paceMs(elapsedMs) {
    return unboundedPaceMs(elapsedMs);
}
/** Did this step put requests on the wire? (`done:nothing-granted` and friends resolved targets and sent nothing.) */
function madeRequests(step) {
    switch (step.kind) {
        case "more":
        case "later":
        case "threw":
            return true;
        case "fatal":
            return step.why === "rejected";
        case "done":
            // U6b (F2b): a HELD step that put a request on the wire (a 403 capture_not_approved) is paced like any other; `requested` says so.
            return step.class === "delivered" || (step.class === "held" && step.requested === true);
        default:
            return false;
    }
}
/** Does `stem` still owe a firing of this identity? A read, no lock. */
function owes(cfg, stem) {
    return readFirings(cfg.home, stem, readCursor(cfg.home, stem).offset).firings.some((r) => r.firing.id === cfg.identity);
}
export async function runUploadWorker(opts) {
    const now = opts.now ?? Date.now;
    const sleep = opts.sleep ?? realSleep;
    const random = opts.random ?? Math.random;
    const noProgressMs = opts.noProgressMs ?? NO_PROGRESS_MS;
    const totalMs = opts.totalMs ?? TOTAL_MS;
    const url = ingestUrl(opts.env);
    if (url === null)
        return "no-url";
    const identity = identityDigest({ url, env: opts.env });
    const cfg = {
        home: opts.home,
        env: opts.env,
        nodeVersion: opts.nodeVersion,
        identity,
        url,
        requestTimeoutMs: opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
        ...(opts.selfPath === undefined ? {} : { selfPath: opts.selfPath }),
    };
    const startedAt = now();
    let lastProgressAt = startedAt;
    const counts = {};
    const outcomes = [];
    // Set when the server rejects a credential; cleared by the next delivery. Read by the hook's `credential_revoked` notice.
    let rejected;
    const failures = new Map();
    const notBefore = new Map();
    // The idle drain (U5c): bytes sent this worker life, and one backoff for the drain as a whole (a failing session rotates to the back).
    const drain = { bytes: 0 };
    let drainFailures = 0;
    let drainNotBefore = 0;
    const writeStatus = (state, exit) => {
        const status = {
            v: 1,
            pid: process.pid,
            startedAt,
            heartbeatAt: now(),
            state,
            ...(exit === undefined ? {} : { exit }),
            counts,
            outcomes,
            ...(rejected === undefined ? {} : { rejected }),
        };
        try {
            writeFileAtomic(uploaderStatusPath(opts.home, identity), `${JSON.stringify(status)}\n`, 0o600);
        }
        catch {
            // A status file that cannot be written must not stop the uploading it reports on.
        }
    };
    const record = (stem, klass, elapsedMs) => {
        counts[klass] = (counts[klass] ?? 0) + 1;
        outcomes.push({ at: now(), class: klass, elapsedMs, session: stem });
        if (outcomes.length > OUTCOMES_KEPT)
            outcomes.splice(0, outcomes.length - OUTCOMES_KEPT);
    };
    for (;;) {
        const claim = claimUploader(opts.home, identity);
        if (claim === null)
            return "not-claimed";
        let lockLost = false;
        // The lock is beaten from a timer, so a live worker is never judged dead however long one request runs.
        const beat = setInterval(() => {
            if (!claim.refresh())
                lockLost = true;
        }, UPLOADER_BEAT_MS);
        beat.unref();
        let exit = null;
        try {
            writeStatus("running");
            while (exit === null) {
                if (lockLost) {
                    exit = "lock-lost";
                    break;
                }
                if (now() - startedAt >= totalMs) {
                    exit = "total";
                    break;
                }
                if (now() - lastProgressAt >= noProgressMs) {
                    exit = "no-progress";
                    break;
                }
                let worked = false;
                let waiting = false;
                let newer = false;
                for (const stem of firingSessions(opts.home)) {
                    if ((notBefore.get(stem) ?? 0) > now()) {
                        waiting = true;
                        continue;
                    }
                    let step;
                    try {
                        step = await replayStep(cfg, stem);
                    }
                    catch {
                        // `replayStep` counts its own throws; one that escapes it is a bug, and a worker that dies on it would crash-loop the machine.
                        record(stem, "escaped", 0);
                        continue;
                    }
                    switch (step.kind) {
                        case "idle":
                        case "foreign":
                            continue;
                        case "busy":
                            waiting = true;
                            continue;
                        case "newer":
                            newer = true;
                            continue;
                        case "done":
                            if (step.class === "delivered")
                                rejected = undefined;
                            record(stem, `done:${step.class}`, step.elapsedMs);
                            // U11: counts only, no path. A recovery that is still a miss must say so.
                            if (step.roots !== undefined)
                                counts[step.roots === "recovered" ? "recovered_from_roots" : "roots_no_repo"] = (counts[step.roots === "recovered" ? "recovered_from_roots" : "roots_no_repo"] ?? 0) + 1;
                            failures.delete(stem);
                            notBefore.delete(stem);
                            worked = true;
                            lastProgressAt = now();
                            break;
                        case "more":
                            record(stem, "more", step.elapsedMs);
                            failures.delete(stem);
                            worked = true;
                            lastProgressAt = now();
                            break;
                        case "later": {
                            const n = (failures.get(stem) ?? 0) + 1;
                            failures.set(stem, n);
                            notBefore.set(stem, now() + waitAfterLaterMs(n, step.retryAfterMs, random));
                            record(stem, "later", step.elapsedMs);
                            waiting = true;
                            break;
                        }
                        case "threw":
                            record(stem, `threw:${step.class}`, step.elapsedMs);
                            if (step.class === "cursor-unwritable") {
                                // U6b (F9c): a cursor that cannot be written re-ran the resolver every ~250 ms for the worker's whole life. Back off like a `later`.
                                const n = (failures.get(stem) ?? 0) + 1;
                                failures.set(stem, n);
                                notBefore.set(stem, now() + waitAfterLaterMs(n, undefined, random));
                                waiting = true;
                            }
                            else {
                                worked = true;
                            }
                            break;
                        case "fatal":
                            if (step.why === "rejected" && step.fingerprint !== undefined)
                                rejected = { at: now(), fingerprint: step.fingerprint };
                            record(stem, `fatal:${step.why}`, step.elapsedMs);
                            exit = "fatal";
                            break;
                        case "lost":
                            record(stem, "lock-lost", 0);
                            exit = "lock-lost";
                            break;
                    }
                    writeStatus("running");
                    if (exit !== null)
                        break;
                    // D9 pacing after requests; otherwise just yield the session lock long enough for a waiter to take it.
                    await sleep(madeRequests(step) ? paceMs("elapsedMs" in step ? step.elapsedMs : 0) : YIELD_MS);
                    if (lockLost)
                        break;
                }
                if (exit !== null)
                    break;
                if (newer) {
                    exit = "newer-firing";
                    break;
                }
                // LIVE FIRINGS OUTRANK THE DRAIN: it runs only when this pass had no live work, and one delta at a time, so the queue is looked at again
                // before the next one.
                if (!worked && !newer) {
                    if (drainNotBefore > now()) {
                        waiting = true;
                    }
                    else {
                        const step = await drainIdleStep(cfg, drain, now);
                        switch (step.kind) {
                            case "delivered":
                                record("drain", "drain:delivered", step.elapsedMs);
                                drainFailures = 0;
                                worked = true;
                                lastProgressAt = now();
                                writeStatus("running");
                                await sleep(paceMs(step.elapsedMs));
                                break;
                            case "later":
                                drainFailures += 1;
                                drainNotBefore = now() + waitAfterLaterMs(drainFailures, step.retryAfterMs, random);
                                record("drain", "drain:later", step.elapsedMs);
                                waiting = true;
                                writeStatus("running");
                                break;
                            case "held":
                                // F2a/c: a held (403) session costs one request, then the whole drain backs off like a `later`: the same session asked again
                                // every second was the flood. The backoff resets on a delivery.
                                drainFailures += 1;
                                drainNotBefore = now() + waitAfterLaterMs(drainFailures, undefined, random);
                                record("drain", "drain:held", step.elapsedMs);
                                waiting = true;
                                writeStatus("running");
                                await sleep(paceMs(step.elapsedMs));
                                break;
                            case "fatal":
                                record("drain", "drain:fatal", step.elapsedMs);
                                exit = "fatal";
                                break;
                            case "idle":
                                break;
                        }
                        if (exit !== null)
                            break;
                    }
                }
                if (!worked) {
                    if (!waiting && ![...firingSessions(opts.home)].some((stem) => owes(cfg, stem))) {
                        exit = "idle";
                        break;
                    }
                    await sleep(IDLE_POLL_MS);
                }
            }
            // ⛔ "EXITED" IS WRITTEN WHILE THE LOCK IS STILL OURS (P1's F3). Written after the release, a successor that claimed in the gap and wrote
            // "running" would be overwritten by this stale "exited", and the hook's notices and `status` read this file. Then the test seam, then the release.
            writeStatus("exited", exit ?? "idle");
            opts.beforeRelease?.();
        }
        finally {
            clearInterval(beat);
            // Release FIRST, look at the queue SECOND: the hook appends first and checks the lock second, so at least one side sees the other.
            claim.release();
        }
        if (exit === "idle" && firingSessions(opts.home).some((stem) => owes(cfg, stem))) {
            // A firing arrived between the last look and the release, and the hook that wrote it saw our lock still held and did not spawn.
            continue;
        }
        return exit ?? "idle";
    }
}
/** The process entry for `__upload-worker`: real clock, real env. Never throws, never prints, always exits 0. */
export async function runUploadWorkerMain(env, home, selfPath = process.argv[1] ?? "") {
    try {
        await runUploadWorker({ home, env, nodeVersion: process.versions.node, selfPath });
    }
    catch {
        // A detached process has nobody to tell.
    }
    return 0;
}
//# sourceMappingURL=upload_worker.js.map