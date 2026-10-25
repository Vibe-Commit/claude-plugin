/**
 * The ingest request — the ONE place the credential's plaintext is used.
 *
 * `send()` still makes exactly one attempt and decides nothing; `deliver()`, at
 * the bottom of this file, is `CR-018`'s application of the failure policy around
 * it. The classification itself is data in `policy.ts` and the ledger is in
 * `state.ts`, so what lives here is only the wiring between them and the wire.
 *
 * `X-Repo-Slug` is derived in `git.ts` (`CR-019d`) and arrives here already
 * resolved. It is REQUIRED on the wire: the merged server 400s a request without
 * it, deliberately, because a NULL `repository_id` is fail-closed-INVISIBLE
 * rather than merely wrong (D57 §OV1).
 *
 * Wire shape retyped from the plan and from reading the closed-source server. No
 * code is imported or copied from `vibecommit-mcp` (D60 §D1a): this package is
 * MIT, and lifting closed code into it relicenses that code by accident.
 *
 * @provenance vibecommit-mcp src/conversation/ingest_session.ts — wire shape, retyped
 */
import { createHash } from "node:crypto";
import { agentForTranscript } from "./agents/registry.js";
import { UNKNOWN_AGENT_ID } from "./agents/types.js";
import { noteGrantEpoch, recordRefused } from "./consent.js";
import { headerSafe, sessionIdSafe } from "./header_safety.js";
import { recordInferredSkipped } from "./inferred_tally.js";
import { clearOrgPending, markOrgPending } from "./org_pending.js";
import { MAX_DELTA_FRAME_BYTES, MAX_DELTA_RAW_BYTES, REPOSITORY_EXCLUDED, classify, markDelivered, markHeld, markSkipped, nextSpan, planChunk, resolveCaps, splitPoint, } from "./policy.js";
import { fileState, isStopped, loadSessionState, saveSessionState, withFileState, } from "./state.js";
import { INFERRED_SET_ASIDE_AFTER, dropInferredGroups, dropRewrites, dropSpooled, isFullSha, recordInferredAttempt, setAsideInferredGroup, settleSpooled, } from "./spool.js";
import { CLIENT_VERSION, CLIENT_VERSION_HEADER } from "./version.js";
/** Production data plane. Overridable for tests and for a self-hosted server. */
export const DEFAULT_INGEST_URL = "https://api.vibecommit.ai/ingest/v1/session";
/**
 * Loopback hosts, the only place a plaintext ingest URL is tolerated.
 * The contract test needs `http://127.0.0.1:<port>`; nothing else does.
 */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);
/**
 * `/cso` finding 2 (2026-08-09), MEDIUM. The override used to be passed to
 * `fetch` unexamined, so `http://` put `Authorization: Bearer vcik_…` on the
 * wire in cleartext — and the ingest credential is long-lived with no rotation
 * by design, so one interception is a durable compromise rather than a
 * 15-minute one.
 */
export function isAllowedIngestUrl(raw) {
    let url;
    try {
        url = new URL(raw);
    }
    catch {
        return false;
    }
    if (url.protocol === "https:")
        return true;
    return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
}
/** The ingest URL, or null when the override is one we refuse to send to. */
export function ingestUrl(env) {
    const override = env.VIBECOMMIT_INGEST_URL;
    if (override === undefined || override.trim() === "")
        return DEFAULT_INGEST_URL;
    const candidate = override.trim();
    return isAllowedIngestUrl(candidate) ? candidate : null;
}
/**
 * `parseObservedHead`'s upper bound on `X-Head-Branch`, mirrored here — `TODOS[182]`.
 *
 * Duplicating the server's constant is deliberate, the same reason `git.ts`'s
 * `SLUG_MAX` duplicates `REPO_SLUG_MAX`: this module cannot import across the
 * repo boundary, and the alternative is a 431 in the field instead of an
 * omission here. The server nulls, never truncates, a branch over this bound
 * — it has a matching check of its own one layer further down, is why.
 *
 * @provenance vibecommit-mcp src/conversation/ingest_session.ts — `parseObservedHead`,
 * `trimmed.length > 255 ? null : trimmed`, read
 */
const MAX_HEAD_BRANCH_LENGTH = 255;
/**
 * Build the request headers.
 *
 * `expose()` is called here and in no other module. That is the point of the
 * opaque wrapper: the single call site is greppable, reviewable, and sits at the
 * boundary where the secret has to be plaintext anyway.
 *
 * ## ⛔ SHAs ON THE WIRE, NEVER COMMIT METADATA (`CR-170` §4)
 *
 * No message, no author, no dates. MEASURED over the last 20 commits per repo:
 * **9/20 schema, 8/20 web and 5/20 capture exceed 4096 bytes, largest 12,112** —
 * so a quarter of real commits would land PERMANENTLY TRUNCATED in a header, and
 * `capture_commits` rows cannot be retracted. Metadata is backfillable from a
 * sha by anyone holding the repository; the observation that a commit happened
 * at all is not. So the wire carries the irreplaceable half.
 */
