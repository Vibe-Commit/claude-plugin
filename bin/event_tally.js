/**
 * The ONE append-only counter behind every "a loss is never silent" tally in the client (multi-session attribution, T5 + T7; D6 · D12 · OV3).
 *
 * Three tallies count what the client had to give up on: `dropped-commits.tally` (commit lines that were not linked), `inferred-skipped.tally` (squash pairs) and
 * `pruned-pending.tally` (orphan waiting lines). The older two used to READ a JSON object, ADD to it and WRITE it back with no lock, so two processes counting at once (the worker,
 * and a concurrent `backfill` or `finalize` of another session in the same repo) lost an increment, and a counted loss turned silent again (OV3).
 *
 * ⛔ **ONE `O_APPEND` LINE PER EVENT.** `{"r": <reason>, "n": <count>, "at": <ms>}`: a few dozen bytes appended in one write is atomic, so concurrent writers never overwrite one
 * another, and the sum is READ, never stored. Counts only; the reasons are a closed set the caller names; nothing here can hold a sha, a session id or a path.
 *
 * ⛔ **THE WINDOW IS THE OLD TALLIES' RULE, EXACTLY (P2's ruling, 11-08).** A tally is shown while its NEWEST event is at most 7 days old, and the count is the events since the last gap of
 * more than 7 days between consecutive events: an older run restarts instead of accumulating, and a chain of events each within 7 days of the last keeps accumulating, as
 * "up to 7 days after the last one" always meant. (A hard "events older than 7 days are ignored" window would show different numbers from the sentences these tallies feed.)
 *
 * ⛔ **A FILE WRITTEN BY AN OLDER CLIENT STILL READS.** Those were one JSON object (`{oversize, sha256, set_aside, pruned, at}`, `{files, lines, at}`). The caller passes `legacy`, which turns such a
 * line into events at its own `at`, so an upgrade neither hides nor loses a count already shown. New events are APPENDED after it.
 *
 * The file is compacted to the current run by an atomic replace once it passes `COMPACT_BYTES` (hundreds of events): the one moment a concurrent append can still be lost, stated
 * rather than hidden. Nothing here throws: it can run inside the user's `git commit`.
 */
import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { writeFileAtomic } from "./atomic_write.js";
export const TALLY_TTL_MS = 7 * 24 * 3600_000;
const COMPACT_BYTES = 64 * 1024;
const isCount = (v) => typeof v === "number" && Number.isSafeInteger(v) && v > 0;
const isTime = (v) => typeof v === "number" && Number.isFinite(v);
/** The events in `text`. A damaged line, an unknown reason and a non-positive or fractional count are skipped; the rest still count. */
export function parseEvents(text, shape) {
    const out = [];
    for (const line of text.split("\n")) {
        if (line.trim() === "")
            continue;
        try {
            const o = JSON.parse(line);
            if (o === null || typeof o !== "object" || Array.isArray(o))
                continue;
            if (typeof o.r === "string" && shape.reasons.has(o.r) && isCount(o.n) && isTime(o.at)) {
                out.push({ r: o.r, n: o.n, at: o.at });
                continue;
            }
            const old = shape.legacy?.(o);
            if (old !== undefined && old !== null)
                out.push(...old.filter((e) => isCount(e.n) && isTime(e.at)));
        }
        catch {
            /* a torn line: skipped, the rest still counts */
        }
    }
    return out;
}
/** The events of the CURRENT run, newest first: back from the newest until a gap of more than the TTL. Empty when the newest is itself older than the TTL. */
export function currentRun(events, nowMs) {
    if (events.length === 0)
        return [];
    const sorted = [...events].sort((a, b) => b.at - a.at);
    if (nowMs - sorted[0].at > TALLY_TTL_MS)
        return [];
    const run = [sorted[0]];
    for (let i = 1; i < sorted.length; i += 1) {
        if (sorted[i - 1].at - sorted[i].at > TALLY_TTL_MS)
            break;
        run.push(sorted[i]);
    }
    return run;
}
/** Append one event per `(reason, n)` pair with `n > 0` to the tally file at `path`, creating its directory. Never throws. */
export function appendEvents(path, shape, events, nowMs) {
    try {
        const lines = events.filter((e) => isCount(e.n) && shape.reasons.has(e.r)).map((e) => `${JSON.stringify({ r: e.r, n: e.n, at: nowMs })}\n`);
        if (lines.length === 0)
            return;
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        // ONE write for all of an event group: lines of a group are adjacent, and each is atomic on its own.
        appendFileSync(path, lines.join(""), { mode: 0o600 });
        compactIfLarge(path, shape, nowMs);
    }
    catch {
        /* the event already happened; failing to count it must not throw */
    }
}
function compactIfLarge(path, shape, nowMs) {
    try {
        if (statSync(path).size <= COMPACT_BYTES)
            return;
        const run = currentRun(parseEvents(readFileSync(path, "utf8"), shape), nowMs).reverse();
        writeFileAtomic(path, run.map((e) => `${JSON.stringify(e)}\n`).join(""), 0o600);
    }
    catch {
        /* an oversize tally stays oversize: still correct, only larger */
    }
}
/** The per-reason sums of the current run at `path`, or `null` when there is no run (no file, nothing recent, or nothing counted). */
export function sumRun(path, shape, nowMs) {
    try {
        const run = currentRun(parseEvents(readFileSync(path, "utf8"), shape), nowMs);
        if (run.length === 0)
            return null;
        const sums = {};
        for (const reason of shape.reasons)
            sums[reason] = 0;
        for (const e of run)
            sums[e.r] += e.n;
        return sums;
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=event_tally.js.map