/**
 * Where the failure policy's decisions are remembered — CR-018.
 *
 * `policy.ts` decides; this module persists. The split is what keeps every
 * classification and both backlog caps testable without a filesystem.
 *
 * ## The binding key — `CR-017d`
 *
 * `(repoKey, sessionId)`, and the repo half is REQUIRED. `CR-018` shipped this
 * module keyed on the session alone, deliberately and one dimension short; D58
 * names what that costs: *"The server key gains repo; the client offset state did
 * not, so a `prefix_sha256` resync would duplicate repo 1's turns into repo 2."*
 * The key lives in the path (`sessionStatePath`, which refuses to produce one
 * without a repo), so there is no bucket for a caller that cannot say which repo
 * it is in. `files` is untouched — it is already keyed by `FileKey`, which is the
 * `file_key` of the server's four-column key.
 *
 * What `CR-018` needed, and the only reason this module exists a wave early, is
 * that its three classes are *defined* in terms of an offset: `later` holds one,
 * `never` advances one, and neither means anything without somewhere to keep it.
 * `CR-016` left a bootstrap that re-sent from byte 0 every time and said,
 * correctly, not to build a backlog policy on that. This is the alternative it was
 * pointing at, kept as thin as the policy allows.
 *
 * ## Failure posture
 *
 * Every read failure yields the empty state. That direction is a RESYNC — the
 * client re-sends from offset 0 and the server is idempotent on
 * `(repo, session, offset)` — rather than a silent skip, which would be data
 * loss. The one thing lost with it is a recorded `fatal` stop, and a revoked
 * credential simply 401s again on the next attempt and re-stops.
 *
 * Two hooks racing in one session can lose an update to each other. The
 * consequence is a re-send from a stale offset, which the server treats as a
 * resync — so this is left unlocked rather than paying for a lockfile on the
 * hook's wall-clock budget.
 */
import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pendingFileExpired } from "./pending_prune.js";
import { repoSessionsDir, sessionStatePath } from "./paths.js";
import { EMPTY_FILE_STATE } from "./policy.js";
import { SESSION_LIVE_WINDOW_MS, WIRE_RUNGS, readInferred, readRewrites, readSpool } from "./spool.js";
export const EMPTY_SESSION_STATE = {
    seq: 0,
    stop: null,
    files: {},
    endHold: null,
    lastReceipt: null,
    endedAt: null,
    finalized: null,
    liveAt: null,
};
export function loadSessionState(home, key) {
    const path = sessionStatePath(home, key);
    // No repo, no key, no read. Falling back to a session-only file here is the
    // whole of D58: it is the one path on which two repos share an offset ledger.
    if (path === null)
        return EMPTY_SESSION_STATE;
    return readStateAt(path);
}
/** One state file, or the empty state. Every failure yields empty — a RESYNC. */
function readStateAt(path) {
    let raw;
    try {
        raw = readFileSync(path, "utf8");
    }
    catch {
        return EMPTY_SESSION_STATE;
    }
    try {
        return parseSessionState(JSON.parse(raw));
    }
    catch {
        return EMPTY_SESSION_STATE;
    }
}
/**
 * When did this REPO last deliver anything, and at what `seq` — `CR-021`.
 *
 * A scan, deliberately, and not a second index. `status` is interactive and has
 * no `session_id`, so it cannot address a session file the way a hook can; it
 * knows only the repo. The alternative — a per-repo "latest" pointer written on
 * every successful send — is a second source of truth for a fact the session
 * files already hold, and it would be the one that goes stale.
 *
 * The directory holds one small JSON per session for one repo, read once per
 * `status` invocation on a human's keypress. There is no budget here worth
 * trading correctness for.
 *
 * Null means nothing has ever been delivered for this repo. That is distinct
 * from `at: 0`, which a pre-`CR-021` file parses to — both render as "nothing
 * recorded yet" rather than as a date.
 */
