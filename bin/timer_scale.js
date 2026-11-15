/**
 * TEST SEAM: the upload worker's waits (backoff and pacing between requests) can be shortened by a factor, so a test that must watch the
 * REAL worker process retry does not sit through a 5 s + 10 s backoff. (CI-minutes plan R4/D5-C: since U6 moved delivery into a detached worker, dozens of
 * cells wait on those timers in real time.)
 *
 * ## Production behaviour does not change
 *
 * The factor is 1 unless `VIBECOMMIT_TEST_TIMER_SCALE` names a number in (0, 1) (values below 0.05 mean 0.05) AND `setTimerScaleFromEnv` is called. It is called in exactly ONE place,
 * `runUploadWorkerMain` (the `__upload-worker` process entry). Anything else (unset, empty, `0`, negative, `1` or more, `NaN`, text) leaves it at 1.
 * The constants themselves (`BACKOFF_FIRST_MS` ...) are untouched and pinned by `test/timer-scale.test.ts`.
 *
 * ## What it scales, and what it does not
 *
 * Scaled: the worker's OWN backoff after a `later`, and the pace between requests (`unboundedPaceMs`, `pauseFirstMs`).
 * NOT scaled, ever: a server-sent `Retry-After` (a stray factor must not make a client ignore what the server asked for; `scaledWaitAfterLaterMs`).
 * The factor is clamped to at least 0.05, so a stray tiny value cannot become a tight loop.
 * NOT scaled: the worker's idle poll (`IDLE_POLL_MS`, 1 s: a worker that outlives its test, which the rigs do not always stop, then makes one pass per
 * second as it does today instead of twenty, and retries a dead stub at most every scaled backoff ceiling), `YIELD_MS` (it must stay longer than the 20 ms writer poll so a waiter can win the session lock), request timeouts, the lock heartbeat,
 * and the worker's lifetime bounds (`NO_PROGRESS_MS`, `TOTAL_MS`).
 */
export const TIMER_SCALE_ENV = "VIBECOMMIT_TEST_TIMER_SCALE";
/** The smallest factor honoured: a stray tiny value must not turn the worker's backoff into a tight loop. Anything in (0, this) means this. */
export const MIN_TIMER_SCALE = 0.05;
let scale = 1;
/** The factor an env value means: a finite number in [0.05, 1) as given, in (0, 0.05) clamped to 0.05, anything else 1. Pure. */
export function parseTimerScale(raw) {
    if (raw === undefined || raw.trim() === "")
        return 1;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0 || n >= 1)
        return 1;
    return Math.max(n, MIN_TIMER_SCALE);
}
/** Called once, by the worker's process entry. */
export function setTimerScaleFromEnv(env) {
    scale = parseTimerScale(env[TIMER_SCALE_ENV]);
}
/** `ms` shortened by the factor (never below 1 ms); `ms` itself when the factor is 1. */
export function scaledMs(ms) {
    return scale === 1 ? ms : Math.max(1, Math.round(ms * scale));
}
//# sourceMappingURL=timer_scale.js.map