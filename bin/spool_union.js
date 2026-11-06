/**
 * The commit, rewrite and inferred-squash spools of ONE (repo, session), read across every work tree of the repo
 * (any-folder capture, R5 · O7).
 *
 * A session that works in `code/` and `code-wt-c4/` makes commits in both, and each work tree's `post-commit` spools under its
 * OWN state digest. One stream per repo (D6) must send all of them, so a target reads the union. ⛔ **And it cannot be
 * acknowledged as one file.** `dropSpooled` drops the FIRST N LINES of a file, so a union acknowledged by "drop N lines" would
 * delete lines from whichever file happened to be first. The union therefore carries `(source, consumed count)` per source, and
 * `post.ts` truncates each source by its own count (O7). The lines consumed are always a PREFIX of the concatenation, so the
 * per-source counts are a prefix split.
 *
 * With one source (every session that never leaves one work tree) this is exactly the three `read…`/`cap…` calls the hook has
 * always made, and `sources` names the ledger key alone, so the 0.8.0 wire and truncation are unchanged (R14).
 */
import { capInferred, capSpool, capSuccessors, readInferred, readRewrites, readSpool, } from "./spool.js";
/**
 * U4 — THE PIN. A firing replayed late may carry only the commits that existed when its hook fired: the PREFIX of one source's lines that
 * are UNSTAMPED or have `observedAt <= pinAtMs`. A turn N+1 commit must not ride a delivery capped at turn N, or the server places it on
 * the wrong turn (and a permanent row cannot be corrected).
 *
 *  - ⛔ **Unstamped counts as pinned.** `undefined <= pinAtMs` is false in JS, so a naive prefix would stop at the first line from an older
 *    client and that spool would never drain, with no error.
 *  - ⛔ **Per source, BEFORE the flatten** (the caller maps it over `commitLists`): flattened first, a newer line in work tree A would hold
 *    back an older line in work tree B.
 *  - A prefix, not a filter: the drops remove the FIRST `count` well-formed lines of each file, so what is carried must be a head of it.
 *  - A clock stepping back only delays a line until the clock catches up. Nothing is lost.
 * No firing (`pinAtMs` unset) means no pin: `finalize`, `backfill`, the idle drain and the inline hook read the whole spool.
 */
export function pinnedPrefix(entries, pinAtMs) {
    if (pinAtMs === undefined)
        return entries;
    const stop = entries.findIndex((entry) => entry.observedAt !== undefined && entry.observedAt > pinAtMs);
    return stop === -1 ? entries : entries.slice(0, stop);
}
/** `total` lines consumed from the front of lists with these lengths → how many came from each. */
function prefixSplit(total, lengths) {
    let left = total;
    return lengths.map((length) => {
        const taken = Math.min(left, length);
        left -= taken;
        return taken;
    });
}
/**
 * Read the union. `ledgerKey` is the target's ledger worktree and always the FIRST source, so a single-worktree target reads
 * exactly what it always did; `worktrees` are every work tree of the repo this session was seen in.
 */
export function readSpoolUnion(home, sessionId, ledgerKey, worktrees, 
/** U4: the moment the firing being replayed fired. Unset for the inline hook, `finalize`, `backfill` and the drain: no pin. */
pinAtMs) {
    const keys = [ledgerKey, ...worktrees.filter((worktree) => worktree !== ledgerKey)];
    const at = (repoKey) => ({ repoKey, sessionId });
    const commitLists = keys.map((key) => pinnedPrefix(readSpool(home, at(key)), pinAtMs));
    const commits = capSpool(commitLists.flat());
    const commitCounts = prefixSplit(commits.count, commitLists.map((list) => list.length));
    const rewriteLists = keys.map((key) => readRewrites(home, at(key)));
    const rewrites = capSuccessors(rewriteLists.flat());
    const rewriteCounts = prefixSplit(rewrites.count, rewriteLists.map((list) => list.length));
    const inferredLists = keys.map((key) => readInferred(home, at(key)));
    const inferred = capInferred(inferredLists.flat());
    let inferredSource = null;
    const group = inferred.groups[0];
    if (group !== undefined) {
        const holder = keys.findIndex((_, i) => inferredLists[i].some((pair) => pair.successor === group.successor && pair.patchId === group.patchId));
        inferredSource = { repoKey: keys[Math.max(0, holder)], group };
    }
    return {
        commits,
        rewrites,
        inferred,
        sources: {
            commits: keys.map((repoKey, i) => ({ repoKey, count: commitCounts[i] })).filter((source) => source.count > 0),
            rewrites: keys.map((repoKey, i) => ({ repoKey, count: rewriteCounts[i] })).filter((source) => source.count > 0),
            inferred: inferredSource,
        },
    };
}
//# sourceMappingURL=spool_union.js.map