export function lastSendForRepo(home, repoKey) {
    const dir = repoSessionsDir(home, repoKey);
    if (dir === null)
        return null;
    let entries;
    try {
        entries = readdirSync(dir);
    }
    catch {
        // No directory means nothing was ever written for this repo.
        return null;
    }
    let best = null;
    for (const entry of entries) {
        if (!entry.endsWith(".json"))
            continue;
        const session = readStateAt(join(dir, entry));
        for (const file of Object.values(session.files)) {
            if (file.lastSentAt <= 0)
                continue;
            if (best === null || file.lastSentAt > best.at) {
                best = { at: file.lastSentAt, seq: session.seq };
            }
        }
    }
    return best;
}
/**
 * Every byte this repo's sessions WROTE OFF, across every session and file —
 * `CR-228`, `TODOS[142]`.
 *
 * ⛔ **THE COUNTERS EXISTED; NOTHING READ THEM.** `markSkipped` and `enforceCaps`
 * have always added to `gapBytes`/`gapCount`, and until this function no
 * consumer anywhere did — so `status` printed "ok Capture is on" over a session
 * whose 323,147 bytes were gone (`CR-227` Gate A). A written-off byte is never
 * re-offered (`sentOffset` is already past it), so this is the only place the
 * loss can ever be seen from this machine.
 *
 * ⛔ **NO `lastSentAt` FILTER, AND THAT IS THE POINT.** `lastSendForRepo` above
 * skips every stream that never delivered, and `markSkipped` deliberately
 * CARRIES `lastSentAt` — so a session that sent nothing and lost everything has
 * `lastSentAt === 0` and `gapCount > 0`. That is the measured failure's own
 * shape. A counter added inside that loop would read zero on exactly the case
 * that motivated it (VD, reviewing this task).
 *
 * A scan for the same reason `lastSendForRepo` is one: `status` has no
 * `session_id`, and a second index would be a second truth to go stale.
 */
export function writtenOffForRepo(home, repoKey) {
    const none = { bytes: 0, gaps: 0, sessions: 0 };
    const dir = repoSessionsDir(home, repoKey);
    if (dir === null)
        return none;
    let entries;
    try {
        entries = readdirSync(dir);
    }
    catch {
        return none;
    }
    let bytes = 0;
    let gaps = 0;
    let sessions = 0;
    for (const entry of entries) {
        if (!entry.endsWith(".json"))
            continue;
        const session = readStateAt(join(dir, entry));
        let holes = 0;
        for (const file of Object.values(session.files)) {
            bytes += file.gapBytes;
            holes += file.gapCount;
        }
        gaps += holes;
        if (holes > 0)
            sessions += 1;
    }
    return { bytes, gaps, sessions };
}
/**
 * Bytes a `SessionEnd` HELD that have not since been delivered — `CR-228`.
 *
 * The other half of `writtenOffForRepo`, and the reason the hold is not the
 * same defect with a longer fuse: a session that ended owing bytes is reported
 * as owing them for as long as it does. ⚠ A resumed session drains its hold on
 * its next successful send (measured — see `stampGaps`), and one never resumed
 * never does; this machine cannot know which a given session will be. So this
 * counts what is owed and claims nothing about recovery.
 */
export function heldAtEndForRepo(home, repoKey) {
    const none = { bytes: 0, sessions: 0 };
    const dir = repoSessionsDir(home, repoKey);
    if (dir === null)
        return none;
    let entries;
    try {
        entries = readdirSync(dir);
    }
    catch {
        return none;
    }
    let bytes = 0;
    let sessions = 0;
    for (const entry of entries) {
        if (!entry.endsWith(".json"))
            continue;
        const session = readStateAt(join(dir, entry));
        if (session.endHold === null)
            continue;
        let owed = 0;
        for (const [fileKey, eof] of Object.entries(session.endHold.eof)) {
            owed += Math.max(0, eof - fileState(session, fileKey).sentOffset);
        }
        bytes += owed;
        if (owed > 0)
            sessions += 1;
    }
    return { bytes, sessions };
}
/**
 * Bytes a file holds that `heldAtEndForRepo` does NOT already claim — `TODOS[184]`, VG's D1.
 *
 * `heldAtEndForRepo` owns `[sentOffset, endHold.eof[file])`, keyed on the LAST `SessionEnd`'s snapshot. A
 * resumed session's hooks keep appending to `backlog` without ever re-stamping `endHold`, so the backlog's
 * tail beyond that snapshot (or the whole backlog, if `endHold` never claimed this file at all) belongs to
 * nobody today. This is that remainder — the offset range `heldAtEndForRepo` cannot see because arithmetic,
 * not a session field, is what tells the two apart (an `endedAt === null` gate double-counts or misses it,
 * measured in DESIGN.md's S3/S4).
 */
