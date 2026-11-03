/**
 * One firing, one process — `CR-195`/U4, D205.
 *
 * ## ⛔ THE DEFECT THIS EXISTS FOR, MEASURED IN CURSOR'S OWN BUNDLE
 *
 * `connect` registers our hook in each agent's config. Cursor then reads **more
 * than its own**: `isClaudeCodeHooksEnabled()` returns
 * `thirdPartyExtensibilityObservable.get() ?? true` — ⛔ **defaulting to ON** —
 * and under it Cursor loads the USER-level `~/.claude/settings.json` and runs
 * every entry through a Claude→Cursor mapper whose table maps all three events
 * we register:
 *
 *     W2i = { …, Stop: stop, SessionEnd: sessionEnd, PreCompact: preCompact, … }
 *
 * So on a machine with both agents configured, ONE Cursor event fires our binary
 * TWICE — once from `~/.cursor/hooks.json` and once from Claude's settings,
 * mapped. Cursor does dedupe Claude-sourced entries against its own
 * (`_getDeduplicatedClaudeHooks`), but the key is derived from the entry, and
 * ours deliberately differ: the Cursor registration carries `--agent=cursor` so
 * the budget and event vocabulary are right. **Different key, no dedupe.**
 *
 * ⛔ **Two processes then race on one session state file.** Both read the same
 * `sentOffset`, both send the same span, both write it back — a duplicate
 * upload — and both reach `dropSpooled`, which truncates the spool by LINES
 * CONSUMED. Dropping the same lines twice discards commits that were never
 * sent, and `capture_commits` rows cannot be retracted (D105/D108). That is
 * unrecoverable, which puts it in the same class as the `SessionEnd` hole.
 *
 * ## ⚠ WHY THE LOSER BOWS OUT INSTEAD OF WAITING — the opposite of `oauth/lock.ts`
 *
 * The refresh lock makes its loser WAIT and re-read, because both callers need
 * the result. Here the loser needs nothing: the holder is running the same work
 * with the same inputs, so a second pass would send nothing anyway.
 *
 * ⛔ And waiting would be actively harmful on the one event that cannot afford
 * it. A waiter spends the budget the watchdog is counting down, and `stampGaps`
 * runs AFTER the send loop — which is precisely the arithmetic that produced the
 * G6 defect, where the reserve was measured against the wrong clock and the
 * final turn was lost. Adding a wait in front of `SessionEnd` would re-open it
 * from the other side.
 *
 * ## ⚠ WHY SKIPPING CANNOT SUPPRESS A LEGITIMATE CAPTURE
 *
 * The key is `(repo, session, event)`, so the only thing a skip can lose is a
 * SECOND firing of the SAME event in the SAME session while the first is still
 * running. Taken one event at a time:
 *
 *   - `Stop` and `PreCompact` fire repeatedly, and an overlapping one is
 *     harmless to drop: `hookBody`'s own comment is that *"every other event has
 *     a next invocation to pick up a lagging write"*. The bytes are not lost,
 *     they are sent by the next turn.
 *   - ⛔ `SessionEnd` has no next invocation — which is exactly why it is safe
 *     here. It fires **once per session**, so a concurrent second one is not a
 *     later capture at all; it is the duplicate this file exists to stop.
 *
 * So the arm that would be dangerous does not exist, and the arm that exists is
 * not dangerous. Stated rather than assumed, because "a lock that silently drops
 * work" is the right thing to be suspicious of.
 */
import { linkSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, closeSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { repoSessionsDir, sessionFileStem, targetsDir } from "../paths.js";
/** How much longer than the budget a lock may sit before anyone may reclaim it. */
export const STALE_MARGIN_MS = 2_000;
/** `FireKey.repoKey` meaning "this firing is session-scoped, not repo-scoped". Never a path, so it cannot collide with one. */
export const SESSION_SCOPE = "\u0000session";
/**
 * Where one firing's lock lives — beside the session state it protects.
 *
 * `null` when the repo key is empty, matching `sessionStatePath`: a hook with no
 * project resolved has nothing to serialise against and must not invent a path.
 */
export function fireLockPath(home, key) {
    // `SESSION_SCOPE` keys the firing by session and event alone (any-folder capture): the lock then lives beside the session's
    // target record and never creates a repo-digest directory, which a turn that ended outside any work tree has no business making.
    const dir = key.repoKey === SESSION_SCOPE ? targetsDir(home) : repoSessionsDir(home, key.repoKey);
    if (dir === null)
        return null;
    const session = key.sessionId.replace(/[^A-Za-z0-9._-]/g, "_") || "_";
    const event = key.event.replace(/[^A-Za-z0-9._-]/g, "_") || "_";
    return join(dir, `${session}.${event}.fire.lock`);
}
/**
 * Claim this firing, or report that another process already has it.
 *
 * `null` means **a live invocation is already doing this exact work** — the
 * caller's whole remaining job is to exit 0 quietly.
 *
 * ⚠ `budgetMs` is what makes the staleness bound DERIVED rather than guessed.
 * The watchdog ends a healthy holder at `budgetMs`, so nothing can legitimately
 * hold this longer than that plus the I/O either side; a lock older than
 * `budgetMs + STALE_MARGIN_MS` therefore belongs to a process that is gone.
 * Reclaiming too EARLY re-admits the double-send this prevents, and reclaiming
 * too LATE only skips one redundant invocation — so the margin leans late.
 */
export function claimFiring(home, key, budgetMs) {
    const path = fireLockPath(home, key);
    if (path === null)
        return null;
    return claimPath(path, budgetMs + STALE_MARGIN_MS);
}
/**
 * Take the lock at `path` or report that a live holder has it. `staleAfterMs` is how old a lock may be before it is presumed
 * to belong to a dead process and is reclaimed (exactly once, see the comment inside).
 */
function claimPath(path, staleAfterMs) {
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
 * It is NOT `claimFiring`. That one answers "is this exact firing already running?" and the loser BOWS OUT; this one answers
 * "is another writer touching this session right now?" and the loser WAITS, because a Stop and a PreCompact (or a hook and a
 * `finalize`) are different work that must not interleave on one record. The wait is spent out of the CALLER'S OWN budget:
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