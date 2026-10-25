/**
 * The account-grants client — `POST /ingest/v1/grants/sync` and `GET /ingest/v1/grants` (slice 2, `CR-259`, S4).
 *
 * ```
 *   POST <ingest origin>/ingest/v1/grants/sync    Authorization: Bearer vcik_…
 *     { "schema": 1, "ops": [{ "op": "grant"|"revoke"|"exclude"|"include", "kind": "owner"|"repo", "value": "<normalized>" }],
 *       "named": { "owners": [..], "repos": [..] } }            64 KiB, 500 ops; `exclude`/`include` take kind "repo"
 *   200 { "schema": 1, "epoch", "owners", "repos", "excluded", "unsynced_machines" }   + X-Grant-Epoch
 *   400 { "error": "invalid_grants_sync" }         nothing applied
 *   401                                            the credential, not the grants
 *
 *   GET  <ingest origin>/ingest/v1/grants                       a pure read — it does not mark the credential as synced
 *   200 { "schema": 1, "epoch", "owners", "repos", "excluded" }   + X-Grant-Epoch
 * ```
 *
 * The contract is `CR-259`'s (`slice2-build-brief-20261024.md` §1.2), which the server side (`cr259b`) is built to as well: this file
 * was written from that brief and not from any closed source, so it declares no sibling-repo provenance.
 *
 * ## What this file is, and is not, in the PR that adds it
 *
 * Primitives. No verb calls them yet: `connect`, `status` and `off` sync at their start or end, and SessionStart does the one
 * bounded GET, but each of those prints something new and waits on the 0.7.0 error-code copy (PR 7). They are tested here
 * through injected deps, and listed in `dead-symbols.test.ts` as unreferenced until those verbs land.
 *
 * ## Who writes what
 *
 *   - `syncGrants` is a VERB's: it may write `grants.json` (to clear what it delivered from `pending`) because a verb is
 *     the only kind of caller that may. Hooks never sync, and never write `grants.json` (`consent.ts`).
 *   - `fetchAccountGrants` writes NOTHING. SessionStart (a hook) is its caller, and what it learned goes to `grants-account.json`.
 *
 * ## Failure is silent, and a failed sync loses nothing
 *
 * Every function here is bounded (3 s) and NEVER THROWS. A sync that fails for any reason leaves `pending` where it was, so the
 * next verb sends it again — the server applies every op idempotently. The caller says "not yet sent" (`status`); this file
 * says nothing.
 */
import { EMPTY_GRANTS, GrantsUnreadableError, isLocalSlug, normalizeOwner, normalizeSlug, readAccountState, readGrants, updateGrants, writeAccountState, } from "./consent.js";
import { MAX_ERROR_BODY_BYTES, readCappedJson } from "./post.js";
import { CLIENT_VERSION, CLIENT_VERSION_HEADER } from "./version.js";
export const GRANTS_PATH = "/ingest/v1/grants";
export const GRANTS_SYNC_PATH = "/ingest/v1/grants/sync";
/** Brief §2: each sync is bounded at 3 s IN TOTAL (one deadline shared by its chunks), so a verb never feels hung on it. The same bound serves the GET. */
export const GRANTS_TIMEOUT_MS = 3_000;
/** The server's caps on one sync request (brief §1.2). A request over either is never sent. */
export const SYNC_MAX_OPS = 500;
export const SYNC_MAX_BYTES = 64 * 1024;
/** What a CLI verb (`connect`, `status`, `off`) passes as `maxBodyBytes`: a verb is not a hook, so eng-2 D2's 64 KiB rule does not bind it. */
export const GRANTS_VERB_BODY_BYTES = 1024 * 1024;
function grantsUrl(ingestUrl, path) {
    return new URL(path, ingestUrl).toString();
}
function headersFor(credential, json) {
    return {
        // The request boundary — a credential's plaintext is used here, in `post.ts` and in `oauth/whoami.ts`.
        authorization: `Bearer ${credential.expose()}`,
        accept: "application/json",
        ...(json ? { "content-type": "application/json" } : {}),
        [CLIENT_VERSION_HEADER.toLowerCase()]: CLIENT_VERSION,
    };
}
function normalizedList(value, normalize) {
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
/** The account state in a sync or GET body, or `null` if it is not what the contract says. Schema 1 only. */
function parseSnapshot(body) {
    if (body === null || typeof body !== "object" || Array.isArray(body))
        return null;
    const o = body;
    if (o.schema !== 1)
        return null;
    if (typeof o.epoch !== "number" || !Number.isSafeInteger(o.epoch) || o.epoch < 0)
        return null;
    const owners = normalizedList(o.owners, normalizeOwner);
    const repos = normalizedList(o.repos, normalizeSlug);
    const excluded = normalizedList(o.excluded, normalizeSlug);
    if (owners === null || repos === null || excluded === null)
        return null;
    return { epoch: o.epoch, owners, repos, excluded };
}
/**
 * `GET /ingest/v1/grants`. A pure read: it changes nothing on the server and writes nothing here. Read through the one capped,
 * signal-raced body reader (`post.ts`), so a 64 KiB cap and the time bound are the same ones the hook's other body reads have; a
 * body that stalls, is cut off, is over the cap or is not JSON is `unavailable`, and the caller's epoch stays as stale as it was.
 */
export async function fetchAccountGrants(ingestUrl, credential, deps) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? GRANTS_TIMEOUT_MS);
    try {
        const res = await deps.fetch(grantsUrl(ingestUrl, GRANTS_PATH), {
            method: "GET",
            headers: headersFor(credential, false),
            signal: controller.signal,
            redirect: "error",
        });
        if (res.status === 401)
            return { kind: "unauthorized" };
        if (res.status !== 200)
            return { kind: "unavailable" };
        const snapshot = parseSnapshot(await readCappedJson(res, controller.signal, deps.maxBodyBytes ?? MAX_ERROR_BODY_BYTES));
        return snapshot === null ? { kind: "unavailable" } : { kind: "ok", ...snapshot };
    }
    catch {
        return { kind: "unavailable" };
    }
    finally {
        clearTimeout(timer);
    }
}
const wire = (p) => ({ op: p.op, kind: p.kind, value: p.value });
/**
 * What to send. `named` is everything THIS machine has named: its `owners`, and its `repos` plus the slug of every clone it holds
 * a per-clone consent for (`consentedSlugs`, which the caller resolves — it needs git) — minus anything the user turned off
 * here, since a turned-off repo is not named. Local-only (`local:`) slugs are never sent: they name a path, and the server has no
 * grant for one.
 *
 * ⭐ **THE FIRST SYNC** (`account === null`: nothing has ever come back from the server) also sends a `grant` for each of those,
 * so per-clone consents made under 0.6.x/0.7.0 reach the account (R3-21). They go BEFORE the pending ops, so a later user
 * intent (a queued `revoke` of the same repo) is the one that stands. After the first sync only `pending` rides.
 */
