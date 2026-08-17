/**
 * A wall-clock budget for SYNCHRONOUS spawns — the half of the hook's timeout
 * contract the watchdog provably cannot cover (`TODOS[87]`).
 *
 * ## Why the watchdog is not enough, and never could be
 *
 * `runHook` arms `setTimeout(() => finish(null), budgetMs).unref()`. ⛔ **A timer
 * cannot fire while the event loop is blocked.** `execFileSync` blocks it by
 * definition, so a git binary that never returns produces an **unbounded hang**
 * rather than a slow hook — no timer, no `--test-timeout` and no watchdog can
 * interrupt it. Demonstrated on Linux 2026-08-10, where an unwritable `/proc`
 * HOME blocked a sync call forever and ran a CI job 25 minutes against a ~50s
 * norm (D89).
 *
 * ⚠ **So widening a timeout cannot help; only BOUNDING can.** And a per-call
 * ceiling is not a bound either — four `timeout: 5_000` literals on one path sum
 * to 20s against a 5s watchdog. The bound has to be on the SUM, which means the
 * spawns have to share one deadline rather than each hold its own ceiling.
 *
 * ## ⛔ `timeout: 0` MEANS "NO TIMEOUT", AND THAT IS THE TRAP THIS MODULE EXISTS
 * ## TO AVOID
 *
 * MEASURED on Node 22: `execFileSync(..., { timeout: 0 })` runs a `sleep 3` to
 * completion — the bound is silently DISABLED — and `timeout: -5` throws
 * `ERR_OUT_OF_RANGE` synchronously. So the obvious implementation, passing a
 * remaining-budget number straight through, turns into "no timeout at all"
 * exactly when the budget has run out, which is precisely when the bound matters
 * most. It would look like a fix and behave like the bug.
 *
 * `spawnTimeoutMs` therefore returns `null` rather than a doomed number, and
 * every caller answers with the value it already uses for "git could not tell
 * us" — a refusal each of them was already built to express.
 *
 * ## The budget is OPT-IN, so the CLI verbs are untouched
 *
 * Only the hook arms it. `report`, `why`, `status` and `connect` are interactive
 * and have no 5s wall clock, so with no budget armed this returns the caller's
 * own ceiling and their behaviour is byte-identical to before.
 */
/**
 * The absolute deadline for synchronous spawns, or null when none is armed.
 *
 * Module state rather than a threaded parameter, deliberately: a wall-clock
 * budget is a property of the PROCESS, and the alternative is an extra argument
 * on `gitToplevel`, `gitRemoteUrl`, `gitProbe`, `gitPatchId` and
 * `resolveSshAlias` plus every CLI caller that has no budget to pass. The hook
 * process arms it once and exits; tests clear it in a `finally`.
 */
let deadlineAt = null;
/**
 * The share of the hook budget all synchronous spawns may take TOGETHER.
 *
 * At the 5s default this is 3000 ms for every git and ssh spawn combined, which
 * still leaves 2000 ms in which the watchdog can actually fire — and the settle
 * and the sends are `await`ed, so they never block the timer and the watchdog
 * really does cover them. The same idiom as `SEND_BUDGET_FRACTION` (0.6) and
 * `SETTLE_BUDGET_FRACTION` (0.3): a named fraction of one budget, never a
 * second literal.
 *
 * ## ⛔ WHY THIS IS GENEROUS RATHER THAN TIGHT, AND IT IS NOT A TUNING KNOB
 *
 * The two failure directions are NOT symmetric, so the value follows from which
 * one is worse rather than from splitting the budget evenly:
 *
 *   - **Window too small** → a spawn is refused on a merely BUSY machine, so
 *     `resolveRepoSlug` falls back to `local:<hash of the developer's absolute
 *     path>`. ⛔ That is a WRONG REPOSITORY IDENTITY on the wire — the join key
 *     every downstream surface uses — and it is silent. It is precisely the
 *     defect `CR-167` (D157) has just finished removing, re-introduced
 *     intermittently and only ever on loaded machines.
 *   - **Window too large** → under a genuine hang the network send is squeezed,
 *     so nothing is captured this turn. The offset is not advanced, the next
 *     hook picks the bytes up, and the user loses nothing.
 *
 * A retried send costs a turn. A wrong identity fragments a repository's audit
 * record permanently. So the window is sized to be unreachable by anything but
 * a real hang: 3000 ms against a MEASURED ~20 ms warm spawn is a 150x margin.
 *
 * ⚠ **MEASURED, NOT REASONED.** At 0.2 (a 1000 ms window) the full suite failed
 * 7-8 cells per run with a DIFFERENT set each time — all of them slug and
 * delivery cells — because the suite's own concurrency pushed ordinary git
 * spawns past the window. Each file passed alone. That is exactly what this
 * degradation looks like from the outside, and it is why the value is here with
 * its reasoning attached rather than left as a number someone can nudge.
 */
export const SPAWN_BUDGET_FRACTION = 0.6;
/**
 * Below this much remaining, do not spawn at all.
 *
 * A spawn that can only time out costs a fork and delivers nothing, and the
 * caller's refusal path is already correct — so refusing early is strictly
 * better than starting a process we know cannot finish. It is also what keeps
 * `timeout: 0` unreachable: the returned number is always at least this.
 */
export const MIN_SPAWN_TIMEOUT_MS = 50;
/**
 * Arm the budget. Called once, beside the watchdog it completes.
 *
 * Takes the same `budgetMs` the watchdog does, so the two cannot drift.
 */
export function startSpawnBudget(budgetMs, now = Date.now()) {
    deadlineAt = now + Math.floor(budgetMs * SPAWN_BUDGET_FRACTION);
}
/** Disarm. Tests call this in a `finally`; the hook process just exits. */
export function clearSpawnBudget() {
    deadlineAt = null;
}
/**
 * What this spawn may take: its own ceiling, the remaining budget, or `null`
 * when there is not enough left to be worth starting.
 *
 * ⚠ **Never returns 0 or a negative**, for the `ERR_OUT_OF_RANGE` and
 * silently-unbounded reasons in the module docblock. `null` is the refusal.
 */
export function spawnTimeoutMs(ceilingMs, now = Date.now()) {
    // No budget armed — a CLI verb. Its own ceiling, exactly as before.
    if (deadlineAt === null)
        return ceilingMs;
    const remaining = deadlineAt - now;
    if (remaining < MIN_SPAWN_TIMEOUT_MS)
        return null;
    return Math.min(ceilingMs, remaining);
}
//# sourceMappingURL=spawn_budget.js.map