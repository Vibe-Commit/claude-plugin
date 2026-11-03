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
export function readSpoolUnion(home, sessionId, ledgerKey, worktrees) {
    const keys = [ledgerKey, ...worktrees.filter((worktree) => worktree !== ledgerKey)];
    const at = (repoKey) => ({ repoKey, sessionId });
    const commitLists = keys.map((key) => readSpool(home, at(key)));
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