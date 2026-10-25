/**
 * What `connect` does with the account's grants (slice 2, S4 part 3): the changes it queues for the account, the turn-ons the
 * account itself had turned off, the second question a joining machine is asked, and `g` — use the repositories the account
 * already grants, on a machine with no credential.
 *
 * ```
 *   changeOps(change, covered)          the account writes a picker change means, for the pending queue
 *   splitAccountExclusions(change, …)   a repo the account turned off is a `turn on`, not an add
 *   joiningMachine(ctx, …)              screen 2: "Your account also grants … Capture those here too?"
 *   mintForG(ctx, …)                    `g`: sign in (the credential held in MEMORY behind a write-ahead row), then read the account's grants
 *   commitG(ctx, g)                     the yes: credentials.json, then the row's deletion
 *   settleG(ctx, deps, g)               the ONE finally: a run that did not commit revokes what `g` made and clears its row
 * ```
 *
 * ⛔ LOADED LAZILY with `connect_picker.ts` (see its docblock): the picker path is a person at a terminal.
 *
 * ⛔ `g` IS THE ONE PLACE A CREDENTIAL IS MADE AHEAD OF CONSENT (exception 3), and it is kept honest by WRITE-AHEAD (`pending_revoke.ts`):
 * the instant the server hands the token over a row for it is written, and the credential lives in memory — `credentials.json` does not
 * exist before the person's yes. Whatever then ends the run short of the yes (a no, Ctrl+C, a kill, an unexpected throw) leaves a row the
 * next verb revokes, never a live credential nothing remembers; the yes commits the grants, then `credentials.json`, then deletes the row.
 * It is reached only from the picker's `g`, which is offered only where there is no credential and a browser to sign in with — so never
 * from the `auth` chain (which has no browser, and always leaves a credential).
 */
import { PICKER, REPLACE } from "../copy/index.js";
import { isAffirmative, normalizeOwner, normalizeSlug, ownerOfSlug, readAccountState, holdsAny, updateGrants, writeAccountState, } from "../consent.js";
import { existsSync } from "node:fs";
import { saveCredential } from "../credential.js";
import { stoppedSyncReason } from "./sync_reason.js";
import { EXIT } from "../exit.js";
import { fetchAccountGrants, GRANTS_VERB_BODY_BYTES } from "../grants_sync.js";
import { readAccountView, syncForVerb } from "../grants_verb.js";
import { authCommandFor, channelCommand, connectCommandFor } from "../install.js";
import { COMMANDS } from "../copy/index.js";
import { addPendingRevoke, holdsRow, removePendingRevoke, revokeHeld } from "../pending_revoke.js";
import { readPerClone } from "../machine_state.js";
import { credentialsPath } from "../paths.js";
import { ingestUrl } from "../post.js";
import { paint, renderErrorBlock, wrap } from "../term.js";
import { askOrCancel, savedBlock } from "./connect.js";
import { credentialProblemBlock } from "./credential_problem.js";
import { writeLines } from "./context.js";
/**
 * The account writes a picker change means, in the order they should be queued. A re-include is `include` (the account's
 * exclusion lifts) and, unless an owner grant already covers the repo, `grant` (it is named on this machine from now on) —
 * exactly what `applyChange` does to `grants.json`. A removal is a `revoke`; a per-clone consent withdrawn is a `revoke` of its slug,
 * because the first sync uploaded it as a grant.
 */
export function changeOps(change, covered) {
    const ops = [];
    for (const value of change.stopOwners)
        ops.push({ op: "revoke", kind: "owner", value });
    for (const value of [...change.stopRepos, ...change.stopClones])
        ops.push({ op: "revoke", kind: "repo", value });
    for (const value of change.addOwners)
        ops.push({ op: "grant", kind: "owner", value });
    for (const value of change.addRepos)
        ops.push({ op: "grant", kind: "repo", value });
    for (const value of change.turnOn) {
        ops.push({ op: "include", kind: "repo", value });
        if (!covered(value))
            ops.push({ op: "grant", kind: "repo", value });
    }
    return ops;
}
/**
 * A repo the ACCOUNT has turned off (not only this machine) and the person picked as an ordinary add is a re-include: it moves
 * to `turnOn`, so the grant block names it on its own `turn on` row, `(turned off on your account)`, and the yes lifts the
 * exclusion for every machine. The user's yes wins, as slice 1's re-include rule has it. `accountOff` is every `turn on` slug the
 * account turned off, the moved ones and the ones that were already turn-ons here.
 */
