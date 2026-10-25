/**
 * The consent gate — D56 plan §D19, D65 §DR7.
 *
 * **It runs BEFORE anything reads `transcript_path`.** That ordering is the whole
 * control: a gate that runs after the read has already read the thing it was
 * gating. `hooks/entry.ts` calls `isProjectAllowed` before it touches the
 * transcript, and `test/consent.test.ts` asserts the transcript file is never
 * opened on the unconsented path.
 *
 * Three rules, in order of how easily they break (style guide §10.2):
 *   1. **The default is `N`.** A consent prompt whose default is yes is not a
 *      consent prompt.
 *   2. **Non-TTY refuses**, with exit 2 (DESIGN.md §13.7). Never proceed.
 *   3. Storage is an allow list keyed on the CONSENT KEY — absence is a NO.
 *      Nothing here can fail open: every error path returns "not allowed".
 *
 * ## ⛔ The key is `resolveProjectKeys(dir).consent`, NOT the git toplevel (D184)
 *
 * A toplevel key differs per `git worktree`, and with no wildcards and
 * absence-means-no that meant an agent session inside a worktree captured
 * **nothing** — silently, by design, because an unconsented repo must not nag.
 * The consent key is the canonicalised git COMMON DIR instead: shared by a main
 * clone and every worktree linked to it, and `M2` shows the post-commit install
 * already had that same reach.
 *
 * ⛔ **This file stays key-agnostic — it stores the string it is given.** The
 * canonicalisation that stops `.git` from being every main clone's key lives in
 * `project.ts` where the value is produced, because a key is only as good as the
 * one place that can mint it. What changes here is the CONTRACT: callers pass
 * `.consent`, and the parameter is named for it so a toplevel passed by habit
 * reads wrong at the call site.
 *
 * ## ⛔ A SECOND KEY, AND ONE DOOR: `isCaptureAllowed` (0.7.0, D1 · B)
 *
 * A repo can now also be admitted by its SLUG (`owner/repo`) through
 * `grants.json`, so any clone of it matches, not only the one that ran
 * `connect`. Every gate asks `isCaptureAllowed`; `isProjectAllowed` is the
 * common-dir half of it and nothing outside this file calls it
 * (`test/consent-gates.test.ts` scans for exactly that). Two keys behind two
 * doors is how `post_rewrite.ts` was missed once.
 *
 * ⚠ **No migration for allow lists written under the old key**, and that is a
 * decision rather than an omission: pre-launch there are zero users and zero
 * rows (`project_pre_launch_no_data`), so there is nothing to migrate. See
 * `resolveProjectKeys`.
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { writeFileAtomic } from "./atomic_write.js";
import { grantsPath, projectsPath, rootDir } from "./paths.js";
/**
 * Read the allow list. **Every failure returns an empty list**, which means "no
 * project is consented" — a corrupt or unreadable file must not be able to grant
 * capture on a repo the user never approved.
 */
export function readAllowList(home) {
    let raw;
    try {
        raw = readFileSync(projectsPath(home), "utf8");
    }
    catch {
        return {};
    }
    try {
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
            return {};
        const out = {};
        for (const [key, value] of Object.entries(parsed)) {
            if (value !== null && typeof value === "object" && !Array.isArray(value)) {
                const at = value.at;
                out[key] = { at: typeof at === "string" ? at : "" };
            }
        }
        return out;
    }
    catch {
        return {};
    }
}
/** Absence is a NO. There is no wildcard and no "all projects" key. */
export function isProjectAllowed(home, consentKey) {
    if (consentKey === null)
        return false;
    return Object.prototype.hasOwnProperty.call(readAllowList(home), consentKey);
}
/** Record consent for one project. 0700 on the directory, 0600 on the file. */
export function grantProject(home, consentKey, now) {
    const path = projectsPath(home);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    chmodSync(rootDir(home), 0o700);
    const next = {
        ...readAllowList(home),
        [consentKey]: { at: now.toISOString() },
    };
    writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    // writeFileSync's `mode` is ignored when the file already exists.
    chmodSync(path, 0o600);
}
/** Revoke consent for one project (`vibecommit off`). */
export function revokeProject(home, consentKey) {
    const current = readAllowList(home);
    if (!Object.prototype.hasOwnProperty.call(current, consentKey))
        return false;
    const next = { ...current };
    delete next[consentKey];
    const path = projectsPath(home);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
    return true;
}
export const EMPTY_GRANTS = {
    disclosed_at: null,
    owners: [],
    repos: [],
    excluded: [],
    refused: [],
};
/**
 * ⛔ **THE ONE NORMALIZATION.** The whole host-qualified slug, lowercased, for every host — the identity the
 * server already stores (`resolve_repository` sets `v_slug := lower(trim(...))`). Owners, repos, exclusions,
 * every `grants.json` write and slice 2's server comparison all go through this, so two clones whose remotes
 * differ only in case are one repo on both sides.
 */
