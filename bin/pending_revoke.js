/**
 * Pending revokes (slice 2, S4, R3-11): the WRITE-AHEAD record of a credential `g` has made and not yet been told to keep.
 *
 * ```
 *   addPendingRevoke(home, credential, endpoint, now)   at the mint, BEFORE anything else: refuses (never overwrites) when it cannot
 *   removePendingRevoke(home, token)                    after the revoke, or after the credential is kept: re-reads, removes ONE row
 *   revokeHeld(home, token, fetch)                      one best-effort revoke (3 s) of a row, to ITS recorded origin
 *   retryPendingRevokes(home, env, fetch, now)          every user-facing verb, once, at its start: one 3 s bound across all rows
 *   readPendingRevokes(home)                            how many are waiting (for `status`'s `pending` count)
 * ```
 *
 * ## ⛔ WHY IT IS WRITE-AHEAD
 *
 * `g` is the one place a credential is made ahead of consent (exception 3). So the credential lives in MEMORY until the yes:
 * `credentials.json` does not exist before it, and the row below is written the instant the server hands the token over. A kill, a
 * second Ctrl+C, a SIGHUP at the y/N or an unexpected throw therefore leaves a ROW (which the next verb revokes), never a live
 * credential on disk that nothing remembers. The yes commits in this order: the grants, then `credentials.json`, then the row's
 * deletion; a retry skips and drops any row whose token IS the current credential, so a kill between the last two never revokes what
 * the user kept.
 *
 * ## ⛔ THE FILE HOLDS A BEARER TOKEN — the same exposure class as `credentials.json`, held to the same rules
 *   - written mode 0600 under the 0700 directory, temp + rename;
 *   - READ through `readSecretFile`: a file or folder others can read is refused, and an insecure or unreadable file is NEVER
 *     overwritten (the writer refuses, and `g` fails closed);
 *   - never printed, logged or returned: `status` counts the rows and shows nothing else, `--json` included;
 *   - a hook never touches it (only the CLI verbs import this module; `test/connect-account.test.ts` walks the hooks' import graph).
 *
 * ## ⛔ A ROW IS NEVER DROPPED UNREVOKED, except by the clock
 *   - it leaves on a 2xx, a 401 (the server does not accept it: already dead) or a 404 (a server that cannot revoke);
 *   - or at `minted_at` + 91 days: a token that was never on disk was never used, and an ingest credential ends 90 days unused;
 *   - there is no row cap that drops one: at the cap `addPendingRevoke` REFUSES, and `g` fails closed.
 *
 * ## ⛔ THE ORIGIN IS THE ROW'S
 *
 * A row records the issuing server's origin and a retry goes ONLY there (https, or http on loopback: `isAllowedIngestUrl`), never to
 * wherever `VIBECOMMIT_MCP_URL` points today.
 */
import { chmodSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { writeFileAtomic } from "./atomic_write.js";
import { IngestCredential, INGEST_TOKEN_PREFIX } from "./credential.js";
import { LEASE_MS, leased, readPendingRevokes, readQueue } from "./pending_revoke_file.js";
import { REVOKE_TIMEOUT_MS, selfRevokeOutcome } from "./oauth/retire.js";
import { credentialsPath, pendingRevokePath, rootDir } from "./paths.js";
import { isAllowedIngestUrl } from "./post.js";
export { readPendingRevokes } from "./pending_revoke_file.js";
/** More rows than `g` can produce in earnest: past it `g` refuses rather than drop one. */
export const MAX_ROWS = 8;
/** A token never used ends 90 days after it is made; one day of slack. */
const MAX_AGE_MS = 91 * 24 * 60 * 60 * 1000;
/** One best-effort revoke, and the bound on a verb's whole retry. */
export { REVOKE_TIMEOUT_MS };
function writeRows(home, rows) {
    if (rows.length === 0) {
        try {
            unlinkSync(pendingRevokePath(home));
        }
        catch {
            /* already gone */
        }
        return;
    }
    mkdirSync(rootDir(home), { recursive: true, mode: 0o700 });
    chmodSync(rootDir(home), 0o700);
    writeFileAtomic(pendingRevokePath(home), `${JSON.stringify({ revokes: rows }, null, 2)}\n`, 0o600);
}
/**
 * Write the row for a credential that has just been made. Never overwrites a file it cannot read, never drops a row.
 * `lease: true` is `g` holding the credential at its y/N: the row carries `{ pid, lease_until }` (30 minutes) so another verb's retry
 * leaves it alone while it is kept; every other writer (a test, an orphaned row) has no lease and is retried at once.
 */
export function addPendingRevoke(home, credential, endpoint, now, options = {}) {
    try {
        const token = credential.expose();
        if (!token.startsWith(INGEST_TOKEN_PREFIX))
            return { kind: "failed" };
        const queue = readQueue(home);
        if (queue.kind === "refused")
            return { kind: "refused", read: queue.read };
        const rows = queue.kind === "ok" ? queue.rows : [];
        if (rows.some((row) => row.token === token))
            return { kind: "written" };
        if (rows.length >= MAX_ROWS)
            return { kind: "full" };
        const lease = options.lease === true ? { pid: process.pid, lease_until: new Date(now.getTime() + LEASE_MS).toISOString() } : null;
        writeRows(home, [...rows, { token, minted_at: now.toISOString(), origin: new URL(endpoint).origin, lease }]);
        return { kind: "written" };
    }
    catch {
        return { kind: "failed" };
    }
}
/** Remove ONE row, re-reading just before the write so a row queued in between survives. Deletes the file when it is empty. Never throws. */
export function removePendingRevoke(home, token) {
    removeRows(home, new Set([token]));
}
/** Give the row up to the retry: `g` is no longer holding the credential, so the next verb may revoke it. Re-reads before it writes. */
export function releaseLease(home, token) {
    try {
        const queue = readQueue(home);
        if (queue.kind !== "ok" || !queue.rows.some((row) => row.token === token && row.lease !== null))
            return;
        writeRows(home, queue.rows.map((row) => (row.token === token ? { ...row, lease: null } : row)));
    }
    catch {
        /* the lease runs out by itself */
    }
}
/**
 * Is the row for `token` still there? `g` asks just before it commits, and the three answers are different things:
 *   - `held`: the row is in a queue this client can use;
 *   - `gone`: the queue is readable and the row is not in it — another verb settled (revoked) it;
 *   - `unusable`: the queue is insecure or unreadable. Nobody revoked anything; this client can neither keep nor settle the record.
 */
export function holdsRow(home, token) {
    const queue = readQueue(home);
    if (queue.kind === "refused")
        return "unusable";
    return queue.kind === "ok" && queue.rows.some((row) => row.token === token) ? "held" : "gone";
}
function removeRows(home, tokens) {
    try {
        const queue = readQueue(home);
        if (queue.kind !== "ok")
            return;
        const rows = queue.rows.filter((row) => !tokens.has(row.token));
        if (rows.length !== queue.rows.length)
            writeRows(home, rows);
    }
    catch {
        /* the row stays; the next verb retries */
    }
}
/** Revoke a token, with itself as the bearer, at `origin` — and only where a credential may be sent at all. */
async function revokeToken(origin, token, fetchImpl, timeoutMs) {
    if (!isAllowedIngestUrl(origin))
        return null;
    const outcome = await selfRevokeOutcome(origin, new IngestCredential(token, "file"), { fetch: fetchImpl, timeoutMs });
    return outcome.kind === "retired" || outcome.kind === "gone" ? "revoked" : outcome.kind === "unknown" ? "unrevocable" : null;
}
/** The tokens this machine is using right now: `credentials.json`'s, read RAW (a mode problem does not hide it) and the environment's. */
function currentTokens(home, env) {
    const out = new Set();
    try {
        const token = JSON.parse(readFileSync(credentialsPath(home), "utf8")).token;
        if (typeof token === "string" && token !== "")
            out.add(token);
    }
    catch {
        /* no file, or not ours: nothing to protect */
    }
    const envToken = env.VIBECOMMIT_TOKEN?.trim();
    if (envToken !== undefined && envToken !== "")
        out.add(envToken);
    return out;
}
/**
 * `g`'s every no-grant exit: one revoke within 3 s. With a readable row it goes to the row's recorded origin and removes the row on a
 * 2xx, 401 or 404 (a failure gives the lease up so the next verb retries). With NO usable row — missing, or the queue refused — it
 * revokes with the in-memory credential at the MINTED origin: a missing row is never taken for "already revoked".
 */
export async function revokeHeld(home, credential, mintedOrigin, fetchImpl) {
    const token = credential.expose();
    let insecure = null;
    try {
        const queue = readQueue(home);
        const row = queue.kind === "ok" ? queue.rows.find((r) => r.token === token) : undefined;
        if (queue.kind === "refused" && queue.read.kind === "insecure-file")
            insecure = queue.read;
        if (row !== undefined) {
            const ended = await revokeToken(row.origin, token, fetchImpl, REVOKE_TIMEOUT_MS);
            if (ended !== null) {
                removePendingRevoke(home, token);
                return { kind: ended, insecure };
            }
            releaseLease(home, token);
            return { kind: "waiting", insecure };
        }
        const ended = await revokeToken(mintedOrigin, token, fetchImpl, REVOKE_TIMEOUT_MS);
        return { kind: ended ?? "orphan", insecure };
    }
    catch {
        return { kind: "orphan", insecure };
    }
}
/**
 * Every user-facing verb, once, at its start: one attempt at each row, and ONE 3 s bound across all of them (a row gets what is
 * left of the bound, and none is attempted once it is spent). Silent, and needs no credential.
 *
 * Before EACH request it re-reads the queue and the current credential (a credential committed, or a row settled, after the loop
 * began is never revoked on a stale view), and it
 *   - skips and DROPS a row whose token is the current credential (the user kept it; the kill came between the credential's write
 *     and the row's deletion) — compared on the file's raw token, so a mode problem does not hide a kept credential;
 *   - skips (and keeps) a LEASED row: `g` is holding it at its y/N in another process;
 *   - drops a row past `minted_at` + 91 days.
 * Removes each row it settles as it goes, re-reading just before it writes. Returns how many rows still wait. Never throws.
 */
export async function retryPendingRevokes(home, env, fetchImpl, now, deadlineMs = REVOKE_TIMEOUT_MS) {
    try {
        const first = readQueue(home);
        if (first.kind !== "ok")
            return 0;
        const started = Date.now();
        for (const listed of first.rows) {
            const fresh = readQueue(home);
            if (fresh.kind !== "ok")
                break;
            const row = fresh.rows.find((r) => r.token === listed.token);
            if (row === undefined)
                continue;
            if (currentTokens(home, env).has(row.token)) {
                removePendingRevoke(home, row.token);
                continue;
            }
            if (leased(row, now))
                continue;
            const age = now.getTime() - Date.parse(row.minted_at);
            if (Number.isFinite(age) && age > MAX_AGE_MS) {
                removePendingRevoke(home, row.token);
                continue;
            }
            const left = deadlineMs - (Date.now() - started);
            if (left <= 0)
                break;
            if ((await revokeToken(row.origin, row.token, fetchImpl, left)) !== null)
                removePendingRevoke(home, row.token);
        }
        return readPendingRevokes(home).length;
    }
    catch {
        return readPendingRevokes(home).length;
    }
}
//# sourceMappingURL=pending_revoke.js.map