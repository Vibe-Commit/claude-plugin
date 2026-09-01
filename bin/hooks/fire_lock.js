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
import { linkSync, openSync, readFileSync, unlinkSync, writeFileSync, closeSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { repoSessionsDir } from "../paths.js";
/** How much longer than the budget a lock may sit before anyone may reclaim it. */
const STALE_MARGIN_MS = 2_000;
/**
 * Where one firing's lock lives — beside the session state it protects.
 *
 * `null` when the repo key is empty, matching `sessionStatePath`: a hook with no
 * project resolved has nothing to serialise against and must not invent a path.
 */
export function fireLockPath(home, key) {
    const dir = repoSessionsDir(home, key.repoKey);
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
    const mine = JSON.stringify({
        pid: process.pid,
        at: Date.now(),
        nonce: randomBytes(8).toString("hex"),
    });
    if (!publish(path, mine)) {
        // Taken. Is the holder alive, or did one die mid-flight?
        const held = heldSince(path);
        if (held !== null && Date.now() - held <= budgetMs + STALE_MARGIN_MS)
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
    let released = false;
    return {
        release: () => {
            if (released)
                return;
            released = true;
            try {
                // ⛔ ONLY IF STILL OURS. A stale reclaim may have handed this path to
                // another process while we were running; deleting it then would drop
                // THEIR lock and re-admit the double-send.
                if (readFileSync(path, "utf8") === mine)
                    unlinkSync(path);
            }
            catch {
                // Already gone, or unreadable. Either way there is nothing of ours left.
            }
        },
    };
}
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
/** When the lock on disk was taken, or `null` if it cannot be dated. */
function heldSince(path) {
    try {
        const at = JSON.parse(readFileSync(path, "utf8")).at;
        return typeof at === "number" ? at : null;
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=fire_lock.js.map