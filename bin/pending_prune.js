/**
 * ORPHAN PENDING FILES — `TODOS[175]`.
 *
 * A `<sid>.pending.jsonl` has ONE consumer: its own session's running hook (D2 / cross-promotion forbid any other). Two
 * producers write them — the cold rung (an env id never seen) and, since 0.4.1, a STALE-OWN id — so an id whose session
 * never runs again leaves its file for ever, and `status` counted it beside the real spool: a permanent "N commits are
 * waiting" with no remedy (`finalize` has no session to close).
 *
 * ## Why deleting one is safe
 * Since 0.4.1 a pending line is promotable only if it was observed no earlier than the start of the turn being delivered
 * (`pending_bound.ts`), i.e. only by a turn that was ALREADY RUNNING when the commit was observed. A line older than any
 * plausible turn can never pass that bound: it is dead weight, not a recoverable edge. (A turn longer than the TTL loses
 * its edge — the safe direction: a lost edge, never a wrong one.)
 *
 * ## The rule
 *  - TTL 7 days, STRICTLY older. A file is EXPIRED when its mtime AND the `observedAt` of every line are past it. A legacy
 *    0.4.0 line has no `observedAt`; the mtime ages it. ⛔ NEVER the line's `at` (the committer date — settable).
 *  - WHOLE FILES ONLY, and only `*.pending.jsonl`. Survivors are never rewritten (`appendPending` is an unlocked
 *    read-modify-write, so a rewrite could race it). `.spool.jsonl` (real, attributed commits), rewrites and state files are
 *    never touched.
 *  - At most 50 files per call. Called from the Stop and SessionEnd hooks only — not `post-commit` (it runs under git) and
 *    not `status` (readers stay read-only).
 *
 * ## The race, narrowed: rename to a tombstone, re-read, put back anything fresh
 * Check-then-delete leaves a window in which an append lands in a file we then delete. So the file is first RENAMED to
 * `<name>.expired-<ts>` — an atomic step after which `appendPending` creates a NEW file at the old path — and the tombstone
 * is re-read: if it is no longer expired (a line landed before the rename) it goes back, MERGED into any new file by sha
 * rather than clobbering it; otherwise it is deleted. The lost-append window is the rename itself. A crashed prune leaves a
 * tombstone; one older than an hour (judged by the timestamp in its NAME — a rename keeps the old mtime) is settled the
 * same way on the next pass.
 *
 * ## Self-announcing, counts only
 * A silent delete would turn a loss into a non-event. What was discarded is tallied in `pruned-pending.tally` (a name no
 * other scan of the sessions directory matches) as `{files, lines, at}`: no sha, no session id. `status` shows one sentence
 * for up to 7 days after the last discard; an older tally restarts instead of accumulating.
 *
 * Nothing here throws: a hook must exit 0.
 */
import { appendFileSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repoSessionsDir } from "./paths.js";
export const PENDING_TTL_MS = 7 * 24 * 3600_000;
export const PRUNE_MAX_FILES = 50;
/** A tombstone younger than this may belong to a prune that is still running in another process. */
export const TOMBSTONE_GRACE_MS = 3600_000;
const PENDING_SUFFIX = ".pending.jsonl";
const TOMBSTONE = /^(.+\.pending\.jsonl)\.expired-(\d+)$/;
const TALLY_NAME = "pruned-pending.tally";
const nonBlank = (raw) => raw.split("\n").filter((l) => l.trim() !== "");
/** Pure. Expired = strictly older than the TTL on the file's mtime AND on every line's `observedAt`. */
export function pendingExpired(raw, mtimeMs, nowMs) {
    if (!(nowMs - mtimeMs > PENDING_TTL_MS))
        return false;
    for (const l of nonBlank(raw)) {
        let rec;
        try {
            rec = JSON.parse(l);
        }
        catch {
            continue;
        }
        const at = rec !== null && typeof rec === "object" ? rec.observedAt : undefined;
        if (typeof at === "number" && Number.isFinite(at) && !(nowMs - at > PENDING_TTL_MS))
            return false;
    }
    return true;
}
/** Reads the file; an unreadable one is NOT expired (never count or delete what cannot be examined). */
export function pendingFileExpired(path, nowMs) {
    try {
        return pendingExpired(readFileSync(path, "utf8"), statSync(path).mtimeMs, nowMs);
    }
    catch {
        return false;
    }
}
function shaOf(line) {
    try {
        const s = JSON.parse(line).sha;
        return typeof s === "string" ? s : null;
    }
    catch {
        return null;
    }
}
/** Put a tombstone's lines back under its original name, merging into a file that appeared meanwhile; then remove it. */
function restore(tomb, original, raw) {
    let live = null;
    try {
        live = readFileSync(original, "utf8");
    }
    catch {
        /* nothing there */
    }
    if (live === null) {
        renameSync(tomb, original);
        return;
    }
    const have = new Set(nonBlank(live).map(shaOf));
    for (const l of nonBlank(raw))
        if (!have.has(shaOf(l)))
            appendFileSync(original, `${l}\n`);
    rmSync(tomb, { force: true });
}
/** Examine one tombstone (just made, or left by a crash): delete it if still expired, else restore it. Returns the lines discarded. */
function settle(tomb, original, nowMs) {
    let raw;
    let mtimeMs;
    try {
        raw = readFileSync(tomb, "utf8");
        mtimeMs = statSync(tomb).mtimeMs;
    }
    catch {
        return 0;
    }
    if (!pendingExpired(raw, mtimeMs, nowMs)) {
        restore(tomb, original, raw);
        return 0;
    }
    rmSync(tomb, { force: true });
    return nonBlank(raw).length;
}
export function pruneOrphanPending(home, repoKey, nowMs, seams = {}) {
    let files = 0;
    let lines = 0;
    try {
        const dir = repoSessionsDir(home, repoKey);
        if (dir === null)
            return { files, lines };
        const entries = readdirSync(dir).sort();
        let budget = PRUNE_MAX_FILES;
        for (const entry of entries) {
            if (budget <= 0)
                break;
            try {
                const t = TOMBSTONE.exec(entry);
                if (t !== null) {
                    if (nowMs - Number(t[2]) <= TOMBSTONE_GRACE_MS)
                        continue; // maybe mid-flight in another process
                    budget -= 1;
                    const n = settle(join(dir, entry), join(dir, t[1]), nowMs);
                    if (n > 0) {
                        files += 1;
                        lines += n;
                    }
                    continue;
                }
                if (!entry.endsWith(PENDING_SUFFIX))
                    continue;
                const path = join(dir, entry);
                if (!pendingFileExpired(path, nowMs))
                    continue;
                budget -= 1;
                const tomb = `${path}.expired-${nowMs}`;
                renameSync(path, tomb);
                seams.afterRename?.(tomb, path);
                const n = settle(tomb, path, nowMs);
                if (n > 0) {
                    files += 1;
                    lines += n;
                }
            }
            catch {
                /* one unreadable entry must not stop the pass */
            }
        }
        if (files > 0 || lines > 0)
            recordTally(dir, files, lines, nowMs);
    }
    catch {
        /* never throw from a hook */
    }
    return { files, lines };
}
function readTally(dir) {
    try {
        const t = JSON.parse(readFileSync(join(dir, TALLY_NAME), "utf8"));
        if (Number.isSafeInteger(t.files) && Number.isSafeInteger(t.lines) && typeof t.at === "number" && Number.isFinite(t.at))
            return t;
    }
    catch {
        /* absent or damaged: no tally */
    }
    return null;
}
function recordTally(dir, files, lines, nowMs) {
    try {
        const prev = readTally(dir);
        const carry = prev !== null && nowMs - prev.at <= PENDING_TTL_MS ? prev : { files: 0, lines: 0, at: nowMs };
        const next = { files: carry.files + files, lines: carry.lines + lines, at: nowMs };
        writeFileSync(join(dir, TALLY_NAME), `${JSON.stringify(next)}\n`, { mode: 0o600 });
    }
    catch {
        /* the discard already happened; failing to announce it must not undo or throw */
    }
}
/** The counts to announce, or null when nothing was discarded in the last 7 days. */
export function readPruneTally(home, repoKey, nowMs) {
    const dir = repoSessionsDir(home, repoKey);
    if (dir === null)
        return null;
    const t = readTally(dir);
    if (t === null || nowMs - t.at > PENDING_TTL_MS || (t.files === 0 && t.lines === 0))
        return null;
    return { files: t.files, lines: t.lines };
}
//# sourceMappingURL=pending_prune.js.map