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
import { classify, markDelivered, markHeld, markSkipped, nextSpan, resolveCaps, } from "./policy.js";
import { fileState, isStopped, loadSessionState, saveSessionState, withFileState, } from "./state.js";
import { dropRewrites, dropSpooled } from "./spool.js";
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
    // ⚠ OMITTED, never sent empty. A blank header is a value the server has to
    // have an opinion about; an absent one is unambiguously "nothing to say", and
    // an empty repository genuinely has nothing to say here.
    if (delta.head != null) {
        headers["x-head-sha"] = delta.head.sha;
        if (delta.head.branch !== null)
            headers["x-head-branch"] = delta.head.branch;
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
    return headers;
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
        return { kind: "response", status: res.status, detail: await readErrorDetail(res) };
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
/**
 * Send the undelivered span of one transcript file and apply the failure policy.
 *
 * **Exactly one attempt, ever.** `later` does not retry here; it leaves the
 * offset where it is so the hook that fires on the NEXT turn picks the same
 * bytes up. A loop in this function would reopen D56 plan §D8, the founder
 * override that says a hook must never block or slow a developer's turn.
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
    const span = nextSpan(current, eof);
    if (span === null)
        return { kind: "nothing-to-send" };
    const body = readBody(span.from, span.to);
    if (body === null)
        return { kind: "nothing-to-send" };
    // `seq` is claimed BEFORE the attempt and persisted regardless of outcome, so
    // it is monotonic per session across retries. A seq reused after a failure
    // would read server-side as a replay of a delta that is not the same bytes.
    const seq = session.seq + 1;
    const outcome = await send(ctx.url, buildIngestHeaders(ctx.credential, {
        sessionId: ctx.sessionId,
        seq,
        byteOffset: span.from,
        fileKey: ctx.fileKey,
        repoSlug: ctx.repoSlug,
        // ⛔ THE ONE PLACE THE WIRE AGENT IS DECIDED — from the containing
        // registry root, never from the flag (D177 §7). Per delivery rather than
        // per hook: a delegated stream is a file in its own right, and the root
        // that contains it is what names its producer.
        agent: agentForTranscript(ctx.home, ctx.env, ctx.transcriptPath),
        head: ctx.head,
        commits: ctx.commits,
        rewrites: ctx.rewrites,
    }), body, ctx.timeoutMs);
    const disposition = classify(outcome);
    const caps = resolveCaps(ctx.env);
    let next = { ...session, seq };
    switch (disposition) {
        case "ok":
            next = withFileState(next, ctx.fileKey, markDelivered(current, span.to, ctx.nowMs));
            // ⛔ TRUNCATE HERE AND NOWHERE ELSE. The spool is append-then-drop-on-2xx,
            // so a commit survives a 500, a timeout and a `later` and is retried by
            // the next hook. Dropping on READ would lose it permanently to one bad
            // response, and `capture_commits` rows can never be retracted (D105/D108).
            //
            // ⛔ `count`, NEVER `shas.length`. `dropSpooled` drops the FIRST N LINES,
            // and a HELD line is consumed without being sent — so truncating by the
            // number of shas on the wire would delete the held line at the head and
            // leave the delivered commit to be re-sent on every hook, forever.
            if (ctx.commits !== undefined && ctx.commits.count > 0) {
                dropSpooled(ctx.home, key, ctx.commits.count);
            }
            // The rewrite spool is its own file with its own cap, so its own drop.
            if (ctx.rewrites !== undefined && ctx.rewrites.length > 0) {
                dropRewrites(ctx.home, key, ctx.rewrites.length);
            }
            break;
        case "later":
            next = withFileState(next, ctx.fileKey, markHeld(current, span, ctx.nowMs, caps));
            break;
        case "never":
            next = withFileState(next, ctx.fileKey, markSkipped(current, span.from, span.to));
            break;
        case "fatal":
            // Credential-level, not payload-level: the offset does NOT advance, because
            // these bytes are fine and a reconnected user should still get them.
            next = {
                ...withFileState(next, ctx.fileKey, markHeld(current, span, ctx.nowMs, caps)),
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
    };
}
//# sourceMappingURL=post.js.map