export function buildIngestHeaders(credential, delta) {
    const headers = {
        authorization: `Bearer ${credential.expose()}`,
        "content-type": "application/x-ndjson",
        "content-encoding": "zstd",
        "x-session-id": delta.sessionId,
        "x-seq": String(delta.seq),
        "x-byte-offset": String(delta.byteOffset),
        "x-file": delta.fileKey,
        "x-repo-slug": delta.repoSlug,
        [CLIENT_VERSION_HEADER.toLowerCase()]: CLIENT_VERSION,
    };
    // ⛔ OMITTED ON `unknown`, AND THE OMISSION IS THE POINT — not a tidier way of
    // saying the same thing.
    //
    // The server keeps ABSENT and `unknown` apart deliberately, and its own
    // comment says the header's parsed type is nullable *because* of this guard:
    // an absent header leaves a stream's pinned agent alone, while a PRESENT
    // header resolves and is compared — and `unknown` resolves to `unknown`, which
    // disagrees with any non-`unknown` pin. That disagreement is not a rejection;
    // it drops the stream's buffered `tail_records` and re-pins, which SHEDS THE
    // IN-FLIGHT TURN (D164 §4's mismatch-as-rewind).
    //
    // ⛔ So sending `unknown` would manufacture exactly the disagreement the
    // nullable type exists to prevent. A stream that resolves cleanly on delta 1
    // and becomes ambiguous later — a second root appearing, an env var set in one
    // shell and not the next, a symlink flipped — would shed a turn on every flip.
    // Omitting cannot: it says nothing, and nothing cannot disagree.
    //
    // ⚠ **NOT "silently", and the correction is worth its line**: the server
    // ECHOES `agent_rewind` in the ingest 200 body (D169 §1), so the RE-PIN is
    // reported. What is NOT reported is the shed itself. ⚠ And nothing on this
    // side reads either — on the hook path `send()` parses a body only on a
    // non-2xx (`connect` alone opts in to one 2xx field, `conversation_id`, and
    // reads nothing else from it). So the case
    // against sending rests on the turn being LOST, not on the loss being
    // invisible; a designed, reported rewind (D164 §4) is survivable, and this
    // client would simply be causing them for no gain.
    //
    // ⚠ On a genuinely ambiguous FIRST delta the two are indistinguishable — the
    // bind writes `unknown` either way. There is no case where sending wins, and
    // one class where it loses, so the header is conditional.
    //
    // This is also this function's existing idiom, four lines below: OMITTED,
    // never sent empty; an absent header is unambiguously "nothing to say".
    if (delta.agent !== UNKNOWN_AGENT_ID)
        headers["x-agent"] = delta.agent;
    // Omitted, never sent as `0`: the server reads the exact token `1` and nothing else.
    if (delta.final === true)
        headers["x-session-final"] = "1";
    // ⚠ OMITTED, never sent empty. A blank header is a value the server has to
    // have an opinion about; an absent one is unambiguously "nothing to say", and
    // an empty repository genuinely has nothing to say here.
    //
    // ⛔⛔ `TODOS[182]` — OMITTED, NEVER TRUNCATED, above `MAX_HEAD_BRANCH_LENGTH`
    // or on an unsendable byte. The server already nulls a branch over its own
    // 255-char limit (`parseObservedHead`, mirrored below) and takes the existing
    // detached-HEAD path for it — no ref move, `last_head_sha` untouched — so
    // omitting here changes nothing downstream; a TRUNCATED prefix could
    // coincidentally equal a different, real, SHORTER branch and mint a wrong,
    // PERMANENT `repository_ref_moves` row (`reject_history_mutation` refuses an
    // UPDATE). And a branch is the one field in this function built from
    // arbitrary git ref bytes rather than a wire-fixed shape, so it is the one
    // that needs `headerSafe`: a character above U+00FF or a bare LF/CR here
    // throws the SAME `TypeError` a real network outage does (`header_safety.ts`),
    // and the 255 cap alone does not catch `功能/登录` (13 bytes).
    if (delta.head != null) {
        headers["x-head-sha"] = delta.head.sha;
        const branch = delta.head.branch;
        if (branch !== null && branch.length <= MAX_HEAD_BRANCH_LENGTH && headerSafe(branch)) {
            headers["x-head-branch"] = branch;
        }
    }
    // ⛔⛔ THE WIRE CONTRACT, AND EVERY WAY OF GETTING IT WRONG IS SILENT IN BOTH
    // DIRECTIONS (`D190`). Three header names and two separators, agreed between
    // two repositories with NO COMPILER, NO SCHEMA AND NO SHARED TYPE spanning the
    // seam. Name it `x-commit-attribution` (singular), join with `;`, or emit the
    // pairs as `ancestor,successor`, and you get a green client suite, a green
    // server suite, a 200 response, and ZERO EDGES FOREVER. Nothing goes red
    // anywhere. `test/wire-attribution.test.ts` types these literals a second time
    // rather than importing them, because a cell that round-trips this code's own
    // constant proves only that it equals itself.
    //
    // ⛔ THE TWO LISTS ARE SENT TOGETHER OR NOT AT ALL, AND THEY ARE THE SAME
    // LENGTH. `parseObservedCommits` returns `[]` — the ENTIRE BATCH, not the odd
    // entry — when `rungs.length !== shas.length`. `capSpool` builds them in one
    // loop so they cannot disagree; this line refuses to send them if they somehow
    // do, because a batch dropped server-side is invisible and a batch not sent is
    // retried by the next hook.
    //
    // ⚠ NO RUNG, NO EDGE (`D190 §2`) is why the guard is a REFUSAL rather than a
    // fallback to `x-commits` alone: the server treats a commit with no attribution
    // as a PRE-LADDER client's mtime guess and writes nothing, so sending the shas
    // bare would be a slower road to the same zero, with a spool truncated on the
    // 2xx as though it had worked.
    const observed = delta.commits;
    if (observed !== undefined && observed.shas.length > 0) {
        if (observed.shas.length === observed.attributions.length) {
            headers["x-commits"] = observed.shas.join(",");
            headers["x-commit-attributions"] = observed.attributions.join(",");
        }
    }
    // ⚠ Same idiom as every other conditional header here: OMITTED, never sent
    // empty. `parseRewritePairs` drops silently on a wrong separator, a third
    // colon-field, a bad sha or a self-pair, so the spelling is fixed by
    // `capSuccessors` and asserted literally by the wire cell.
    if (delta.rewrites !== undefined && delta.rewrites.length > 0) {
        headers["x-rewrites"] = delta.rewrites.join(",");
    }
    // `TODOS[177]` — same idiom: OMITTED, never sent empty; the spelling is fixed by `capInferred`.
    if (delta.inferredRewrites !== undefined && delta.inferredRewrites.length > 0) {
        headers["x-rewrites-inferred"] = delta.inferredRewrites.join(",");
    }
    return headers;
}
/**
 * ⛔⛔ `TODOS[182]` — THE FIVE, AND EXACTLY THE FIVE. `lean` is defined by
 * SUBTRACTION from this set, never by an allow-list: an earlier draft of this
 * fix hand-picked which headers to KEEP and silently dropped `content-type` /
 * `content-encoding` (the server could no longer parse the zstd body) and
 * `x-agent` (a lean FIRST delta would pin `unknown` forever under STICKY
 * `lean` — `UNKNOWN_AGENT_ID`'s own docblock above). A deny-list fails SAFE:
 * anything not named here defaults to "stays", and the only headers worth
 * dropping are the ones whose SIZE is unbounded by a count cap — a branch name
 * and the four list headers. `leanHeaders` is tested by SET EQUALITY against
 * `buildIngestHeaders`'s full output, never by eyeballing an allow-list.
 */
export const LEAN_OMIT_HEADERS = new Set([
    "x-head-branch",
    "x-commits",
    "x-commit-attributions",
    "x-rewrites",
    "x-rewrites-inferred",
]);
/**
 * The lean (deny-list) reduction of a full header set — `TODOS[182]`.
 *
 * Takes the FULL object `buildIngestHeaders` would already build from the real
 * delta — real branch, real commits, real rewrites — and removes exactly
 * `LEAN_OMIT_HEADERS`. Never built the other way around (a delta with its
 * list fields pre-blanked): that would make "lean" whatever
 * `buildIngestHeaders`'s conditionals happen to gate on today, which is the
 * allow-list failure mode this function exists to avoid repeating.
 */
function leanHeaders(full) {
    const reduced = {};
    for (const [name, value] of Object.entries(full)) {
        if (!LEAN_OMIT_HEADERS.has(name))
            reduced[name] = value;
    }
    return reduced;
}
/**
 * The first header whose value fails the shared predicate, or `null` if every
 * one is sendable — `TODOS[182]`.
 *
 * `x-head-branch` can never be the header this returns: `buildIngestHeaders`
 * already omits it unless it is both within `MAX_HEAD_BRANCH_LENGTH` and
 * `headerSafe`. So anything this function still finds, by elimination, is one
 * of the REQUIRED headers — there is no second optional one to drop.
 */
function firstUnsafeHeader(headers) {
    for (const [name, value] of Object.entries(headers)) {
        if (!headerSafe(value))
            return name;
    }
    return null;
}
/**
 * The backstop (`TODOS[182]`, step 4 of the design): `new Headers()` in its
 * own try, after the explicit predicate already passed, before `fetch` ever
 * sees the object. Never the primary check — see `header_safety.ts`.
 */
