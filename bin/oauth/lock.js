/**
 * Cross-process single-flight for the refresh grant.
 *
 * ## ⚠ WHY THIS FILE EXISTS AT ALL — read before simplifying it away
 *
 * `vibecommit-mcp/src/oauth/refresh.ts` implements refresh-token FAMILY rotation
 * with application-layer reuse detection: presenting a token that already has a
 * child row is treated as a replay and **revokes the ENTIRE FAMILY** with
 * `revoked_reason = 'reuse_detected'`. There is a database-level guard behind it
 * too — a partial unique index on `parent_token_id`, so of two concurrent
 * rotations from the same tail exactly one INSERT wins and the loser's 23505 is
 * *also* read as reuse.
 *
 * Two terminals running a read at the same moment present the same tail token.
 * That is not an edge case; it is Tuesday. Without a lock, one of them wins, the
 * other is classed a replay, and **the user is signed out of every machine at
 * once** — from doing nothing but running the same command twice.
 *
 * So the mutual exclusion has to be BETWEEN PROCESSES. An in-process mutex, a
 * module-level promise, an `async` queue — every in-memory construct is the
 * wrong shape here, because the two racers are two separate `vibecommit`
 * invocations that share nothing but a filesystem.
 *
 * ## The loser waits and RE-READS — it does not queue up to present the old token
 *
 * `withRefreshLock` gives its callback the lock, nothing more. The callback's
 * first act must be to re-read the session from disk, because by the time a
 * waiter acquires the lock the winner has already rotated and saved: the tail
 * the waiter loaded BEFORE waiting is now the parent of a live row, and
 * presenting it is precisely the replay this file exists to prevent. See
 * `signin.ts`'s `authorizedAccessToken`, which is the only caller and is written
 * in exactly that order.
 *
 * ## The stale timeout is DERIVED, not guessed
 *
 * A crashed holder must not wedge every future read, so a lock older than
 * `STALE_MS` is reclaimable. That number is not a feel for how long things take:
 * this project has already paid for one wall-clock guess (`CR-126`/D83 found a
 * `setTimeout(..., 60)` that was a guess at boot duration, sitting between p50
 * and p90 and firing ~14% of the time idle and ~28% under load).
 *
 * The holder does exactly ONE thing while holding this lock: a single POST to
 * the token endpoint, and that POST is bounded by an `AbortController` at
 * `REFRESH_REQUEST_TIMEOUT_MS`. So the longest a HEALTHY holder can hold the
 * lock is that timeout plus the file I/O either side of it, and `STALE_MS` is
 * that bound plus a margin — an arithmetic consequence of the operation it
 * bounds, which means changing the request timeout moves it automatically
 * rather than leaving a stale constant behind.
 *
 * Reclaiming too EARLY is the dangerous direction: it puts two processes into
 * the refresh at once, which is the family revoke. Reclaiming too LATE only
 * makes a rare recovery slower. The margin is therefore generous on purpose.
 *
 * Nothing is imported or copied from the closed core (D60 §D1a): what crossed
 * the boundary is the RULE that concurrent rotation is a revoke, which is a
 * behavioural contract this client must obey, not an implementation.
 *
 * @provenance vibecommit-mcp src/oauth/refresh.ts — family-rotation reuse-detection rule, retyped
 */
