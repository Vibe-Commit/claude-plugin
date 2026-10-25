/**
 * What the account grants that THIS machine has not named — the pure rule behind `status`'s "on account" row and SessionStart's notice 10.
 *
 * Its own module so the hook path can use the rule without importing `grants_verb.ts`, which is a verb's (it syncs, prints and reaches the
 * network); the hook-path import-graph cell in `test/connect-g-lifecycle.test.ts` keeps hooks off that module.
 *
 * ⛔ "Not on this machine" is what THIS machine has not named: not in its owners, its repos, or a per-clone consent, and not turned off here
 * or on the account. A repo under an owner the account grants is covered by that owner's row, not listed again. An owner or repo the user
 * turned off is a choice, not a gap.
 */
import { normalizeSlug, ownerOfSlug } from "./consent.js";
/** `owner/` for an owner, the slug for a repo — the way every account row and the first-sync line name them. */
export const ownerName = (owner) => `${owner}/`;
/** The account's owners (as `owner/`) and then its repos this machine has not named. Pure. */
export function accountNotHere(grants, account, perCloneSlugs) {
    const off = new Set([...grants.excluded, ...account.excluded]);
    const named = new Set([...grants.repos, ...perCloneSlugs.map(normalizeSlug)]);
    const owners = account.owners.filter((o) => !grants.owners.includes(o));
    const repos = account.repos.filter((r) => !off.has(r) &&
        !named.has(r) &&
        !grants.owners.includes(ownerOfSlug(r)) &&
        !account.owners.includes(ownerOfSlug(r)));
    return [...owners.map(ownerName), ...repos];
}
//# sourceMappingURL=account_not_here.js.map