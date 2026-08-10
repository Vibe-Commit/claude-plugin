/**
 * `SessionEnd` settles before it reads — `CR-020d`, D57 §DX7.
 *
 * The finding, verbatim: *"`SessionEnd` settles and re-reads inside its timeout.
 * `transcript_path` is documented as written asynchronously and may lag;
 * `SessionEnd` has no next event, so D56's advance-regardless loses the final
 * turn **permanently**."*
 *
 * ## Why only this event
 *
 * The client's whole design tolerates a lagging write: read what is there, leave
 * the offset where it lands, and let the NEXT invocation pick up whatever the
 * write had not flushed yet. `Stop` and `PreCompact` both have a next
 * invocation. `SessionEnd` does not — it is the last hook of the session, so
 * bytes missed here are missed forever, and they are the bytes of the final
 * turn, which is the one a user is most likely to go looking for.
 *
 * So the fix is narrow on purpose: one event pays the cost, and `Stop` behaves
 * exactly as it did before this task. `test/contract.test.ts` asserts that
 * negative half directly, because a change that quietly made every event settle
 * would pass the positive test just as well.
 *
 * ## One wait, not a poll loop
 *
 * The task is "settle-and-reread", singular. D56 §D8 is a founder override that
 * a hook must never block or slow a developer's turn, and "wait until the file
 * stops growing" has no natural upper bound — under load it is unbounded exactly
 * when blocking is least affordable. A single named wait is the simplest thing
 * that closes the finding, and its cost is knowable by reading one constant.
 *
 * ## This module holds no I/O and no clock
 *
 * `settledSize` takes both, for the same reason `policy.ts` is pure: the whole
 * settle rule is then testable without a real 250 ms of wall clock and without a
 * filesystem, and the one place that does touch either is the caller.
 */
/**
 * The event name Claude Code sends on stdin as `hook_event_name` for the last
 * hook of a session. DESIGN.md §13.7 governs it alongside `Stop` and
 * `PreCompact`; this task changes WHEN bytes are read, never the exit contract.
 */
export const SESSION_END_EVENT = "SessionEnd";
/**
 * How long to let the transcript settle. **250 ms, and the number is reasoned.**
 *
 * The lag being covered is a local filesystem write-flush artifact — Claude
 * Code's own process appending JSONL lines to a file this process is about to
 * stat — not a network round trip. That puts the expected lag in the
 * tens-of-milliseconds range, so 250 ms is roughly an order of magnitude of
 * margin over the effect it is covering, while staying a twentieth of the
 * default 5 s budget.
 *
 * It is deliberately NOT larger. Every millisecond here is taken from the send
 * that follows (see `settleDelayMs`), and a settle generous enough to cover a
 * pathologically slow write would starve the upload it exists to make complete.
 * If evidence ever shows real lag above this, change the constant and say why —
 * it is one number in one place precisely so that stays cheap.
 */
export const SESSION_END_SETTLE_DELAY_MS = 250;
/**
 * The most of the hook's budget the settle may ever claim.
 *
 * The settle is carved OUT of the existing budget, never added on top of it, so
 * it competes with the send. This cap is what keeps the constant above safe at
 * any budget: on the 5 s default it never binds (0.3 × 5000 = 1500 ≫ 250), and
 * on a budget small enough that a flat 250 ms would swallow the invocation it
 * scales the settle down instead of eating the send.
 */
export const SETTLE_BUDGET_FRACTION = 0.3;
/**
 * How long to actually settle, given this invocation's whole budget.
 *
 * The override exists for the same two reasons `resolveCaps` has one
 * (`policy.ts`): an operator on a filesystem slower than this constant assumes
 * can raise it without a release, and the end-to-end test has to widen the
 * window to land an append inside it deterministically rather than racing a
 * child's boot — which varies by an order of magnitude under load (`CR-126`).
 *
 * Unset or unparseable takes the default rather than disabling the settle: a
 * window an empty string can switch off is not a window. The budget cap still
 * applies to the override, so it can widen the settle but never let it swallow
 * the send.
 */
export function settleDelayMs(env, budgetMs) {
    const raw = env.VIBECOMMIT_SESSION_END_SETTLE_MS;
    const parsed = raw === undefined ? NaN : Number(raw);
    const configured = Number.isFinite(parsed) && parsed > 0 ? parsed : SESSION_END_SETTLE_DELAY_MS;
    return Math.min(configured, Math.floor(budgetMs * SETTLE_BUDGET_FRACTION));
}
/**
 * The transcript's size after letting a lagging write land.
 *
 * Read, wait, read again, and take the LARGER. Growth is the case this exists
 * for: the first read raced a write in progress, and the second sees the final
 * turn the first one missed.
 *
 * **A SHORTER second read keeps the first.** That is truncation or rotation — a
 * different and much rarer failure mode, which this task deliberately does not
 * try to solve; `nextSpan` already resyncs from 0 when the offset sits past EOF,
 * and `readSpan` already sends only the bytes actually present. Named as a known
 * gap rather than handled speculatively.
 *
 * A `null` second read (the file went away mid-settle) also keeps the first, for
 * the same reason: what we saw is better evidence than what we can no longer see.
 */
export async function settledSize(sizeOf, wait, delayMs) {
    const first = sizeOf();
    // Nothing to settle toward — the caller treats null as "do not send", and a
    // wait would spend budget to learn the same thing again.
    if (first === null)
        return null;
    if (delayMs <= 0)
        return first;
    await wait(delayMs);
    const second = sizeOf();
    if (second === null)
        return first;
    return second > first ? second : first;
}
//# sourceMappingURL=session_end.js.map