function headersConstructible(headers) {
    try {
        new Headers(headers);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * The wire's error code for org-approval-pending — `CR-128`, D81.
 *
 * ⚠ A CROSS-REPO CONTRACT, not a local string. The server emits it as
 * `403 { error: "capture_not_approved", owners_notified }` and pins the body
 * shape in its own suite. **`repository_forbidden` is ALSO a 403** and carries
 * no `owners_notified` at all — deliberately, because it is a different
 * condition where no owner was or could have been notified. That is why every
 * consumer here branches on THIS CODE and never on the status.
 */
export const CAPTURE_NOT_APPROVED = "capture_not_approved";
/**
 * An error body is a handful of bytes by contract. Anything larger is not one
 * this client parses — a cap so a misconfigured or hostile endpoint cannot make
 * a hook buffer an arbitrary response into memory.
 */
export const MAX_ERROR_BODY_BYTES = 64 * 1024;
/**
 * Parse an error body, or return null. **NEVER THROWS, on any input.**
 *
 * That is a hard requirement rather than defensive habit: `deliver()` is the
 * HOOK's path, `post.ts` states that an exception there is the contract
 * breaking, and `JSON.parse` on a response body is an exception waiting for a
 * bad day. Every failure — a non-JSON body, an empty body, an array, a body
 * whose `error` is not a string — resolves to `null`, and `null` sends the
 * caller to the branch that asserts nothing. That is the honest default,
 * because `null` already means *not determinable*.
 *
 * ⚠ Read ONLY on a non-2xx. On the hook path an INGEST reply's 2xx body is not read, not
 * awaited, and not parsed, so the hook's hot path is untouched. `connect`
 * opts in to reading ONE field of a 2xx body through `readConversationId`
 * below; nothing else ever calls that. (Slice 2: SessionStart's one bounded GET of the
 * account's grants reads a 2xx body too, through `readCappedJson` in `fetchAccountGrants` —
 * a separate request, once an hour at most, never on an ingest reply.)
 */
async function readErrorDetail(res, signal) {
    if (res.ok)
        return null;
    // Bounded in BYTES (declared or streamed) and in TIME (raced against `signal`) by `readCappedJson`.
    const body = await readCappedJson(res, signal);
    if (body === null || body === undefined || typeof body !== "object" || Array.isArray(body))
        return null;
    const { error, owners_notified: owners } = body;
    if (typeof error !== "string" || error === "")
        return null;
    // The key is absent (`undefined`) on bodies that do not carry it, `null` when
    // it is present and not determinable. Both are preserved; neither is coerced
    // into a number, because a count invented here is a claim invented here.
    const ownersNotified = owners === null ? null : typeof owners === "number" && Number.isFinite(owners) ? owners : undefined;
    return { code: error, ownersNotified };
}
/**
 * ⛔ THE ONE CAPPED, TIMED BODY READER — `readErrorDetail` (non-2xx), `readConversationId` (`connect`'s opt-in
 * 2xx) and `grants_sync.ts`'s two grants reads all read through it, so no bound can drift from another.
 *
 * Returns the parsed JSON (which may legitimately be `null`, an array or a scalar — the caller shapes it), or
 * `undefined` for EVERY failure: no body, a declared length over the cap, a streamed body that crosses the cap,
 * an abort, a stalled or reset stream, invalid JSON. **NEVER THROWS, on any input.**
 *
 *   - BYTES: the declared `content-length` is checked first, and the stream is then counted chunk by chunk and
 *     CANCELLED the moment it crosses `maxBytes` (`MAX_ERROR_BODY_BYTES`, 64 KiB, unless a CLI verb asks for more) — so a chunked body with no length cannot be
 *     buffered whole before a post-hoc check (the old `await res.text()` did exactly that, contradicting
 *     `readErrorDetail`'s own comment that a hostile endpoint cannot make a hook buffer an arbitrary response).
 *   - TIME: every read is RACED against the request's abort signal rather than trusting the abort to reach the
 *     stream. Aborting is supposed to reject a pending `reader.read()` (it does, in a direct probe), but the
 *     bound is then a property of this function and not of the HTTP client's internals.
 */
export async function readCappedJson(res, signal, maxBytes = MAX_ERROR_BODY_BYTES) {
    if (res.body === null)
        return undefined;
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > maxBytes)
        return undefined;
    const reader = res.body.getReader();
    let onAbort;
    const aborted = new Promise((_resolve, reject) => {
        onAbort = () => reject(new Error("aborted"));
        if (signal.aborted)
            onAbort();
        else
            signal.addEventListener("abort", onAbort, { once: true });
    });
    aborted.catch(() => undefined);
    try {
        const chunks = [];
        let size = 0;
        for (;;) {
            const { done, value } = await Promise.race([reader.read(), aborted]);
            if (done)
                break;
            size += value.byteLength;
            if (size > maxBytes) {
                // Not awaited: a cancel on a stalled stream is the other thing that may never settle.
                reader.cancel().catch(() => undefined);
                return undefined;
            }
            chunks.push(value);
        }
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    }
    catch {
        reader.cancel().catch(() => undefined);
        return undefined;
    }
    finally {
        if (onAbort !== undefined)
            signal.removeEventListener("abort", onAbort);
    }
}
/** A UUID, any version. The only shape `conversation_id` is believed in, so nothing else reaches a terminal. */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * ⭐ `conversation_id` from a 2xx body, for `connect`'s session link — or `undefined`.
 * **NEVER THROWS, on any input, and never changes the outcome.**
 *
 * ⛔ **ONLY `connect` CALLS THIS** (`SendOptions.readConversationId`, eng-2 D2 = A). The hook's
 * hot path never reads an ingest reply's 2xx body — that property is why it cannot stall or throw on one —
 * and an unconditional read here would put a new wait and a new failure point on the hook that
 * runs after every turn, to serve a line only `connect` prints. (The one 2xx body a hook does read is
 * SessionStart's GET of the account's grants — a different request, bounded at 1,000 ms and 64 KiB.)
 *
 * Reads through `readCappedJson`, the same capped, signal-raced reader `readErrorDetail` uses, so the byte
 * and time bounds are one definition. A stalled or reset body reads as "no id": the 2xx stays a 2xx.
 * Only a UUID-shaped string is believed, which also keeps a terminal escape sequence out.
 */
async function readConversationId(res, signal) {
    if (!res.ok)
        return undefined;
    const body = await readCappedJson(res, signal);
    if (body === null || body === undefined || typeof body !== "object" || Array.isArray(body))
        return undefined;
    const id = body.conversation_id;
    return typeof id === "string" && UUID_SHAPE.test(id) ? id.toLowerCase() : undefined;
}
/**
 * `X-Commits-Retry` → the shas to keep, or `null` when the header is absent.
 * **NEVER THROWS** — the same hot-path property `readErrorDetail` keeps. Only
 * full-width shas survive: anything else could never match a spool line.
 */
function parseCommitsRetry(raw) {
    if (raw === null)
        return null;
    return raw
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter((s) => isFullSha(s));
}
/**
 * `X-Grant-Epoch`: a non-negative integer, or null. Digits only (and a sane length), so a header that is not one reads as
 * "the server did not say" and never as `NaN`, a negative, or a float that could equal nothing.
 */
export function parseGrantEpoch(raw) {
    if (raw === null)
        return null;
    const value = raw.trim();
    if (!/^\d{1,15}$/.test(value))
        return null;
    return Number(value);
}
/**
 * `X-Credential-Expires`: an ISO 8601 instant, or null. Only a string that parses as a date is believed —
 * the value is printed (as a date) to a person and compared against the clock, so a header that is not one
 * must read as "the server did not say", never as a date in 1970.
 */
export function parseCredentialExpires(raw) {
    if (raw === null)
        return null;
    const value = raw.trim();
    if (!/^\d{4}-\d{2}-\d{2}T/.test(value))
        return null;
    return Number.isFinite(Date.parse(value)) ? value : null;
}
/** `X-Rewrites-Inferred-Stored` → a non-negative integer, or `null` for absent/malformed. NEVER THROWS. */
function parseInferredStored(raw) {
    if (raw === null)
        return null;
    const n = Number(raw.trim());
    return Number.isInteger(n) && n >= 0 ? n : null;
}
export async function send(url, headers, body, timeoutMs, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, {
            method: "POST",
            headers,
            body,
            signal: controller.signal,
            // `/cso` finding 2. undici strips Authorization on a cross-origin
            // redirect, so following one is not a live hole — but a POST carrying a
            // bearer token has no business chasing a hop the operator did not
            // configure, and an ingest endpoint has no reason to issue one.
            redirect: "error",
        });
        // The body read happens INSIDE the try and BEFORE the timer is cleared, so
        // the same `AbortController` that bounds the request also bounds the read.
        // A slow body cannot outlive the hook's wall-clock budget.
        //
        // ⛔ THE 2xx READ IS OPT-IN AND HAS ITS OWN `try` (inside `readConversationId`): bare in this
        // one, a stalled or reset body would throw to the `catch` below and turn a DELIVERED 2xx into
        // `unreachable` — `later`, offset held, span sent again.
        const conversationId = options.readConversationId === true ? await readConversationId(res, controller.signal) : undefined;
        return {
            kind: "response",
            status: res.status,
            detail: await readErrorDetail(res, controller.signal),
            ...(conversationId === undefined ? {} : { conversationId }),
            // `null` when the server does not send it at all — see `captureId` above.
            captureId: res.headers.get("x-capture-id"),
            commitsRetry: parseCommitsRetry(res.headers.get("x-commits-retry")),
            finalAck: parseFinalAck(res.headers.get("x-session-final")),
            inferredStored: parseInferredStored(res.headers.get("x-rewrites-inferred-stored")),
            credentialExpires: parseCredentialExpires(res.headers.get("x-credential-expires")),
            grantEpoch: parseGrantEpoch(res.headers.get("x-grant-epoch")),
        };
    }
    catch {
        return { kind: "unreachable" };
    }
    finally {
        clearTimeout(timer);
    }
}
// ---------------------------------------------------------------------------
// CR-018 — one attempt, classified, with the matching action applied.
// ---------------------------------------------------------------------------
/**
 * A one-way digest of the credential, for the `fatal` stop's key.
 *
 * The second and last call to `expose()` in the package, kept in this module for
 * the same reason as the first: the plaintext's exits are greppable in one file.
 * What is stored is 16 hex characters of a SHA-256 over a high-entropy opaque
 * token — enough to tell one credential from another, and not a preimage of
 * anything. No copy path and no header ever carries it.
 */
