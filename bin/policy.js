/**
 * The failure policy — CR-018, D58 (plan §ER22/§ER10/§ER11/§ER4).
 *
 * The defect this replaces, verbatim from the register: *"5xx was unclassified
 * and fell through to advance-and-discard; 401/413 never succeed."* Every failed
 * POST used to reach the same code, so the offset moved forward as if the bytes
 * had been delivered. They had not.
 *
 * ## Three classes, and why `never` and `fatal` are not the same class
 *
 *   later   Hold the offset. The NEXT hook invocation retries from the same
 *           point. Transient: 5xx, no-response, 429, and 403 — a 403 here is
 *           org-approval-pending, which means later, not failed (D60 §D12).
 *   never   Advance PAST the failing bytes and stamp a gap, so the record shows
 *           an honest hole instead of pretending nothing happened. Per-PAYLOAD:
 *           resending the identical bytes cannot work (413, structurally
 *           malformed 4xx).
 *   fatal   Stop attempting further sends for this session until the user
 *           reconnects. Per-CREDENTIAL, which is the whole difference from
 *           `never`: 401 does not describe these bytes, it describes the token.
 *
 * **`later` never means a synchronous retry inside one hook invocation.** D56
 * plan §D8 is a founder override that is not to be re-argued: the hook must never
 * block or slow a developer's turn. "Later" means the bytes stay in the
 * transcript file — which is where they already are — and the hook that fires on
 * the next turn picks them up from the same offset.
 *
 * ## The table is data on purpose
 *
 * The title's word "table" is load-bearing. The classification is a literal data
 * structure, so it is auditable by reading it and testable without exercising a
 * real network failure. The original bug was an UNCLASSIFIED status silently
 * defaulting to lossy behaviour, so the default here is explicit and it is
 * `later` — the safe direction. A status nobody enumerated holds its bytes; it
 * never discards them.
 *
 * This module is PURE. No fs, no network, no clock — `state.ts` persists, and the
 * caller supplies `nowMs`. That is what lets both backlog caps be tested at their
 * boundaries without waiting a day for one of them.
 */
import { ERRORS } from "./copy/index.js";
/**
 * THE TABLE. Status codes named one by one, because a family rule that swept up
 * a whole `4xx` would be the implicit fallthrough this task exists to remove.
 *
 * Adding a row is how a new structurally-invalid status becomes `never`. Until
 * someone does, an unnamed `4xx` resolves to `DEFAULT_CLASS` and HOLDS its bytes:
 * a status we have not reasoned about is not one we discard data for.
 */
export const STATUS_CLASSES = new Map([
    // Structurally malformed request. Identical bytes will be rejected identically.
    [400, "never"],
    // The credential, not the payload. Terminal until the user reconnects.
    [401, "fatal"],
    // Org approval pending (D60 §D12). Capture has not stopped; it is waiting.
    [403, "later"],
    // Payload too large. Retrying the same bytes cannot work.
    [413, "never"],
    // Rate limited. The definition of transient.
    [429, "later"],
]);
/** `5xx` — the server's problem, not the payload's. */
export const SERVER_ERROR_CLASS = "later";
/** No HTTP response at all: DNS, refused, TLS, timeout, abort. */
export const NETWORK_CLASS = "later";
/**
 * The explicit default. **It is `later` and it must stay `later`.** An implicit
 * fallthrough to advance-and-discard is the original defect at a smaller scale.
 */
export const DEFAULT_CLASS = "later";
/** Classify one HTTP status. `2xx` is the only success. */
export function classifyStatus(status) {
    if (status >= 200 && status < 300)
        return "ok";
    const named = STATUS_CLASSES.get(status);
    if (named !== undefined)
        return named;
    if (status >= 500 && status < 600)
        return SERVER_ERROR_CLASS;
    return DEFAULT_CLASS;
}
/** Classify one attempt, response or not. */
export function classify(outcome) {
    return outcome.kind === "unreachable" ? NETWORK_CLASS : classifyStatus(outcome.status);
}
/**
 * The §13.6 copy for a class.
 *
 * `ERRORS` was scaffolded for this task and carries exactly these three lines, so
 * this is the one place a class becomes a sentence. Nothing in the HOOK path
 * calls it — a hook speaks only through `systemMessage` (§13.7) — but `CR-021`'s
 * `status` needs a class-to-copy mapping and this is where it belongs rather than
 * as a fourth `switch` in a verb body.
 */
export function failureCopy(cls) {
    switch (cls) {
        case "later":
            return ERRORS.networkLater;
        case "never":
            return ERRORS.payloadNever;
        case "fatal":
            return ERRORS.authFatal;
    }
}
export const EMPTY_FILE_STATE = {
    sentOffset: 0,
    backlog: [],
    gapBytes: 0,
    gapCount: 0,
};
/**
 * The caps.
 *
 * ⚠ **Neither the register nor `DECISIONS.md` specifies an eviction policy once a
 * cap is hit.** What is decided is only that both caps exist. The rule below is
 * this task's choice, stated rather than smuggled: **drop the oldest span,
 * advance past it, stamp a gap, continue.** It is the `never` class's own shape
 * applied to our own storage, and it is the only option that neither grows
 * unbounded nor blocks — the two things D56 §D8 forbids outright.
 *
 * `entries` is not a third policy. It is the same drop-oldest rule guarding the
 * degenerate shape where a file grows one byte at a time: the byte cap alone
 * would permit `MAX_BACKLOG_BYTES` single-byte entries.
 */
