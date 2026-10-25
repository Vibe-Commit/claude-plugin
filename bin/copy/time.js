/**
 * Relative ages, for the one row that has one — `CR-021`, style guide §10.3.
 *
 * In `copy/` and not in a command body because it produces USER-FACING TEXT,
 * which is the whole rule this directory exists for (`strings.ts`'s header): a
 * quoted string inside a verb is the CR-090 precondition-1 violation. It is a
 * function rather than a constant for the same reason `unsupportedRuntime` is —
 * the sentence is templated on a value.
 *
 * No `Intl.RelativeTimeFormat`. Its output is locale-dependent, and §13.4's rule
 * that identical commands emit identical bytes is what makes screenshots, issue
 * pastes and golden-file tests comparable. A fixed English phrase is the same
 * choice `renderHelp` already makes by never reflowing to `stdout.columns`.
 */
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/**
 * How long ago `thenMs` was, as one phrase.
 *
 * Deliberately coarse: the caller is a human asking "is capture working?", and a
 * second-precision answer invites a precision the record does not have — the
 * stamp is written when the client's POST returned, not when the server sealed
 * the turn.
 *
 * A future timestamp (a clock that moved backwards, a state file copied between
 * machines) reads as `just now` rather than as a negative age. It is the one
 * answer that is never wrong in a way that misleads.
 */
export function relativeAge(thenMs, nowMs) {
    const elapsed = nowMs - thenMs;
    if (elapsed < MINUTE_MS)
        return "just now";
    if (elapsed < HOUR_MS)
        return plural(Math.floor(elapsed / MINUTE_MS), "minute");
    if (elapsed < DAY_MS)
        return plural(Math.floor(elapsed / HOUR_MS), "hour");
    return plural(Math.floor(elapsed / DAY_MS), "day");
}
function plural(count, unit) {
    return `${count} ${unit}${count === 1 ? "" : "s"} ago`;
}
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/**
 * `25 Sep` within the current year, `25 Sep 2024` for an older one — style guide
 * §10.1's day-month-year order, design review D26.
 *
 * ⛔ **UTC and a fixed English table**, for the reason `endDateText` gives: a
 * local date moves with the machine's timezone and `toLocaleDateString` with its
 * locale, and §13.4 wants identical commands to emit identical bytes. `now` is an
 * argument because a golden file that read the clock would be a different file
 * every January.
 */
export function shortDate(ms, nowMs) {
    const d = new Date(ms);
    const day = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
    return d.getUTCFullYear() === new Date(nowMs).getUTCFullYear()
        ? day
        : `${day} ${d.getUTCFullYear()}`;
}
//# sourceMappingURL=time.js.map