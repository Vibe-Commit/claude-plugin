/**
 * The credential-meta sidecar — `R10` (D11 = A).
 *
 * `{ [fingerprint]: { expires_at, credential_id, org_id, account, seen_at } }` at
 * `~/.vibecommit/state/credential-meta.json`, keyed by `credentialFingerprint` — the same key the
 * `fatal` stop uses — so a pasted credential, a minted one and `VIBECOMMIT_TOKEN` all get the same
 * facts.
 *
 * ⛔ NOTHING HERE CAN BREAK A HOOK OR A VERB. A missing, unreadable or corrupt file reads as "no
 * metadata" and the caller falls back to today's generic copy; a failed write returns false and the
 * caller carries on. The file is never the secret file: it holds an expiry and an id, not a token.
 *
 * Written atomically (temp + rename, 0600). Entries whose fingerprint is not in `keep` are pruned
 * on every write, so a replaced credential's facts do not outlive it.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { writeFileAtomic } from "./atomic_write.js";
import { loadCredential } from "./credential.js";
import { credentialMetaPath, stateDir } from "./paths.js";
import { credentialFingerprint } from "./post.js";
const str = (v) => (typeof v === "string" && v !== "" ? v : null);
/** One entry, or null when it is not shaped like one. A bad entry is dropped, not repaired. */
function parseMeta(raw) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
        return null;
    const o = raw;
    const seen = str(o.seen_at);
    if (seen === null)
        return null;
    return {
        expires_at: str(o.expires_at),
        credential_id: str(o.credential_id),
        org_id: str(o.org_id),
        account: str(o.account),
        seen_at: seen,
    };
}
/** Every entry that parses. `{}` for a missing, unreadable or corrupt file. */
export function readCredentialMeta(home) {
    let doc;
    try {
        doc = JSON.parse(readFileSync(credentialMetaPath(home), "utf8"));
    }
    catch {
        return {};
    }
    if (typeof doc !== "object" || doc === null || Array.isArray(doc))
        return {};
    const out = {};
    for (const [fingerprint, raw] of Object.entries(doc)) {
        const meta = parseMeta(raw);
        if (meta !== null)
            out[fingerprint] = meta;
    }
    return out;
}
export function metaFor(home, fingerprint) {
    return readCredentialMeta(home)[fingerprint] ?? null;
}
/**
 * Record what the server said about `fingerprint`, and prune every entry that is neither it nor in
 * `keep`. Returns whether the write landed; never throws.
 */
export function recordCredentialMeta(home, fingerprint, meta, keep = []) {
    try {
        const kept = new Set([fingerprint, ...keep]);
        const next = {};
        for (const [fp, existing] of Object.entries(readCredentialMeta(home))) {
            if (kept.has(fp))
                next[fp] = existing;
        }
        next[fingerprint] = meta;
        mkdirSync(stateDir(home), { recursive: true, mode: 0o700 });
        writeFileAtomic(credentialMetaPath(home), `${JSON.stringify(next, null, 2)}\n`, 0o600);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Fingerprints of the credentials this machine would load right now — the env one and the file one.
 * The `keep` set for `recordCredentialMeta`: everything else is a credential that was replaced.
 */
export function loadedFingerprints(home, env) {
    const out = [];
    for (const e of [env, {}]) {
        const load = loadCredential({ env: e, home });
        if (load.kind === "ok")
            out.push(credentialFingerprint(load.credential));
    }
    return out;
}
// ---------------------------------------------------------------------------
// `CR-234d` (D219, plan item 6, decision 12A): where a credential stands against its cap.
// ---------------------------------------------------------------------------
/** From this long before the end, the machine says so (state 5, `status`). */
export const CREDENTIAL_ENDING_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
/** Re-write an UNCHANGED expiry no more than once a day; the hook runs every turn. */
const META_REFRESH_MS = 24 * 60 * 60 * 1000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/**
 * `22 Oct 2027` — an ABSOLUTE date, in UTC, in English month names. UTC and not local for the same reason
 * `utcDay` is: a local date moves with the machine's timezone, so two sessions on one machine could name
 * different days; and a fixed table because `toLocaleDateString` varies with the host's locale.
 */
export function endDateText(iso) {
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms))
        return null;
    const d = new Date(ms);
    return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
/**
 * The end date when this credential is within `CREDENTIAL_ENDING_WINDOW_MS` of it and has not already
 * passed, else null.
 *
 * ⚠ Why "within 14 days of `expires_at`" is the cap and not just idleness: the server extends `expires_at`
 * to `now + 90 days` on a successful ingest (at most daily) and clamps it to the 365-day cap, and the header
 * this was read from rides a 2xx. A credential that just captured therefore reports an end under 14 days
 * away ONLY when the cap is what is limiting it. A date already in the past is not an "ends" — that
 * credential is refused and state 2 speaks for it.
 */
export function endingSoon(meta, nowMs) {
    const iso = meta?.expires_at ?? null;
    if (iso === null)
        return null;
    const end = Date.parse(iso);
    if (!Number.isFinite(end) || end <= nowMs || end - nowMs > CREDENTIAL_ENDING_WINDOW_MS)
        return null;
    return iso;
}
/**
 * The hook heard `X-Credential-Expires` on a 2xx: remember it in the sidecar. Best effort — a hook never
 * fails on this, and ⛔ NEVER touches `credentials.json` (R10): a hook holding the old token must not be
 * able to put it back after a re-auth. Returns the entry as it now stands, or null if there is none.
 *
 * The other facts (id, org, account) are kept as they were; a credential never seen by `connect`/`whoami`
 * gets nulls for them, which is exactly "unknown". An unchanged expiry is not re-written more than daily.
 */
export function noteCredentialExpiry(home, env, fingerprint, expiresAt, now) {
    try {
        if (!Number.isFinite(Date.parse(expiresAt)))
            return null;
        const existing = metaFor(home, fingerprint);
        if (existing !== null &&
            existing.expires_at === expiresAt &&
            now.getTime() - Date.parse(existing.seen_at) < META_REFRESH_MS) {
            return existing;
        }
        const next = {
            expires_at: expiresAt,
            credential_id: existing?.credential_id ?? null,
            org_id: existing?.org_id ?? null,
            account: existing?.account ?? null,
            seen_at: now.toISOString(),
        };
        return recordCredentialMeta(home, fingerprint, next, loadedFingerprints(home, env)) ? next : existing;
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=credential_meta.js.map