export function normalizeSlug(slug) {
    return slug.trim().toLowerCase();
}
/** An owner as stored: normalized, and without the trailing `/` the picker displays (`alexvibecommit/`). */
export function normalizeOwner(owner) {
    return normalizeSlug(owner).replace(/\/+$/, "");
}
/** `local:` slugs name a path, not a repo: no grant can match one, and their consent stays per clone. */
export function isLocalSlug(slug) {
    return slug.startsWith("local:");
}
/** The owner part of a slug: everything before the last `/`. `""` when there is none. */
export function ownerOfSlug(slug) {
    const cut = slug.lastIndexOf("/");
    return cut <= 0 ? "" : slug.slice(0, cut);
}
function stringList(value, normalize) {
    if (!Array.isArray(value))
        return null;
    const out = [];
    for (const item of value) {
        if (typeof item !== "string")
            return null;
        const n = normalize(item);
        if (n !== "" && !out.includes(n))
            out.push(n);
    }
    return out;
}
/** The five fields this version knows; every other top-level key of `grants.json` is carried through untouched. */
const KNOWN_GRANTS_KEYS = new Set(["disclosed_at", "owners", "repos", "excluded", "refused"]);
/**
 * `readGrants` plus the top-level keys it does not know, in file order. One read and one parse, so `updateGrants`
 * rewrites exactly the file it read. `extras` is empty unless `read` is `ok`.
 */
function readGrantsWithExtras(home) {
    const none = [];
    let raw;
    try {
        raw = readFileSync(grantsPath(home), "utf8");
    }
    catch (error) {
        return { read: error.code === "ENOENT" ? { kind: "missing" } : { kind: "unreadable" }, extras: none };
    }
    try {
        const parsed = JSON.parse(raw);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
            return { read: { kind: "unreadable" }, extras: none };
        const o = parsed;
        // A missing list is NOT read as empty: a typo'd `exclude` key would otherwise silently drop every
        // exclusion. All four are required, extra keys are ignored.
        const owners = stringList(o.owners, normalizeOwner);
        const repos = stringList(o.repos, normalizeSlug);
        const excluded = stringList(o.excluded, normalizeSlug);
        const refused = stringList(o.refused, normalizeSlug);
        const at = o.disclosed_at;
        if (owners === null || repos === null || excluded === null || refused === null)
            return { read: { kind: "unreadable" }, extras: none };
        if (at !== null && typeof at !== "string")
            return { read: { kind: "unreadable" }, extras: none };
        return {
            read: { kind: "ok", grants: { disclosed_at: at, owners, repos, excluded, refused } },
            extras: Object.entries(o).filter(([key]) => !KNOWN_GRANTS_KEYS.has(key)),
        };
    }
    catch {
        return { read: { kind: "unreadable" }, extras: none };
    }
}
export function readGrants(home) {
    return readGrantsWithExtras(home).read;
}
/** True when a `grants.json` is present and unusable — the state `status` reports and a SessionStart notice names. */
export function grantsUnreadable(home) {
    return readGrants(home).kind === "unreadable";
}
/**
 * ⛔ **THE ONE ADMISSION DECISION.** Every gate calls this; `entry.ts`, `post_commit.ts`, `post_rewrite.ts` (twice),
 * `finalize.ts`, `status.ts` and `connect.ts` are the seven call sites. Absence is a NO and every error path denies.
 *
 * Precedence:
 *  1. A MISSING `grants.json` is empty (0.6.x machines keep capturing on their common-dir consent). A PRESENT file
 *     that cannot be read denies every clone that has a slug, whatever `projects.json` says.
 *  2. An excluded slug is denied, whatever the basis.
 *  3. Otherwise: admitted on the common-dir consent, or on a slug matched by `owners` or `repos`.
 *
 * `local:` slugs never match a grant and keep common-dir consent alone. They are also not subject to
 * exclusion or to an unreadable file: there is no repo identity to exclude.
 *
 * ⚠ **`slug` MAY BE A THUNK, and the hooks pass one.** Computing a slug can spawn `git remote get-url` and `ssh -G`,
 * which is real time on a hook's budget; a machine with no `grants.json` (every 0.6.x machine) needs none of it, and
 * neither does a clone with no consent and no grants to match. The slug is asked for only when the answer depends on it.
 * Pass a memoized thunk (`git.ts`'s `onceRepoSlug`) so the caller's own later use shares the one spawn.
 *
 * `keys` is the `resolveProjectKeys` result the caller already holds, so the confinement roots it derives afterwards
 * come from the very resolution this gate used (`D184 §3`).
 */
