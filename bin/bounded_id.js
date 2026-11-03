/**
 * C75 (4): ONE bound for the non-path strings a transcript hands the client and the client keeps as keys (a call id, a tool name, a process session id, a script cell id).
 *
 * The checkpoint stores these (`CallEntry.id`, `droppedIds`, `droppedNamed`, `prunedIds`, the session and cell maps), and a transcript can hold a 3 MB value in any of them:
 * a record of the same size, written on every firing. An id longer than `MAX_ID_BYTES` is stored (and compared) as `sha256:` + the hex digest of its UTF-8 bytes, so two ids still match exactly when
 * they are the same string, and nothing a transcript names is kept at its own length. (A genuine id is a UUID, a `call_...` token or a small integer: all far under the bound.)
 * A tool NAME longer than the bound reads as "" (default deny: the name is not one of the tools the rules know).
 *
 * ⛔ The helper is applied where a string ENTERS (the scan, the delivery observer) and where one is LOOKED UP (a `write_stdin` / `wait` argument, a Claude `tool_use_id`),
 * never in between, so the checkpoint, the observer and the lookup always agree.
 */
import { createHash } from "node:crypto";
export const MAX_ID_BYTES = 128;
/** The id as the client keys it: itself, or (over `MAX_ID_BYTES`) `sha256:` + its hex digest (71 bytes). */
export function boundedId(id) {
    return Buffer.byteLength(id, "utf8") > MAX_ID_BYTES ? `sha256:${createHash("sha256").update(id, "utf8").digest("hex")}` : id;
}
/** A tool name as the client keeps it: itself, or "" (default deny) when longer than `MAX_ID_BYTES`. */
export function boundedName(name) {
    return Buffer.byteLength(name, "utf8") > MAX_ID_BYTES ? "" : name;
}
/**
 * C75 (8): the bytes ONE stream's call log may store (an entry's fixed cost and the `paths` and `files` of every entry, open and closed). Per-value caps (4,096 bytes a path, 4,096 files a
 * call, 256 open and 4,096 closed calls) multiply to gigabytes; this is the bound on the TABLE. A call that alone names more is UNKNOWN (not stored: UNJUDGED_FILE for Codex,
 * INCOMPLETE for Claude); a table that would pass it evicts its oldest entries through the existing eviction (the departed id is remembered, its output fails closed).
 */
export const CALL_LOG_BUDGET_BYTES = 1024 * 1024;
/** The bytes the strings take in the persisted record (UTF-8). */
export function bytesOf(strings) {
    let total = 0;
    for (const s of strings)
        total += Buffer.byteLength(s, "utf8");
    return total;
}
/** The JSON one stored string costs beyond its own text (quotes, a comma), or one folder of an id map (`{"dir":..., "at":...,"file":true}`) beyond its path. */
export const STRING_OVERHEAD_BYTES = 4;
export const DIR_OVERHEAD_BYTES = 48;
/** The bytes a list of strings takes in the persisted record: their text and their quoting. */
export function storedBytes(strings) {
    return bytesOf(strings) + STRING_OVERHEAD_BYTES * strings.length;
}
//# sourceMappingURL=bounded_id.js.map