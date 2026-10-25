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
import { grantsAccountPath, grantsPath, projectsPath, rootDir } from "./paths.js";
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
    pending: [],
    synced_at: null,
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
const PENDING_OPS = new Set(["grant", "revoke", "exclude", "include"]);
/**
 * `pending`: ABSENT is none (every 0.7.0 file), but a field that is there and malformed is `null` — the caller reads the
 * whole file as unreadable, the same rule as the other lists, since a queue we cannot read may hold a grant we are holding.
 */
function parsePending(value) {
    if (value === undefined)
        return [];
    if (!Array.isArray(value))
        return null;
    const out = [];
    for (const item of value) {
        if (item === null || typeof item !== "object" || Array.isArray(item))
            return null;
        const { op, kind, value: v, at } = item;
        if (typeof op !== "string" || !PENDING_OPS.has(op))
            return null;
        if (kind !== "owner" && kind !== "repo")
            return null;
        if (typeof v !== "string" || typeof at !== "string")
            return null;
        if ((op === "exclude" || op === "include") && kind !== "repo")
            return null;
        const clean = kind === "owner" ? normalizeOwner(v) : normalizeSlug(v);
        if (clean === "")
            return null;
        out.push({ op: op, kind, value: clean, at });
    }
    return out;
}
/**
 * The seven fields this version knows and REBUILDS on every write (`pending` and `synced_at` are slice 2's); every other top-level key
 * of `grants.json` is carried through untouched.
 */
