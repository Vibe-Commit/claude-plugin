/**
 * `SessionStart`'s one bounded read of the account's grants (slice 2, `CR-259`, S4; exception 2, VT's conditions).
 *
 * ```
 *   GET <ingest origin>/ingest/v1/grants      200 { "schema": 1, "epoch", "owners", "repos", "excluded" }
 * ```
 *
 * This is the ONLY place a hook reads a successful response body. It is a separate request from any upload and it never goes through
 * `send`, so an ingest reply's 2xx body is still not read on the hook path (`post.ts`).
 *
 * ## When it runs — all four, or not at all
 *
 *   1. the machine's account state is **stale**: a credential-lane answer carried an `X-Grant-Epoch` that is not the epoch last
 *      recorded (`noteGrantEpoch`, called from `deliver`). A machine that has seen the same epoch every turn never asks;
 *   2. the last GET was **more than an hour ago** (`last_get_at`). It is written BEFORE the request, so a server that hangs or a
 *      hook that is killed mid-request costs the next hour of sessions nothing;
 *   3. there is a **usable credential and ingest address**;
 *   4. the hook has **budget to spare**: the GET is bounded at 1,000 ms and by what is left of the hook's own wall clock.
 *
 * ## What it can and cannot do
 *
 *   - It reads through `readCappedJson` at the **hook path's 64 KiB** (a CLI verb reads 1 MiB; a hook does not). A stalled, cut-off,
 *     oversize or off-contract body is "unavailable": **the state stays stale**, nothing throws, and nothing waits past the bound.
 *   - It writes `grants-account.json` — `account`, `stale: false`, `last_get_at` — whole and atomically, and NEVER `grants.json`.
 *     `refused` is left as it was: a GET is not a sync, only a sync (or this machine's own next 200) says a refusal is over.
 *   - It never syncs: no POST, no queue, no `pending`. Whatever the machine has not delivered stays for the next verb.
 *   - What it learned admits nothing. `isCaptureAllowed` never reads `account` as a grant.
 *
 * It returns how many of the account's owner grants and repository grants this machine has not named, so the caller can say state 10.
 * `null` means nothing to say.
 */
import { accountNotHere } from "../account_not_here.js";
import { readGrants, readAccountState, writeAccountState, EMPTY_GRANTS } from "../consent.js";
import { fetchAccountGrants } from "../grants_sync.js";
import { readPerClone } from "../machine_state.js";
import { ingestUrl } from "../post.js";
/** The most one SessionStart GET waits: exception 2's bound, inside the hook's existing budget. */
export const SESSION_GRANTS_GET_MS = 1_000;
/** At most one GET an hour per machine. */
export const SESSION_GRANTS_MIN_INTERVAL_MS = 60 * 60 * 1000;
/** Kept back from the hook's wall clock for everything after the request (the notice, the write, the exit). */
const RESERVE_MS = 300;
/** Under this the request is not worth starting: the hook just leaves the state stale. */
const MIN_TIMEOUT_MS = 100;
/**
 * Do the one bounded GET if it is due, record what it said, and report the unnamed count if there is one to report.
 * **NEVER THROWS.**
 */
export async function refreshAccountGrants(deps) {
    try {
        const now = (deps.now ?? (() => new Date()))();
        const state = readAccountState(deps.home);
        if (!state.stale)
            return null;
        if (state.last_get_at !== null) {
            const last = Date.parse(state.last_get_at);
            if (Number.isFinite(last) && now.getTime() - last < SESSION_GRANTS_MIN_INTERVAL_MS && now.getTime() >= last)
                return null;
        }
        const url = ingestUrl(deps.env);
        if (url === null)
            return null;
        const left = deps.budgetLeftMs?.() ?? Number.POSITIVE_INFINITY;
        const timeoutMs = Math.min(SESSION_GRANTS_GET_MS, left - RESERVE_MS);
        if (!(timeoutMs >= MIN_TIMEOUT_MS))
            return null;
        // Before the request, not after it: a hang must not be paid for again by every session of the next hour.
        writeAccountState(deps.home, { ...state, last_get_at: now.toISOString() });
        const read = await fetchAccountGrants(url, deps.credential, { fetch: deps.fetch ?? fetch, timeoutMs });
        if (read.kind !== "ok")
            return null;
        const stamp = now.toISOString();
        const account = { owners: read.owners, repos: read.repos, excluded: read.excluded, epoch: read.epoch, synced_at: stamp };
        // Re-read: another hook or a verb may have written the file during the request, and only this hook's own fields are ours to set.
        writeAccountState(deps.home, { ...readAccountState(deps.home), account, stale: false, last_get_at: stamp });
        const grants = readGrants(deps.home);
        if (grants.kind === "unreadable")
            return null;
        // A repo this machine holds only a per-clone consent for is on here: count it as named (the same resolution `status` uses).
        const perClone = readPerClone(deps.home).flatMap((c) => (c.slug === null ? [] : [c.slug]));
        const notHere = accountNotHere(grants.kind === "ok" ? grants.grants : EMPTY_GRANTS, account, perClone);
        // `notHere` names an owner as `owner/` and a repo as its slug (`account_not_here.ts`): the trailing slash is the split.
        const owners = notHere.filter((name) => name.endsWith("/")).length;
        const repos = notHere.length - owners;
        return owners + repos === 0 ? null : { epoch: read.epoch, owners, repos };
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=session_grants.js.map