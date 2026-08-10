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
 */
import { createHash } from "node:crypto";
import { classify, markDelivered, markHeld, markSkipped, nextSpan, resolveCaps, } from "./policy.js";
import { fileState, isStopped, loadSessionState, saveSessionState, withFileState, } from "./state.js";
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
 */
export function buildIngestHeaders(credential, delta) {
    return {
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
        return { kind: "response", status: res.status };
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
    }), body, ctx.timeoutMs);
    const disposition = classify(outcome);
    const caps = resolveCaps(ctx.env);
    let next = { ...session, seq };
    switch (disposition) {
        case "ok":
            next = withFileState(next, ctx.fileKey, markDelivered(current, span.to));
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
    return { kind: "attempted", disposition };
}
//# sourceMappingURL=post.js.map