const KNOWN_GRANTS_KEYS = new Set(["disclosed_at", "owners", "repos", "excluded", "refused", "pending", "synced_at"]);
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
        const pending = parsePending(o.pending);
        const syncedAt = o.synced_at === undefined ? null : o.synced_at;
        const at = o.disclosed_at;
        if (owners === null || repos === null || excluded === null || refused === null || pending === null) {
            return { read: { kind: "unreadable" }, extras: none };
        }
        if (at !== null && typeof at !== "string")
            return { read: { kind: "unreadable" }, extras: none };
        if (syncedAt !== null && typeof syncedAt !== "string")
            return { read: { kind: "unreadable" }, extras: none };
        return {
            read: { kind: "ok", grants: { disclosed_at: at, owners, repos, excluded, refused, pending, synced_at: syncedAt } },
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
export const EMPTY_ACCOUNT_STATE = { account: null, refused: [], stale: false, last_get_at: null };
function parseAccountGrants(value) {
    if (value === null)
        return null;
    if (typeof value !== "object" || Array.isArray(value))
        return undefined;
    const o = value;
    const owners = stringList(o.owners, normalizeOwner);
    const repos = stringList(o.repos, normalizeSlug);
    const excluded = stringList(o.excluded, normalizeSlug);
    if (owners === null || repos === null || excluded === null)
        return undefined;
    if (typeof o.epoch !== "number" || !Number.isSafeInteger(o.epoch) || o.epoch < 0)
        return undefined;
    if (typeof o.synced_at !== "string")
        return undefined;
    return { owners, repos, excluded, epoch: o.epoch, synced_at: o.synced_at };
}
/** Read it. **NEVER THROWS, and any failure — missing, unreadable, not JSON, any field off-shape — is the empty state.** */
export function readAccountState(home) {
    try {
        const parsed = JSON.parse(readFileSync(grantsAccountPath(home), "utf8"));
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
            return EMPTY_ACCOUNT_STATE;
        const o = parsed;
        const account = o.account === undefined ? null : parseAccountGrants(o.account);
        const refused = o.refused === undefined ? [] : stringList(o.refused, normalizeSlug);
        const last = o.last_get_at === undefined ? null : o.last_get_at;
        if (account === undefined || refused === null)
            return EMPTY_ACCOUNT_STATE;
        if (o.stale !== undefined && typeof o.stale !== "boolean")
            return EMPTY_ACCOUNT_STATE;
        if (last !== null && typeof last !== "string")
            return EMPTY_ACCOUNT_STATE;
        return { account, refused, stale: o.stale === true, last_get_at: last };
    }
    catch {
        return EMPTY_ACCOUNT_STATE;
    }
}
/** Write it whole: normalized, atomic, 0600. Throws on an I/O failure (the destination is then untouched). */
export function writeAccountState(home, state) {
    const clean = {
        account: state.account === null
            ? null
            : {
                owners: [...new Set(state.account.owners.map(normalizeOwner).filter((o) => o !== ""))],
                repos: [...new Set(state.account.repos.map(normalizeSlug).filter((r) => r !== ""))],
                excluded: [...new Set(state.account.excluded.map(normalizeSlug).filter((x) => x !== ""))],
                epoch: state.account.epoch,
                synced_at: state.account.synced_at,
            },
        refused: [...new Set(state.refused.map(normalizeSlug).filter((x) => x !== "" && !isLocalSlug(x)))],
        stale: state.stale,
        last_get_at: state.last_get_at,
    };
    const path = grantsAccountPath(home);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileAtomic(path, `${JSON.stringify(clean, null, 2)}\n`, 0o600);
}
/**
 * A hook saw `repository_excluded` for this slug: remember it, so this machine stops reading that repo's transcripts until
 * the next sync says otherwise. **NEVER THROWS** — it runs on the hook's path, where a failed write only means the server
 * refuses the next upload too. `local:` slugs are never recorded (there is no repo identity to refuse).
 */
export function recordRefused(home, slug) {
    const name = normalizeSlug(slug);
    if (name === "" || isLocalSlug(name))
        return;
    try {
        const current = readAccountState(home);
        if (current.refused.includes(name))
            return;
        writeAccountState(home, { ...current, refused: [...current.refused, name] });
    }
    catch {
        // The hook goes on: nothing was written, and the next refusal tries again.
    }
}
/**
 * A hook saw `X-Grant-Epoch` on a server answer (an ingest 2xx, or a grants refusal): if it is not the epoch this machine last
 * recorded, mark the account state `stale`, which is what SessionStart's one bounded `GET` looks for (`session_grants.ts`).
 * A machine with no recorded account state counts as epoch 0, as the server does when a user has no grants row.
 *
 * Writes `grants-account.json` and never `grants.json` (see `AccountState`), only when something changed — so a Stop hook that sees
 * the same epoch every turn does no file write at all — and only ever sets `stale`; the GET (or a sync) clears it. **NEVER THROWS**:
 * it runs on the hook's path, and a lost mark only means the next answer marks it again.
 */
export function noteGrantEpoch(home, epoch) {
    if (epoch === null || epoch === undefined || !Number.isSafeInteger(epoch) || epoch < 0)
        return;
    try {
        const current = readAccountState(home);
        if (current.stale)
            return;
        if (epoch === (current.account?.epoch ?? 0))
            return;
        writeAccountState(home, { ...current, stale: true });
    }
    catch {
        // The hook goes on: nothing was written, and the next answer marks it again.
    }
}
/**
 * True when the last synced account state (the last 200) already grants this repo, or its owner. ⚠ Read only to avoid a NEEDLESS
 * hold — say an owner grant was queued and refused with a 400 while the server already admits this repo — and never to admit: the
 * account's grants do not admit anything on this machine.
 */
function accountGrants(state, name) {
    const a = state.account;
    return a !== null && (a.repos.includes(name) || a.owners.includes(ownerOfSlug(name)));
}
/** True when a queued `grant` op names this slug, or its owner. */
function grantPendingFor(pending, name) {
    const owner = ownerOfSlug(name);
    return pending.some((p) => p.op === "grant" && (p.kind === "repo" ? p.value === name : p.value === owner));
}
/**
 * Does the hold of `isCaptureAllowed` (step 3) apply to ANYTHING on this machine right now? True when the machine has synced
 * (`synced_at` is set) and a queued `grant` op names an owner or a repo the last synced account state does not already grant
 * (the same two conditions the per-slug hold uses: a synced machine, and the account not already admitting it). "0.8.0 truth
 * fixes" R2-2: `connect`'s untold line says sessions wait only when something actually waits. Reads `grants.json` and
 * `grants-account.json`; an unreadable `grants.json` holds nothing here (the gate denies for its own reason).
 */
export function holdsAny(home) {
    const read = readGrants(home);
    if (read.kind !== "ok" || read.grants.synced_at === null)
        return false;
    const state = readAccountState(home);
    // `accountGrants` is the gate's own predicate: an owner op is asked as `owner/` (its owner is `owner`, and no account repo is spelled that way).
    return read.grants.pending.some((p) => p.op === "grant" && !accountGrants(state, p.kind === "repo" ? p.value : `${p.value}/`));
}
/**
 * ⛔ **THE ONE ADMISSION DECISION.** Every gate calls this; `entry.ts`, `post_commit.ts`, `post_rewrite.ts` (twice),
 * `finalize.ts`, `status.ts` and `connect.ts` are the seven call sites. Absence is a NO and every error path denies.
 *
 * Precedence:
 *  1. A MISSING `grants.json` is empty (0.6.x machines keep capturing on their common-dir consent). A PRESENT file
 *     that cannot be read denies every clone that has a slug, whatever `projects.json` says.
 *  2. A denied slug is denied, whatever the basis: `grants.json`'s `excluded` (and its legacy `refused`), the account file's
 *     `refused`, or the account's own `excluded`.
 *  3. On a machine that HAS SYNCED (`grants.synced_at` is set), a slug with a `grant` still PENDING (queued, not yet delivered to
 *     the account) is held back when that grant is the slug's ONLY local basis, i.e. the clone has no common-dir consent: its
 *     spans stay unsent with their offset unchanged, and go once a sync delivers the grant. It is not held either when the last
 *     synced account state already grants the repo or its owner (the server admits it, so a queued grant that was refused must
 *     not hold it for ever).
 *     ⭐ **A MACHINE THAT HAS NEVER SYNCED HOLDS NOTHING** (VQ, "0.8.0 truth fixes" F1): the server refuses only a credential that
 *     has synced (`grants_synced_at`), so before the first sync the hold protects nothing and would only defer uploads, for ever
 *     against a server without the routes. Such a machine decides capture by its own choices, as under 0.7.0.
 *     ⭐ **WHY A COMMON-DIR CONSENT LIFTS THE HOLD** (VQ's ruling): a remote repo gets a common-dir consent only from pre-0.8.0
 *     flows (0.8.0's in-repo `connect` pre-ticks the picker, which writes GRANTS). The first sync uploads those consented slugs, so
 *     either this credential has not synced, and the server never refuses anything for it, or the first sync already granted the
 *     slug, and holding it would only delay bytes the server accepts.
 *  4. Otherwise: admitted on the common-dir consent, or on a slug matched by `owners` or `repos`. ⛔ The account's own
 *     `owners`/`repos` are NOT consulted — a repo only the account grants is not captured on this machine (per-machine naming).
 *
 * `local:` slugs never match a grant and keep common-dir consent alone. They are also not subject to
 * exclusion or to an unreadable file: there is no repo identity to exclude.
 *
 * `grants-account.json` is read on every call and an unreadable one is the empty state, never a denial (`AccountState`).
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
    const resolve = () => normalizeSlug(typeof slug === "function" ? slug() : slug);
    if (read.kind === "unreadable")
        return isLocalSlug(resolve()) ? byClone : false;
    const grants = read.kind === "ok" ? read.grants : EMPTY_GRANTS;
    const account = readAccountState(home);
    const denyLists = [grants.excluded, grants.refused, account.refused, account.account?.excluded ?? []];
    const mayDeny = denyLists.some((list) => list.length > 0);
    const mayHold = !byClone && grants.synced_at !== null && grants.pending.some((p) => p.op === "grant");
    if (!mayDeny && !mayHold && (byClone || (grants.owners.length === 0 && grants.repos.length === 0)))
        return byClone;
    const name = resolve();
    if (isLocalSlug(name))
        return byClone;
    if (denyLists.some((list) => list.includes(name)))
        return false;
    if (!byClone && grants.synced_at !== null && grantPendingFor(grants.pending, name) && !accountGrants(account, name))
        return false;
    return byClone || grants.repos.includes(name) || grants.owners.includes(ownerOfSlug(name));
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
        pending: next.pending.flatMap((p) => {
            const value = p.kind === "owner" ? normalizeOwner(p.value) : normalizeSlug(p.value);
            return value === "" ? [] : [{ ...p, value }];
        }),
        synced_at: next.synced_at,
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