export const BACKLOG_CAPS = {
    bytes: 8 * 1024 * 1024,
    ageMs: 24 * 60 * 60 * 1000,
    entries: 512,
};
/**
 * Read the caps from the environment.
 *
 * Same shape as `hookBudgetMs`: an unset or unparseable value takes the default
 * rather than disabling the cap, because a cap that an empty string can switch
 * off is not a cap. Present for operators with unusual transcript volumes and
 * for the tests, which have to reach a boundary they cannot otherwise reach.
 */
export function resolveCaps(env) {
    return {
        bytes: positiveOr(env.VIBECOMMIT_BACKLOG_MAX_BYTES, BACKLOG_CAPS.bytes),
        ageMs: positiveOr(env.VIBECOMMIT_BACKLOG_MAX_AGE_MS, BACKLOG_CAPS.ageMs),
        entries: positiveOr(env.VIBECOMMIT_BACKLOG_MAX_ENTRIES, BACKLOG_CAPS.entries),
    };
}
function positiveOr(raw, fallback) {
    if (raw === undefined)
        return fallback;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
/** Undelivered bytes currently held. */
export function pendingBytes(state) {
    if (state.backlog.length === 0)
        return 0;
    return state.backlog[state.backlog.length - 1].to - state.backlog[0].from;
}
/**
 * The span the next attempt should carry: everything from the offset to `eof`.
 *
 * A file SHORTER than the offset means the transcript was replaced or truncated —
 * a new file at a path we have state for. Resync from 0 rather than reading a
 * negative-length slice; the server is idempotent on `(session, offset)`.
 */
export function nextSpan(state, eof) {
    const from = state.sentOffset > eof ? 0 : state.sentOffset;
    return eof > from ? { from, to: eof } : null;
}
/** Everything up to `to` arrived. The backlog clears. */
export function markDelivered(state, to) {
    return { ...state, sentOffset: to, backlog: [] };
}
/**
 * `never` — advance PAST the attempted span exactly once, stamping a gap.
 *
 * Exactly once is the point: the offset lands at `to`, so the next invocation
 * starts on the next, unrelated chunk. It neither loops on the poisoned bytes nor
 * swallows what comes after them.
 */
export function markSkipped(state, from, to) {
    const skipped = Math.max(0, to - from);
    return {
        sentOffset: to,
        backlog: [],
        gapBytes: state.gapBytes + skipped,
        gapCount: state.gapCount + (skipped > 0 ? 1 : 0),
    };
}
/**
 * `later` — hold the offset and remember when this span first failed.
 *
 * The span is appended only when the file has actually grown past what is already
 * held. A hook that fires twice on an unchanged file retries the same span rather
 * than minting a second entry with a newer timestamp, which would keep resetting
 * the age cap and make it unreachable.
 */
export function markHeld(state, span, nowMs, caps) {
    const base = state.sentOffset === span.from
        ? state
        : // The offset moved under us (a resync). Start the backlog over from here.
            { ...state, sentOffset: span.from, backlog: [] };
    const last = base.backlog[base.backlog.length - 1];
    const heldTo = last?.to ?? base.sentOffset;
    const backlog = span.to > heldTo
        ? [...base.backlog, { from: heldTo, to: span.to, at: nowMs }]
        : base.backlog;
    return enforceCaps({ ...base, backlog }, nowMs, caps);
}
/**
 * Shed the oldest spans until every cap holds.
 *
 * Never blocks, never grows. Each shed span advances the offset past itself and
 * stamps a gap, so what the server sees is a discontinuity in `byteOffset` — an
 * honest hole — and not a silent renumbering.
 */
export function enforceCaps(state, nowMs, caps) {
    let sentOffset = state.sentOffset;
    let backlog = state.backlog;
    let gapBytes = state.gapBytes;
    let gapCount = state.gapCount;
    while (backlog.length > 0) {
        const oldest = backlog[0];
        const overBytes = backlog[backlog.length - 1].to - backlog[0].from > caps.bytes;
        const overAge = nowMs - oldest.at > caps.ageMs;
        const overEntries = backlog.length > caps.entries;
        if (!overBytes && !overAge && !overEntries)
            break;
        sentOffset = oldest.to;
        gapBytes += oldest.to - oldest.from;
        gapCount += 1;
        backlog = backlog.slice(1);
    }
    return { sentOffset, backlog, gapBytes, gapCount };
}
//# sourceMappingURL=policy.js.map