/**
 * The count of commit lines this machine saw and could NOT link to a session, by reason, so a loss is never silent (multi-session attribution, T5; D6 · OV3).
 *
 * Before this, a commit line the client could not send was deleted by the next 2xx with no log and no counter: L16's Codex commit was found only by reading prd by hand.
 * Every drop site now records here BEFORE it deletes. Counts only: never a sha, a session id, a path or a branch.
 *
 * ⛔ **APPEND-ONLY, ONE `O_APPEND` LINE PER EVENT, AND THE WINDOW IS THE OLDER TALLIES' RULE** — both from `event_tally.ts`, which holds them for all three tallies (OV3, D12).
 *
 * The file is named so no scanner of the sessions directory matches it (`pruned-pending.tally`'s rule). Nothing here throws: it can run inside the user's `git commit`.
 */
import { join } from "node:path";
import { appendEvents, sumRun } from "./event_tally.js";
import { repoSessionsDir } from "./paths.js";
export const DROPPED_TALLY_NAME = "dropped-commits.tally";
/**
 * Why a commit line was not linked. Each is recorded at ONE site, once:
 *   held_ambiguous      two or more sessions were live and nothing named which (`recency_heuristic`); consumed by a 2xx
 *   held_unmatched      the commit named a session that matches none (`env_session_unmatched`), or any other line that never goes on the wire; consumed by a 2xx
 *   agent_mismatch      no id, the commit's agent is known, and the only live session is a different known agent (D5): refused at `post-commit`, no line written
 *   walk_failed         two agents were evidenced and the process walk could not name the nearest (D4/D9): refused at `post-commit`, no line written
 *   pending_before_turn a waiting line observed before the turn being delivered started, or a stale session with no turn start: dropped by the promotion bound
 *   pending_over_cap    a waiting line past `MAX_PENDING_SHAS`: only the newest are kept
 *   torn                a malformed line inside a consumed region of the spool
 */
export const DROP_REASONS = ["held_ambiguous", "held_unmatched", "agent_mismatch", "walk_failed", "pending_before_turn", "pending_over_cap", "torn"];
const SHAPE = { reasons: new Set(DROP_REASONS) };
/** Count `n` (default 1) commit lines dropped for one reason, in this repo. Never throws. Call it BEFORE the delete it describes. */
export function recordDropped(home, repoKey, reason, n = 1, nowMs = Date.now()) {
    try {
        const dir = repoSessionsDir(home, repoKey);
        if (dir === null)
            return;
        appendEvents(join(dir, DROPPED_TALLY_NAME), SHAPE, [{ r: reason, n }], nowMs);
    }
    catch {
        /* the drop already happened; failing to count it must not throw */
    }
}
/** The counts to announce, or null when nothing was dropped in the current run or the newest drop is older than 7 days. */
export function readDropped(home, repoKey, nowMs) {
    try {
        const dir = repoSessionsDir(home, repoKey);
        if (dir === null)
            return null;
        const sums = sumRun(join(dir, DROPPED_TALLY_NAME), SHAPE, nowMs);
        if (sums === null)
            return null;
        const total = DROP_REASONS.reduce((sum, reason) => sum + sums[reason], 0);
        return { ...sums, total };
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=dropped_tally.js.map