export function credentialFingerprint(credential) {
    return createHash("sha256").update(credential.expose()).digest("hex").slice(0, 16);
}
/** Only the three values the server defines; anything else is "no acknowledgement". */
function parseFinalAck(raw) {
    const v = raw?.trim().toLowerCase();
    return v === "sealed" || v === "already" || v === "refused" ? v : null;
}
/**
 * PR 4a — below this much remaining hook budget, do not START another delta. The same floor the sub-agent loop uses
 * (`MIN_SUBAGENT_BUDGET_MS`, `hooks/entry.ts`), for the same reason: a request that small can only time out.
 */
const MIN_NEXT_DELTA_BUDGET_MS = 400;
/** The floor under one attempt's timeout once the hook budget is nearly or fully spent — `MIN_SEND_TIMEOUT_MS` in `hooks/entry.ts`. */
const MIN_ATTEMPT_TIMEOUT_MS = 50;
/** The share of what is left one further attempt may take — `SEND_BUDGET_FRACTION`'s value in `hooks/entry.ts`. */
const NEXT_DELTA_BUDGET_FRACTION = 0.6;
/**
 * Build the delta, reduce it to the deny-list set when `lean`, validate every
 * resulting header value, and only then call `send()` — `TODOS[182]`.
 *
 * `x-head-branch` can never be the `header` an "unsafe" result names:
 * `buildIngestHeaders` already omits it unless it is both within
 * `MAX_HEAD_BRANCH_LENGTH` and `headerSafe`. So a `header-unsafe` result here,
 * by elimination, always names a REQUIRED header — there is no second
 * optional one for the caller to drop.
 */
async function attemptSend(ctx, agent, seq, span, body, lean, 
// PR 4a. ⛔ ONLY THE DELTA THAT ENDS AT EOF CARRIES THE SESSION-LEVEL HEADERS. `X-Session-Final` seals the open turn, and
// sealing before the rest of the span has arrived would seal a poorer turn (`finalize.ts`'s docblock). The commits,
// rewrites and head describe the END of the session, and `capture_commits`' PK admits one row per (capture, sha), so they
// ride on one delta and not on every one. A delta that is not the last sends none of them, and the spool keeps them.
isLast = true) {
    const full = buildIngestHeaders(ctx.credential, {
        sessionId: ctx.sessionId,
        seq,
        byteOffset: span.from,
        fileKey: ctx.fileKey,
        repoSlug: ctx.repoSlug,
        agent,
        final: ctx.final === true && isLast,
        head: isLast ? ctx.head : undefined,
        commits: isLast ? ctx.commits : undefined,
        rewrites: isLast ? ctx.rewrites : undefined,
        inferredRewrites: isLast ? ctx.inferredRewrites : undefined,
    });
    const headers = lean ? leanHeaders(full) : full;
    const badHeader = firstUnsafeHeader(headers);
    if (badHeader !== null)
        return { kind: "unsafe", header: badHeader };
    // The backstop: nothing named it, but `Headers()` still refuses. Cannot be
    // attributed to a specific header from here, so it is reported the same way
    // a non-`authorization` failure is below — a general refusal, never `fatal`
    // on a guess.
    if (!headersConstructible(headers))
        return { kind: "unsafe", header: "" };
    return {
        kind: "sent",
        outcome: await send(ctx.url, headers, body, ctx.timeoutMs, { readConversationId: ctx.readConversationId === true }),
    };
}
/**
 * A pre-send refusal: the header that failed never reached `fetch`, so there
 * is no `SendOutcome` to classify — `TODOS[182]`.
 *
 * `disposition: "fatal"` is for `authorization` specifically (a byte-invalid
 * credential is a credential-class problem, not a payload-class one, the
 * exact reasoning a 401 already gets): `markHeld`, never `markSkipped`,
 * because these bytes are fine and a reconnected user should still get them.
 * Every other required header takes `"never"` — the loud-refusal path a 400
 * or 413 already gets, so a bad session id is exactly as visible in `status`
 * as those are, never a new, differently-silent no-op.
 *
 * ⚠ **This `authorization` branch is unreachable via any real CLI path today, verified rather than
 * assumed.** `credential.ts`'s `loadCredential` already rejects anything that would fail `headerSafe` (the
 * same predicate `attemptSend` runs here), and `"Bearer " + secret` cannot become unsafe from a safe secret —
 * a safe ASCII prefix added to a safe string is still safe. So `headerSafe(secret)` at load time and
 * `headerSafe(authorization)` here always agree, and the real first line of defense is `credential.ts`'s,
 * never this one — which is kept anyway as the backstop for a FUTURE credential source that might bypass
 * that loader.
 *
 * `lean` is an explicit parameter, never read off `current`, because the ONE
 * caller that can reach this mid-transition (a `finalize` lean retry whose
 * OWN headers somehow still failed — unreachable in practice, since lean
 * headers are already proven safe, but stated rather than assumed) must
 * persist `lean: true` going forward, which `current.lean` would not yet say.
 */
function refuse(ctx, key, session, current, span, caps, disposition, lean) {
    const next = disposition === "fatal"
        ? {
            ...withFileState(session, ctx.fileKey, { ...markHeld(current, span, ctx.nowMs, caps), lean }),
            stop: { at: new Date(ctx.nowMs).toISOString(), fingerprint: credentialFingerprint(ctx.credential) },
        }
        : withFileState(session, ctx.fileKey, { ...markSkipped(current, span.from, span.to), lean });
    saveSessionState(ctx.home, key, next);
    return { kind: "attempted", disposition, detail: null, finalAck: null, inferredStored: null, inferredSetAsidePairs: 0 };
}
/**
 * The first 431 on a HOOK's attempt: hold the span (not `never` yet — the
 * bytes may still be sendable, just not with these headers) and set `lean`
 * STICKY for every attempt after this one, on this file, for the rest of the
 * session — `TODOS[182]`.
 *
 * D56 §D8 forbids a synchronous retry inside a hook, so the lean retry itself
 * waits for the NEXT hook invocation, which re-enters `deliver()` and reads
 * `current.lean === true` from the top. `deliver()`'s own 431 branch below
 * explains why `finalize` (no "next hook" to defer to) instead retries
 * in-process, within the same call.
 */
