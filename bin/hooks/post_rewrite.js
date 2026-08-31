/**
 * `vibecommit post-rewrite` — the verb git's own `post-rewrite` hook invokes.
 *
 * ## ⛔ WHY IT EXISTS: `post-commit` OBSERVES A SHA THE REWRITE THEN DESTROYS
 *
 * **`M5`: `--amend` and `rebase` both fire `post-commit`, and destroy the sha
 * they fired for.** `--amend` fires `post-commit` for the pre-amend sha AND for
 * the amended one; a `rebase -i` squash fires it for the new sha. **The
 * pre-rewrite sha is unreachable from every branch and gone after
 * `gc --prune=now`** — so nothing downstream can discover, later, that the two
 * commits are the same work. The pairing has to be recorded while git still
 * knows it, and `post-rewrite` is the only hook that is told.
 *
 * **`M6`: the pairs arrive on STDIN.** `argv[1]` is `amend` or `rebase`; stdin
 * carries `<ancestor> <successor>` per line. That is `commit_sha_successors`'
 * shape verbatim, so there is no new table and no migration.
 *
 * ## ⛔ TWO GUARDS, AND THEY ARE NOT REDUNDANCY
 *
 * `M6` measured the squash hazard across sizes and **it is SIZE-DEPENDENT**:
 *
 * | Squash | Fires | Hazard |
 * |---|---|---|
 * | 3 → 1 | `amend A→F` · `rebase A→F; B→F` | ⛔ **duplicate pair** (`A→F` twice) |
 * | 4 → 1 | `amend A→I` · `amend I→F` · `rebase A→F; B→F; C→F` | ⛔ **two rows name `I`**, a sha that never existed on any branch and is gc-able |
 *
 * ⚠ **NEITHER IS THE GENERAL CASE.** The suppression below kills the dead
 * intermediates; `appendRewrites`' dedup kills the duplicate. **One squash size
 * cannot exercise both**, and a review that saw only one concluded a guard was
 * pointless.
 *
 * ## ⛔ THIS RUNS INSIDE THE USER'S `git rebase`
 *
 * The same three rules `post_commit.ts` states, for the same reasons: **never
 * throws, always exits 0; never writes to stdout or stderr; no network.** And,
 * as there, **NO SPAWN BUDGET IS ARMED** — `spawn_budget.ts` is opt-in and only
 * `runHook` arms it, so the probes here take their own ceilings. This is git's
 * process, not the 5s Claude Code hook path.
 */
import { EXIT } from "../exit.js";
import { DEFAULT_AGENT_ID, dialectFor } from "../agents/registry.js";
import { isProjectAllowed } from "../consent.js";
import { gitProbe } from "../git.js";
import { resolveProjectKeys } from "../project.js";
import { activeSessionFor, appendRewrites, isFullSha } from "../spool.js";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
/**
 * Record the rewrite that just happened, or do nothing.
 *
 * Exits 0 unconditionally — git ignores a `post-rewrite` exit code, but an
 * uncaught exception would still print a stack into the terminal where someone
 * is rebasing.
 */