export function planSync(grants, consentedSlugs, firstSync) {
    const off = new Set(grants.excluded);
    const owners = [...new Set(grants.owners.map(normalizeOwner))].filter((o) => o !== "");
    const repos = [...new Set([...grants.repos, ...consentedSlugs].map(normalizeSlug))].filter((r) => r !== "" && !isLocalSlug(r) && !off.has(r));
    const derived = firstSync
        ? [
            ...owners.map((value) => ({ op: "grant", kind: "owner", value })),
            ...repos.map((value) => ({ op: "grant", kind: "repo", value })),
        ]
        : [];
    return { ops: [...derived, ...grants.pending.map(wire)], named: { owners, repos } };
}
/** Cut `ops` into requests of at most 500, each carrying the whole `named` set (the server replaces it each time). */
function requestBodies(plan) {
    const bodies = [];
    const chunks = [];
    for (let i = 0; i < plan.ops.length; i += SYNC_MAX_OPS)
        chunks.push(plan.ops.slice(i, i + SYNC_MAX_OPS));
    if (chunks.length === 0)
        chunks.push([]);
    for (const ops of chunks) {
        const body = JSON.stringify({ schema: 1, ops, named: plan.named });
        if (Buffer.byteLength(body, "utf8") > SYNC_MAX_BYTES)
            return null;
        bodies.push(body);
    }
    return bodies;
}
/**
 * One sync. Reads `grants.json`, sends its `pending` queue (and, the first time, what this machine already named), and on a 200
 * records the answer:
 *   - `grants-account.json` gets the account state, with `refused` and `stale` cleared (the server has just said what it thinks);
 *   - the ops that were sent leave `pending` — exactly those, matched by value, so an op queued while the request was in flight
 *     stays.
 * Anything else leaves both files as they were.
 *
 * **NEVER THROWS**, and it is bounded by `timeoutMs` per request (3 s). `consentedSlugs` is the caller's: the slug of every clone
 * with a per-clone consent, because only the caller can afford the git spawns to know them.
 */
