/**
 * `TODOS[177]` — INFER a squash that git never reported.
 *
 * ## ⛔ WHY IT EXISTS
 *
 * `git reset --soft B && git commit -m …` collapses `B..T` into one commit `F`, and **git fires no `post-rewrite` for it**: a
 * reset is not a rewrite as far as the hook is concerned, and the commit that follows is an ordinary `post-commit`. So the pairing
 * `T-and-friends → F` — which the amend and the interactive rebase get from git itself — is never recorded, and `blame_commit`
 * on any of the folded commits calls them untouched (measured by Gate C probe 3, in-session squash agent).
 *
 * ## ⛔ AN INFERENCE IS NOT A FACT, AND THE WIRE SAYS SO
 *
 * Nothing here is reported by git. The pairs go out on their own header (`x-rewrites-inferred`, with the patch-id as the stored
 * evidence) and NEVER on `x-rewrites`, which the server stores as exact. See `IngestDelta.inferredRewrites`.
 *
 * ## THE DETECTOR — all five, or nothing
 *
 * For the commit `F` just made on a BRANCH (not a detached HEAD), an inferred squash is emitted iff ALL of:
 *
 *  1. the branch reflog entry immediately before F's own `commit: …` entry is `reset: moving to <ref>`, whose result is `B` and
 *     whose predecessor tip was `T`;
 *  2. `B` is a STRICT ancestor of `T` (`merge-base --is-ancestor`, `B != T`);
 *  3. `parent(F) == B`, and `F` has exactly ONE parent;
 *  4. `tree(F) == tree(T)`;
 *  5. the patch-ids agree: the diff `B → T` and the diff of `F` hash to the same `git patch-id --stable` (redundant with 4 — equal
 *     trees on an equal base are the same diff — and kept because it is the EVIDENCE the header stores).
 *
 * The pairs are `(each c in rev-list B..T) → F`, each carrying that patch-id.
 *
 * Everything else emits NOTHING, and each is a different reason with the same silence: the trees differ (reset, edit, commit);
 * `B` is not an ancestor; the reflog is missing, expired, or too short; two resets stand in between; `F` is a merge or an amend or
 * an initial commit (`commit (merge)`, `commit (amend)`, `commit (initial)` are not `commit:`); HEAD is detached; the diff is
 * empty (a squash whose net effect is nothing has no patch-id to store).
 *
 * ## DECISIONS (said here so a reader does not have to guess)
 *
 *  - **A ONE-commit "squash" counts.** `reset --soft HEAD~1 && git commit -m "new message"` with the SAME tree is a reword done by
 *    reset: `B..T` is `{T}`, `F` has the same tree and parent. The pair `T → F` is as true as any other, and it is exactly what a
 *    `git commit --amend` would have reported. The same reset WITH an edit changes the tree and emits nothing (condition 4).
 *  - **At most `MAX_INFERRED_COMMITS` (64) commits per squash, and a larger fold emits NOTHING** (server contract: the reader counts
 *    anything past 64 per request as dropped, and a partial edge set is worse than none). It is TALLIED (`inferred_tally.ts`), not
 *    truncated: the squash was detected, the contract could not carry it, and `status` says so.
 *  - **Only 40-hex repositories.** The wire contract is `ancestor40:successor40:patchid40` and the server refuses 64-hex, so a sha256
 *    repository emits nothing — also TALLIED, but only once the five conditions hold (a sha256 repo's ordinary commits are not noise).
 *  - **Needs a reflog.** `core.logAllRefUpdates=false` and bare repositories keep none, so nothing is inferred there.
 *
 * ## ⛔ THIS RUNS INSIDE THE USER'S `git commit`
 *
 * Never throws; no network; writes nothing itself. +1 spawn on every ordinary commit (the reflog read) and a handful more ONLY when
 * the reflog says a reset came first. `post_commit.ts` arms no spawn budget (see its header), so each probe takes its own ceiling.
 */
import { gitPatchId, gitProbe, gitRangePatchId } from "./git.js";
/** Most folded commits one squash may name. More than this and the squash emits NOTHING (and is tallied): the server caps a request at 64. */
export const MAX_INFERRED_COMMITS = 64;
/** Object names as git prints them: 40-hex (sha1) or 64-hex (sha256). Only 40-hex may be SENT. */
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SHA1 = /^[0-9a-f]{40}$/;
const NONE = { pairs: [], skipped: null };
/**
 * The newest `n` entries of `refs/heads/<branch>`'s reflog, newest first, or null if git cannot answer. A line that is not
 * `<40-hex> TAB <subject>` makes the whole answer null: half a reflog is how a wrong predecessor gets picked.
 */
