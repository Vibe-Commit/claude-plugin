/**
 * The pending-revoke queue's FILE: its path's format, and reading it (slice 2, S4). Split from `pending_revoke.ts` so that what
 * `status` needs — a COUNT — does not drag the writer and the network revoke onto every process's load path.
 *
 * Read through `readSecretFile` (the same mode checks as `credentials.json`): a file or folder others can read, a file that is not
 * what this client wrote, or one with a row it cannot read all come back `refused`, and `pending_revoke.ts` never overwrites those.
 * Nothing here writes, sends or prints a token; the only thing it hands `status` is how many rows wait.
 */
import { INGEST_TOKEN_PREFIX, readSecretFile } from "./credential.js";
import { pendingRevokePath } from "./paths.js";
/** How long a holder's lease lasts: a `g` whose question stays open longer may be revoked by another verb, and its commit then refuses. */
export const LEASE_MS = 30 * 60 * 1000;
/**
 * Is the row leased at `now`? BOTH must hold: the holder's pid is alive (`kill(pid, 0)`: EPERM counts as alive, ESRCH as dead) and
 * `now` is before the EARLIER of the row's own `lease_until` and `minted_at` + 30 minutes. The lease is capped at its mint: a
 * `lease_until` written far in the future (a bug, or an edit) does not keep a live pid's row out of the retry for ever. A dead holder or
 * an expired lease is an orphan, which any verb's retry revokes.
 */
export function leased(row, now) {
    if (row.lease === null)
        return false;
    const until = Math.min(Date.parse(row.lease.lease_until), Date.parse(row.minted_at) + LEASE_MS);
    if (!(until > now.getTime()))
        return false;
    try {
        process.kill(row.lease.pid, 0);
        return true;
    }
    catch (error) {
        return error.code === "EPERM";
    }
}
export function readQueue(home) {
    const read = readSecretFile(home, pendingRevokePath(home));
    if (read.kind === "absent")
        return { kind: "absent" };
    if (read.kind !== "ok")
        return { kind: "refused", read };
    try {
        const doc = JSON.parse(read.raw);
        if (doc === null || typeof doc !== "object" || !Array.isArray(doc.revokes))
            return { kind: "refused", read: { kind: "unreadable" } };
        const rows = [];
        for (const row of doc.revokes) {
            if (row === null || typeof row !== "object")
                return { kind: "refused", read: { kind: "unreadable" } };
            const r = row;
            if (typeof r.token !== "string" || !r.token.startsWith(INGEST_TOKEN_PREFIX) || typeof r.minted_at !== "string" || typeof r.origin !== "string") {
                // A row this client cannot read is a row it must not lose: refuse the whole file rather than rewrite it without the row.
                return { kind: "refused", read: { kind: "unreadable" } };
            }
            // A lease this client cannot read is NO lease: the row is an orphan, which errs toward revoking.
            const l = r.lease;
            const lease = l !== null && l !== undefined && typeof l === "object" && typeof l.pid === "number" && Number.isInteger(l.pid) && typeof l.lease_until === "string"
                ? { pid: l.pid, lease_until: l.lease_until }
                : null;
            rows.push({ token: r.token, minted_at: r.minted_at, origin: r.origin, lease });
        }
        return { kind: "ok", rows };
    }
    catch {
        return { kind: "refused", read: { kind: "unreadable" } };
    }
}
/** The rows waiting, for a count. An absent, insecure or unreadable file reads as none (it is never sent from). */
export function readPendingRevokes(home) {
    const queue = readQueue(home);
    return queue.kind === "ok" ? queue.rows : [];
}
/** How many rows wait: all `status` shows of the queue. */
export function countPendingRevokes(home) {
    return readPendingRevokes(home).length;
}
//# sourceMappingURL=pending_revoke_file.js.map