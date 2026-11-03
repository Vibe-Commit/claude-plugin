/**
 * What this machine captures, as the machine-level verbs need it (0.7.0, PR 3): `auth` outside a repo (D32), `status` from
 * any folder (D6) and the picker's "No changes" line all say the same thing about the same facts, so they ask here.
 *
 * Reads `grants.json` and `projects.json` and, for each per-clone consent, the clone's remote (one `git remote get-url`
 * apiece). Opens no transcript and writes nothing.
 */
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { EMPTY_GRANTS, normalizeSlug, ownerOfSlug, isLocalSlug, readAccountState, readAllowList, readGrants } from "./consent.js";
import { folderStandingOf, grantedFolders } from "./folder_grants.js";
import { resolveProjectKeys } from "./project.js";
import { readStoppedFolders, readUndecidedNames } from "./session_targets.js";
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
    const entries = new Map();
    for (const slug of grants.repos) {
        if (!excluded.has(slug) && !owners.includes(ownerOfSlug(slug))) {
            entries.set(slug, { key: slug, slug, commonDir: null, state: "slug", path: null });
        }
    }
    for (const entry of perClone) {
        const slug = entry.slug === null ? null : normalizeSlug(entry.slug);
        if (slug === null || isLocalSlug(slug)) {
            const key = `local:${entry.commonDir}`;
            entries.set(key, {
                key,
                slug: null,
                commonDir: entry.commonDir,
                state: existsSync(entry.commonDir) ? "no-remote" : "missing",
                path: dirname(entry.commonDir),
            });
        }
        else if (!excluded.has(slug) && !owners.includes(ownerOfSlug(slug)) && !entries.has(slug)) {
            entries.set(slug, { key: slug, slug, commonDir: entry.commonDir, state: "slug", path: null });
        }
    }
    const folders = grantedFolders(home);
    if (owners.length === 0 && entries.size === 0 && folders.length === 0)
        return { kind: "none" };
    return { kind: "on", grants, perClone, owners: owners.length, repos: entries.size, repoEntries: [...entries.values()], folders };
}
/**
 * The names `status` lists as "not chosen yet": what the resolver recorded as undecided in the last `sinceMs`, MINUS anything
 * that has been decided since (granted, turned off, declined, or a clone that no longer exists). Names only, read from the target
 * records: no transcript is opened. Re-checked against today's consent, so declining a folder or granting a repo removes it the
 * moment it is done, not when the record ages out (P1, A-T5 review: a declined folder must not read "undecided" forever).
 */
export function undecidedNow(home, sinceMs) {
    const read = readGrants(home);
    const grants = read.kind === "ok" ? read.grants : EMPTY_GRANTS;
    const account = readAccountState(home);
    const denied = [grants.excluded, grants.refused, account.refused, account.account?.excluded ?? []];
    const perCloneSlugs = new Set(readPerClone(home).flatMap((c) => (c.slug === null ? [] : [normalizeSlug(c.slug)])));
    const allowed = readAllowList(home);
    const out = [];
    for (const name of readUndecidedNames(home, sinceMs)) {
        if (name.kind === "folder") {
            if (folderStandingOf(home, name.name) === "undecided")
                out.push({ kind: "folder", name: name.name });
            continue;
        }
        if (name.name.startsWith("/")) {
            // A repo with no remote is named by its work tree. One that is gone cannot be connected, so it is not offered.
            const keys = resolveProjectKeys(name.name);
            if (keys !== null && !Object.prototype.hasOwnProperty.call(allowed, keys.consent))
                out.push({ kind: "repo", name: name.name });
            continue;
        }
        const slug = normalizeSlug(name.name);
        const decided = denied.some((list) => list.includes(slug)) ||
            grants.repos.includes(slug) ||
            grants.owners.includes(ownerOfSlug(slug)) ||
            perCloneSlugs.has(slug);
        if (!decided)
            out.push({ kind: "repo", name: name.name });
    }
    return out;
}
/** `1 owner and 2 repos` — or the empty string when nothing is on. A granted folder adds `and 1 folder`. */
export function machineSummary(capture) {
    return capture.kind === "on" ? PICKER.summary(capture.owners, capture.repos, capture.folders.length) : "";
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
/**
 * The granted folders `status` names as refused: what the target records stopped in the last `sinceMs`, MINUS any folder that is no
 * longer granted (excluded, or removed), so a folder the user has since turned off does not read as refused for ever. A record the
 * drain forgot (DRAIN_FORGET_MS) is not listed either: names only, read from the target records, no transcript is opened.
 */
export function refusedFoldersNow(home, sinceMs) {
    return readStoppedFolders(home, sinceMs)
        .filter((stop) => folderStandingOf(home, stop.folder) === "granted")
        .map((stop) => ({ folder: stop.folder, at: stop.at }));
}
//# sourceMappingURL=machine_state.js.map