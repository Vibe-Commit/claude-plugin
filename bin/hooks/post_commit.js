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
import { DEFAULT_AGENT_ID, dialectFor } from "../agents/registry.js";
import { isProjectAllowed } from "../consent.js";
import { gitProbe, headRef } from "../git.js";
import { resolveProjectKeys } from "../project.js";
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
    // ⛔ BOTH KEYS, AND ONLY ONE OF THE SIX USES BELOW MOVES (`D184 §1`). The
    // consent gate keys on the git COMMON DIR; the session bucket, the `repoKey`
    // and every `git -C` in this function stay on the worktree TOPLEVEL. They were
    // one value until `D184` and the variable name did not change, so read what
    // each line DOES with it — `resolveProjectKeys` exists so taking the wrong one
    // has to be deliberate.
    //
    // ⚠ +1 spawn on git's own process, accepted on the record (`D184 §6`): this
    // hook arms no spawn budget (`:30-33`), so the probe takes its own 5s ceiling
    // and the watchdog `TODOS[87]` defeats does not exist on this path.
    const keys = resolveProjectKeys(ctx.cwd);
    if (keys === null)
        return false;
    const toplevel = keys.worktree;
    // ⛔ THE CONSENT GATE, on the same key the Claude Code hook uses. A repo the
    // user declined must not have its commits recorded either.
    //
    // ⛔ IT IS `keys.consent` OR THE COMMIT GATE IS A HALF-FLIP. `entry.ts` checks
    // the common dir and `connect` grants it; a `post_commit` still checking the
    // toplevel would refuse every commit in every repository — silently, because
    // silence is this file's whole contract — while transcript capture worked
    // fine. That asymmetry is invisible to any cell that grants and checks through
    // one helper (`D184 §9`).
    if (!isProjectAllowed(ctx.home, keys.consent))
        return false;
    // ⛔ THE SESSION GATE — WHICH SESSION, NOT WHOSE HANDS.
    //
    // ⚠ **This comment used to say it is "the one that keeps a HUMAN'S commit
    // out", and that has been FALSE since `CR-170` shipped** — not since D5, and
    // not because of the ladder. `activeSessionFor` gates on a session being active
    // in this clone and has never inspected authorship; the paragraph three lines
    // below already said so, in this same file, about this same hook. Corrected as
    // a comment fix.
    //
    // What the gate really does is refuse when no capture session is live here, and
    // — since the ladder — SAY HOW IT DECIDED. `sole_live_session` still writes for
    // a human's commit in a clone with one live session, exactly as it did at HEAD.
    const active = activeSessionFor(ctx.home, toplevel, envSessionId(ctx.env));
    if (active === null)
        return false;
    const head = headRef(toplevel);
    // No HEAD means a repository with no commits, which cannot be the state
    // immediately after one — so this is a git we could not read, not a case.
    if (head === null)
        return false;
    return appendSpool(ctx.home, { repoKey: toplevel, sessionId: active.sessionId }, {
        sha: head.sha,
        branch: head.branch,
        at: committedAt(toplevel),
        // ⚠ Gathered here because it is FREE here and impossible later: the file
        // list is a property of the commit, and reconstructing it server-side
        // would need the repository. It stays in the spool for wave 2 and never
        // reaches a header (`CR-170` §4).
        files: changedFiles(toplevel),
        // ⛔ RECORDED AT OBSERVATION TIME, because the evidence expires. By the
        // time the next hook delivers this line, the environment belonged to a
        // process that has exited and the mtimes have all moved on — the rung
        // could not be re-derived from anything then, only re-guessed.
        attribution: active.attribution,
    });
}
/**
 * The committing session's own id, or null.
 *
 * ⛔ **THE DIALECT ANSWERS, NOT THIS FILE.** `sessionIdFromEnv` is a required
 * member precisely so a new agent has to declare its own variable rather than
 * inherit a guess (`D3`), and reading `CLAUDE_CODE_SESSION_ID` here would put a
 * second, quieter copy of that knowledge outside the registry.
 *
 * ⚠ **`DEFAULT_AGENT_ID`, because git hands this hook no `--agent=` flag** — the
 * installed script is `vibecommit post-commit`, with no argv to read. Asking
 * every dialect instead would be identical today (the other two answer `null`,
 * UNMEASURED) and would invent a precedence rule nobody has needed yet.
 *
 * ⚠ A value from the WRONG agent is survivable by construction: the ladder's
 * first rung requires a live state file to agree with it, and an id that
 * corroborates nothing drops to the HOLD rung rather than naming anyone.
 */
function envSessionId(env) {
    return dialectFor(DEFAULT_AGENT_ID).sessionIdFromEnv(env);
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