export async function syncGrants(ingestUrl, credential, consentedSlugs, deps) {
    try {
        const read = readGrants(deps.home);
        if (read.kind === "unreadable")
            return { kind: "unreadable" };
        const grants = read.kind === "ok" ? read.grants : EMPTY_GRANTS;
        // ⛔ "First" is decided by grants.json's own `synced_at` and never by the account file, which reads as empty when it is corrupt
        // or gone — and a re-sent first sync would re-grant whatever was revoked on another machine since.
        const plan = planSync(grants, consentedSlugs, grants.synced_at === null);
        const bodies = requestBodies(plan);
        if (bodies === null)
            return { kind: "too-large" };
        const derivedCount = plan.ops.length - grants.pending.length;
        let last = null;
        // ⛔ ONE deadline for the whole sync, shared by every chunk: a verb "never feels hung on it" (brief §2) however many
        // requests more than 500 ops make. A sync that runs out of time is `unavailable`, `pending` untouched, and the next verb
        // sends it again (every op is idempotent on the server).
        const deadline = Date.now() + (deps.timeoutMs ?? GRANTS_TIMEOUT_MS);
        for (const [index, body] of bodies.entries()) {
            const remaining = deadline - Date.now();
            if (remaining <= 0)
                return { kind: "unavailable" };
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), remaining);
            try {
                const res = await deps.fetch(grantsUrl(ingestUrl, GRANTS_SYNC_PATH), {
                    method: "POST",
                    headers: headersFor(credential, true),
                    body,
                    signal: controller.signal,
                    redirect: "error",
                });
                if (res.status === 401)
                    return { kind: "unauthorized" };
                if (res.status === 400) {
                    const from = index * SYNC_MAX_OPS;
                    const to = Math.min(plan.ops.length, from + SYNC_MAX_OPS);
                    return { kind: "rejected", pendingRejected: Math.max(0, to - Math.max(from, derivedCount)) };
                }
                if (res.status !== 200)
                    return { kind: "unavailable" };
                const json = await readCappedJson(res, controller.signal, deps.maxBodyBytes ?? MAX_ERROR_BODY_BYTES);
                const snapshot = parseSnapshot(json);
                const unsynced = json?.unsynced_machines;
                if (snapshot === null || typeof unsynced !== "number" || !Number.isSafeInteger(unsynced) || unsynced < 0) {
                    return { kind: "unavailable" };
                }
                last = { ...snapshot, unsynced };
            }
            finally {
                clearTimeout(timer);
            }
        }
        if (last === null)
            return { kind: "unavailable" };
        // The server has it. Record that: pending first (a failure there leaves the queue to be re-sent, which is idempotent),
        // then the account file.
        const sent = new Set(grants.pending.map((p) => `${p.op}\n${p.kind}\n${p.value}\n${p.at}`));
        const stamp = deps.now().toISOString();
        if (sent.size > 0 || grants.synced_at === null) {
            try {
                updateGrants(deps.home, (g) => ({
                    ...g,
                    pending: g.pending.filter((p) => !sent.has(`${p.op}\n${p.kind}\n${p.value}\n${p.at}`)),
                    // Once, on the first 200, in the same write that clears what was delivered.
                    synced_at: g.synced_at ?? stamp,
                }));
            }
            catch (error) {
                if (error instanceof GrantsUnreadableError)
                    return { kind: "unavailable" };
                throw error;
            }
        }
        const { unsynced, ...account } = last;
        writeAccountState(deps.home, {
            account: { owners: account.owners, repos: account.repos, excluded: account.excluded, epoch: account.epoch, synced_at: stamp },
            refused: [],
            stale: false,
            last_get_at: readAccountState(deps.home).last_get_at,
        });
        return { kind: "synced", unsyncedMachines: unsynced, account };
    }
    catch {
        return { kind: "unavailable" };
    }
}
/** `grant` / `revoke` are one axis (is the repo granted?) and `exclude` / `include` another (is it turned off?). */
const axisOf = (op) => (op === "grant" || op === "revoke" ? "grant" : "exclude");
/**
 * The queue after `ops` are added to it. ⛔ **A later op REPLACES an earlier one on the same axis, kind and value, and is then
 * appended** — only the last word on each axis matters, and keeping the first (the old "already queued, skip it") turned an
 * offline grant, stop, grant into `[grant, revoke]`: the server ended revoked while this machine named the repo, and every upload
 * was refused for ever. The two axes are independent, so `grant X` and `exclude X` both stay, in the order they were queued.
 * Pure: `connect`'s grant write uses it inside its own `updateGrants`, so the grants and the queue land in ONE write.
 */
export function mergePending(pending, ops, now) {
    let queued = [...pending];
    for (const op of ops) {
        const value = op.kind === "owner" ? normalizeOwner(op.value) : normalizeSlug(op.value);
        if (value === "")
            continue;
        queued = queued.filter((p) => !(axisOf(p.op) === axisOf(op.op) && p.kind === op.kind && p.value === value));
        queued.push({ op: op.op, kind: op.kind, value, at: now.toISOString() });
    }
    return queued;
}
/**
 * Queue writes for the next sync (a verb's, never a hook's: it goes through `updateGrants`). See `mergePending` for the rule.
 * Returns false — and writes nothing — if `grants.json` is unreadable.
 */
export function queueGrantOps(home, ops, now) {
    try {
        updateGrants(home, (g) => ({ ...g, pending: mergePending(g.pending, ops, now) }));
        return true;
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=grants_sync.js.map