export function splitAccountExclusions(change, accountExcluded) {
    const off = new Set(accountExcluded.map(normalizeSlug));
    const moved = change.addRepos.filter((slug) => off.has(slug));
    const next = moved.length === 0
        ? change
        : { ...change, addRepos: change.addRepos.filter((slug) => !off.has(slug)), turnOn: [...change.turnOn, ...moved] };
    return { change: next, accountOff: new Set(next.turnOn.filter((slug) => off.has(slug))) };
}
/**
 * Screen 2 — a machine joining an account by picking local repos (design slice 2, step 4). After the credential and the first
 * sync, the account may grant more than was just picked: ask, naming them, before any is admitted on this machine. `y` names them
 * here (and syncs, so the server learns this machine's set); `n` — and Ctrl+C, which here is a No that does not undo what was
 * already chosen — leaves them on the account, listed by `status`.
 *
 * Returns the names now captured here, for the "Capture is on" block, and whether the question was cancelled with Ctrl+C: the run
 * then finishes its non-interactive steps and asks nothing more (no backfill offer), VQ's ruling on #88.
 */
export async function joiningMachine(ctx, deps, answers, 
/** The first-sync line was already printed in this run: the sync after "y" does not print it again. */
firstSyncSaid = false) {
    const view = readAccountView(ctx.home, readPerClone(ctx.home).flatMap((clone) => (clone.slug === null ? [] : [clone.slug])), { kind: "skipped" });
    const names = view === null ? [] : view.notHere;
    if (names.length === 0)
        return { names: [], cancelled: false, sync: null };
    writeLines(ctx.stdout, [
        "",
        ...wrap(PICKER.joinAlso(names.join("\n")), 2),
        ...(names.length > 3 ? names.map((name) => `    ${name}`) : []),
    ]);
    const answer = await askOrCancel(ctx, `  ${paint(ctx.colour, "text", PICKER.joinQuestion)} ${paint(ctx.colour, "muted", answers)} `);
    if (answer === null || !isAffirmative(answer)) {
        writeLines(ctx.stdout, ["", ...wrap(PICKER.joinDeclined(channelCommand(ctx.env, ctx.selfPath, COMMANDS.status)), 2)]);
        return { names: [], cancelled: answer === null, sync: null };
    }
    const owners = names.filter((name) => name.endsWith("/")).map((name) => normalizeOwner(name.slice(0, -1)));
    const repos = names.filter((name) => !name.endsWith("/")).map(normalizeSlug);
    try {
        updateGrants(ctx.home, (g) => {
            const nextOwners = [...new Set([...g.owners, ...owners])];
            return {
                ...g,
                owners: nextOwners,
                repos: [...new Set([...g.repos, ...repos.filter((slug) => !nextOwners.includes(ownerOfSlug(slug)))])],
            };
        });
    }
    catch {
        // `grants.json` became unreadable since the picker's own write: nothing was named, and the next `connect` says so.
        return { names: [], cancelled: false, sync: null };
    }
    // The server's `named` set is what the dashboard's "confirmed on N of M machines" counts: tell it now.
    const sync = await syncForVerb(ctx, false, deps, { quietFirst: firstSyncSaid });
    return { names, cancelled: false, sync };
}
/**
 * What `connect` says under "Capture is on" about the sync after its writes (VQ, on VT's question). Capture IS on whatever this
 * says — the local grants admit the repo — so these are muted lines that tell the truth about the ACCOUNT, by what the sync answered:
 *   - synced: nothing;
 *   - a 400 (our own bug; the queue is kept and will be refused again): the status row's wording, "didn't accept · report this";
 *   - a 401 (the credential is no longer accepted): `ERRORS.authFatal` and the channel's `auth` command;
 *   - anything else (no answer, off-contract, over the caps, or no sync attempted): "hasn't been told yet; running `status` retries".
 * Only `connect`, `status` and `off` sync, so the retry it names is `status`.
 */
export function accountNoteLines(ctx, sync) {
    if (sync === null)
        return [];
    if (sync.kind === "ran" && sync.result.kind === "synced")
        return [];
    if (sync.kind === "ran") {
        // A 400 and a 401 have their own lines, shared with `off` (`sync_reason.ts`, hook-safe).
        const reason = stoppedSyncReason(ctx, sync.result);
        if (reason !== null)
            return reason;
    }
    const status = channelCommand(ctx.env, ctx.selfPath, COMMANDS.status);
    // F2 / R2-2: the held wording only when the hold applies to something — a synced machine with a queued grant the cached account does
    // not already grant (`holdsAny`, the gate's own predicate). Otherwise nothing waits and the plain line is the true one.
    const held = holdsAny(ctx.home);
    return wrap(held ? PICKER.accountNotToldHeld(status) : PICKER.accountNotTold(status), 2).map((line) => paint(ctx.colour, "muted", line));
}
/**
 * The yes, for a credential `g` is holding: the GRANTS are already written (the caller's `applyChange`); now `credentials.json`, THEN
 * the row's deletion. `committed` flips as soon as the credential is on disk, so a failure of the deletion (or a kill between the two)
 * never revokes what the person kept: the row's token IS the current credential, and the next verb's retry skips and drops it.
 */