export function runPostRewrite(ctx) {
    try {
        observeRewrites(ctx);
    }
    catch {
        // The contract is silence. There is no channel to report on and no caller
        // who could act: git has already rewritten the commits.
    }
    return EXIT.ok;
}
/** How many pairs were newly spooled. Zero is an ordinary answer. */
export function observeRewrites(ctx) {
    const pairs = parsePairs(ctx.stdin);
    if (pairs.length === 0)
        return 0;
    // ⛔ BOTH KEYS, AS IN `post_commit.ts` (`D184 §1`): the consent gate keys on the
    // git COMMON DIR, and every `git -C` and the session bucket stay on the
    // worktree TOPLEVEL. The variable name does not tell you which is which.
    const keys = resolveProjectKeys(ctx.cwd);
    if (keys === null)
        return 0;
    const toplevel = keys.worktree;
    // ⛔ GUARD 1 — SUPPRESS `amend` WHILE A REBASE IS IN PROGRESS.
    //
    // A `rebase -i` squash fires this hook as `amend` for each intermediate commit
    // it builds along the way, and those intermediates are **discarded**: a 4 → 1
    // squash produces two rows naming a sha that never existed on any branch and is
    // gc-able. The final `rebase` fire carries the pairs that are actually true.
    //
    // ⛔ **MEASURED, and the predicate is exactly this**: `.git/rebase-merge`
    // EXISTS during ALL fires of a `rebase -i`, including both `amend` ones, and
    // does NOT exist for a plain `git commit --amend`. `.git/rebase-apply` never
    // appears for `-i` at all, so it is not consulted.
    //
    // ⚠ It must not swallow an ordinary `--amend`, which is the other cell.
    if (ctx.kind === "amend" && rebaseInProgress(toplevel))
        return 0;
    if (!isProjectAllowed(ctx.home, keys.consent))
        return 0;
    // ⚠ THE SESSION BUCKET, AND THE RUNG IS DELIBERATELY NOT CONSULTED. A pair
    // asserts a relation between two SHAs — `A was rewritten to B` — and claims
    // nothing about who did it, so there is no attribution to be wrong about and
    // nothing for it to put on `x-commit-attributions`. The ladder is used here for
    // the one thing it still decides on this path: which session's spool the pair
    // belongs in, so that the next hook for that session delivers it.
    const active = activeSessionFor(ctx.home, toplevel, envSessionId(ctx.env));
    if (active === null)
        return 0;
    return appendRewrites(ctx.home, { repoKey: toplevel, sessionId: active.sessionId }, pairs);
}
/**
 * Is a rebase running right now?
 *
 * ⛔ **THE PATH COMES FROM GIT, NOT FROM JOINING `.git` ONTO THE TOPLEVEL.** A
 * linked worktree's rebase state is its own and does not live in the main clone's
 * git dir, and `--git-common-dir`'s answer is relative in a main clone and
 * absolute in a worktree (`M3`, D184 §8) — a hand-built path is right in exactly
 * one of those shapes. `--git-path` answers for the shape it is actually in, and
 * is resolved against `dir` because that is the directory git ran in.
 *
 * ⚠ A probe failure resolves to FALSE — *not in a rebase* — which is the arm that
 * RECORDS the pair. That is the correct direction here: the cost of a false
 * negative is one extra pair that dedup or the server's own self-pair drop will
 * handle, while a false positive silently discards a real `--amend`.
 */
function rebaseInProgress(dir) {
    const out = gitProbe(dir, ["rev-parse", "--git-path", "rebase-merge"]);
    if (out === null)
        return false;
    const path = out.trim();
    if (path === "")
        return false;
    return existsSync(isAbsolute(path) ? path : join(dir, path));
}
/** See `post_commit.ts`'s copy — the dialect answers, and this file does not read the variable. */
function envSessionId(env) {
    return dialectFor(DEFAULT_AGENT_ID).sessionIdFromEnv(env);
}
/**
 * `<ancestor> <successor>` per line, whitespace-separated.
 *
 * ⚠ **git may append a third field** — the `rebase` form carries extra info for
 * some invocations — so the line is split and the first two fields are taken
 * rather than requiring exactly two. A malformed line is SKIPPED, never fatal:
 * this is a stream from another program, and losing one pair beats losing the
 * batch.
 *
 * ⚠ A self-pair is dropped here as well as in the spool's parser. `parseRewritePairs`
 * drops it server-side too, and a pair that survives to occupy one of the 16 wire
 * slots while meaning nothing is a slot a real pair needed.
 */
function parsePairs(stdin) {
    const out = [];
    for (const line of stdin.split("\n")) {
        const fields = line.trim().split(/\s+/);
        if (fields.length < 2)
            continue;
        const [ancestor, successor] = fields;
        if (!isFullSha(ancestor) || !isFullSha(successor))
            continue;
        if (ancestor === successor)
            continue;
        out.push({ ancestor, successor });
    }
    return out;
}
//# sourceMappingURL=post_rewrite.js.map