function unclaimedPendingBytes(fs, claimedEof) {
    if (fs.backlog.length === 0)
        return 0;
    const start = Math.max(fs.backlog[0].from, claimedEof ?? fs.backlog[0].from);
    return Math.max(0, fs.backlog[fs.backlog.length - 1].to - start);
}
/** The `at` of the first backlog span whose `.to` exceeds `claimedEof` — the oldest span `unclaimedPendingBytes` counts. */
function oldestUnclaimedAt(fs, claimedEof) {
    const claimedUpTo = claimedEof ?? fs.backlog[0]?.from ?? 0;
    for (const span of fs.backlog) {
        if (span.to > claimedUpTo)
            return span.at;
    }
    return null;
}
/**
 * Classify this session's MAIN file as `live_stuck`, `held_idle`, or neither.
 *
 * Deliberately MAIN ONLY, never a sub-agent file: a spooled commit rides the MAIN delivery by
 * construction (`entry.ts:841`'s own comment, carried over from `TODOS[182]`'s budget work), so this is
 * the one classification `stuckSpoolLinesForRepo` below needs — a sub-agent file being stuck says
 * nothing about whether a commit is waiting to go out. `stuckForRepo` (below) answers a DIFFERENT,
 * broader question — every file's unclaimed bytes, not just main's — and is not built from this
 * function. Returns which BUCKET (not a bare boolean) so a caller naming commits inside the
 * `liveStuck`/`heldIdle` sentence never attributes the same session's lines to both.
 */
function classifyMainStuck(session, nowMs, windowMs) {
    const fs = fileState(session, "main");
    const claimedEof = session.endHold?.eof.main;
    if (unclaimedPendingBytes(fs, claimedEof) === 0)
        return null;
    const live = session.liveAt !== null && nowMs - session.liveAt <= windowMs;
    if (!live)
        return "idle"; // no age bound — no hook is coming soon to retry.
    const oldest = oldestUnclaimedAt(fs, claimedEof);
    return oldest !== null && nowMs - oldest > windowMs ? "live" : null; // survived a full turn's retries, or not stuck at all.
}
const EMPTY_STUCK_GAUGES = {
    liveStuck: { bytes: 0, sessions: 0, ids: [] },
    heldIdle: { bytes: 0, sessions: 0, ids: [] },
};
/**
 * Bytes stuck in a LIVE session's backlog, vs. a session nobody has retried in a while — `TODOS[184]`.
 *
 * Partitioned by BYTE RANGE per file (VG's D1), never by `endedAt`: `unclaimedPendingBytes` excludes
 * whatever `heldAtEndForRepo` already owns for that file, so the two gauges are disjoint by arithmetic.
 * Which of `liveStuck`/`heldIdle` a session's unclaimed bytes fall into is decided purely by liveness —
 * `SessionState.liveAt` inside `SESSION_LIVE_WINDOW_MS` (`spool.ts`'s own hook-cadence constant, reused
 * rather than a new wall-clock guess) — and, for a live session, whether its OLDEST unclaimed span (across
 * every file) has itself survived a full turn's worth of retries. A live session whose unclaimed backlog
 * is all RECENT is reported by neither gauge: that is an ordinary in-flight hold, not a defect.
 */
