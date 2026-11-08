/**
 * COMMIT-EDGE T7 — `x-commits-pos`: where in a Cursor transcript each commit was made, as the SERVER can use it (plan `commit-edge-open-turn-plan-20261105.md`,
 * eng R5/D13-C; wire contract in the lanes file, "Commit placement headers").
 *
 * Cursor's transcripts carry no record times, so a Cursor commit cannot be placed by `x-commits-at`. `post-commit` records the transcript's byte size
 * (`SpoolEntry.observedPos`), and the delivery that carries the commit converts it, against the span it is actually sending, to one slot per sha:
 *
 *   `k`   the commit came after the k-th record of THIS delta (k >= 1, whole records only)
 *   `b`   the commit came before this delta's first record: it precedes the span
 *   ``    no position, a position past the span, or a delta that resynced from byte 0 (the file was replaced, so the position names a different file)
 *
 * The header is a comma list parallel to `x-commits`, sent only on a delivery whose agent is Cursor (the sender rule), omitted when every slot is empty,
 * and dropped on a lean request. A record is a line, and a record the redactor withholds is replaced by a line of the same length, so counting the RAW
 * transcript's lines counts the lines that went on the wire, withheld ones included (`redactLine`'s contract).
 */
import { closeSync, openSync, readSync } from "node:fs";
export const COMMITS_POS_HEADER = "x-commits-pos";
/** The number of complete lines (newline-terminated records) in `[from, to)` of a file, or `null` when it cannot be read. Never throws. */
export function countRecords(path, from, to) {
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to < from)
        return null;
    let fd = null;
    try {
        fd = openSync(path, "r");
        const chunk = Buffer.alloc(64 * 1024);
        let at = from;
        let lines = 0;
        while (at < to) {
            const want = Math.min(chunk.length, to - at);
            const n = readSync(fd, chunk, 0, want, at);
            if (n <= 0)
                return null; // the file is shorter than the position claims: not a count to trust
            for (let i = 0; i < n; i += 1)
                if (chunk[i] === 0x0a)
                    lines += 1;
            at += n;
        }
        return lines;
    }
    catch {
        return null;
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
/** One commit's slot. Pure but for the line count it is handed. */
export function positionSlot(pos, span, resynced, count) {
    if (pos === null || !Number.isSafeInteger(pos) || pos < 0 || resynced)
        return "";
    if (pos > span.to)
        return "";
    if (pos <= span.from)
        return "b";
    const k = count(span.from, pos);
    if (k === null)
        return "";
    return k === 0 ? "b" : String(k);
}
/**
 * `x-commits-pos`'s value for one delta, or `null` when it is not sent: a non-Cursor delivery, a list that does not pair with the shas, or no slot with a value.
 * `transcriptPath` is read only for the positions that fall inside the span.
 */
export function commitPositionSlots(observed, agent, span, resynced, transcriptPath) {
    const positions = observed.observedPos;
    if (agent !== "cursor" || positions === undefined || positions.length !== observed.shas.length)
        return null;
    const slots = positions.map((pos) => positionSlot(pos, span, resynced, (from, to) => countRecords(transcriptPath, from, to)));
    return slots.some((slot) => slot !== "") ? slots.join(",") : null;
}
//# sourceMappingURL=commit_pos.js.map