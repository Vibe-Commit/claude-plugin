/**
 * WHAT `vibecommit status` SAYS ABOUT THE BACKGROUND UPLOADER — U7 (plan §3.8).
 *
 * ⛔ COMPUTED FROM FIRING LOGS AGAINST LEDGERS, NEVER FROM THE WORKER'S OWN CLAIM. A worker that died mid-step leaves a status file that says
 * "running" forever; trusting it would show a dead uploader as healthy (memory: live-state-must-prove-it-is-current). So "how far behind" is the
 * firings nobody has consumed (the hook's own record) measured against what the ledgers say was acknowledged, and "is it running" is the worker's
 * LOCK being fresh (`uploaderAlive`, which dates the lock the way the hook does), with the status file consulted only for WHEN and HOW the last
 * attempts went.
 *
 * `sessions_checked` is the denominator: how many firing logs were looked at. An empty scan (0 of 0) is a different answer than "checked 40, all caught up",
 * and the JSON says which.
 *
 * Counts, classes and times only. No session id, path or body leaves this module.
 */
import { STATUS, relativeAge } from "./copy/index.js";
import { firingSessions, readCursor, readFirings } from "./firing.js";
import { uploaderAlive } from "./hooks/fire_lock.js";
import { identityDigest } from "./identity.js";
import { ingestUrl } from "./post.js";
import { loadTargetRecord } from "./session_targets.js";
import { fileState, loadSessionState } from "./state.js";
import { labelled } from "./term.js";
import { readUploaderStatus } from "./uploader_status.js";
const DELIVERED = new Set(["done:delivered", "drain:delivered", "more"]);
function problemOf(klass) {
    if (klass === "later" || klass === "drain:later")
        return "no_answer";
    if (klass.startsWith("fatal:") || klass === "drain:fatal")
        return "credential";
    if (klass.startsWith("threw:") || klass === "escaped")
        return "error";
    return null;
}
export function uploaderView(home, env, nowMs) {
    const stems = firingSessions(home);
    let sessions = 0;
    let bytes = 0;
    for (const stem of stems) {
        const cursor = readCursor(home, stem);
        const owed = readFirings(home, stem, cursor.offset).firings;
        if (owed.length === 0)
            continue;
        sessions += 1;
        // What the NEWEST owed firing wants delivered, less what the slowest of the session's ledgers has acknowledged. A session the worker has not
        // reached has no record yet: all of it is owed.
        const last = owed[owed.length - 1].firing;
        const record = loadTargetRecord(home, last.sid);
        const acked = record === null || record.targets.length === 0
            ? 0
            : Math.min(...record.targets.map((target) => fileState(loadSessionState(home, { repoKey: target.ledgerKey, sessionId: last.sid }), "main").sentOffset));
        bytes += Math.max(0, last.eof - acked);
    }
    const url = ingestUrl(env);
    const identity = url === null ? null : identityDigest({ url, env });
    const status = identity === null ? null : readUploaderStatus(home, identity);
    const alive = identity !== null && uploaderAlive(home, identity, nowMs);
    const outcomes = status?.outcomes ?? [];
    const ack = [...outcomes].reverse().find((outcome) => DELIVERED.has(outcome.class)) ?? null;
    const attempt = outcomes.length === 0 ? null : outcomes[outcomes.length - 1];
    const problem = attempt === null ? null : problemOf(attempt.class);
    let state;
    if (sessions === 0)
        state = "up_to_date";
    else if (!alive)
        state = "not_running";
    else if (problem === "no_answer" && (ack === null || attempt === null || attempt.at >= ack.at))
        state = "waiting_to_retry";
    else
        state = "sending";
    return {
        state,
        heartbeatAgeMs: status === null ? null : Math.max(0, nowMs - status.heartbeatAt),
        behind: { sessions, bytes, sessionsChecked: stems.length },
        lastAckAtMs: ack === null ? null : ack.at,
        lastAttempt: attempt === null ? null : { atMs: attempt.at, outcome: attempt.class, problem, elapsedMs: attempt.elapsedMs },
    };
}
/** The `--json` `uploader` object (plan §3.8). `last_attempt.status` is `null`: the worker records the class of an attempt, not an HTTP status (a recorded deviation). */
export function uploaderJson(view) {
    return {
        state: view.state,
        heartbeat_age_ms: view.heartbeatAgeMs,
        behind: { sessions: view.behind.sessions, bytes: view.behind.bytes, sessions_checked: view.behind.sessionsChecked },
        last_ack_at_ms: view.lastAckAtMs,
        last_attempt: view.lastAttempt === null ? null : { at_ms: view.lastAttempt.atMs, outcome: view.lastAttempt.outcome, status: null, elapsed_ms: view.lastAttempt.elapsedMs },
    };
}
/** The screen rows: none until something has ever been recorded for upload (an empty scan says nothing, and the JSON still reports `sessions_checked: 0`). */
export function uploaderRows(view, nowMs, indent) {
    if (view.behind.sessionsChecked === 0)
        return [];
    const rows = [
        labelled(indent, STATUS.uploadLabel, STATUS.uploadValue({
            state: view.state,
            sessions: view.behind.sessions,
            bytes: view.behind.bytes,
            ackAge: view.lastAckAtMs === null ? null : relativeAge(view.lastAckAtMs, nowMs),
            attemptAge: view.lastAttempt === null ? null : relativeAge(view.lastAttempt.atMs, nowMs),
            problem: view.lastAttempt?.problem ?? null,
        })),
    ];
    if (view.state === "not_running")
        rows.push(labelled(indent, "", STATUS.uploadNotRunning));
    return rows;
}
//# sourceMappingURL=uploader_view.js.map