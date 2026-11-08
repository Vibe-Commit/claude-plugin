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
import { lstatSync } from "node:fs";
import { EXIT } from "../exit.js";
import { DEFAULT_AGENT_ID, admitsTranscript, agentForTranscript, dialectFor } from "../agents/registry.js";
import { UNKNOWN_AGENT_ID } from "../agents/types.js";
import { isCaptureAllowed } from "../consent.js";
import { gitProbe, headRef, onceRepoSlug } from "../git.js";
import { detectSquash } from "../inferred_squash.js";
import { recordInferredSkipped } from "../inferred_tally.js";
import { resolveProjectKeys } from "../project.js";
import { lastFiring } from "../firing.js";
import { activeSessionFor, appendInferred, appendPending, appendSpool } from "../spool.js";
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
    if (!isCaptureAllowed(ctx.home, keys, onceRepoSlug(toplevel)))
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
    // ⛔ THE COLD RUNG GOES TO THE SIDECAR, NOT THE SPOOL (`CR-195`/D208).
    // `capSpool` counts every taken line toward the truncation, so a non-wire line
    // in `.spool.jsonl` is discarded by the next 2xx — the very post that could not
    // carry it. `.pending.jsonl` gives it different retention without touching that
    // truncation rule, whose `count`-not-`shas.length` semantics are load-bearing.
    const write = active.attribution === "env_session_uncorroborated" ? appendPending : appendSpool;
    const sessionKey = { repoKey: toplevel, sessionId: active.sessionId };
    const wrote = write(ctx.home, sessionKey, {
        sha: head.sha,
        branch: head.branch,
        at: committedAt(toplevel),
        // ⚠ Gathered here because it is FREE here and impossible later: the file
        // list is a property of the commit, and reconstructing it server-side
        // would need the repository. It reaches the server in the upload BODY, as
        // the length-framed trailer of `commit_files.ts`, and never in a header
        // (`CR-170` §4), and only for a granted repository (E8).
        files: changedFiles(toplevel),
        // ⛔ RECORDED AT OBSERVATION TIME, because the evidence expires. By the
        // time the next hook delivers this line, the environment belonged to a
        // process that has exited and the mtimes have all moved on — the rung
        // could not be re-derived from anything then, only re-guessed.
        attribution: active.attribution,
        // `TODOS[176]` — OUR wall clock at observation, the clock the promotion bound compares with the start of the turn being
        // delivered (the first unsent prompt-like transcript record). Not the committer time above, which is settable.
        //
        // U2: on EVERY line now, not the pending sidecar only. The upload worker replays a firing as of the moment its hook ran, and
        // the commits that delivery may carry are exactly those observed at or before it (`observedAt <= firing.at`): a commit made in
        // the next turn must ride the next delivery. A line without it (an older client) counts as old and is carried at once.
        observedAt: ctx.nowMs ?? Date.now(),
        // Commit-edge T7: how far into the transcript this commit happened, for EVERY agent. Cursor's transcripts carry no times, so a position is its only placement
        // signal and it goes on the wire (`x-commits-pos`, Cursor only). For Claude Code and Codex it never goes on the wire: it only chooses WHICH REQUEST of a
        // multi-request delivery carries the commit (`commit_carry.ts`), the time `observedAt` still placing it.
        ...transcriptPosition(ctx, active.sessionId),
    });
    // ⭐ `TODOS[177]` — A SQUASH BY `reset --soft` FIRES NO `post-rewrite`, so the pairs are INFERRED here, from the reflog + ancestry +
    // tree + patch-id (see `inferred_squash.ts`; all five conditions or nothing). They go to the session's INFERRED spool — a file of their
    // own, delivered on `x-rewrites-inferred`, NEVER merged into the exact `x-rewrites` spool. The session is the one the ladder just chose
    // (the rung itself is not consulted, as in `post_rewrite.ts`: a pair relates two shas and claims nothing about who made them).
    // ⚠ After the commit line is written and in its own guard: an inference that throws must not cost the commit it was made for.
    try {
        const squash = detectSquash(toplevel, head);
        appendInferred(ctx.home, sessionKey, squash.pairs);
        // A squash that WAS detected but the contract cannot carry (over 64 commits; a sha256 repository) is counted, never silently dropped.
        if (squash.skipped !== null)
            recordInferredSkipped(ctx.home, toplevel, squash.skipped);
    }
    catch {
        // silence is the contract
    }
    return wrote;
}
/**
 * Commit-edge T7. `{ observedPos }` for a commit made in a session of ANY agent whose transcript we can place, or `{}`. Runs inside `post-commit`, inside the user's `git commit`, so it is
 * cheap, bounded and never throws: any doubt is "no position", which the delivery sends as an empty slot (the server then falls back to its own rule).
 *
 *  - The transcript's path is the LAST firing's, read from the session's firing log by a bounded tail read (`lastFiring`). That replaces the plan's "the
 *    hook saves the path in session state": hooks no longer write state (0.11), and `.live` is a bare timestamp. So a commit made before any hook of the
 *    session fired has no path and no position, which for Cursor is also a commit with no spool line at all (`activeSessionFor`: no env id, no state).
 *  - The agent is the TRANSCRIPT's root (A8), never `firing.agent`: Cursor's end also fires the Claude Code hook with the same sid and transcript.
 *  - The path must live under the agent's transcript root (`admitsTranscript`), and is only STAT-ed (a regular file's byte size), never opened here. The
 *    worker's confinement still governs the real read at delivery.
 */
function transcriptPosition(ctx, sessionId) {
    try {
        const last = lastFiring(ctx.home, sessionId);
        if (last === null)
            return {};
        if (agentForTranscript(ctx.home, ctx.env, last.transcript) === UNKNOWN_AGENT_ID)
            return {};
        if (!admitsTranscript(ctx.home, ctx.env, last.transcript))
            return {};
        const stat = lstatSync(last.transcript);
        if (!stat.isFile())
            return {};
        return Number.isSafeInteger(stat.size) && stat.size >= 0 ? { observedPos: stat.size } : {};
    }
    catch {
        return {};
    }
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
/** git's own `%cI` — strict ISO-8601, the committer date. `--no-show-signature`: see `inferred_squash.ts`'s reflog read for why. */
function committedAt(dir) {
    const out = gitProbe(dir, ["log", "--no-show-signature", "-1", "--format=%cI"]);
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
export function changedFiles(dir) {
    // `-z`: NUL-terminated and NEVER C-quoted. Plain `--name-only` writes a non-ASCII path as `"\303\251.ts"`, which would never match
    // an Edit's `file_path` once this list reaches the server (E8). A path may begin or end with a space, so nothing is trimmed.
    // `--root`: the first commit of a repository is a commit like any other.
    const out = gitProbe(dir, ["diff-tree", "-z", "--root", "--no-commit-id", "--name-only", "-r", "HEAD"]);
    if (out === null)
        return [];
    return out.split("\0").filter((l) => l !== "");
}
//# sourceMappingURL=post_commit.js.map