export function isCaptureAllowed(home, keys, slug) {
    if (keys === null)
        return false;
    const byClone = isProjectAllowed(home, keys.consent);
    const read = readGrants(home);
    if (read.kind === "missing")
        return byClone;
    const resolve = () => normalizeSlug(typeof slug === "function" ? slug() : slug);
    if (read.kind === "unreadable")
        return isLocalSlug(resolve()) ? byClone : false;
    const { owners, repos, excluded } = read.grants;
    if (excluded.length === 0 && (byClone || (owners.length === 0 && repos.length === 0)))
        return byClone;
    const name = resolve();
    if (isLocalSlug(name))
        return byClone;
    if (excluded.includes(name))
        return false;
    return byClone || repos.includes(name) || owners.includes(ownerOfSlug(name));
}
/** `updateGrants` refuses to rewrite a file it cannot read: overwriting would silently drop exclusions it never saw. */
export class GrantsUnreadableError extends Error {
    constructor() {
        super("grants.json is present and cannot be read");
        this.name = "GrantsUnreadableError";
    }
}
/**
 * Read-modify-write `grants.json`. 0700 on the directory, 0600 on the file, atomic (a hook reading while a verb saves
 * sees the old file or the new, never half). Entries are normalized and de-duplicated on the way out.
 *
 * ⛔ **Throws `GrantsUnreadableError` rather than start from empty** when the file is present and unusable: a rewrite
 * would turn "denies everything" into "admits on common-dir consent" without the user having decided anything.
 *
 * ⛔ **Keeps the top-level keys it does not know**, verbatim and uninterpreted, after the five it rebuilds (which always
 * win). A newer version's file read by this one is written back whole: dropping a key it added would silently undo its
 * state. No lock: same read-modify-write as `projects.json`, so two simultaneous verbs can lose one write.
 */
export function updateGrants(home, change) {
    const { read, extras } = readGrantsWithExtras(home);
    if (read.kind === "unreadable")
        throw new GrantsUnreadableError();
    const next = change(read.kind === "ok" ? read.grants : EMPTY_GRANTS);
    const clean = {
        disclosed_at: next.disclosed_at,
        owners: [...new Set(next.owners.map(normalizeOwner).filter((o) => o !== ""))],
        repos: [...new Set(next.repos.map(normalizeSlug).filter((r) => r !== ""))],
        excluded: [...new Set(next.excluded.map(normalizeSlug).filter((x) => x !== ""))],
        refused: [...new Set(next.refused.map(normalizeSlug).filter((x) => x !== ""))],
    };
    const path = grantsPath(home);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    chmodSync(rootDir(home), 0o700);
    // `Object.fromEntries` defines own properties, so even a key named `__proto__` is written back as data.
    const out = Object.fromEntries([...Object.entries(clean), ...extras]);
    writeFileAtomic(path, `${JSON.stringify(out, null, 2)}\n`, 0o600);
    return clean;
}
/** `vibecommit off`: the slug joins `excluded`. Returns true when that changed the file. */
export function excludeSlug(home, slug) {
    const name = normalizeSlug(slug);
    let changed = false;
    updateGrants(home, (g) => {
        changed = !g.excluded.includes(name);
        return changed ? { ...g, excluded: [...g.excluded, name] } : g;
    });
    return changed;
}
/**
 * A yes at the disclosure re-includes a turned-off repo; nothing else does. `"none"` when the slug was not excluded
 * (no file is written then), `"unreadable"` when `grants.json` cannot be read.
 */
export function clearExclusion(home, slug) {
    const name = normalizeSlug(slug);
    const read = readGrants(home);
    if (read.kind === "unreadable")
        return "unreadable";
    if (read.kind === "missing" || !read.grants.excluded.includes(name))
        return "none";
    updateGrants(home, (g) => ({ ...g, excluded: g.excluded.filter((x) => x !== name) }));
    return "cleared";
}
/**
 * Interpret an answer to the consent prompt. **Only an explicit yes is a yes.**
 * Empty (the user pressed return) is NO, which is what makes `[y/N]` honest.
 */
export function isAffirmative(answer) {
    const a = answer.trim().toLowerCase();
    return a === "y" || a === "yes";
}
//# sourceMappingURL=consent.js.map