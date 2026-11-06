/**
 * The file locks under every writer: `claimPath` (the one mechanism), the session writer lock and the upload worker's lock.
 *
 * ## ⛔ WHAT USED TO BE HERE, AND WHY IT IS GONE (U6)
 * Until U6 the HOOK held a lock per firing `(repo, session, event)` (`claimFiring`, `CR-195`/U4, D205). The defect it guarded: Cursor reads the user-level
 * `~/.claude/settings.json` (`isClaudeCodeHooksEnabled()` defaults to ON) and maps `Stop`/`SessionEnd`/`PreCompact` onto its own events, so ONE Cursor event
 * fired our binary TWICE, and two processes then raced on one session state file: both read the same `sentOffset`, both sent the same span, both
 * reached `dropSpooled`, which truncates the spool by LINES CONSUMED. Dropping the same lines twice discards commits that were never sent, and
 * `capture_commits` rows cannot be retracted. The hook no longer sends or touches that state: it appends a firing line (one `O_APPEND` write, so two
 * hooks interleave whole lines) and the worker replays each firing alone, in order, under the session's writer lock; a duplicate firing is a
 * no-op by the pin (trap 1). The per-firing key and its loser-bows-out rule had nothing left to protect and were removed with the code that used them.
 *
 * ## What is here
 *  - `claimPath`: take the lock at a path or report a live holder. The holder writes its own staleness bound into the lock (C18 #2), beats it
 *    (`refresh`, C25) and releases only a lock that still carries its nonce.
 *  - `claimSessionWriter`: ONE writer per session (O5), whichever repo the writer stands in. The loser WAITS (spent out of its own deadline).
 *  - `claimUploader` / `uploaderAlive`: one worker per machine and identity (D4); the hook only READS the lock.
 */
import { linkSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, closeSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { sessionFileStem, targetsDir, uploaderLockPath } from "../paths.js";
/** How much longer than the budget a lock may sit before anyone may reclaim it. */
export const STALE_MARGIN_MS = 2_000;
/**
 * Take the lock at `path` or report that a live holder has it. `staleAfterMs` is how old a lock may be before it is presumed
 * to belong to a dead process and is reclaimed (exactly once, see the comment inside).
 */
export function claimPath(path, staleAfterMs) {
    // ⛔ THE HOLDER WRITES ITS OWN STALENESS BOUND INTO THE LOCK (C18 #2). A contender used to judge a lock by ITS OWN timeout, so a hook
    // (budget ~7 s) could unlink the live 60 s lock of `finalize`, and two writers then ran at once. Now a contender honours the value
    // the holder stamped; only a lock with none (written by an older client) falls back to the contender's own.
    const nonce = randomBytes(8).toString("hex");
    const mine = JSON.stringify({
        pid: process.pid,
        at: Date.now(),
        staleAfterMs,
        nonce,
    });
    if (!publish(path, mine)) {
        // Taken. Is the holder alive, or did one die mid-flight?
        const held = heldLock(path);
        if (held !== null && Date.now() - held.at <= (held.staleAfterMs ?? staleAfterMs))
            return null;
        // ⚠ Stale (or undatable, which means it was not written by this code).
        // Remove and try EXACTLY ONCE more: if a third process wins that race, it is
        // a live holder and bowing out is the correct answer anyway.
        try {
            unlinkSync(path);
        }
        catch {
            // Someone else reclaimed it first — they are now the live holder.
            return null;
        }
        if (!publish(path, mine))
            return null;
    }
    // THE NONCE IS THE LOCK'S IDENTITY (C25): `refresh` rewrites `at` and nothing else, so "is it still ours?" is "does the file carry our
    // nonce?", never "is it byte-for-byte what we wrote?".
    const isOurs = () => {
        try {
            const parsed = JSON.parse(readFileSync(path, "utf8"));
            return parsed !== null && typeof parsed === "object" && parsed.nonce === nonce ? { parsed } : null;
        }
        catch {
            return null;
        }
    };
    let released = false;
    let lost = false;
    return {
        release: () => {
            if (released)
                return;
            released = true;
            try {
                // ⛔ ONLY IF STILL OURS. A stale reclaim may have handed this path to
                // another process while we were running; deleting it then would drop
                // THEIR lock and re-admit the double-send.
                if (isOurs() !== null)
                    unlinkSync(path);
            }
            catch {
                // Already gone, or unreadable. Either way there is nothing of ours left.
            }
        },
        refresh: () => {
            if (released || lost)
                return false;
            try {
                // ⛔ Only a lock that still carries OUR nonce is re-stamped. A reclaimed lock holds another holder's, and writing over it
                // would hand the session to two writers again.
                const held = isOurs();
                if (held === null) {
                    lost = true;
                    return false;
                }
                const next = JSON.stringify({ ...held.parsed, at: Date.now() });
                // Replace atomically (the stamp is complete before it is visible, as `publish` insists): a contender reading mid-write
                // must see the old stamp or the new one, never an empty file it would treat as stale. The check-then-rename window is
                // only exploitable by a contender that finds the lock STALE inside it, which a holder that beats within its bound
                // never is.
                const staging = `${path}.${process.pid}.${randomBytes(6).toString("hex")}`;
                const fd = openSync(staging, "wx", 0o600);
                try {
                    writeFileSync(fd, next);
                }
                finally {
                    closeSync(fd);
                }
                try {
                    renameSync(staging, path);
                }
                catch (error) {
                    try {
                        unlinkSync(staging);
                    }
                    catch {
                        // Ours alone.
                    }
                    throw error;
                }
                return true;
            }
            catch {
                // Unreadable or unwritable: ownership cannot be shown, so the holder stops (fail closed).
                lost = true;
                return false;
            }
        },
    };
}
/** Where a session's ONE writer lock lives (O5): beside its target record, keyed by the session id alone. */
export function sessionWriterLockPath(home, sessionId) {
    return join(targetsDir(home), `${sessionFileStem(sessionId)}.writer.lock`);
}
/**
 * ⛔ THE ONE LOCK PER SESSION (O5, any-folder capture): serialises every writer of a session's target record, ledgers and
 * spools: every hook event, `finalize` and `backfill`, whichever repo each is standing in.
 *
 * The loser WAITS: it asks "is another writer touching this session right now?", and a worker's replay of one firing and a `finalize` or
 * `backfill` are different work that must not interleave on one record. The wait is spent out of the CALLER'S OWN budget:
 * it polls until `deadlineAtMs` and then gives up with `null`, and the bytes it did not send ride the next firing (or the idle
 * drain). A waiter never holds the watchdog hostage: `wait` is the caller's awaitable timer, not a blocking sleep.
 *
 * `staleAfterMs` is the age after which a lock is presumed to belong to a dead process: a hook passes its budget plus the
 * margin (a healthy holder is ended by its watchdog at the budget), an interactive verb its own ceiling.
 */
export async function claimSessionWriter(home, sessionId, options) {
    const path = sessionWriterLockPath(home, sessionId);
    for (;;) {
        const claim = claimPath(path, options.staleAfterMs);
        if (claim !== null)
            return claim;
        if (Date.now() >= options.deadlineAtMs)
            return null;
        await options.wait(WRITER_POLL_MS);
    }
}
/**
 * U5 — THE UPLOAD WORKER'S LOCK: one worker per machine and identity (D4). Its holder writes its own staleness bound and beats from a TIMER
 * (`UPLOADER_BEAT_MS`), so a worker that is alive is never judged dead however long one request runs, and a dead one goes stale within
 * `UPLOADER_STALE_MS`. The loser of the claim exits: someone else is serving the queue.
 */
export function claimUploader(home, identity) {
    return claimPath(uploaderLockPath(home, identity), UPLOADER_STALE_MS);
}
/** How often the worker re-stamps its lock. */
export const UPLOADER_BEAT_MS = 15_000;
/** Age after which an unbeaten worker lock is presumed to belong to a dead process: four missed beats. */
export const UPLOADER_STALE_MS = 4 * UPLOADER_BEAT_MS;
/**
 * U5 — IS A WORKER ALIVE FOR THIS IDENTITY? A read, never a claim: the hook asks this before it spawns and must not take, wait for or
 * remove a lock. A lock that cannot be read or dated reads as "no worker", which at worst spawns one that then loses the claim and exits.
 */
export function uploaderAlive(home, identity, nowMs = Date.now()) {
    const held = heldLock(uploaderLockPath(home, identity));
    return held !== null && nowMs - held.at <= (held.staleAfterMs ?? UPLOADER_STALE_MS);
}
/** How often a waiting writer retries. Short against any budget, long against the cost of a failed `link()`. */
const WRITER_POLL_MS = 20;
/**
 * Create the lock atomically, contents first.
 *
 * ⛔ **WRITE FIRST, PUBLISH SECOND — and `oauth/lock.ts` paid for this lesson
 * with a measured bug.** `openSync(path, "wx")` then `writeFileSync` creates the
 * lock EMPTY and fills it a moment later; in that window a second process reads
 * a zero-byte file, cannot date it, treats it as stale and reclaims a lock that
 * was just taken. `link()` is atomic and fails with `EEXIST`, and the staging
 * file already holds the full stamp before the link publishes it.
 */
function publish(path, contents) {
    const staging = `${path}.${process.pid}.${randomBytes(6).toString("hex")}`;
    try {
        mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
        // `wx` on the staging file also refuses to follow a symlink.
        const fd = openSync(staging, "wx", 0o600);
        try {
            writeFileSync(fd, contents);
        }
        finally {
            closeSync(fd);
        }
    }
    catch {
        return false;
    }
    try {
        linkSync(staging, path);
        return true;
    }
    catch {
        return false;
    }
    finally {
        try {
            unlinkSync(staging);
        }
        catch {
            // The staging file is ours alone; a failure to clean it up is not a
            // failure to lock, and the hook contract forbids saying anything.
        }
    }
}
/** The longest a holder's own bound is believed: a corrupt or hostile value must not wedge a lock for good. */
const MAX_HOLDER_STALE_MS = 10 * 60_000;
/** When the lock on disk was taken and how long its holder said it may be held, or `null` if it cannot be dated. */
function heldLock(path) {
    try {
        const parsed = JSON.parse(readFileSync(path, "utf8"));
        if (typeof parsed.at !== "number")
            return null;
        const bound = parsed.staleAfterMs;
        const own = typeof bound === "number" && Number.isFinite(bound) && bound > 0 ? Math.min(bound, MAX_HOLDER_STALE_MS) : null;
        return { at: parsed.at, staleAfterMs: own };
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=fire_lock.js.map