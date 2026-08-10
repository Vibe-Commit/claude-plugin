/**
 * Where the failure policy's decisions are remembered — CR-018.
 *
 * `policy.ts` decides; this module persists. The split is what keeps every
 * classification and both backlog caps testable without a filesystem.
 *
 * ## The binding key — `CR-017d`
 *
 * `(repoKey, sessionId)`, and the repo half is REQUIRED. `CR-018` shipped this
 * module keyed on the session alone, deliberately and one dimension short; D58
 * names what that costs: *"The server key gains repo; the client offset state did
 * not, so a `prefix_sha256` resync would duplicate repo 1's turns into repo 2."*
 * The key lives in the path (`sessionStatePath`, which refuses to produce one
 * without a repo), so there is no bucket for a caller that cannot say which repo
 * it is in. `files` is untouched — it is already keyed by `FileKey`, which is the
 * `file_key` of the server's four-column key.
 *
 * What `CR-018` needed, and the only reason this module exists a wave early, is
 * that its three classes are *defined* in terms of an offset: `later` holds one,
 * `never` advances one, and neither means anything without somewhere to keep it.
 * `CR-016` left a bootstrap that re-sent from byte 0 every time and said,
 * correctly, not to build a backlog policy on that. This is the alternative it was
 * pointing at, kept as thin as the policy allows.
 *
 * ## Failure posture
 *
 * Every read failure yields the empty state. That direction is a RESYNC — the
 * client re-sends from offset 0 and the server is idempotent on
 * `(repo, session, offset)` — rather than a silent skip, which would be data
 * loss. The one thing lost with it is a recorded `fatal` stop, and a revoked
 * credential simply 401s again on the next attempt and re-stops.
 *
 * Two hooks racing in one session can lose an update to each other. The
 * consequence is a re-send from a stale offset, which the server treats as a
 * resync — so this is left unlocked rather than paying for a lockfile on the
 * hook's wall-clock budget.
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { sessionStatePath } from "./paths.js";
import { EMPTY_FILE_STATE } from "./policy.js";
export const EMPTY_SESSION_STATE = { seq: 0, stop: null, files: {} };
export function loadSessionState(home, key) {
    const path = sessionStatePath(home, key);
    // No repo, no key, no read. Falling back to a session-only file here is the
    // whole of D58: it is the one path on which two repos share an offset ledger.
    if (path === null)
        return EMPTY_SESSION_STATE;
    let raw;
    try {
        raw = readFileSync(path, "utf8");
    }
    catch {
        return EMPTY_SESSION_STATE;
    }
    try {
        return parseSessionState(JSON.parse(raw));
    }
    catch {
        return EMPTY_SESSION_STATE;
    }
}
/** Persist. Returns false on any failure — the caller must not throw from a hook. */
export function saveSessionState(home, key, next) {
    const path = sessionStatePath(home, key);
    // Refusing to write is safe in the direction this module already fails: the
    // next invocation resyncs from 0. Writing under a placeholder key is not.
    if (path === null)
        return false;
    try {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        writeFileSync(path, `${JSON.stringify(next)}\n`, { mode: 0o600 });
        // `writeFileSync`'s `mode` is ignored when the file already exists.
        chmodSync(path, 0o600);
        return true;
    }
    catch {
        return false;
    }
}
export function fileState(session, fileKey) {
    return session.files[fileKey] ?? EMPTY_FILE_STATE;
}
export function withFileState(session, fileKey, next) {
    return { ...session, files: { ...session.files, [fileKey]: next } };
}
/**
 * Is this session stopped for THIS credential?
 *
 * A stop recorded against a different fingerprint does not apply: that is the
 * user having reconnected.
 */
export function isStopped(session, fingerprint) {
    return session.stop !== null && session.stop.fingerprint === fingerprint;
}
/**
 * Read back a persisted state defensively.
 *
 * Hand-written rather than trusted, for the same reason `consent.ts` validates
 * its allow list: this file lives in the user's home, is edited by nothing but
 * us, and would still be believed if something else wrote nonsense into it. A
 * bogus `sentOffset` would silently skip real turns.
 */
function parseSessionState(parsed) {
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        return EMPTY_SESSION_STATE;
    }
    const o = parsed;
    const files = {};
    const rawFiles = o.files;
    if (rawFiles !== null && typeof rawFiles === "object" && !Array.isArray(rawFiles)) {
        for (const [key, value] of Object.entries(rawFiles)) {
            const state = parseFileState(value);
            if (state !== null)
                files[key] = state;
        }
    }
    return { seq: nonNegative(o.seq), stop: parseStop(o.stop), files };
}
function parseStop(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        return null;
    const o = value;
    if (typeof o.at !== "string" || typeof o.fingerprint !== "string")
        return null;
    if (o.fingerprint === "")
        return null;
    return { at: o.at, fingerprint: o.fingerprint };
}
function parseFileState(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        return null;
    const o = value;
    const sentOffset = nonNegative(o.sentOffset);
    const backlog = [];
    if (Array.isArray(o.backlog)) {
        let cursor = sentOffset;
        for (const entry of o.backlog) {
            if (entry === null || typeof entry !== "object" || Array.isArray(entry))
                continue;
            const e = entry;
            const from = nonNegative(e.from);
            const to = nonNegative(e.to);
            const at = nonNegative(e.at);
            // Contiguity is an invariant of the writer, so a file that breaks it has
            // been tampered with or half-written. Stop at the break rather than trust
            // the rest: a non-contiguous backlog makes `pendingBytes` a fiction.
            if (from !== cursor || to <= from)
                break;
            backlog.push({ from, to, at });
            cursor = to;
        }
    }
    return {
        sentOffset,
        backlog,
        gapBytes: nonNegative(o.gapBytes),
        gapCount: nonNegative(o.gapCount),
    };
}
function nonNegative(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0
        ? Math.floor(value)
        : 0;
}
//# sourceMappingURL=state.js.map