export function stuckForRepo(home, repoKey, nowMs = Date.now(), windowMs = SESSION_LIVE_WINDOW_MS) {
    const dir = repoSessionsDir(home, repoKey);
    if (dir === null)
        return EMPTY_STUCK_GAUGES;
    let entries;
    try {
        entries = readdirSync(dir);
    }
    catch {
        return EMPTY_STUCK_GAUGES;
    }
    let liveBytes = 0;
    let liveSessions = 0;
    const liveIds = [];
    let idleBytes = 0;
    let idleSessions = 0;
    const idleIds = [];
    for (const entry of entries) {
        if (!entry.endsWith(".json"))
            continue;
        const sessionId = entry.slice(0, -".json".length);
        const session = readStateAt(join(dir, entry));
        const live = session.liveAt !== null && nowMs - session.liveAt <= windowMs;
        let sessionBytes = 0;
        let oldestAcrossFiles = null;
        for (const [fileKey, fs] of Object.entries(session.files)) {
            const claimedEof = session.endHold?.eof[fileKey];
            const unclaimed = unclaimedPendingBytes(fs, claimedEof);
            if (unclaimed === 0)
                continue;
            sessionBytes += unclaimed;
            const oldest = oldestUnclaimedAt(fs, claimedEof);
            if (oldest !== null && (oldestAcrossFiles === null || oldest < oldestAcrossFiles))
                oldestAcrossFiles = oldest;
        }
        if (sessionBytes === 0)
            continue;
        if (!live) {
            idleBytes += sessionBytes;
            idleSessions += 1;
            idleIds.push(sessionId);
        }
        else if (oldestAcrossFiles !== null && nowMs - oldestAcrossFiles > windowMs) {
            liveBytes += sessionBytes;
            liveSessions += 1;
            liveIds.push(sessionId);
        }
        // else: live, and every unclaimed span is recent — an ordinary in-flight hold, reported by neither gauge.
    }
    return {
        liveStuck: { bytes: liveBytes, sessions: liveSessions, ids: liveIds },
        heldIdle: { bytes: idleBytes, sessions: idleSessions, ids: idleIds },
    };
}
/** Commit lines waiting in a session's spool or pending file. */
function commitLinesFor(dir, stem, nowMs) {
    let n = 0;
    for (const suffix of [".spool.jsonl", ".pending.jsonl"]) {
        try {
            // `TODOS[175]`: an EXPIRED pending file (older than 7 days, nobody can claim it) is not "waiting"; spool lines always are.
            if (suffix === ".pending.jsonl" && pendingFileExpired(join(dir, `${stem}${suffix}`), nowMs))
                continue;
            n += readFileSync(join(dir, `${stem}${suffix}`), "utf8")
                .split("\n")
                .filter((l) => l.trim() !== "").length;
        }
        catch {
            /* no file: nothing waiting */
        }
    }
    return n;
}
/**
 * Sessions of this repo that ended with the last turn still open AND a loss to name — `TODOS[145]`.
 *
 * ⛔ **THE SERVER SEALS A TURN ONLY WHEN A FOLLOWING PROMPT ARRIVES**, so EVERY session ends with its last
 * turn open; raising that on every session would be noise and would teach the user to ignore the line.
 * The loss is real in two cases, and only those are named: the session NEVER sealed anything (a one-shot
 * run — none of it is recorded), or it ended with commits still waiting for a turn to close. A session
 * the caller already finalized, or whose newest delivery sealed something, is not listed. A header the
 * server did not send (`sealed: null`, an older server) is unknown, and unknown is not reported.
 */
