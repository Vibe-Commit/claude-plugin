/**
 * "This repo's upload was refused because its org has not approved capture yet" — a one-bit memory, so `status` can say so
 * (0.7.0, PR 3: VQ's claim-check-2 follow-up, Alexander's "Status lists them", and VT's review of the first design).
 *
 * The client already KNOWS this: a `403 capture_not_approved` is the answer to THIS repo's own upload, and `connect` prints the
 * held beat for it. A hook treats the same 403 as `later` (the offset holds, the bytes stay on disk) and remembered nothing, so
 * `status` could not tell a repo waiting on an owner from one that simply had not sent yet.
 *
 * ## ONE marker per SLUG, because an organization's approval is about the repo and not about one clone of it
 *
 * `<state>/org-pending/<digest of normalizeSlug(slug)>.mark`, holding the slug. The first design keyed the marker by the
 * worktree, and it outlived the approval whenever a DIFFERENT clone, or a worktree since removed, was the one that delivered:
 * machine `status` kept saying "the org must approve capture" about a repo that was approved. Keyed by slug, a 2xx from any clone
 * removes it, and both statuses read the same file:
 *
 *   - **in-repo `status`** reads the marker for the repo's slug (`readOrgPending`);
 *   - **machine `status`** lists the directory (`listOrgPending`): one small file per WAITING repo.
 *
 * ## The hot path stays flat
 *
 * Written on that 403 only; cleared on any 2xx by ONE `rmSync` of a path computed from `ctx.repoSlug`. No directory scan and no
 * spawn on a delivery; the only scan is `listOrgPending`, by `status`, of this small directory. (`test/load-path.test.ts` pins
 * that `clearOrgPending` and `markOrgPending` contain neither.)
 *
 * ## Rules
 *   - The slug is the CLIENT's (`ctx.repoSlug`), never anything in the response body, which names nobody.
 *   - `normalizeSlug` (consent.ts) on write, on clear and on both reads, so `Acme/Widget` and `acme/widget` are one marker.
 *   - No marker for a `local:` slug: it names a path, and no organization can hold it.
 *   - The file is NAMED by a digest and carries the slug inside, so a slug with `/` or anything a host allows is never a path.
 *   - Every function swallows its own failure: it runs on the hook's path, where nothing may throw, and a missing marker only
 *     means `status` says nothing extra.
 *
 * Old per-worktree markers (written by earlier builds of this PR) are not read and not migrated: they were never released.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isLocalSlug, normalizeSlug } from "./consent.js";
import { stateDir } from "./paths.js";
const SLUG_DIR = "org-pending";
function markerPath(home, slug) {
    return join(stateDir(home), SLUG_DIR, `${createHash("sha256").update(normalizeSlug(slug)).digest("hex").slice(0, 32)}.mark`);
}
export function markOrgPending(home, nowMs, ownersNotified, slug) {
    const name = normalizeSlug(slug);
    if (name === "" || isLocalSlug(name))
        return;
    try {
        const path = markerPath(home, name);
        mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
        writeFileSync(path, `${JSON.stringify({ at: nowMs, owners_notified: ownersNotified, slug: name })}\n`, { mode: 0o600 });
    }
    catch {
        // Nothing to remember it with; `status` says nothing extra.
    }
}
/** A delivery landed, so the org approved: remove this slug's marker, whichever clone wrote it. One `rmSync`. */
export function clearOrgPending(home, slug) {
    try {
        rmSync(markerPath(home, slug), { force: true });
    }
    catch {
        // A marker that cannot be removed is a stale "waiting" line at worst, and the next delivery tries again.
    }
}
function parse(path) {
    try {
        const parsed = JSON.parse(readFileSync(path, "utf8"));
        if (parsed === null || typeof parsed !== "object")
            return null;
        const { at, owners_notified: owners, slug } = parsed;
        if (typeof at !== "number" || !Number.isFinite(at) || at <= 0)
            return null;
        return {
            at,
            ownersNotified: typeof owners === "number" && Number.isFinite(owners) ? owners : null,
            slug: typeof slug === "string" && slug !== "" ? normalizeSlug(slug) : null,
        };
    }
    catch {
        return null;
    }
}
/** Is THIS repo (any clone of it) waiting on an organization's approval? In-repo `status`. */
export function readOrgPending(home, slug) {
    const name = normalizeSlug(slug);
    if (name === "" || isLocalSlug(name))
        return null;
    return parse(markerPath(home, name));
}
/**
 * Every repo on this machine with a standing refusal, for the machine-level `status`: the slug directory, one small file per
 * waiting repo. Never `sessions/*`, and only ever called by `status`, never on a delivery. Unreadable entries are skipped.
 */
export function listOrgPending(home) {
    const root = join(stateDir(home), SLUG_DIR);
    let names;
    try {
        names = readdirSync(root);
    }
    catch {
        return [];
    }
    return names.flatMap((name) => {
        const entry = parse(join(root, name));
        return entry === null ? [] : [entry];
    });
}
//# sourceMappingURL=org_pending.js.map