export function commitG(ctx, g, save = saveCredential) {
    if (g.credential === null)
        return "lost";
    // ⛔ BEFORE ANYTHING IS WRITTEN: the row is `g`'s lease on the credential. If it is gone, another verb's retry settled it (revoked it)
    // while the question was open, and a `credentials.json` written now would be a dead credential: refuse. A `credentials.json` that
    // already exists is a concurrent mint: never overwritten. Either way nothing is saved, and the finally revokes the in-memory token.
    const held = holdsRow(ctx.home, g.credential.expose());
    if (held === "gone")
        return "lost";
    if (held === "unusable")
        return "unrecorded";
    if (existsSync(credentialsPath(ctx.home)))
        return "occupied";
    save(ctx.home, g.credential);
    g.committed = true;
    removePendingRevoke(ctx.home, g.credential.expose());
    savedBlock(ctx, g.notes);
    // The account's state, as a sync leaves it — written only now, after the yes, so a no or Ctrl+C leaves nothing about the account
    // on a machine that keeps no credential. It makes `account.excluded` deny an account-excluded repo under a newly granted owner.
    if (g.snapshot !== null) {
        try {
            writeAccountState(ctx.home, {
                account: {
                    owners: g.snapshot.owners,
                    repos: g.snapshot.repos,
                    excluded: g.snapshot.excluded,
                    epoch: g.snapshot.epoch,
                    synced_at: ctx.now().toISOString(),
                },
                refused: [],
                stale: false,
                last_get_at: readAccountState(ctx.home).last_get_at,
            });
        }
        catch {
            // A cache of what the server said; the next sync writes it.
        }
    }
    return "committed";
}
/**
 * `g`: sign in through `deps.browser` (the credential beat, behind its own gate: no credential, a terminal, a browser), then ONE
 * `GET` of the account's grants — a pure read that marks nothing as synced.
 *
 * ⛔ **WRITE-AHEAD, AND NOTHING ON DISK.** The mint is asked to HOLD the credential (`hold`): the instant the server hands the token
 * over, a row for it is written to `pending-revoke.json` (`addPendingRevoke`), and `credentials.json` is NOT written — the credential
 * lives in memory until the person's yes, and the GET below uses it from there. If the row cannot be written (an insecure or unreadable
 * file, the cap, a failed write) the credential is revoked in memory at once, nothing is kept, and `g` ends on the ordinary
 * "Nothing was changed" path with a muted line that says what happened.
 *
 * What the GET learned is NOT written here: `commitG` writes it to `grants-account.json` after the yes, so a no or Ctrl+C leaves nothing
 * about the account behind on a machine that keeps no credential — and after a yes, `account.excluded` denies an account-excluded repo
 * under a newly granted owner.
 */