function holdLean(ctx, key, session, current, span, caps) {
    const next = withFileState(session, ctx.fileKey, { ...markHeld(current, span, ctx.nowMs, caps), lean: true });
    saveSessionState(ctx.home, key, next);
    return { kind: "attempted", disposition: "later", detail: null, finalAck: null, inferredStored: null, inferredSetAsidePairs: 0 };
}
/**
 * Send the undelivered span of one transcript file and apply the failure policy.
 *
 * **At most one NETWORK attempt per hook, still — exactly D56 §D8's rule — FOR ONE DELTA.** PR 4a:
 * `deliver()` (below) calls this once per delta, and a hook calls it again only while its budget lasts; a 413 split's
 * retry is budget-gated the same way and is a DIFFERENT, smaller body, so it is not the retry of the same bytes §D8
 * forbids. A `finalize` lean retry (below) is the one exception D56 §D8 itself does not
 * cover: it governs HOOKS, and `finalize` is a synchronous, user-invoked verb
 * that already makes 1 + up to `FINALIZE_DRAIN_MAX_ITERATIONS` requests by
 * design (VL's explicit ruling, `TODOS[182]`). On the hook path, `later` still
 * does not retry here; it leaves the offset where it is so the hook that fires
 * on the NEXT turn picks the same bytes up.
 *
 * Never throws: the caller is a hook, and an exception on this path is the
 * contract breaking. Every failure resolves to a `Delivery`.
 *
 * `readBody` is supplied by the caller rather than read here, because the caller
 * is the one that has confined `transcript_path` to the Claude Code root
 * (`/cso` finding 1). This module never opens a file.
 */