export function openTailForRepo(home, repoKey, nowMs = Date.now()) {
    const none = { ids: [] };
    const dir = repoSessionsDir(home, repoKey);
    if (dir === null)
        return none;
    let entries;
    try {
        entries = readdirSync(dir);
    }
    catch {
        return none;
    }
    const found = [];
    for (const entry of entries) {
        if (!entry.endsWith(".json"))
            continue;
        const stem = entry.slice(0, -".json".length);
        const session = readStateAt(join(dir, entry));
        const r = session.lastReceipt;
        if (session.endedAt === null || r === null || r.sealed !== false)
            continue;
        if (session.finalized !== null && session.finalized.at >= r.at)
            continue;
        if (r.everSealed && commitLinesFor(dir, stem, nowMs) === 0)
            continue;
        found.push({ id: stem, endedAt: session.endedAt });
    }
    found.sort((a, b) => b.endedAt - a.endedAt);
    return { ids: found.map((f) => f.id) };
}
/** Commit lines this repo is holding because no turn has closed over them yet. */
export function commitsWaitingForRepo(home, repoKey, nowMs = Date.now()) {
    const dir = repoSessionsDir(home, repoKey);
    if (dir === null)
        return 0;
    let entries;
    try {
        entries = readdirSync(dir);
    }
    catch {
        return 0;
    }
    let n = 0;
    for (const entry of entries) {
        if (!entry.endsWith(".spool.jsonl") && !entry.endsWith(".pending.jsonl"))
            continue;
        // ⛔⛔ `TODOS[182]` (VG's B1, VL's V3 ruling) — a LEAN session's `.spool.jsonl` is excluded here
        // ENTIRELY, never partially. "Waiting for a turn to close" promises a future send; under STICKY
        // lean no commit on this file will EVER be sent again, sendable or held, so the sentence this count
        // feeds is false for all of it, not just the sendable part. These lines are reported exactly once,
        // under `leanHeldForRepo`'s count (sendable only — see its own docblock for why a held line is NOT
        // double-counted there either), never here. `.pending.jsonl` is untouched: it predates promotion into
        // the wire mechanism lean governs, so lean says nothing about it.
        if (entry.endsWith(".spool.jsonl") && fileState(readStateAt(join(dir, `${entry.slice(0, -".spool.jsonl".length)}.json`)), "main").lean) {
            continue;
        }
        try {
            if (entry.endsWith(".pending.jsonl") && pendingFileExpired(join(dir, entry), nowMs))
                continue; // `TODOS[175]`
            n += readFileSync(join(dir, entry), "utf8").split("\n").filter((l) => l.trim() !== "").length;
        }
        catch {
            /* a vanished file holds nothing */
        }
    }
    return n;
}
const EMPTY_STUCK_SPOOL_LINES = { liveCommits: 0, idleCommits: 0 };
/**
 * `commitsWaitingForRepo`'s "waiting for a turn to close" is false for a commit whose own Stop already
 * fired and failed to deliver (measured, DESIGN.md's S8) — the turn DID close; what's actually pending is
 * delivery, the exact fact `live_stuck`/`held_idle` already name. `status.ts` subtracts THIS reader's
 * count from `commitsWaitingForRepo`'s for the rendered TEXT only; the JSON key and `commitsWaitingForRepo`
 * itself are never called differently and never change — this function does its own independent scan.
 *
 * ⛔⛔ **MIRRORS `commitsWaitingForRepo`'S OWN TWO EXCLUSIONS EXACTLY, same `nowMs`, same helpers** (VL's
 * required ruling on this ticket): it must count EXACTLY the stuck-session SUBSET of that function's
 * population, never a superset — so it skips a `.spool.jsonl` whose session is `lean` on `main` (the
 * SAME existing TODOS[182] exclusion `commitsWaitingForRepo` applies) and an EXPIRED `.pending.jsonl`
 * (the SAME existing TODOS[175] exclusion), and counts every remaining non-blank line with NO
 * `WIRE_RUNGS` filter — `commitsWaitingForRepo` has none either (confirmed by reading it: a flat
 * `split("\n").filter(...)`.length`, nothing rung-aware). A rung filter here, or either exclusion
 * missing, would make the stuck count larger than its own population and corrupt the subtraction
 * `status.ts` does — which is exactly why there is no `Math.max(0, …)` clamp anywhere around that
 * subtraction: this being a true subset is what the clamp would otherwise have to paper over.
 */