export async function mintForG(ctx, options, deps, account) {
    if (deps.browser === undefined)
        return { kind: "exit", code: EXIT.failure };
    const refusal = { current: null };
    const mintedAt = { origin: "" };
    const hold = {
        record: (credential, endpoint) => {
            // The row carries `g`'s lease (this process, 30 minutes): another verb's retry leaves it alone while the question is open.
            const added = addPendingRevoke(ctx.home, credential, endpoint, ctx.now(), { lease: true });
            if (added.kind === "written")
                mintedAt.origin = new URL(endpoint).origin;
            if (added.kind !== "written")
                refusal.current = added;
            return added.kind === "written";
        },
        release: (credential) => removePendingRevoke(ctx.home, credential.expose()),
    };
    const minted = await deps.browser(ctx, "connect", { device: options.device === true, scope: "repos", hold });
    if (minted.kind === "unrecorded") {
        const read = refusal.current !== null && refusal.current.kind === "refused" ? refusal.current.read : null;
        if (read !== null && read.kind === "insecure-file") {
            writeLines(ctx.stderr, ["", ...renderErrorBlock(credentialProblemBlock(read, authCommandFor(ctx.env, ctx.selfPath)), ctx.colour)]);
        }
        else {
            writeLines(ctx.stdout, ["", ...wrap(PICKER.gNotRecorded, 2).map((line) => paint(ctx.colour, "muted", line))]);
        }
        // ⛔ NEVER "Cancelled. Nothing was changed.": a credential WAS made. In memory it was revoked (`declinedRevoked`), or it could not be
        // and may still be live (`declinedOrphan` says where to revoke it) — either way the line is the credential's, and the exit is 1.
        writeLines(ctx.stdout, wrap(minted.revoked ? REPLACE.declinedRevoked : REPLACE.declinedOrphan, 2).map((line) => paint(ctx.colour, "muted", line)));
        return { kind: "exit", code: EXIT.failure };
    }
    // A declined or failed sign-in has already said why on screen, and made no credential that the client has to remember.
    if (minted.kind !== "held")
        return { kind: "exit", code: EXIT.failure };
    const url = ingestUrl(ctx.env);
    const read = url === null
        ? null
        : await fetchAccountGrants(url, minted.credential, {
            fetch: account.fetch,
            ...(account.timeoutMs === undefined ? {} : { timeoutMs: account.timeoutMs }),
            maxBodyBytes: GRANTS_VERB_BODY_BYTES,
        });
    const snapshot = read !== null && read.kind === "ok" ? read : null;
    return { kind: "minted", credential: minted.credential, snapshot, notes: minted.notes ?? [], origin: mintedAt.origin };
}
/** The account's own list as a picker change: its owners, and its repos that no listed owner covers and that are not turned off. */
export function accountChange(snapshot) {
    const owners = snapshot.owners.map(normalizeOwner);
    const off = new Set(snapshot.excluded);
    return {
        addOwners: owners,
        addRepos: snapshot.repos.map(normalizeSlug).filter((slug) => !off.has(slug) && !owners.includes(ownerOfSlug(slug))),
        turnOn: [],
        stopOwners: [],
        stopRepos: [],
        stopClones: [],
    };
}
/**
 * The ONE `finally` of `g` (VQ + VT, #88). A run that did not COMMIT the credential — a no, Ctrl+C (the first, a second, a
 * SIGHUP: the row already exists, so a signal needs only to exit), an empty account, Enter, a removals-only yes, a failed write or an
 * unexpected throw — makes one best-effort revoke within 3 s, to the origin the row recorded, and the row leaves on a 2xx, a 401 or a
 * 404. Nothing was ever on disk, so there is no file to delete; the row is what stays if the revoke does not land.
 *
 * `end` says how a run that granted nothing ended: its line is printed here, and "the server will be told on the next vibecommit
 * command that contacts the server" only when the row is still there to say it with. A throw prints nothing and rethrows.
 */
export async function settleG(ctx, deps, g) {
    if (g.credential === null || g.committed)
        return;
    const result = await revokeHeld(ctx.home, g.credential, g.origin, deps.fetch ?? globalThis.fetch);
    // A queue file that is insecure is named, with its fix: until it is fixed no later verb can read the row.
    if (result.insecure !== null) {
        writeLines(ctx.stderr, ["", ...renderErrorBlock(credentialProblemBlock(result.insecure, authCommandFor(ctx.env, ctx.selfPath)), ctx.colour)]);
    }
    if (g.end === null)
        return;
    const cancelled = g.end === "cancelled";
    // Exactly what happened: "revoked" only on an answer from the server; "removed here … will be told" only while a readable row is
    // there to tell it with; and with no usable row and no answer the credential may be live, so it says where to remove it.
    const connect = connectCommandFor(ctx.env, ctx.selfPath);
    const fate = result.kind === "revoked" ? REPLACE.declinedRevoked : result.kind === "waiting" ? PICKER.gRemovedWillTell : REPLACE.declinedOrphan;
    // `orphan` (no usable row, no answer) and `unrevocable` (a 404: the row ended, but nothing revoked it) both leave a credential that may
    // be live: neither is ever called "revoked" ("0.8.0 truth fixes" F7).
    const live = result.kind === "orphan" || result.kind === "unrevocable";
    // ⛔ "Nothing is captured on this machine" is for a run that ended with no credential kept AND nothing granted. An occupied
    // `credentials.json` means the grants are saved and a credential is on disk: capture IS on, so that case says what happened and
    // then what became of the credential this run made, on its own line.
    if (g.end === "occupied") {
        writeLines(ctx.stdout, ["", ...wrap(PICKER.gOccupied(connect), 2), ...wrap(fate, 2)]);
        return;
    }
    const line = g.end === "lost" && result.kind === "revoked"
        ? PICKER.gRevokedElsewhere(connect)
        : g.end === "unrecorded" && !live
            ? PICKER.gRecordUnusable(connect)
            : live
                ? REPLACE.declinedOrphan
                : cancelled
                    ? result.kind === "revoked"
                        ? PICKER.gCancelledRevoked
                        : PICKER.gCancelledRemoved
                    : result.kind === "revoked"
                        ? PICKER.gDeclinedRevoked
                        : PICKER.gDeclinedRemoved;
    writeLines(ctx.stdout, cancelled ? ["", "", ...wrap(line, 2)] : ["", ...wrap(line, 2)]);
}
/** The account state the last sync recorded, or `null` before a first sync. */
export function lastAccountState(home) {
    return readAccountState(home).account;
}
//# sourceMappingURL=connect_account.js.map