async function deliverChunk(ctx, eof, readBody, cutter) {
    // `CR-017d`. The consent gate already refuses a `cwd` outside a work tree, so
    // the hook cannot reach this — but the ledger's isolation must not rest on a
    // check in another module, the same discipline `consent.ts` states about its
    // own error paths. No repo, no send: a delta whose progress cannot be recorded
    // against a repo is one whose progress would be recorded against all of them.
    const key = { repoKey: ctx.repoKey, sessionId: ctx.sessionId };
    if (key.repoKey === "")
        return { kind: "no-repo" };
    const session = loadSessionState(ctx.home, key);
    if (isStopped(session, credentialFingerprint(ctx.credential)))
        return { kind: "stopped" };
    const current = fileState(session, ctx.fileKey);
    let span = nextSpan(current, eof);
    // ⭐ `TODOS[146]`: a finalize with nothing new to send still has something to SAY. An empty span at
    // the current offset is a valid delta (the server tolerates a zero-record body) and carries the flag.
    if (span === null && ctx.final === true) {
        const at = Math.min(current.sentOffset, eof);
        span = { from: at, to: at };
    }
    if (span === null)
        return { kind: "nothing-to-send" };
    const caps = resolveCaps(ctx.env);
    const limits = ctx.limits ?? { rawBytes: MAX_DELTA_RAW_BYTES, frameBytes: MAX_DELTA_FRAME_BYTES };
    // ⭐ PR 4a — ONE DELTA, NOT THE WHOLE SPAN TO EOF. Without a `cutter` this is the old single-span path, byte for byte.
    //
    // The delta is cut on a record boundary (the server drops a trailing partial line), at most `limits.rawBytes` raw, and
    // measured AFTER compression: a frame over `limits.frameBytes` is halved at a boundary and measured again. A record that
    // alone exceeds either limit cannot be split, so it is skipped and COUNTED (`markSkipped`: the gap counters `status`
    // reports as "skipped … will not be sent later"), never retried — retrying the same bytes cannot work.
    //
    // A cut that is NOT at EOF is not the last delta (`isLast`), so it carries none of the session-level headers.
    if (cutter !== undefined && span.to > span.from) {
        const plan = planChunk(cutter, span.from, span.to, limits.rawBytes);
        // An unterminated record longer than the limit, still at EOF: it may be growing. Leave it for the next event.
        if (plan.kind === "wait")
            return { kind: "nothing-to-send" };
        if (plan.kind === "oversize")
            return recordTooLarge(ctx, key, session, current, { from: span.from, to: plan.to }, caps);
        span = { from: span.from, to: plan.to };
    }
    let body = readBody(span.from, span.to);
    if (body === null)
        return { kind: "nothing-to-send" };
    if (cutter !== undefined) {
        while (body.length > limits.frameBytes) {
            const at = splitPoint(cutter, span.from, span.to);
            if (at === null)
                return recordTooLarge(ctx, key, session, current, span, caps);
            span = { from: span.from, to: at };
            body = readBody(span.from, span.to);
            if (body === null)
                return { kind: "nothing-to-send" };
        }
    }
    // An empty span (a `final` with nothing new) is the last delta by definition.
    let isLast = cutter === undefined || span.to >= eof || span.to === span.from;
    // `seq` is claimed BEFORE the attempt and persisted by the SWITCH below (every ordinary disposition —
    // "ok"/"later"/"never"/"fatal" — builds `next` from `{ ...session, seq, … }`), so it is monotonic per
    // session across retries once a request was actually classified. A seq reused after a failure would read
    // server-side as a replay of a delta that is not the same bytes.
    //
    // ⚠ `refuse()` and `holdLean()` below do NOT persist it — they build `next` from `session` alone, so a
    // pre-send refusal or a hook's first hold leaves `session.seq` exactly where it was. That is harmless: a
    // request classified `refuse`/`holdLean` never reached `send()` at all (a bad session id, an unsafe
    // credential, or the first 431 a hook defers on), so the server never saw THIS seq either — reusing it on
    // the next real attempt is not a replay of anything, because nothing was sent under it.
    //
    // Claimed ONCE even across a `finalize` lean retry below: both attempts, if there are two, carry the same
    // bytes at the same offset, so they are one logical delivery that happened to need its headers shed, not two.
    const seq = session.seq + 1;
    // ⛔ THE ONE PLACE THE WIRE AGENT IS DECIDED — from the containing registry
    // root, never from the flag (D177 §7). Computed once per `deliver()` call,
    // reused across a lean retry, so a retry never pays a second filesystem
    // lookup for an answer that cannot have changed between two attempts
    // milliseconds apart.
    const agent = agentForTranscript(ctx.home, ctx.env, ctx.transcriptPath);
    // ⛔⛔ `TODOS[182]` — `X-Session-Id` HAS NO BOUND ANYWHERE ELSE ON THE HOOK
    // PATH. The server 400s an id over its own `SESSION_ID_MAX` (200), and 400 is
    // already `never` — so an over-LONG id was never silently retried. The GAP is
    // charset: a byte above `\x7E` here throws the SAME `TypeError` a real
    // network outage does (`header_safety.ts`), which `classify`'s `unreachable`
    // branch would fold into `later` and retry FOREVER. Checked before anything
    // else: a bad id can never be sent no matter what the rest of the delta looks
    // like, so there is nothing to gain by building headers around it first.
    if (!sessionIdSafe(ctx.sessionId)) {
        return refuse(ctx, key, session, current, span, caps, "never", current.lean);
    }
    // `lean` is STICKY (VL's ruling, `TODOS[182]`): once `current.lean` is true,
    // THIS attempt — and every attempt after it, for this file, for the rest of
    // the session — builds the deny-list header set from the start. Not
    // re-evaluated size or charset attempt by attempt: a flag that cleared
    // itself whenever a smaller delta happened to fit would alternate between
    // full and lean requests depending on what the NEXT turn happens to contain,
    // which nobody can debug.
    let lean = current.lean;
    let attempt = await attemptSend(withinBudget(ctx), agent, seq, span, body, lean, isLast);
    if (attempt.kind === "unsafe") {
        return refuse(ctx, key, session, current, span, caps, attempt.header === "authorization" ? "fatal" : "never", lean);
    }
    let outcome = attempt.outcome;
    // ⛔⛔ `TODOS[182]` — 431 IS NOT IN `STATUS_CLASSES` AND NEVER WILL BE: it is
    // handled entirely by this state machine, never by the generic table.
    // `later`'s own definition is "retry the SAME bytes next hook" — for a 431,
    // "the same bytes" means the same HEADERS, and nothing about a later attempt
    // changes the branch, the spooled commits or the session id that caused it.
    // A table-driven `later` for 431 retries the identical oversized/rejected
    // request forever: the exact stall this task exists to close.
    if (outcome.kind === "response" && outcome.status === 431) {
        if (lean) {
            // Already lean and STILL 431: nothing client-side can shrink this
            // further. `never`, exactly as an UNSPLITTABLE 413 (a single record) — the one case `never` is correct
            // here, because it really is per-body now.
            return refuse(ctx, key, session, current, span, caps, "never", true);
        }
        if (ctx.byHook) {
            // A hook defers rather than retries — see `holdLean`'s own docblock.
            return holdLean(ctx, key, session, current, span, caps);
        }
        // `finalize`: no "next hook" to defer to, and VL's explicit ruling that one
        // in-process retry here does not reopen D56 §D8, which governs hooks. Go
        // lean and retry ONCE, within this same invocation.
        lean = true;
        attempt = await attemptSend(withinBudget(ctx), agent, seq, span, body, lean, isLast);
        if (attempt.kind === "unsafe") {
            // Unreachable in practice — every lean header is already proven safe, or
            // it would never have reached the full build either — but stated rather
            // than assumed: refuse exactly as the first attempt would have.
            return refuse(ctx, key, session, current, span, caps, attempt.header === "authorization" ? "fatal" : "never", lean);
        }
        outcome = attempt.outcome;
        if (outcome.kind === "response" && outcome.status === 431) {
            // The lean retry ALSO 431'd, within the SAME `finalize` invocation:
            // `never` for the span, discovered now rather than on a next hook that
            // does not exist for this verb.
            return refuse(ctx, key, session, current, span, caps, "never", true);
        }
        // Falls through to the ordinary classification below, now with `lean`
        // true — the `"ok"` case's accounting reads it to skip settling data this
        // attempt never put on the wire.
    }
    // ⭐ PR 4a — A 413 IS NO LONGER A WRITE-OFF WHEN THE SPAN CAN BE SPLIT. Halve it at a record boundary and send the first half
    // as a different, smaller request. A 413 is refused before the server applies anything (`server.ts`'s body limit, then the
    // decompressed-size check), so the SAME `seq` is reused: the server never recorded it, and it is not a replay.
    //
    // ⛔ Only a span that is a single record falls through to `classify`, where 413 is `never`: the bytes cannot be made
    // smaller, so skipping them is correct and the record is counted. Everything else here sends bytes the 413 did not see.
    //
    // Each retry is gated on the hook's remaining budget (`budgetLeftMs`), so this is not D56 §D8's forbidden synchronous
    // retry of the SAME bytes: it is bounded by the budget the hook already has, and out of budget it HOLDS the span.
    let splitTooLarge = false;
    while (cutter !== undefined && outcome.kind === "response" && outcome.status === 413) {
        const at = splitPoint(cutter, span.from, span.to);
        if (at === null) {
            splitTooLarge = true;
            break;
        }
        if (budgetLeftMs(ctx) < MIN_NEXT_DELTA_BUDGET_MS)
            return holdSpan(ctx, key, session, current, span, caps, lean);
        span = { from: span.from, to: at };
        isLast = false;
        const half = readBody(span.from, span.to);
        if (half === null)
            return { kind: "nothing-to-send" };
        attempt = await attemptSend(withinBudget(ctx), agent, seq, span, half, lean, false);
        if (attempt.kind === "unsafe") {
            return refuse(ctx, key, session, current, span, caps, attempt.header === "authorization" ? "fatal" : "never", lean);
        }
        outcome = attempt.outcome;
    }
    const disposition = classify(outcome);
    let next = ctx.byHook ? { ...session, seq, liveAt: ctx.nowMs } : { ...session, seq };
    let inferredSetAsidePairs = 0;
    switch (disposition) {
        case "ok":
            // `{ ...markDelivered(...), lean }` rather than relying on `markDelivered`'s own spread of `current`:
            // `current.lean` is this file's state from BEFORE this call, so on the one path where a `finalize`
            // retry just went lean mid-call and then succeeded, `current.lean` would still read `false` — `lean`
            // (the local variable, updated above) is the value that must persist going forward.
            next = withFileState(next, ctx.fileKey, { ...markDelivered(current, span.to, ctx.nowMs), lean });
            // ⭐ `TODOS[145]` — KEEP THE RECEIPT. `captureId` is non-empty when this delta sealed a capture
            // and EMPTY when it sealed nothing; the client used to stamp `lastSentAt` identically for both and
            // surface neither. MAIN stream only (a sub-agent stream seals nothing by construction and would
            // overwrite the main stream's answer). A delivery also ends any "session is over" mark: the
            // session is demonstrably alive again.
            if (ctx.fileKey === "main" && outcome.kind === "response") {
                next = {
                    ...next,
                    lastReceipt: {
                        at: ctx.nowMs,
                        sealed: outcome.captureId === null ? null : outcome.captureId !== "",
                        everSealed: session.lastReceipt?.everSealed === true || (outcome.captureId !== null && outcome.captureId !== ""),
                    },
                    // ⛔ A DELIVERY THAT ASKED FOR FINALITY AND WAS NOT TOLD IT GOT IT LEAVES THE END MARK STANDING (VG review
                    // 2, A2). Against a server that ignores `X-Session-Final` this ok-delivery used to clear `endedAt` for
                    // every caller, so `status` said "ok Capture is on" about a session whose last turn was still open.
                    endedAt: ctx.final === true && outcome.finalAck !== "sealed" && outcome.finalAck !== "already" ? session.endedAt : null,
                };
                // ⭐ `TODOS[146]` — the server ACKNOWLEDGED the caller's assertion. `null` (an older server that
                // ignored the header) and `refused` record nothing: "asked" is not "done".
                if (ctx.final === true && (outcome.finalAck === "sealed" || outcome.finalAck === "already")) {
                    next = { ...next, finalized: { at: ctx.nowMs, ack: outcome.finalAck } };
                }
            }
            // ⛔ TRUNCATE HERE AND NOWHERE ELSE. The spool is append-then-drop-on-2xx,
            // so a commit survives a 500, a timeout and a `later` and is retried by
            // the next hook. Dropping on READ would lose it permanently to one bad
            // response, and `capture_commits` rows can never be retracted (D105/D108).
            //
            // ⛔ `count`, NEVER `shas.length`. `dropSpooled` drops the FIRST N LINES,
            // and a HELD line is consumed without being sent — so truncating by the
            // number of shas on the wire would delete the held line at the head and
            // leave the delivered commit to be re-sent on every hook, forever.
            //
            // ⛔ AND ONLY WHEN THE SERVER SAYS THE COMMITS LANDED (D209 §3). A 200 is
            // "the delta was accepted", not "your commit was bound": the server writes
            // a `capture_commits` edge ONLY from a delta that SEALED A TURN, because
            // the row's turn-hash columns are NOT NULL with RESTRICT FKs and a turnless
            // delta has no turn to name. So a session's FIRST commit reached the
            // server on a `Stop` that closed nothing, was discarded there, and was
            // then deleted here by this very line. Measured in prd, session
            // `a1ae7406`: three deltas, two of which wrote captures, and the sha never
            // bound.
            //
            // ⚠ THE HOLD IS NARROW ON PURPOSE — two conditions, and dropping either
            // one re-opens something:
            //   • `captureId === ""` — PRESENT AND EMPTY. An ABSENT header is an old
            //     server, and holding against one means holding forever.
            //   • `shas.length > 0` — we actually put something on the wire. A batch
            //     of nothing but HELD entries had nothing to bind, and those entries
            //     can never become sendable (`capSpool`), so holding them would keep
            //     re-reading a line with no future instead of draining it.
            //
            // ⭐ AND WHEN THE SERVER NAMES WHAT TO KEEP, THAT ANSWER WINS (`CR-222`,
            // D209 §4). `X-Capture-Id` is about the capture, not about our shas: a
            // capture can be written while a sha's edge insert fails, which the rule
            // above reads as "drop". `X-Commits-Retry` is the per-sha answer, so it
            // decides line by line and the prefix drop is only the fallback for a
            // server that predates it.
            //
            // ⛔⛔ `TODOS[182]` — EVERYTHING BELOW IS GATED ON `!lean`. A lean request's `ctx.commits` /
            // `ctx.rewrites` / `ctx.inferredRewrites` / `ctx.inferredGroups` describe data THIS delivery never put
            // on the wire (the deny-list dropped their headers) — dropping, settling or counting an attempt
            // against them would discard real, unsent data. VG's measured finding: a copy of this client whose
            // header BUILDER omitted the list headers while `ctx` was left unchanged lost a real commit (3→0) and
            // a real rewrite (1→0) in one Stop hook, neither of which the server had ever seen. Held (never
            // sendable, for a reason unrelated to `lean`) entries are UNAFFECTED by this gate: they are consumed
            // only via a NORMAL, non-lean call's `capSpool`/`capSuccessors`/`capInferred`, which this gate does not
            // touch, so a lean session's held lines still drain exactly as soon as a non-lean request reads them.
            // PR 4a: AND ONLY ON THE DELTA THAT CARRIED THEM (`isLast`). A delta earlier in the span sent none of the commits,
            // rewrites or inferred pairs, so a 2xx for it says nothing about them and the spool must keep them for the delta that did.
            if (!lean && isLast) {
                const retry = outcome.kind === "response" ? outcome.commitsRetry : null;
                const nothingLanded = outcome.kind === "response" && outcome.captureId === "";
                const holdForNextDelta = nothingLanded && (ctx.commits?.shas.length ?? 0) > 0;
                if (ctx.commits !== undefined && ctx.commits.count > 0) {
                    if (retry !== null) {
                        settleSpooled(ctx.home, key, ctx.commits.count, new Set(retry));
                    }
                    else if (!holdForNextDelta) {
                        dropSpooled(ctx.home, key, ctx.commits.count);
                    }
                }
                // The rewrite spool is its own file with its own cap, so its own drop.
                //
                // ⛔ AND IT IS UNCONDITIONAL, UNLIKE THE COMMITS ABOVE — do not "fix" this
                // to match. `tryRecordRewrites` on the server sits OUTSIDE the capture
                // write and its comment says why: "Unconditional on the capture: a delta
                // that sealed no turns still saw the rewrite, and the mapping is what
                // keeps a squash-merged commit reachable." A `commit_sha_successors` row
                // names no turn, so `X-Capture-Id` says nothing about whether it landed.
                if (ctx.rewrites !== undefined && ctx.rewrites.length > 0) {
                    dropRewrites(ctx.home, key, ctx.rewrites.length);
                }
                // `TODOS[177]` — the INFERRED pairs have their own file and their own drop. ⛔ UNLIKE `rewrites` above, this one is
                // CONDITIONAL on the server's per-request ack (`x-rewrites-inferred-stored`): a 2xx alone is "the delta was
                // accepted", not "every inferred pair in it was recorded" (VG pre-review, 2026-10-08). Drop by GROUP IDENTITY,
                // never by count — see `dropInferredGroups`'s own comment for why a count-based drop lost pairs under concurrency.
                //
                // ⛔⛔ PER-GROUP BOUND (VL, 2026-10-08, VG's head-of-line finding): `capInferred` sends exactly ONE group per
                // request now, so `ctx.inferredGroups` has at most one member and the ack names it unambiguously.
                //   stored === sent        → delivered, drop it.
                //   stored !== null, short → a real signal from a server that saw the group and recorded fewer than all of it:
                //                            count an attempt; after `INFERRED_SET_ASIDE_AFTER` attempts, give up on it so it
                //                            stops blocking the group behind it.
                //   stored === null        → an old/absent-ack server said nothing at all: "keeping is right there" — no
                //                            attempt is counted (an attempt means a signal was RECEIVED), nothing is set aside.
                if (ctx.inferredRewrites !== undefined && ctx.inferredRewrites.length > 0 && ctx.inferredGroups !== undefined && ctx.inferredGroups.length > 0) {
                    const group = ctx.inferredGroups[0];
                    const stored = outcome.kind === "response" ? outcome.inferredStored : null;
                    if (stored === ctx.inferredRewrites.length) {
                        dropInferredGroups(ctx.home, key, [group]);
                    }
                    else if (stored !== null) {
                        // ⛔⛔ `stored !== null` ALONE, never `stored !== null && stored > 0` (VG's mutant G5, 2026-10-08): the
                        // real server (`ff67ef9`) writes a group in one atomic upsert, so a CARRIED group gets back either `n`
                        // (all stored, handled above) or exactly `0` (the write failed, the header was voided, or a replay) — it
                        // never answers `n-1`. An ack of `0` is a real signal ("the server saw this and stored none of it") and
                        // must count an attempt exactly like any other short ack, or a persistently-refused group is never set
                        // aside and head-of-line blocking comes back on the realistic path.
                        const attempts = recordInferredAttempt(ctx.home, key, group);
                        if (attempts >= INFERRED_SET_ASIDE_AFTER) {
                            setAsideInferredGroup(ctx.home, key, group, "short_ack");
                            // `TODOS[177]` follow-up (VL, 2026-10-08, VG's silent-loss finding): tally BEFORE any deletion can
                            // happen — `finalize` may delete this session's `.inferred.jsonl` outright once every group in it is
                            // resolved, and this tally is the ONLY record of `set_aside` left once that file is gone (VG's
                            // follow-up finding: an earlier version of this fix also kept a live gauge reading that same file,
                            // which double-counted these pairs once the group aged into the 7-day prune — removed).
                            recordInferredSkipped(ctx.home, key.repoKey, "set_aside", ctx.nowMs, ctx.inferredRewrites.length);
                            inferredSetAsidePairs = ctx.inferredRewrites.length;
                        }
                    }
                }
            }
            break;
        case "later":
            next = withFileState(next, ctx.fileKey, { ...markHeld(current, span, ctx.nowMs, caps), lean });
            break;
        case "never":
            next = withFileState(next, ctx.fileKey, { ...markSkipped(current, span.from, span.to), lean });
            break;
        case "fatal":
            // Credential-level, not payload-level: the offset does NOT advance, because
            // these bytes are fine and a reconnected user should still get them.
            next = {
                ...withFileState(next, ctx.fileKey, { ...markHeld(current, span, ctx.nowMs, caps), lean }),
                stop: {
                    at: new Date(ctx.nowMs).toISOString(),
                    fingerprint: credentialFingerprint(ctx.credential),
                },
            };
            break;
    }
    saveSessionState(ctx.home, key, next);
    // Slice 2: the server's grants epoch rides every credential-lane ingest answer. A different one than this machine last recorded marks
    // `grants-account.json` stale, which is all SessionStart's one bounded GET waits for — nothing else changes, and nothing here reads
    // a body. A write only on a change, `grants-account.json` only (never `grants.json`), and `noteGrantEpoch` cannot throw.
    if (outcome.kind === "response")
        noteGrantEpoch(ctx.home, outcome.grantEpoch);
    // 0.7.0: remember, for `status`, that THIS repo's upload was refused because its org has not approved capture — and
    // forget it on the next delivery. Only that one error code sets it; a 5xx or a timeout neither sets nor clears it.
    if (disposition === "ok")
        clearOrgPending(ctx.home, ctx.repoSlug);
    else if (disposition === "later" && outcome.kind === "response" && outcome.detail?.code === CAPTURE_NOT_APPROVED) {
        // The slug is the CLIENT's (`ctx.repoSlug`), never the response body's: the 403 names nobody.
        markOrgPending(ctx.home, ctx.nowMs, outcome.detail.ownersNotified ?? null, ctx.repoSlug);
    }
    else if (disposition === "never" && outcome.kind === "response" && outcome.detail?.code === REPOSITORY_EXCLUDED) {
        // Slice 2: the account turned this repo off. Remember it in `grants-account.json` — NEVER `grants.json`, which a hook does not
        // write (`consent.ts`) — so the next hook's gate stops before it reads this repo's transcript. Same rule as above: the slug is
        // the client's. `recordRefused` cannot throw.
        recordRefused(ctx.home, ctx.repoSlug);
    }
    // `outcome.detail` is null on every path except a non-2xx with a parseable
    // error body, so this is a pass-through and not a second decision.
    return {
        kind: "attempted",
        disposition,
        detail: outcome.kind === "response" ? outcome.detail : null,
        finalAck: outcome.kind === "response" ? outcome.finalAck : null,
        inferredStored: outcome.kind === "response" ? outcome.inferredStored : null,
        inferredSetAsidePairs,
        credentialExpires: outcome.kind === "response" && disposition === "ok" ? (outcome.credentialExpires ?? null) : null,
        // Carried the way `credentialExpires` is: only on `ok`, and only when there is one to carry.
        ...(outcome.kind === "response" && disposition === "ok" && outcome.conversationId !== undefined
            ? { conversationId: outcome.conversationId }
            : {}),
        ...(outcome.kind === "unreachable" ? { unreachable: true } : {}),
        // PR 4a: a 413 that no split could shrink was skipped by the `never` arm above; say so, so the caller can count it.
        ...(splitTooLarge && disposition === "never" ? { recordsTooLarge: 1 } : {}),
    };
}
/**
 * PR 4a — a single record that alone exceeds a delta limit. Nothing is sent: the same bytes would be refused, so the record
 * is skipped, the gap is stamped (`markSkipped`, which `status` reports), and the offset moves past it. `refuse` does
 * exactly that and persists it; this adds the count.
 */
