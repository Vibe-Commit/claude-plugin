/**
 * THE FIRING LOG AND THE HOOK'S LIVENESS STAMP — U3 of the detached uploader.
 *
 * A *firing* is one hook that ended a turn: today's hook body, deferred. The hook appends one line saying "this turn ended here, at this
 * size, in this folder, with these repos" and returns; the upload worker (U5) replays the lines in order, each ALONE, with the values
 * recorded at the moment the hook fired (plan §3.2-§3.4, D15). This module is the storage half and nothing in the hook calls it yet:
 * it is inert until the hook is flipped (U6).
 *
 * ## What it owns
 *  - `<sid>.firings.jsonl` — append-only, one `O_APPEND` write per line, no lock (hooks never wait).
 *  - `<sid>.firings.cursor` — the worker's progress: a byte offset, and how many times the firing at that offset made the worker THROW.
 *    Written atomically, and only by a holder of the session's writer lock.
 *  - `<repo digest>/<sid>.live` — the hook-only liveness stamp, and the ONE function that reads liveness (`liveAtOf`).
 *
 * ## What a firing holds: paths and numbers only
 * No credential, no transcript content. The worker re-confines `transcript` and `announced` with `admitsTranscript` before every read.
 *
 * ## ⛔ A LEAF MODULE. It imports `paths` and `atomic_write` and nothing else of this package's, because `spool.ts` and `state.ts` both
 * read liveness through it and neither may import the other.
 */