export function stuckSpoolLinesForRepo(home, repoKey, nowMs = Date.now(), windowMs = SESSION_LIVE_WINDOW_MS) {
    const dir = repoSessionsDir(home, repoKey);
    if (dir === null)
        return EMPTY_STUCK_SPOOL_LINES;
    let entries;
    try {
        entries = readdirSync(dir);
    }
    catch {
        return EMPTY_STUCK_SPOOL_LINES;
    }
    let liveCommits = 0;
    let idleCommits = 0;
    for (const entry of entries) {
        if (!entry.endsWith(".spool.jsonl") && !entry.endsWith(".pending.jsonl"))
            continue;
        const stem = entry.endsWith(".spool.jsonl")
            ? entry.slice(0, -".spool.jsonl".length)
            : entry.slice(0, -".pending.jsonl".length);
        const session = readStateAt(join(dir, `${stem}.json`));
        if (entry.endsWith(".spool.jsonl") && fileState(session, "main").lean)
            continue;
        const cls = classifyMainStuck(session, nowMs, windowMs);
        if (cls === null)
            continue;
        try {
            if (entry.endsWith(".pending.jsonl") && pendingFileExpired(join(dir, entry), nowMs))
                continue;
            const lines = readFileSync(join(dir, entry), "utf8").split("\n").filter((l) => l.trim() !== "").length;
            if (cls === "live")
                liveCommits += lines;
            else
                idleCommits += lines;
        }
        catch {
            /* a vanished file holds nothing */
        }
    }
    return { liveCommits, idleCommits };
}
/**
 * How many inferred pairs this REPO has spooled right now, across every session, waiting on an ack that has
 * not (yet) come back `n == sent` (VL, 2026-10-08: "count it in status, e.g. `inferred_unacknowledged`"). A
 * live gauge, not a cumulative tally like `inferred_tally.ts`'s oversize/sha256 — a pair stops counting the
 * moment it is acknowledged, same as `commitsWaitingForRepo`'s shape for the exact-commit spool.
 *
 * Moved here from `spool.ts` (`TODOS[182]`): this function now needs `FileState.lean`, which lives in
 * `SessionState` (`state.ts`'s own domain) — `spool.ts` cannot import this module without a cycle, since
 * `state.ts` already imports several `spool.ts` read/cap functions.
 *
 * ⛔⛔ A LEAN session's `.inferred.jsonl` is excluded ENTIRELY, same reasoning as `commitsWaitingForRepo`
 * above: "waiting for the server to confirm them" is false under sticky lean, and the pairs are reported
 * exactly once, under `leanHeldForRepo`.
 */
export function inferredUnacknowledgedForRepo(home, repoKey) {
    const dir = repoSessionsDir(home, repoKey);
    if (dir === null)
        return 0;
    let entries;
    try {
        entries = readdirSync(dir);
    }
    catch {
        return 0;
    }
    let n = 0;
    for (const entry of entries) {
        if (!entry.endsWith(".inferred.jsonl"))
            continue;
        const sessionId = entry.slice(0, -".inferred.jsonl".length);
        if (fileState(readStateAt(join(dir, `${sessionId}.json`)), "main").lean)
            continue;
        try {
            n += readInferred(home, { repoKey, sessionId }).length;
        }
        catch {
            /* one unreadable session file must not stop the count */
        }
    }
    return n;
}
const EMPTY_LEAN_HELD = { commits: 0, rewrites: 0, inferred: 0 };
/**
 * How many SENDABLE commits/rewrites/inferred pairs this repo is currently holding back because a session
 * went `lean`, broken out by kind — `TODOS[182]`. A live count, like `commitsWaitingForRepo`'s shape, not a
 * durable tally: there is no age-based prune for `.spool.jsonl`/`.rewrites.jsonl` (`pending_prune.ts:18-20`,
 * verbatim — "never touched") and `deleteInferredSpool` only ever fires on full resolution, so held-back
 * data here persists until a future lean-or-not request actually calls the cap functions again. There is no
 * discard event for a durable tally to attach to, and a live read is therefore safe in a way the `[177]` C2
 * live gauge was not: that gauge double-counted against a durable tally because its underlying file COULD be
 * deleted by a prune/finalize race out from under it — these files have no such deleter while unresolved.
 *
 * ⛔ **SENDABLE ONLY, NEVER A RAW LINE COUNT, AND NEVER THROUGH `capSpool`/`capSuccessors`/`capInferred`.**
 * Two separate reasons, not one:
 *  1. A held (non-wire-rung) commit line is never sendable for a reason unrelated to `lean`, and would be
 *     dropped on any ordinary 2xx regardless — counting it here would conflate two different stuck-reasons
 *     behind one number, and under STICKY `lean` it would never get swept up by a later non-lean request IN
 *     THIS SESSION either (lean never clears), so it would inflate "held because too large" with something
 *     lean never caused and can never fix. `WIRE_RUNGS` is the filter that separates the two; `capSpool`'s
 *     own `.shas` already applies it, which is why commits use it directly below.
 *  2. `capSpool`/`capSuccessors`/`capInferred` each return only the FIRST wire-eligible batch (32 shas, 16
 *     pairs, one inferred group) — correct for deciding what goes on THIS request, wrong for counting
 *     everything a session is holding, which can be larger. Rewrites and inferred pairs have no held/
 *     sendable split at all (every line is wire-eligible), so they are counted directly from the raw read,
 *     uncapped.
 */
