/**
 * `vibecommit post-commit` — the verb git's own `post-commit` hook invokes.
 *
 * ## This is the only place a commit is ever OBSERVED (`CR-170`, D154)
 *
 * `observed` had no producer in any repo, and the alternative — inferring
 * commits from a `Bash(git commit)` tool_use — yields NO EDGE AT ALL for
 * `make`, `just`, `gh`, an alias or a script, which is the common path (D56).
 * A commit hook sees all of them, because git runs it regardless of who typed
 * what.
 *
 * ⛔ **AND IT SEES ONLY COMMITS.** `post-commit` does not fire for `git pull`
 * (a merge runs `post-merge`), `checkout` or `reset` — so the three conditions
 * a polling design had to GUESS at are structural here rather than heuristic.
 * That is the whole argument for the mechanism, and it is why ref moves are
 * observed separately, by `headRef` on the Claude Code hook path.
 *
 * ## ⛔ THIS RUNS INSIDE THE USER'S `git commit`
 *
 * Three rules follow, and none of them is defensive tidiness:
 *
 *   - **Never throws, always exits 0.** MEASURED 2026-08-17: git ignores
 *     `post-commit`'s exit code entirely (a hook exiting 7 leaves `git commit`
 *     at 0), so this cannot break a commit — but an uncaught exception would
 *     still print a stack into the terminal where someone is working.
 *   - **Never writes to stdout or stderr.** That output lands in their commit.
 *   - **No network.** Delivery belongs on the hook path, which already has a
 *     credential, a budget and a retry story. This writes a line and returns.
 *
 * ⚠ **NO SPAWN BUDGET IS ARMED HERE, deliberately.** `spawn_budget.ts` is opt-in
 * and only `runHook` arms it, so the probes below get their own ceilings. That
 * is correct: this is git's process, not the 5s Claude Code hook path, and
 * `TODOS[87]`'s watchdog does not exist here to be defeated.
 */
import { EXIT } from "../exit.js";
import { isProjectAllowed } from "../consent.js";
import { gitProbe, headRef } from "../git.js";
import { resolveProjectKey } from "../project.js";
import { activeSessionFor, appendSpool } from "../spool.js";
/**
 * Observe the commit that just happened, or do nothing.
 *
 * Returns the spool entry written, or null — exposed as a value rather than
 * kept internal so the tests can assert WHAT was observed, not merely that the
 * call survived. Every refusal below is a `null`, and each is a different
 * reason with the same silence.
 */
export function runPostCommit(ctx) {
    try {
        observe(ctx);
    }
    catch {
        // The contract is silence. There is no channel to report on and no caller
        // who could act: git has already made the commit.
    }
    return EXIT.ok;
}
export function observe(ctx) {
    const toplevel = resolveProjectKey(ctx.cwd);
    if (toplevel === null)
        return false;
    // ⛔ THE CONSENT GATE, on the same key the Claude Code hook uses. A repo the
    // user declined must not have its commits recorded either.
    if (!isProjectAllowed(ctx.home, toplevel))
        return false;
    // ⛔ THE SESSION GATE — the one that keeps a HUMAN'S commit out. `post-commit`
    // fires for every commit in this work tree, including ones no agent was
    // involved in. A commit they did not write, linked forever, is the harm.
    const sessionId = activeSessionFor(ctx.home, toplevel);
    if (sessionId === null)
        return false;
    const head = headRef(toplevel);
    // No HEAD means a repository with no commits, which cannot be the state
    // immediately after one — so this is a git we could not read, not a case.
    if (head === null)
        return false;
    return appendSpool(ctx.home, { repoKey: toplevel, sessionId }, {
        sha: head.sha,
        branch: head.branch,
        at: committedAt(toplevel),
        // ⚠ Gathered here because it is FREE here and impossible later: the file
        // list is a property of the commit, and reconstructing it server-side
        // would need the repository. It stays in the spool for wave 2 and never
        // reaches a header (`CR-170` §4).
        files: changedFiles(toplevel),
    });
}
/** git's own `%cI` — strict ISO-8601, the committer date. */
function committedAt(dir) {
    const out = gitProbe(dir, ["log", "-1", "--format=%cI"]);
    return out === null ? "" : out.trim();
}
/**
 * The paths this commit touched.
 *
 * `--no-commit-id --name-only -r` against `HEAD`. ⚠ A MERGE COMMIT yields
 * nothing here — `diff-tree` emits no single diff for one — and that is left as
 * it is rather than papered over with `-m`, which would emit the diff against
 * every parent and multiply the list.
 */
function changedFiles(dir) {
    const out = gitProbe(dir, ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"]);
    if (out === null)
        return [];
    return out.split("\n").map((l) => l.trim()).filter((l) => l !== "");
}
//# sourceMappingURL=post_commit.js.map