function branchReflog(dir, branch, n) {
    // ⛔ `--no-show-signature` (VG pre-review, 2026-10-08): with the user's `log.showSignature=true` and an
    // SSH-signed commit, `git log` prepends a signature-verification banner to the formatted line, which
    // breaks the `%H\t%gs` parse — measured as the fold reading 0 pairs, not an error. The flag is unconditional:
    // this output is parsed by byte position, never shown to anyone, so there is nothing for the banner to serve.
    const out = gitProbe(dir, ["log", "--no-show-signature", "-g", "--no-abbrev", "--format=%H%x09%gs", "-n", String(n), `refs/heads/${branch}`, "--"]);
    if (out === null)
        return null;
    const entries = [];
    for (const line of out.split("\n")) {
        if (line === "")
            continue;
        const tab = line.indexOf("\t");
        const sha = tab < 0 ? "" : line.slice(0, tab);
        if (!OID.test(sha))
            return null;
        entries.push({ sha, subject: line.slice(tab + 1) });
    }
    return entries;
}
/**
 * The inferred pairs for the commit `head` just made — or, for a squash that WAS detected but cannot be sent, why not (so the caller can
 * tally it). `head.branch` is null on a detached HEAD, which is nothing to infer. Never throws.
 */
export function detectSquash(dir, head) {
    try {
        return infer(dir, head);
    }
    catch {
        return NONE;
    }
}
function infer(dir, head) {
    const F = head.sha;
    if (head.branch === null || !OID.test(F))
        return NONE;
    // (1) the reflog: F's own plain `commit:` entry, directly preceded by a reset, itself preceded by the tip it moved away from.
    const log = branchReflog(dir, head.branch, 3);
    if (log === null || log.length < 3)
        return NONE;
    const [commitEntry, resetEntry, before] = log;
    // `commit: ` exactly. `commit (amend): `, `commit (merge): `, `commit (initial): ` and `commit (cherry-pick): ` are other events.
    if (commitEntry.sha !== F || !commitEntry.subject.startsWith("commit: "))
        return NONE;
    if (!/^reset: moving to \S/.test(resetEntry.subject))
        return NONE;
    const B = resetEntry.sha;
    const T = before.sha;
    // (2) B is a STRICT ancestor of T. `merge-base --is-ancestor` exits 0 for yes: gitProbe answers "" for yes and null for no/unanswerable.
    if (B === T)
        return NONE;
    if (gitProbe(dir, ["merge-base", "--is-ancestor", B, T]) === null)
        return NONE;
    // (3) parent(F) == B, exactly one parent. `rev-list --parents -n 1 F` prints `F P1 [P2 …]`.
    const parents = gitProbe(dir, ["rev-list", "--parents", "-n", "1", F]);
    if (parents === null)
        return NONE;
    const fields = parents.trim().split(/\s+/);
    if (fields.length !== 2 || fields[0] !== F || fields[1] !== B)
        return NONE;
    // (4) tree(F) == tree(T).
    const trees = gitProbe(dir, ["rev-parse", `${F}^{tree}`, `${T}^{tree}`]);
    if (trees === null)
        return NONE;
    const [treeF, treeT] = trees.trim().split("\n");
    if (!OID.test(treeF ?? "") || treeF !== treeT)
        return NONE;
    // (5) the patch-ids, the evidence we store. A missing one (an empty diff, a git that would not answer) is "no evidence": nothing.
    const patchB = gitRangePatchId(dir, B, T);
    const patchF = gitPatchId(dir, F);
    if (patchB === null || patchF === null || patchB !== patchF || !OID.test(patchB))
        return NONE;
    // The squash is DETECTED. From here on, "nothing" is a tallied skip, not a non-event.
    // One more than the cap, so a fold of exactly 64 is sendable and 65 is known to be over.
    const listed = gitProbe(dir, ["rev-list", `--max-count=${MAX_INFERRED_COMMITS + 1}`, `${B}..${T}`]);
    if (listed === null)
        return NONE;
    const folded = listed.split("\n").filter((l) => l !== "");
    if (folded.length === 0 || !folded.every((c) => OID.test(c) && c !== F))
        return NONE;
    // sha256 repository (any object name 64-hex): the server refuses 64-hex, so nothing is sent.
    if (![F, B, patchB, ...folded].every((x) => SHA1.test(x)))
        return { pairs: [], skipped: "sha256" };
    // A fold of more than 64: the server counts the excess as dropped and a partial edge set is worse than none, so none.
    if (folded.length > MAX_INFERRED_COMMITS)
        return { pairs: [], skipped: "oversize" };
    return { pairs: folded.map((ancestor) => ({ ancestor, successor: F, patchId: patchB })), skipped: null };
}
//# sourceMappingURL=inferred_squash.js.map