export function leanHeldForRepo(home, repoKey) {
    const dir = repoSessionsDir(home, repoKey);
    if (dir === null)
        return EMPTY_LEAN_HELD;
    let entries;
    try {
        entries = readdirSync(dir);
    }
    catch {
        return EMPTY_LEAN_HELD;
    }
    let commits = 0;
    let rewrites = 0;
    let inferred = 0;
    for (const entry of entries) {
        if (!entry.endsWith(".json"))
            continue;
        const sessionId = entry.slice(0, -".json".length);
        const session = readStateAt(join(dir, entry));
        if (!fileState(session, "main").lean)
            continue;
        const key = { repoKey, sessionId };
        try {
            commits += readSpool(home, key).filter((e) => WIRE_RUNGS.includes(e.attribution)).length;
            rewrites += readRewrites(home, key).length;
            inferred += readInferred(home, key).length;
        }
        catch {
            /* one unreadable session's spool must not stop the count */
        }
    }
    return { commits, rewrites, inferred };
}
/**
 * How many sessions in this repo have gone `lean` on ANY file, main or sub-agent — `TODOS[184]`, Gate C's
 * construction check K.
 *
 * `leanHeldForRepo` above counts SPOOLED data a lean session is holding back, which can read 0 for a
 * session that went lean with nothing currently spooled (a 431 on a hook carrying no new commits,
 * rewrites or inferred groups) — the flag itself is the only durable trace of that. A session, not a
 * line or a file, is the unit: two lean files in one session count once.
 */
export function leanSessionsForRepo(home, repoKey) {
    const dir = repoSessionsDir(home, repoKey);
    if (dir === null)
        return 0;
    let entries;
    try {
        entries = readdirSync(dir);
    }
    catch {
        return 0;
    }
    let n = 0;
    for (const entry of entries) {
        if (!entry.endsWith(".json"))
            continue;
        const session = readStateAt(join(dir, entry));
        if (Object.values(session.files).some((f) => f.lean))
            n += 1;
    }
    return n;
}
/** The newest main-stream receipt across this repo's sessions, or null. */
export function lastReceiptForRepo(home, repoKey) {
    const dir = repoSessionsDir(home, repoKey);
    if (dir === null)
        return null;
    let entries;
    try {
        entries = readdirSync(dir);
    }
    catch {
        return null;
    }
    let best = null;
    for (const entry of entries) {
        if (!entry.endsWith(".json"))
            continue;
        const r = readStateAt(join(dir, entry)).lastReceipt;
        if (r !== null && (best === null || r.at > best.at))
            best = r;
    }
    return best;
}
/** Persist. Returns false on any failure — the caller must not throw from a hook. */
export function saveSessionState(home, key, next) {
    const path = sessionStatePath(home, key);
    // Refusing to write is safe in the direction this module already fails: the
    // next invocation resyncs from 0. Writing under a placeholder key is not.
    if (path === null)
        return false;
    try {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        writeFileSync(path, `${JSON.stringify(next)}\n`, { mode: 0o600 });
        // `writeFileSync`'s `mode` is ignored when the file already exists.
        chmodSync(path, 0o600);
        return true;
    }
    catch {
        return false;
    }
}
export function fileState(session, fileKey) {
    return session.files[fileKey] ?? EMPTY_FILE_STATE;
}
export function withFileState(session, fileKey, next) {
    return { ...session, files: { ...session.files, [fileKey]: next } };
}
/**
 * Is this session stopped for THIS credential?
 *
 * A stop recorded against a different fingerprint does not apply: that is the
 * user having reconnected.
 */
