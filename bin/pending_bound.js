/**
 * THE PROMOTION BOUND — `TODOS[176]`; revised after VG's review of 68eb3a7 (option A, VL ruling 2026-10-05).
 *
 * A pending line is promoted into the wire spool by its own session's running hook. Since the cold rung also holds the
 * lines of a RESUMED session (state file present but not live), a pending line can be days old when that session's hook
 * finally runs: a terminal that still exports the session id, committing by hand, would otherwise have those commits
 * adopted as the session's own the moment it resumed. So a line is promoted only if it was OBSERVED no earlier than the
 * START OF THE TURN the hook is delivering: `observedAt >= turnStart`.
 *
 * ## What "the start of the turn" is — and what 68eb3a7 got wrong
 * 68eb3a7 compared against the FIRST unsent record. Measured with real `claude -p` (VG), that is not the turn start:
 *   1. A session left OPEN and idle (no SessionEnd flush): after a Stop, the first unsent record is the previous Stop's
 *      TRAILING record (attachment / stop_hook_summary), stamped at the OLD Stop time, so a lingering-id commit anywhere in
 *      the idle gap passed `>=` and was adopted.
 *   2. Many real records carry NO timestamp (mode, agent-name, custom-title, last-prompt, permission-mode,
 *      file-history-snapshot, cost-state); "no bound can be computed" then meant "keep", which adopted lines 0.4.0 refused.
 * So the turn start is the timestamp of the first unsent PROMPT-LIKE record, found by SKIPPING everything else:
 *   - `type:"user"` whose `message.content` is a STRING (a tool_result is an array; an `isMeta` record is skipped), or
 *   - `type:"queue-operation"` with `operation:"enqueue"` (the resume-time record `claude -p --resume` writes first).
 * Local slash-command / `!` records are skipped (`LOCAL_RECORD`).
 * A prompt always precedes the turn's tool calls, so it is never later than a commit made in the turn.
 *
 * ## Which clock is compared to which
 * `observedAt` is the WALL CLOCK of the `post-commit` process (our process clock, written when the line was spooled).
 * The prompt time is the `timestamp` the AGENT wrote on that record. ⛔ NEVER the committer date: it is settable
 * (`GIT_COMMITTER_DATE`, `rebase --committer-date-is-author-date`). STRICT `>=`, no tolerance.
 *
 * ## The scan cap (stated): at most 64 complete records, and 8 MiB, from the sent offset — read in 64 KiB chunks
 * 0.4.1 read ONE 64 KiB window; a big record (an attachment, a large tool_result) before the prompt pushed it out in ~1.8% of
 * resumes (VG), and the line was dropped. Now the file is read in chunks until a prompt-like record with a timestamp is
 * found, so a big record no longer hides the prompt. The 64-RECORD cap is unchanged, and an 8 MiB ceiling stops one
 * pathological record from making a hook read for ever. Garbled lines and records without a valid timestamp are skipped and
 * count toward the 64. A trailing unterminated line is not a record. A prompt beyond either cap is not found.
 *
 * ## What happens when no prompt time is found — the two paths differ ON PURPOSE
 *   - STALE-OWN path (the session's state file already existed): the line is DROPPED. That is exactly what 0.4.0 did with
 *     such a line (it never wrote one), so dropping adopts nothing 0.4.0 refused. A line with no `observedAt` is dropped
 *     too: no 0.4.0 client wrote a stale-own pending line, so it cannot be ours.
 *   - FIRST-TURN path (no state file yet): the line is KEPT. There the first record IS the prompt, and keeping is today's
 *     behaviour. A legacy 0.4.0 line (no `observedAt`) is kept on this path only.
 * A prompt dated AFTER the hook's own clock (skew: a record cannot be written ahead of now) disables the bound on both
 * paths (kept): a bound that is demonstrably wrong must not drop a legitimate line.
 *
 * ## The cost, accepted (the safe direction: a lost edge, never a wrong one)
 * A commit whose line is promoted by a hook whose unsent span has no prompt (its tool_result is the first unsent record,
 * e.g. a hook that delivered the tool_use before the commit without refreshing liveAt) is dropped on the stale-own path.
 */