import { randomBytes } from "node:crypto";
import { closeSync, linkSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { rootDir } from "../paths.js";
/**
 * The whole budget for one refresh POST. Also the ONLY thing done under the
 * lock, which is what makes `STALE_MS` below derivable.
 */
export const REFRESH_REQUEST_TIMEOUT_MS = 10_000;
/**
 * When a lock is old enough to be a corpse rather than a holder.
 *
 * `REFRESH_REQUEST_TIMEOUT_MS` bounds the healthy hold; the rest is margin for
 * the read/write either side and for a machine under enough load that a process
 * does not get scheduled promptly. Erring long is the cheap direction — see the
 * module note.
 */
export const STALE_MS = REFRESH_REQUEST_TIMEOUT_MS + 5_000;
/**
 * How long a waiter waits before giving up.
 *
 * Strictly greater than `STALE_MS`: a waiter that gave up sooner would abandon a
 * refresh that a perfectly healthy holder was still allowed to be running, and
 * the user would see a spurious failure while the thing they needed was in
 * flight one process over.
 */
export const WAIT_TIMEOUT_MS = STALE_MS + 2_000;
/**
 * Poll interval while waiting. Short enough that the handoff is imperceptible,
 * long enough that waiting costs nothing: over a full 10s refresh this is a few
 * hundred `readFileSync` calls on a file in the page cache.
 */
const POLL_MS = 20;
/** One lock for the refresh grant. Sits beside the session it protects. */
export function refreshLockPath(home) {
    return join(rootDir(home), "refresh.lock");
}
const sleep = (ms) => new Promise((resolve) => {
    setTimeout(resolve, ms);
});
/**
 * The lock's contents: enough to tell one holder from another, and nothing
 * secret. Never a token — a lock file has looser handling than a credential
 * file by nature (it is created and destroyed constantly) and is exactly the
 * wrong place to put a bearer secret.
 */
function stamp() {
    // The nonce is what makes the stamp an IDENTITY rather than a description.
    // `releaseIfMine` compares these bytes to decide whether the lock on disk is
    // still ours, and pids are recycled — so without it, "same pid, same
    // millisecond" would be a (remote) way to delete somebody else's lock.
    return JSON.stringify({
        pid: process.pid,
        at: Date.now(),
        nonce: randomBytes(8).toString("hex"),
    });
}
function heldSince(raw) {
    try {
        const at = JSON.parse(raw).at;
        return typeof at === "number" ? at : null;
    }
    catch {
        return null;
    }
}
/**
 * Try once to create the lock exclusively.
 *
 * `wx` is `O_CREAT | O_EXCL | O_WRONLY`, which the kernel makes atomic: of any
 * number of processes calling this at the same instant, exactly one gets the
 * file and the rest get EEXIST. That atomicity is the entire mutual exclusion —
 * a "does it exist? then create it" pair would have a window between the two
 * calls, and a window is all this needs to fail.
 */
function tryAcquire(path) {
    const mine = stamp();
    // ⚠ WRITE FIRST, PUBLISH SECOND — and this ordering is a BUG FIX, not style.
    //
    // The obvious implementation is `openSync(path, "wx")` then `writeFileSync`.
    // That creates the lock EMPTY and fills it a moment later, and in that window
    // a second process reads a zero-byte file. `heldSince` cannot date it, the
    // wait loop's "an undatable lock was not written by this code, treat it as
    // stale" branch fires, and the racer RECLAIMS A LOCK THAT WAS JUST TAKEN.
    // Both processes then refresh, and the server revokes the family — the exact
    // outcome this module exists to prevent, reached through the module itself.
    //
    // Measured, not theorised: the two-process case in `test/oauth-signin.test.ts`
    // failed on 2 of 8 runs with the second child getting `expired`, which is the
    // server's answer to a replayed token.
    //
    // `link()` is the fix because it is ATOMIC and it fails with EEXIST when the
    // target exists. The temp file already holds the full stamp before the link
    // publishes it, so the lock is never observable half-written. The temp name
    // carries a random component as well as the pid: two processes must not
    // collide on the staging file either.
    const staging = `${path}.${process.pid}.${randomBytes(6).toString("hex")}`;
    try {
        // `wx` on the STAGING file also refuses to follow a symlink (`O_CREAT |
        // O_EXCL`), so a pre-planted link cannot be written through.
        const fd = openSync(staging, "wx", 0o600);
        try {
            writeFileSync(fd, mine);
        }
        finally {
            closeSync(fd);
        }
    }
    catch {
        return null;
    }
    try {
        linkSync(staging, path);
    }
    catch {
        // Somebody else holds it. Ours never became visible.
        return null;
    }
    finally {
        try {
            unlinkSync(staging);
        }
        catch {
            // The lock path keeps the inode alive; a stranded staging file is inert.
        }
    }
    // Returned so the RELEASE can prove the lock it deletes is still ours.
    return mine;
}
/**
 * Reclaim a lock whose holder is gone.
 *
 * Compare-then-delete: the same bytes we saw when we judged it stale must still
 * be there when we unlink. Without that a third process that acquired the lock
 * in between would have it deleted out from under it.
 *
 * ⚠ Residual, stated rather than papered over: the compare and the unlink are
 * not one atomic operation, so a sufficiently unlucky interleaving can still
 * drop a fresh lock. Reaching it requires a process to crash mid-refresh, a
 * second to wait out the full `STALE_MS`, and a third to acquire inside the
 * microseconds between the re-read and the unlink. The cost of closing it
 * properly is a directory-rename protocol, and this package's failure mode on
 * that path is one avoidable re-sign-in, not data loss.
 */
function reclaimIfUnchanged(path, observed) {
    try {
        if (readFileSync(path, "utf8") !== observed)
            return;
        unlinkSync(path);
    }
    catch {
        // Gone already, or not ours to remove. Either way the next acquire decides.
    }
}
/**
 * Release, but ONLY if the lock on disk is still the one we took.
 *
 * ⚠ `/cso` finding, HIGH, and it is the family revoke arriving by the back door.
 * An unconditional `unlink` on release is wrong whenever a holder outlived
 * `STALE_MS`: a waiter reclaims the stale lock and starts its own refresh, and
 * then the original holder wakes up and deletes THAT lock — letting a third
 * process in while the second is mid-rotation. Two live refreshes is exactly the
 * replay the server reads as `reuse_detected`.
 *
 * The obvious objection is that a healthy holder cannot exceed `STALE_MS`,
 * because its one request is bounded by an `AbortController` well inside it.
 * True — and irrelevant. **A laptop that sleeps mid-refresh does exceed it**, and
 * so does any process the scheduler or a debugger suspends. Wall-clock bounds
 * hold for code, not for the machine underneath it.
 *
 * Same compare-then-delete as the reclaim above, and the same stated residual:
 * the read and the unlink are not one atomic operation.
 */
function releaseIfMine(path, mine) {
    try {
        if (readFileSync(path, "utf8") !== mine)
            return;
        unlinkSync(path);
    }
    catch {
        // Already gone. Nothing to undo.
    }
}
/**
 * Run `fn` with the refresh lock held.
 *
 * Returns `{ kind: "timeout" }` rather than throwing when the lock cannot be
 * taken: the caller is a read verb, and a read that cannot refresh should tell
 * the user what happened, not take an exception out of a lock file.
 *
 * The lock is released in a `finally`, so a throwing callback still frees it.
 */
export async function withRefreshLock(home, fn, now = Date.now) {
    const path = refreshLockPath(home);
    const deadline = now() + WAIT_TIMEOUT_MS;
    let mine = tryAcquire(path);
    while (mine === null) {
        let raw;
        try {
            raw = readFileSync(path, "utf8");
        }
        catch {
            // Released between our failed acquire and this read. Go straight round.
            mine = tryAcquire(path);
            continue;
        }
        const since = heldSince(raw);
        // An unparseable or timestamp-less lock is treated as stale immediately: it
        // was not written by this code, and waiting `STALE_MS` for a file nobody can
        // date is waiting for nothing.
        if (since === null || now() - since > STALE_MS) {
            reclaimIfUnchanged(path, raw);
            mine = tryAcquire(path);
            continue;
        }
        if (now() >= deadline)
            return { kind: "timeout" };
        await sleep(POLL_MS);
        mine = tryAcquire(path);
    }
    try {
        return { kind: "ok", value: await fn() };
    }
    finally {
        releaseIfMine(path, mine);
    }
}
//# sourceMappingURL=lock.js.map