import { appendFileSync, chmodSync, closeSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { writeFileAtomic } from "./atomic_write.js";
import { sessionFileStem, sessionFiringsCursorPath, sessionFiringsPath, sessionLivePath, targetsDir } from "./paths.js";
/** The line format this build writes and reads. A reader sees a NEWER `v` as a stop sign, never as garbage (§3.14). */
export const FIRING_VERSION = 1;
/** A line longer than this is not written: a firing is ~300 bytes, and one `O_APPEND` write of a small buffer is what keeps hooks lock-free. */
export const MAX_FIRING_BYTES = 32 * 1024;
/** After this many uncaught throws on one firing, the worker skips it. A firing only sets an EOF, so the next one still covers its bytes. */
export const MAX_FIRING_THROWS = 3;
/** More sub-agent files than this in one firing: the map is left out (uncapped) rather than growing the line past `MAX_FIRING_BYTES`. */
export const MAX_FIRING_SUB_FILES = 200;
// --- the log -------------------------------------------------------------------------------------------------------------------
/**
 * Append one firing. Returns false on any failure — a hook must never throw, and a missed firing self-heals: the NEXT firing's `eof`
 * covers the same bytes.
 *
 * ⛔ ONE `O_APPEND` WRITE. Two hooks (Cursor double-fires) interleave whole lines, never halves, so no lock is needed. A line over
 * `MAX_FIRING_BYTES` is refused rather than split.
 */
export function appendFiring(home, sessionId, firing) {
    try {
        const line = `${JSON.stringify(firing)}\n`;
        if (Buffer.byteLength(line) > MAX_FIRING_BYTES)
            return false;
        const path = sessionFiringsPath(home, sessionId);
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        appendFileSync(path, line, { mode: 0o600 });
        chmodSync(path, 0o600);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * What the hook calls: `appendFiring`, and if the line is refused while it carries a `sub` map, once more WITHOUT it (uncapped, the behaviour before
 * the cap existed). The map is the one part of a line that grows with the session; the cap must never cost a firing. Never throws.
 */
export function recordFiring(home, sessionId, firing) {
    if (appendFiring(home, sessionId, firing))
        return true;
    if (firing.sub === undefined)
        return false;
    const { sub: _dropped, ...withoutSub } = firing;
    return appendFiring(home, sessionId, withoutSub);
}
/**
 * The firings from `from` (a cursor offset) on. Never throws: an unreadable log reads as empty.
 *
 * A malformed COMPLETE line is skipped and counted in `through`. A trailing line with no newline is a hook mid-append and is left alone.
 * A line of a newer `v` stops the read and is not consumed (`blockedByNewer`).
 */
export function readFirings(home, sessionId, from = 0) {
    const empty = { firings: [], through: from, blockedByNewer: false };
    let fd = null;
    try {
        fd = openSync(sessionFiringsPath(home, sessionId), "r");
        const size = fstatSync(fd).size;
        if (!Number.isSafeInteger(from) || from < 0 || from >= size)
            return { ...empty, through: Math.min(Math.max(from, 0), size) };
        const buf = Buffer.alloc(size - from);
        let got = 0;
        while (got < buf.length) {
            const n = readSync(fd, buf, got, buf.length - got, from + got);
            if (n <= 0)
                break;
            got += n;
        }
        const firings = [];
        let through = from;
        let start = 0;
        for (let nl = buf.indexOf(0x0a, 0); nl !== -1 && nl < got; nl = buf.indexOf(0x0a, start)) {
            const parsed = parseFiring(buf.subarray(start, nl).toString("utf8"), sessionFileStem(sessionId));
            const lineStart = from + start;
            const lineEnd = from + nl + 1;
            if (parsed === "newer")
                return { firings, through, blockedByNewer: true };
            if (parsed !== null)
                firings.push({ firing: parsed, start: lineStart, end: lineEnd });
            through = lineEnd;
            start = nl + 1;
        }
        return { firings, through, blockedByNewer: false };
    }
    catch {
        return empty;
    }
    finally {
        if (fd !== null) {
            try {
                closeSync(fd);
            }
            catch {
                /* nothing to do */
            }
        }
    }
}
/** A valid firing, `"newer"` for a line of a version this build does not know, or null for anything else. */
function parseFiring(text, stem) {
    let raw;
    try {
        raw = JSON.parse(text);
    }
    catch {
        return null;
    }
    if (raw === null || typeof raw !== "object" || Array.isArray(raw))
        return null;
    const o = raw;
    if (typeof o.v !== "number" || !Number.isInteger(o.v) || o.v < 1)
        return null;
    if (o.v > FIRING_VERSION)
        return "newer";
    const str = (x) => typeof x === "string" && x !== "";
    if (typeof o.at !== "number" || !Number.isFinite(o.at) || o.at <= 0)
        return null;
    if (typeof o.eof !== "number" || !Number.isSafeInteger(o.eof) || o.eof < 0)
        return null;
    // `sid` must be THIS log's session: a line whose id sanitises to another file name could otherwise be replayed under another session's cursor,
    // lock and ledger. It is deliberately NOT required to be header-safe HERE: `sid` goes on the wire as `x-session-id` and delivery refuses an id the
    // wire cannot carry (`sessionIdSafe`, post.ts) as a LOUD write-off (`never`, a gap `status` counts). Dropping such a line at the parse would be a
    // new, differently-silent no-op (the 182 ruling); the id never reaches a header, a file name or a lock path except through `sanitise`.
    if (!str(o.sid) || o.sid.length > 512 || sessionFileStem(o.sid) !== stem)
        return null;
    if (!str(o.event) || !str(o.transcript) || !str(o.agent) || !str(o.id) || typeof o.cwd !== "string")
        return null;
    const prior = {};
    if (o.prior !== undefined) {
        if (o.prior === null || typeof o.prior !== "object" || Array.isArray(o.prior))
            return null;
        for (const [key, value] of Object.entries(o.prior)) {
            if (value === null)
                prior[key] = null;
            else if (typeof value === "number" && Number.isFinite(value) && value > 0)
                prior[key] = value;
            else
                return null;
        }
    }
    let keys;
    if (o.keys !== undefined) {
        const k = o.keys;
        if (k === null || typeof k !== "object" || !str(k.worktree) || !str(k.consent))
            return null;
        keys = { worktree: k.worktree, consent: k.consent };
    }
    if (o.slug !== undefined && !str(o.slug))
        return null;
    if (o.announced !== undefined && !str(o.announced))
        return null;
    // A `sub` map that is not exactly {key: non-negative integer} is IGNORED (the firing is uncapped, today's behaviour), never a reason to drop the firing.
    let sub;
    if (o.sub !== null && typeof o.sub === "object" && !Array.isArray(o.sub)) {
        const entries = Object.entries(o.sub);
        if (entries.length <= MAX_FIRING_SUB_FILES && entries.every(([, size]) => typeof size === "number" && Number.isSafeInteger(size) && size >= 0)) {
            sub = Object.fromEntries(entries);
        }
    }
    return {
        v: o.v,
        at: o.at,
        sid: o.sid,
        event: o.event,
        eof: o.eof,
        transcript: o.transcript,
        cwd: o.cwd,
        ...(keys === undefined ? {} : { keys }),
        ...(o.slug === undefined ? {} : { slug: o.slug }),
        agent: o.agent,
        id: o.id,
        prior,
        ...(o.announced === undefined ? {} : { announced: o.announced }),
        ...(sub === undefined ? {} : { sub }),
    };
}
const LOG_SUFFIX = ".firings.jsonl";
/**
 * Every session that has a firing log: the file stems, oldest-modified first (so a session that has waited longest is served first). A
 * stem is `sanitise(sid)`; it names the log and cursor files and nothing else, because the id to SEND is `Firing.sid`. Never throws.
 */
export function firingSessions(home) {
    try {
        const dir = targetsDir(home);
        return readdirSync(dir)
            .filter((name) => name.endsWith(LOG_SUFFIX) && name.length > LOG_SUFFIX.length)
            .map((name) => ({ stem: name.slice(0, -LOG_SUFFIX.length), at: modifiedAt(`${dir}/${name}`) }))
            .sort((a, b) => a.at - b.at || (a.stem < b.stem ? -1 : 1))
            .map((entry) => entry.stem);
    }
    catch {
        return [];
    }
}
function modifiedAt(path) {
    try {
        return statSync(path).mtimeMs;
    }
    catch {
        return 0;
    }
}
/** Forget a session's firing log and cursor (with its target record, on the existing 30-day schedule). Never throws. */
export function forgetFirings(home, sessionId) {
    for (const path of [sessionFiringsPath(home, sessionId), sessionFiringsCursorPath(home, sessionId)]) {
        try {
            rmSync(path, { force: true });
        }
        catch {
            /* an undeletable file is retried next schedule */
        }
    }
}
export const START_OF_LOG = { offset: 0, throws: 0 };
/**
 * The cursor, or the start of the log when it is missing or unreadable. Starting over is SAFE: replaying a consumed firing is a no-op
 * (`firing.eof <= sentOffset`, trap 1), just slower.
 */
export function readCursor(home, sessionId) {
    try {
        const raw = JSON.parse(readFileSync(sessionFiringsCursorPath(home, sessionId), "utf8"));
        const offset = raw.offset;
        const throws = raw.throws;
        if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0)
            return START_OF_LOG;
        return { offset, throws: typeof throws === "number" && Number.isSafeInteger(throws) && throws > 0 ? throws : 0 };
    }
    catch {
        return START_OF_LOG;
    }
}
/**
 * Persist the cursor atomically. ⛔ ONLY A HOLDER OF THE SESSION'S WRITER LOCK may call this, and only after a heartbeat that said the
 * lock is still its own (§3.3: "every cursor write beats first"); a worker that lost its lock writes nothing. Returns false on failure.
 */
export function writeCursor(home, sessionId, cursor) {
    try {
        const path = sessionFiringsCursorPath(home, sessionId);
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        writeFileAtomic(path, `${JSON.stringify({ v: 1, offset: cursor.offset, throws: cursor.throws })}\n`, 0o600);
        return true;
    }
    catch {
        return false;
    }
}
/** Move the cursor to `offset`; the throw count belongs to the firing it left, so it resets. */
export const advanced = (cursor, offset) => ({ offset: Math.max(cursor.offset, offset), throws: 0 });
/** The firing at the cursor made the worker throw once more. */
export const threw = (cursor) => ({ offset: cursor.offset, throws: cursor.throws + 1 });
/** Skip the firing at the cursor: it has thrown `MAX_FIRING_THROWS` times. */
export const shouldSkip = (cursor) => cursor.throws >= MAX_FIRING_THROWS;
// --- liveness ------------------------------------------------------------------------------------------------------------------
/**
 * Stamp "this session's hook ran at `atMs`" for one repo key. HOOK-ONLY: the worker runs `deliver` with `byHook: false` and never calls
 * this. A JSON object (`{at}`) rather than a bare number so P2's T7 can add `transcript` without a format change; the reader ignores
 * unknown fields. Atomic replace. Never throws; false on failure (the commit then falls to the cold rung or goes unrecorded, as today
 * before a first hook).
 */
export function stampLive(home, key, atMs) {
    const path = sessionLivePath(home, key);
    if (path === null || !Number.isFinite(atMs) || atMs <= 0)
        return false;
    try {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        writeFileAtomic(path, `${JSON.stringify({ at: atMs })}\n`, 0o600);
        return true;
    }
    catch {
        return false;
    }
}
/** The `.live` stamp at `path`, or null when absent, unreadable or not a positive number. Unknown fields are ignored. */
export function readLiveFile(path) {
    try {
        const at = JSON.parse(readFileSync(path, "utf8")).at;
        return typeof at === "number" && Number.isFinite(at) && at > 0 ? at : null;
    }
    catch {
        return null;
    }
}
/**
 * ⛔ THE ONE LIVENESS READER (§3.5). A session is live as of the LATER of its state file's `liveAt` (stamped by `deliver()` for a hook
 * delivery) and its `.live` file (stamped by the hook itself, before the worker has delivered anything). All three readers go through
 * this: `liveSessions` and `pendingModeFor` (`spool.ts`) and the two `status` classifiers (`state.ts`). Read straight from the files,
 * never from the mtime: a `finalize` that rewrites a dead session's state must not make it live (VG review 2, D2).
 */
export function liveAtOf(stateLiveAt, livePath) {
    const stamped = livePath === null ? null : readLiveFile(livePath);
    if (stamped === null)
        return stateLiveAt;
    return stateLiveAt === null ? stamped : Math.max(stateLiveAt, stamped);
}
/**
 * Which repo keys a hook stamps `.live` for (§3.5).
 *  - the turn-end repo, when allowed;
 *  - for a dialect that ISOLATES its content records (Claude Code, Codex): also every ledger key in the session's target record;
 *  - for one that does not (Cursor): the turn-end repo ONLY. Sticky targets stay in Cursor's record but are not delivered, and only
 *    delivered targets stamp today. Stamping them would keep a repo Cursor has left live for 30 minutes past every turn, a human's commit
 *    there would become `sole_live_session`, and the row is permanent.
 */
export function liveStampKeys(input) {
    const keys = new Set();
    if (input.turnEnd !== null && input.turnEnd !== "")
        keys.add(input.turnEnd);
    if (input.isolates)
        for (const key of input.recordLedgerKeys)
            if (key !== "")
                keys.add(key);
    return [...keys];
}
//# sourceMappingURL=firing.js.map