export function isStopped(session, fingerprint) {
    return session.stop !== null && session.stop.fingerprint === fingerprint;
}
/**
 * Read back a persisted state defensively.
 *
 * Hand-written rather than trusted, for the same reason `consent.ts` validates
 * its allow list: this file lives in the user's home, is edited by nothing but
 * us, and would still be believed if something else wrote nonsense into it. A
 * bogus `sentOffset` would silently skip real turns.
 */
function parseSessionState(parsed) {
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return EMPTY_SESSION_STATE;
    }
    const o = parsed;
    const files = {};
    const rawFiles = o.files;
    if (rawFiles !== null && typeof rawFiles === "object" && !Array.isArray(rawFiles)) {
        for (const [key, value] of Object.entries(rawFiles)) {
            const state = parseFileState(value);
            if (state !== null)
                files[key] = state;
        }
    }
    return {
        seq: nonNegative(o.seq),
        stop: parseStop(o.stop),
        files,
        endHold: parseEndHold(o.endHold),
        lastReceipt: parseReceipt(o.lastReceipt),
        endedAt: positiveOrNull(o.endedAt),
        finalized: parseFinalized(o.finalized),
        liveAt: positiveOrNull(o.liveAt),
    };
}
/** Absent in every file written before `TODOS[145]`, which reads as "no delivery recorded". */
function parseReceipt(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        return null;
    const o = value;
    const at = nonNegative(o.at);
    if (at === 0)
        return null;
    const sealed = o.sealed === true ? true : o.sealed === false ? false : null;
    return { at, sealed, everSealed: o.everSealed === true || sealed === true };
}
function parseFinalized(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        return null;
    const o = value;
    const at = nonNegative(o.at);
    if (at === 0 || (o.ack !== "sealed" && o.ack !== "already"))
        return null;
    return { at, ack: o.ack };
}
function positiveOrNull(value) {
    const n = nonNegative(value);
    return n > 0 ? n : null;
}
/** Absent in every file written before `CR-228`, which reads as "held nothing". */
function parseEndHold(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        return null;
    const o = value;
    const rawEof = o.eof;
    if (rawEof === null || typeof rawEof !== "object" || Array.isArray(rawEof))
        return null;
    const eof = {};
    for (const [key, size] of Object.entries(rawEof)) {
        const n = nonNegative(size);
        if (n > 0)
            eof[key] = n;
    }
    if (Object.keys(eof).length === 0)
        return null;
    return { at: nonNegative(o.at), eof };
}
function parseStop(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        return null;
    const o = value;
    if (typeof o.at !== "string" || typeof o.fingerprint !== "string")
        return null;
    if (o.fingerprint === "")
        return null;
    return { at: o.at, fingerprint: o.fingerprint };
}
function parseFileState(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        return null;
    const o = value;
    const sentOffset = nonNegative(o.sentOffset);
    const backlog = [];
    if (Array.isArray(o.backlog)) {
        let cursor = sentOffset;
        for (const entry of o.backlog) {
            if (entry === null || typeof entry !== "object" || Array.isArray(entry))
                continue;
            const e = entry;
            const from = nonNegative(e.from);
            const to = nonNegative(e.to);
            const at = nonNegative(e.at);
            // Contiguity is an invariant of the writer, so a file that breaks it has
            // been tampered with or half-written. Stop at the break rather than trust
            // the rest: a non-contiguous backlog makes `pendingBytes` a fiction.
            if (from !== cursor || to <= from)
                break;
            backlog.push({ from, to, at });
            cursor = to;
        }
    }
    return {
        sentOffset,
        backlog,
        gapBytes: nonNegative(o.gapBytes),
        gapCount: nonNegative(o.gapCount),
        // Absent in any file written before `CR-021`. `nonNegative` yields 0, which
        // this codebase reads as "never sent" rather than as 1 January 1970.
        lastSentAt: nonNegative(o.lastSentAt),
        // `TODOS[182]`. Absent in any file written before this field existed, which
        // reads as `false` — "never gone lean" — the correct default: an old file's
        // history recorded no 431 for this to carry forward.
        lean: o.lean === true,
    };
}
function nonNegative(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0
        ? Math.floor(value)
        : 0;
}
//# sourceMappingURL=state.js.map