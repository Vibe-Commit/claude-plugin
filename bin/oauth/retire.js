/**
 * `POST /oauth/ingest-credential/retire` — retire the credential this one replaces (G4).
 *
 * ```
 *   POST <mcp origin>/oauth/ingest-credential/retire
 *   Authorization: Bearer <the NEW vcik_>         { "old_token": "vcik_…" }
 *
 *   200 { "retired": true }     the old credential was revoked with reason 'rotated'
 *   200 { "retired": false }    the ONE uniform answer for not-found / other user / other org /
 *                               already revoked / same token — the server never says which
 *   401 opaque · 400 { "error": "invalid_request" } · 429 retry-after · 404 an older server
 * ```
 *
 * ## Self-revoke (brief A3)
 *
 * The same route, body exactly `{ "self": true }`, Bearer = the credential to revoke: the bearer's own
 * row is revoked (`user_revoke`) and the answer is 200 `{ "retired": true }`. It exists for the one
 * case the two-token form cannot serve: a re-auth the user DECLINES after the browser landed in a
 * different workspace. The credential just minted there is the one to remove, and the only credential
 * this machine holds in that workspace is that one. A 404 (a server without it) or any failure leaves
 * the credential live and unused, and the caller says where to revoke it.
 *
 * Proof of possession: the caller holds BOTH tokens, over the same TLS every ingest already uses.
 * The old token travels in the body, never in argv or a URL. A 404 means "this server cannot
 * retire", which the caller prints as "unknown" rather than as a failure — nothing is lost either
 * way, the old row simply lives until it expires and shows in Settings.
 *
 * ⛔ `old_token` IS A SECRET, so nothing in this module renders a response body or an error.
 *
 * @provenance vibecommit-mcp src/transport/server.ts — POST /oauth/ingest-credential/retire, retyped
 */
import { HTTP_TIMEOUT_MS } from "./signin.js";
export const RETIRE_PATH = "/oauth/ingest-credential/retire";
/** One best-effort revoke of a credential `g` holds, and the bound on a verb's whole retry of the queue (`pending_revoke.ts`). */
export const REVOKE_TIMEOUT_MS = 3_000;
export function retireUrl(mcpEndpoint) {
    return new URL(RETIRE_PATH, mcpEndpoint).toString();
}
export async function retireCredential(mcpEndpoint, replacement, old, deps) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? HTTP_TIMEOUT_MS);
    try {
        const res = await deps.fetch(retireUrl(mcpEndpoint), {
            method: "POST",
            headers: {
                authorization: `Bearer ${replacement.expose()}`,
                "content-type": "application/json",
                accept: "application/json",
            },
            body: JSON.stringify({ old_token: old.expose() }),
            signal: controller.signal,
            redirect: "error",
        });
        if (res.status === 404)
            return { kind: "unknown" };
        if (res.status !== 200)
            return { kind: "failed" };
        const doc = (await res.json());
        if (doc?.retired === true)
            return { kind: "retired" };
        if (doc?.retired === false)
            return { kind: "not-retired" };
        return { kind: "failed" };
    }
    catch {
        return { kind: "failed" };
    }
    finally {
        clearTimeout(timer);
    }
}
/**
 * Revoke `credential` with itself as the bearer — see "Self-revoke" above.
 *
 * `retired` only on a clean 200 `{ retired: true }`; a 404 is `unknown` (an older server); everything
 * else — 401, 400, 429, 5xx, a timeout, a body off-contract — is `failed`. Never throws, and the
 * result carries nothing of the credential.
 */
export async function selfRevokeCredential(mcpEndpoint, credential, deps) {
    const outcome = await selfRevokeOutcome(mcpEndpoint, credential, deps);
    return outcome.kind === "gone" ? { kind: "failed" } : outcome;
}
/**
 * `selfRevokeCredential`, plus the one thing a RETRY needs to know: `gone` is a 401, the server saying it does not accept this
 * credential — already revoked, expired or never real — so there is nothing left to revoke and a queued retry stops. Every
 * other result is `selfRevokeCredential`'s.
 */
export async function selfRevokeOutcome(mcpEndpoint, credential, deps) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? HTTP_TIMEOUT_MS);
    try {
        const res = await deps.fetch(retireUrl(mcpEndpoint), {
            method: "POST",
            headers: {
                authorization: `Bearer ${credential.expose()}`,
                "content-type": "application/json",
                accept: "application/json",
            },
            body: JSON.stringify({ self: true }),
            signal: controller.signal,
            redirect: "error",
        });
        if (res.status === 404)
            return { kind: "unknown" };
        if (res.status === 401)
            return { kind: "gone" };
        if (res.status !== 200)
            return { kind: "failed" };
        const doc = (await res.json());
        return doc?.retired === true ? { kind: "retired" } : { kind: "failed" };
    }
    catch {
        return { kind: "failed" };
    }
    finally {
        clearTimeout(timer);
    }
}
//# sourceMappingURL=retire.js.map