import { closeSync, openSync, readSync } from "node:fs";
/** The scan reads this many bytes at a time from the sent offset… */
export const SCAN_CHUNK_BYTES = 64 * 1024;
/** …and at most this many in all (a whole number of chunks). Past it the answer is `none`. */
export const SCAN_MAX_BYTES = 8 * 1024 * 1024;
/** …and considers at most this many complete records. */
export const SCAN_MAX_RECORDS = 64;
const NONE = { kind: "none" };
function isPromptLike(rec) {
    if (rec.type === "queue-operation")
        return rec.operation === "enqueue";
    if (rec.type !== "user" || rec.isMeta === true)
        return false;
    const message = rec.message;
    if (message === null || typeof message !== "object")
        return false;
    const content = message.content;
    return typeof content === "string" && !LOCAL_RECORD.test(content);
}
/**
 * A LOCAL record the CLI writes for a slash command or a `!` shell escape (`<command-name>`, `<command-message>`,
 * `<local-command-…>`, `<bash-…>`) is `type:"user"` with STRING content and not `isMeta`, but it starts no model turn and
 * triggers no Stop. Run as the last thing before an idle spell it is still unsent at the next turn's hook, stamped HOURS
 * before the real prompt, so a lingering-id line observed in between would pass `>=` (VG, cell 12). Skipped. The price is
 * the safe direction: a turn started ONLY by such a record has no turn start, so a stale-own line is dropped. Anchored at
 * the start of the trimmed text: a real prompt that merely MENTIONS a tag still counts.
 */
const LOCAL_RECORD = /^\s*<(?:command-name>|command-message>|local-command|bash-)/;
/**
 * The turn start of the unsent span of `path` beginning at byte `offset`, as the timestamp of the first prompt-like
 * record with a valid timestamp (see the header). `nowMs` is the hook's own clock (the skew guard).
 */
export function turnStart(path, offset, nowMs) {
    if (!Number.isSafeInteger(offset) || offset < 0)
        return NONE;
    let fd = null;
    try {
        fd = openSync(path, "r");
        const buf = Buffer.alloc(SCAN_CHUNK_BYTES);
        // A record that crosses a chunk boundary is carried in `partial` as BYTES (never decoded early: a multi-byte character
        // may be cut by the boundary) and decoded only once its newline arrives.
        let partial = [];
        let records = 0;
        let read = 0;
        while (read < SCAN_MAX_BYTES) {
            const got = readSync(fd, buf, 0, SCAN_CHUNK_BYTES, offset + read);
            if (got <= 0)
                break;
            read += got;
            let start = 0;
            for (let nl = buf.indexOf(0x0a, 0); nl !== -1 && nl < got; nl = buf.indexOf(0x0a, start)) {
                const text = Buffer.concat([...partial, buf.subarray(start, nl)]).toString("utf8");
                partial = [];
                start = nl + 1;
                records += 1;
                if (records > SCAN_MAX_RECORDS)
                    return NONE;
                const found = promptStart(text, nowMs);
                if (found !== null)
                    return found;
            }
            partial.push(Buffer.from(buf.subarray(start, got))); // copy: `buf` is reused by the next read
        }
        return NONE;
    }
    catch {
        return NONE;
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
/** One complete record: its turn-start answer if it is a prompt-like record with a valid timestamp, else null. */
function promptStart(line, nowMs) {
    let rec;
    try {
        rec = JSON.parse(line);
    }
    catch {
        return null;
    }
    if (rec === null || typeof rec !== "object" || Array.isArray(rec))
        return null;
    const r = rec;
    if (!isPromptLike(r) || typeof r.timestamp !== "string")
        return null;
    const ms = Date.parse(r.timestamp);
    if (!Number.isFinite(ms))
        return null;
    return ms > nowMs ? { kind: "future" } : { kind: "ts", ms };
}
/** Keep (promote) this pending line? See the header for the two paths. */
export function keepsPendingLine(line, bound, mode) {
    if (bound.kind === "future")
        return true;
    if (bound.kind === "none")
        return mode === "first-turn";
    if (line.observedAt === undefined)
        return mode === "first-turn";
    return line.observedAt >= bound.ms;
}
//# sourceMappingURL=pending_bound.js.map