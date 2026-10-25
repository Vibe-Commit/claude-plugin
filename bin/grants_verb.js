/**
 * What a CLI verb does with the account's grants (slice 2, S4): `status` and `off` sync at the start or the end, and read what
 * the last sync recorded. `connect` (the picker's "on your account" group, the joining-machine prompt, `g`) comes in a later PR.
 *
 * ```
 *   syncForVerb(ctx, …)      one bounded sync, silent on failure         (a verb's, never a hook's)
 *   accountView(…)           the account rows' data, read from the files (no network)
 * ```
 *
 * ## The first sync says what it saves, or it waits
 *
 * The first sync uploads what this machine already named — its owners and repos, and the slug of every per-clone consent
 * made under 0.6.x/0.7.0 — to the user's account (R3-21). That is a disclosure the user must be able to read, so it runs
 * only on a verb that can print it: a terminal, and not `--json`. Anywhere else it WAITS (nothing is sent, `pending` is
 * untouched), and the next verb that can say so does it. The line names slugs, never paths.
 *
 * ## Nothing here is a hook
 *
 * Hooks never sync (`grants_sync.ts`). A verb reads the response with the 1 MiB cap a verb may use (`GRANTS_VERB_BODY_BYTES`).
 */
import { accountNotHere, ownerName } from "./account_not_here.js";
import { normalizeSlug, readAccountState, readGrants, EMPTY_GRANTS } from "./consent.js";
import { loadCredential } from "./credential.js";
import { GRANTS_VERB_BODY_BYTES, planSync, syncGrants } from "./grants_sync.js";
import { readPerClone } from "./machine_state.js";
import { countPendingRevokes } from "./pending_revoke_file.js";
import { ingestUrl } from "./post.js";
import { STATUS } from "./copy/index.js";
import { wrap } from "./term.js";
import { writeLines } from "./commands/context.js";
/** The slugs of every per-clone consent, normalized — what `planSync` calls `consentedSlugs`. */
function consentedSlugs(home) {
    const out = [];
    for (const clone of readPerClone(home)) {
        if (clone.slug === null)
            continue;
        const slug = normalizeSlug(clone.slug);
        if (slug !== "" && !out.includes(slug))
            out.push(slug);
    }
    return out;
}
/** `owner/` for an owner, the slug for a repo — the way every account row and the first-sync line name them (`account_not_here.ts`). */
export { ownerName };
/**
 * One sync for a verb. `json` is true for `--json`, which can print no line and so never does a FIRST sync.
 *
 * Prints, to stdout, only the first-sync line (and its full list past three names) and a blank line after it. Never throws.
 */
export async function syncForVerb(ctx, json, deps, 
/** A verb that syncs more than once (`connect`: at its start and after its writes) says what the first sync saves only once. */
options = {}) {
    try {
        const load = loadCredential({ env: ctx.env, home: ctx.home });
        if (load.kind !== "ok")
            return { kind: "skipped" };
        const url = ingestUrl(ctx.env);
        if (url === null)
            return { kind: "skipped" };
        const read = readGrants(ctx.home);
        if (read.kind === "unreadable")
            return { kind: "skipped" };
        const grants = read.kind === "ok" ? read.grants : EMPTY_GRANTS;
        const consented = consentedSlugs(ctx.home);
        const first = grants.synced_at === null;
        let disclosed = false;
        if (first) {
            // ⛔ A first sync that cannot say what it is saving waits.
            if (!ctx.stdinIsTty || json)
                return { kind: "skipped" };
            const plan = planSync(grants, consented, true);
            const names = [
                ...plan.named.owners.map(ownerName),
                ...plan.named.repos,
            ];
            if (names.length > 0 && options.quietFirst !== true) {
                const lines = [...wrap(STATUS.accountSaving(names.join("\n")), 2)];
                if (names.length > 3)
                    lines.push(...names.map((name) => `    ${name}`));
                writeLines(ctx.stdout, [...lines, ""]);
                disclosed = true;
            }
        }
        const result = await syncGrants(url, load.credential, consented, {
            fetch: deps.fetch,
            home: ctx.home,
            now: ctx.now,
            timeoutMs: deps.timeoutMs,
            maxBodyBytes: GRANTS_VERB_BODY_BYTES,
        });
        // One line per verb run, never one per op (VQ's ruling (ii)); the `pending` row is what the user sees.
        if (result.kind === "rejected" && ctx.env.VIBECOMMIT_DEBUG !== undefined && ctx.env.VIBECOMMIT_DEBUG !== "") {
            ctx.stderr.write(`grants sync rejected (400): ${result.pendingRejected} queued change(s) not accepted\n`);
        }
        return { kind: "ran", result, disclosed };
    }
    catch {
        return { kind: "skipped" };
    }
}
/**
 * ⛔ "Not on this machine" is what THIS machine has not named: not in its owners, its repos, or a per-clone consent, and not
 * turned off here or on the account. A repo under an owner the account grants is covered by that owner's row, not listed
 * again. An owner or repo the user turned off is a choice, not a gap.
 */
export function accountView(grants, account, perCloneSlugs, sync, pendingRevokes = 0) {
    const pendingRejected = sync.kind === "ran" && sync.result.kind === "rejected" ? sync.result.pendingRejected : 0;
    // A revoke of a credential `g` dropped is a change not yet sent to the account like any queued op (R3-11).
    const queued = grants.pending.length + pendingRevokes;
    if (account === null)
        return { account, notHere: [], pending: queued, pendingRejected };
    return { account, notHere: accountNotHere(grants, account, perCloneSlugs), pending: queued, pendingRejected };
}
/** The account state and grants for a view, read fresh from disk. `null` when `grants.json` is unreadable. */
export function readAccountView(home, perCloneSlugs, sync) {
    const read = readGrants(home);
    if (read.kind === "unreadable")
        return null;
    return accountView(read.kind === "ok" ? read.grants : EMPTY_GRANTS, readAccountState(home).account, perCloneSlugs, sync, countPendingRevokes(home));
}
//# sourceMappingURL=grants_verb.js.map