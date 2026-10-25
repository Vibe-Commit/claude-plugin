/**
 * What this machine captures, as the machine-level verbs need it (0.7.0, PR 3): `auth` outside a repo (D32), `status` from
 * any folder (D6) and the picker's "No changes" line all say the same thing about the same facts, so they ask here.
 *
 * Reads `grants.json` and `projects.json` and, for each per-clone consent, the clone's remote (one `git remote get-url`
 * apiece). Opens no transcript and writes nothing.
 */
import { EMPTY_GRANTS, normalizeSlug, ownerOfSlug, isLocalSlug, readAllowList, readGrants } from "./consent.js";
import { remoteSlugOfCommonDir } from "./git.js";
import { PICKER } from "./copy/index.js";
export function readPerClone(home) {
    return Object.keys(readAllowList(home)).map((commonDir) => ({ commonDir, slug: remoteSlugOfCommonDir(commonDir) }));
}
/**
 * ⛔ **Counts what ADMITS capture, not what is written down.** An excluded slug is not on whatever else says so; a repo an
 * owner grant covers is counted once, under the owner; a per-clone consent whose clone has no remote (`local:`) is still a
 * repo that is on, and counts as one.
 */
export function machineCapture(home) {
    const read = readGrants(home);
    if (read.kind === "unreadable")
        return { kind: "unreadable" };
    const grants = read.kind === "ok" ? read.grants : EMPTY_GRANTS;
    const perClone = readPerClone(home);
    const excluded = new Set(grants.excluded);
    const owners = grants.owners;
    const repos = new Set();
    for (const slug of grants.repos) {
        if (!excluded.has(slug) && !owners.includes(ownerOfSlug(slug)))
            repos.add(slug);
    }
    for (const entry of perClone) {
        const slug = entry.slug === null ? null : normalizeSlug(entry.slug);
        if (slug === null || isLocalSlug(slug))
            repos.add(`local:${entry.commonDir}`);
        else if (!excluded.has(slug) && !owners.includes(ownerOfSlug(slug)))
            repos.add(slug);
    }
    if (owners.length === 0 && repos.size === 0)
        return { kind: "none" };
    return { kind: "on", grants, perClone, owners: owners.length, repos: repos.size };
}
/** `1 owner and 2 repos` — or the empty string when nothing is on. */
export function machineSummary(capture) {
    return capture.kind === "on" ? PICKER.summary(capture.owners, capture.repos) : "";
}
/**
 * Meaningful only for a clone `isCaptureAllowed` admits. An owner grant outranks a repo grant, which outranks a per-clone
 * consent — the broadest reason first, so `status` names what would have to be removed to turn the repo off by grant.
 */
export function captureBasis(home, slug) {
    const read = readGrants(home);
    if (read.kind === "ok" && !isLocalSlug(slug)) {
        const name = normalizeSlug(slug);
        const owner = ownerOfSlug(name);
        if (read.grants.owners.includes(owner))
            return { kind: "owner", owner };
        if (read.grants.repos.includes(name))
            return { kind: "repo" };
    }
    return { kind: "clone" };
}
//# sourceMappingURL=machine_state.js.map