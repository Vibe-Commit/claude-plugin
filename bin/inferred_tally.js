/**
 * `TODOS[177]` — the counts of squash pairs that were DETECTED but never ended up recorded by the server, so the
 * silence is not a non-event.
 *
 * `oversize`/`sha256` are a contract limit of the server's `x-rewrites-inferred` reader, caught before the squash is
 * ever spooled: a fold of more than 64 commits (the server counts anything past 64 per request as dropped, and a
 * partial edge set is worse than none), and a sha256 repository (the server refuses 64-hex shas). Either way the
 * client emits NOTHING for that squash and counts it here instead — one per squash, since neither ever had pairs on
 * disk to count.
 *
 * ⛔⛔ `set_aside`/`pruned` (VL, 2026-10-08, VG's silent-loss finding over a real `finalize` short-ack run) exist
 * because set-aside and the 7-day prune both end by deleting or quietly carrying forward the group line a reader
 * would otherwise count from the live spool file. Without a durable record here, a group that was set aside and
 * then `finalize` deleted the (now fully-resolved) spool for — or one that aged out under the prune — left no
 * trace anywhere: MEASURED, `status` read 0 before the event and 0 after, as if 70 real pairs had never existed.
 * These two count PAIRS, recorded at the moment of the event, before any deletion can happen — which is what
 * makes deleting the spool afterward fine.
 *
 * ⚠ THIS TALLY IS THE ONE SOURCE OF TRUTH FOR `set_aside` (VG's follow-up finding, item (b)): an earlier version
 * of this fix also added a LIVE gauge (`inferredSetAsideForRepo` in `spool.ts`, reading the still-on-disk file
 * directly), which double-counted the SAME pairs once a group aged into the prune — `status` announced 80 pairs
 * for one 40-pair group, 40 from each source. That gauge is gone; `inferredUnacknowledgedForRepo` ("still
 * waiting on an ack," a genuinely different fact) is the only live gauge left in this area.
 *
 * Counts only — never a sha, a path or a branch. One small file per repo beside the session files, named so no
 * scanner matches it (`pruned-pending.tally`'s rule); a tally older than 7 days restarts instead of accumulating.
 * Never throws: this can run inside the user's `git commit`.
 *
 * ⛔ **APPEND-ONLY SINCE THE MULTI-SESSION ATTRIBUTION WAVE (D12 · OV3).** This used to read the JSON object, add to it and write it back with no lock, so the worker and a concurrent `backfill` or
 * `finalize` of another session in the same repo could lose an increment and turn a counted loss silent again. It is now one `O_APPEND` line per event (`event_tally.ts`, the same
 * core as `dropped-commits.tally` and `pruned-pending.tally`); the window, the units and `status`'s sentences are unchanged, and a file an older client wrote still reads (as events at its own time).
 */
import { join } from "node:path";
import { appendEvents, sumRun } from "./event_tally.js";
import { repoSessionsDir } from "./paths.js";
const TALLY_NAME = "inferred-skipped.tally";
const REASONS = ["oversize", "sha256", "set_aside", "pruned"];
/**
 * ⚠ A line written by 0.12.0 or earlier is ONE JSON object `{oversize, sha256, [set_aside, pruned,] at}`. It reads as up to four events at its own `at`. ADDITIVE as it always was:
 * `set_aside`/`pruned` default to 0 when absent (0.4.2 and earlier have neither), rather than invalidating the line.
 */
const SHAPE = {
    reasons: new Set(REASONS),
    legacy: (o) => {
        if (!(Number.isSafeInteger(o.oversize) && Number.isSafeInteger(o.sha256) && typeof o.at === "number" && Number.isFinite(o.at)))
            return null;
        const count = (v) => (Number.isSafeInteger(v) ? v : 0);
        return REASONS.map((r) => ({ r, n: count(o[r]), at: o.at })).filter((e) => e.n > 0);
    },
};
/**
 * Count `count` (default 1) pairs/squashes skipped for one reason. Never throws.
 *
 * ⛔⛔ `set_aside` and `pruned` (VL, 2026-10-08, VG's silent-loss finding) are PAIR counts — unlike `oversize`/
 * `sha256`, which count SQUASHES (an oversize/sha256 squash is never spooled, so there is nothing to count by
 * pair). Both record the ONLY durable trace of pairs that a live gauge (`inferredUnacknowledgedForRepo`) stops
 * counting the moment the file backing it is deleted or pruned. Called BEFORE that deletion — `set_aside` from
 * `post.ts` at the moment it calls `setAsideInferredGroup`, `pruned` from the prune sweep at the moment it
 * discards a group with NEITHER mark (never a delivered or already-tallied-set-aside one, or this would
 * double-count — `spool.ts`'s `settleInferred`) — so "deleting the spool is fine" (VL) because this tally is
 * what makes it fine.
 */
export function recordInferredSkipped(home, repoKey, reason, nowMs = Date.now(), count = 1) {
    try {
        const dir = repoSessionsDir(home, repoKey);
        if (dir === null)
            return;
        appendEvents(join(dir, TALLY_NAME), SHAPE, [{ r: reason, n: count }], nowMs);
    }
    catch {
        /* the event already happened; failing to count it must not throw */
    }
}
/** The counts to announce, or null when nothing was skipped in the last 7 days. */
export function readInferredSkipped(home, repoKey, nowMs) {
    const dir = repoSessionsDir(home, repoKey);
    if (dir === null)
        return null;
    const sums = sumRun(join(dir, TALLY_NAME), SHAPE, nowMs);
    if (sums === null || (sums.oversize === 0 && sums.sha256 === 0 && sums.set_aside === 0 && sums.pruned === 0))
        return null;
    return { oversize: sums.oversize, sha256: sums.sha256, set_aside: sums.set_aside, pruned: sums.pruned };
}
//# sourceMappingURL=inferred_tally.js.map