function recordTooLarge(ctx, key, session, current, span, caps) {
    const skipped = refuse(ctx, key, session, current, span, caps, "never", current.lean);
    return skipped.kind === "attempted" ? { ...skipped, recordsTooLarge: 1 } : skipped;
}
/**
 * PR 4a — out of hook budget in the middle of a 413 split: hold the span the failed request covered, as a `later` does. The
 * `seq` is not persisted for the same reason the split reuses it: the 413 was refused before the server applied it.
 */
function holdSpan(ctx, key, session, current, span, caps, lean) {
    saveSessionState(ctx.home, key, withFileState(session, ctx.fileKey, { ...markHeld(current, span, ctx.nowMs, caps), lean }));
    return { kind: "attempted", disposition: "later", detail: null, finalAck: null, inferredStored: null, inferredSetAsidePairs: 0 };
}
/** Hook budget left for further sends, ms. `Infinity` when the caller set no deadline (`finalize`, `connect`). */
function budgetLeftMs(ctx) {
    return ctx.deadlineAtMs === undefined ? Infinity : ctx.deadlineAtMs - (ctx.clock ?? Date.now)();
}
/**
 * `ctx` with this attempt's timeout trimmed to what is left of the hook budget (unchanged when there is no deadline).
 *
 * ⛔ CALLED RIGHT BEFORE EACH `attemptSend`, never ahead of the read. The read, the redaction and the compression of a delta
 * (and every halving pass) take real time, and a timeout fixed before them lets the last delta end past `deadlineAtMs` by
 * exactly that. Floored like `sendTimeoutMs` (`hooks/entry.ts`): when the budget is already gone the watchdog is the real
 * limit, and a zero timeout would only abort a send that was about to be refused anyway.
 */
