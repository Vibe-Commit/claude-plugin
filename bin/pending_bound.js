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
 * ## The scan cap (stated): at most 64 complete records and 64 KiB from the sent offset
 * Garbled lines and records without a valid timestamp are skipped and count toward the 64. A trailing unterminated line
 * is not a record. A prompt beyond either cap is not found.
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
/** The scan reads at most this many bytes from the sent offset. */
export const SCAN_WINDOW_BYTES = 64 * 1024;
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
        const buf = Buffer.alloc(SCAN_WINDOW_BYTES);
        const got = readSync(fd, buf, 0, SCAN_WINDOW_BYTES, offset);
        const text = buf.subarray(0, got).toString("utf8");
        const lines = text.split("\n");
        lines.pop(); // the tail after the last newline is not a complete record
        for (const line of lines.slice(0, SCAN_MAX_RECORDS)) {
            let rec;
            try {
                rec = JSON.parse(line);
            }
            catch {
                continue;
            }
            if (rec === null || typeof rec !== "object" || Array.isArray(rec))
                continue;
            const r = rec;
            if (!isPromptLike(r) || typeof r.timestamp !== "string")
                continue;
            const ms = Date.parse(r.timestamp);
            if (!Number.isFinite(ms))
                continue;
            return ms > nowMs ? { kind: "future" } : { kind: "ts", ms };
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