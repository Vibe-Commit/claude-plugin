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
import { headerSafe, sessionIdSafe } from "./header_safety.js";
import { recordInferredSkipped } from "./inferred_tally.js";
import { classify, markDelivered, markHeld, markSkipped, nextSpan, resolveCaps, } from "./policy.js";
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
    // side reads either — `send()` parses a body only on a non-2xx. So the case
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
const MAX_ERROR_BODY_BYTES = 64 * 1024;
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
 * ⚠ Read ONLY on a non-2xx. A 2xx body is not read, not awaited, and not
 * parsed, so the hook's hot path is untouched.
 */
async function readErrorDetail(res) {
    if (res.ok)
        return null;
    // The declared length, when there is one. The abort signal already bounds the
    // read in TIME; this bounds it in BYTES for a fast, huge response.
    const declared = Number(res.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_ERROR_BODY_BYTES)
        return null;
    let body;
    try {
        const text = await res.text();
        if (text.length > MAX_ERROR_BODY_BYTES)
            return null;
        body = JSON.parse(text);
    }
    catch {
        return null;
    }
    if (body === null || typeof body !== "object" || Array.isArray(body))
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
/** `X-Rewrites-Inferred-Stored` → a non-negative integer, or `null` for absent/malformed. NEVER THROWS. */
function parseInferredStored(raw) {
    if (raw === null)
        return null;
    const n = Number(raw.trim());
    return Number.isInteger(n) && n >= 0 ? n : null;
}
/**
 * One attempt. No retry, no backoff, no classification — `CR-018` owns all three.
 *
 * The timeout is mandatory rather than optional: a hook has a wall-clock budget
 * it must not exceed (DESIGN.md §13.7), and `fetch` without a signal waits on the
 * platform default, which is far longer than any hook timeout.
 *
 * Never throws. A hook that takes an exception from the network has already
 * broken the contract; returning `unreachable` keeps the decision with the
 * caller.
 */
export async function send(url, headers, body, timeoutMs) {
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
        return {
            kind: "response",
            status: res.status,
            detail: await readErrorDetail(res),
            // `null` when the server does not send it at all — see `captureId` above.
            captureId: res.headers.get("x-capture-id"),
            commitsRetry: parseCommitsRetry(res.headers.get("x-commits-retry")),
            finalAck: parseFinalAck(res.headers.get("x-session-final")),
            inferredStored: parseInferredStored(res.headers.get("x-rewrites-inferred-stored")),
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
 * Build the delta, reduce it to the deny-list set when `lean`, validate every
 * resulting header value, and only then call `send()` — `TODOS[182]`.
 *
 * `x-head-branch` can never be the `header` an "unsafe" result names:
 * `buildIngestHeaders` already omits it unless it is both within
 * `MAX_HEAD_BRANCH_LENGTH` and `headerSafe`. So a `header-unsafe` result here,
 * by elimination, always names a REQUIRED header — there is no second
 * optional one for the caller to drop.
 */
async function attemptSend(ctx, agent, seq, span, body, lean) {
    const full = buildIngestHeaders(ctx.credential, {
        sessionId: ctx.sessionId,
        seq,
        byteOffset: span.from,
        fileKey: ctx.fileKey,
        repoSlug: ctx.repoSlug,
        agent,
        final: ctx.final === true,
        head: ctx.head,
        commits: ctx.commits,
        rewrites: ctx.rewrites,
        inferredRewrites: ctx.inferredRewrites,
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
    return { kind: "sent", outcome: await send(ctx.url, headers, body, ctx.timeoutMs) };
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
 * **At most one NETWORK attempt per hook, still — exactly D56 §D8's rule.** A
 * `finalize` lean retry (below) is the one exception D56 §D8 itself does not
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
export async function deliver(ctx, eof, readBody) {
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
    const body = readBody(span.from, span.to);
    if (body === null)
        return { kind: "nothing-to-send" };
    const caps = resolveCaps(ctx.env);
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
    let attempt = await attemptSend(ctx, agent, seq, span, body, lean);
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
            // further. `never`, exactly as 413 — the one case `never` is correct
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
        attempt = await attemptSend(ctx, agent, seq, span, body, lean);
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
            if (!lean) {
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
    // `outcome.detail` is null on every path except a non-2xx with a parseable
    // error body, so this is a pass-through and not a second decision.
    return {
        kind: "attempted",
        disposition,
        detail: outcome.kind === "response" ? outcome.detail : null,
        finalAck: outcome.kind === "response" ? outcome.finalAck : null,
        inferredStored: outcome.kind === "response" ? outcome.inferredStored : null,
        inferredSetAsidePairs,
    };
}
//# sourceMappingURL=post.js.map