function withinBudget(ctx) {
    const left = budgetLeftMs(ctx);
    if (!Number.isFinite(left))
        return ctx;
    return { ...ctx, timeoutMs: Math.max(MIN_ATTEMPT_TIMEOUT_MS, Math.min(ctx.timeoutMs, Math.floor(left * NEXT_DELTA_BUDGET_FRACTION))) };
}
/**
 * Send the undelivered span of one transcript file, in deltas — PR 4a.
 *
 * Without a `cutter` this is the single request it always was: everything from the offset to EOF, at most one attempt.
 * With one (every production caller), the span goes out as record-aligned deltas, each acknowledged before the offset
 * moves past it:
 *
 *   - **A hook sends deltas only while its budget lasts** (`ctx.deadlineAtMs`) and leaves the rest for its next event or
 *     `vibecommit finalize`; `Delivery.more` says it stopped early. `finalize` and `connect` set no deadline and run on.
 *   - **It stops at the first delta that is not `ok`** and returns that delta's outcome: `later` and `fatal` hold exactly
 *     the bytes that failed, so a resume starts at the next unacknowledged delta, with no resend and no gap. A
 *     `capture_not_approved` 403 on any delta is such a stop, so its pending beat is printed once.
 *   - **A skipped oversize record does not stop it.** The records after it still go out.
 *   - **`connect`'s conversation id survives a partial run** (DX D8): it is read from the first 2xx that carries it, no later
 *     delta reads a body, and it is returned even when a later delta came back `later`.
 *
 * ⛔ A 2xx never changes a delta's outcome, and a hook reads no body (eng-2 D2): the only body read is `connect`'s opt-in.
 */
export async function deliver(ctx, eof, readBody, cutter) {
    if (cutter === undefined)
        return deliverChunk(ctx, eof, readBody, undefined);
    const key = { repoKey: ctx.repoKey, sessionId: ctx.sessionId };
    let chunkCtx = ctx;
    let conversationId;
    let tooLarge = 0;
    let deltas = 0;
    let last = null;
    const carry = (d, more = false) => d.kind !== "attempted"
        ? d
        : {
            ...d,
            ...(d.conversationId === undefined && conversationId !== undefined ? { conversationId } : {}),
            ...(tooLarge > 0 ? { recordsTooLarge: tooLarge } : {}),
            ...(deltas > 1 ? { deltas } : {}),
            ...(more ? { more: true } : {}),
        };
    for (;;) {
        const before = fileState(loadSessionState(ctx.home, key), ctx.fileKey).sentOffset;
        let delivery;
        try {
            delivery = await deliverChunk(chunkCtx, eof, readBody, cutter);
        }
        catch {
            // The cutter reads the file and a read can fail. That must read as "could not tell where the record ends", never as
            // "it does not end" (which would skip a record). Nothing was persisted for this delta, so the next event retries it.
            delivery = { kind: "nothing-to-send" };
        }
        if (delivery.kind !== "attempted")
            return last === null ? delivery : carry(last);
        deltas += 1;
        tooLarge += delivery.recordsTooLarge ?? 0;
        conversationId ??= delivery.conversationId;
        // `ok`, or a record skipped as too large, moved the offset on; anything else is a stop, and its outcome is the answer.
        if (delivery.disposition !== "ok" && delivery.recordsTooLarge === undefined)
            return carry(delivery);
        const after = fileState(loadSessionState(ctx.home, key), ctx.fileKey).sentOffset;
        // No progress is a bug somewhere below; end the loop rather than spin on it.
        if (after <= before)
            return carry(delivery);
        // ⛔ EVERY BYTE IS ACCOUNTED FOR, BUT THE LAST DELTA WAS SKIPPED RATHER THAN SENT, AND THE SESSION-LEVEL HEADERS RODE
        // ON IT. A skipped record (too large by the raw limit, the frame limit, or a 413 no split can shrink) puts nothing on
        // the wire, so the `final` assertion, the commits, the head and the rewrites that belong to the delta ending at EOF
        // never landed. Run ONE more pass: `nextSpan` is null at EOF, so the existing `span === null && final` branch of
        // `deliverChunk` sends the empty delta that carries them (`isLast` is true for an empty span). Without this a
        // `finalize` whose last record was oversize reported `notDelivered` after every byte had been sent or written off.
        // Hooks never set `final`, and their commits ride the next event as they always did.
        const tailSkipped = delivery.recordsTooLarge !== undefined && after >= eof && ctx.final === true;
        if (after >= eof && !tailSkipped)
            return carry(delivery);
        if (budgetLeftMs(ctx) < MIN_NEXT_DELTA_BUDGET_MS)
            return carry(delivery, true);
        last = delivery;
        chunkCtx = {
            ...ctx,
            // Stop reading bodies once the id is in hand: a later delta never needs one.
            readConversationId: ctx.readConversationId === true && conversationId === undefined,
        };
    }
}
//# sourceMappingURL=post.js.map