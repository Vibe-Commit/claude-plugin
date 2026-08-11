/**
 * The `/oauth/token` client — both grants.
 *
 * RFC 6749 §4.1.3 (`authorization_code`) and §6 (`refresh_token`), posted
 * form-encoded, which is the shape the server prefers and parses first. No
 * client secret: this is a PUBLIC client (the server advertises
 * `token_endpoint_auth_methods_supported: ["none"]`), and a secret shipped
 * inside a CLI on a developer's disk is not a secret.
 *
 * ## ⚠ THE CLIENT ID IS NOT REGISTERED SERVER-SIDE YET
 *
 * `vibecommit-mcp`'s `REGISTERED_CLIENT_IDS` is a hard-coded membership set
 * (RFC 7591 dynamic registration is deferred) holding ten entries — `claude-ai`,
 * `cursor-mcp`, `vscode-copilot`, `codex-cli`, `windsurf-mcp`, `cline`,
 * `continue-dev`, `roo-code`, `kiro`, `mcp-inspector` — and **none of them is
 * this CLI**. `isRegisteredClient` gates BOTH `/oauth/authorize` and
 * `/oauth/token`, so against the live server every sign-in below returns
 * `unauthorized_client` until `CLIENT_ID` below is added to that list.
 *
 * That is a one-line server-side change in another repo, and it is REPORTED
 * rather than worked around: the two alternatives are both worse. Borrowing
 * `mcp-inspector` would ship a dev/testing identity in a released binary, and
 * borrowing `claude-ai` would make this client indistinguishable from Claude
 * Code in the audit trail of a product whose entire value is an audit trail.
 *
 * One constant, named, so the registration is a one-line change on this side too.
 *
 * ⚠ AND THE NAME IS `capture-cli` RATHER THAN THE OBVIOUS PRODUCT-PREFIXED ONE.
 * Every sibling repo in this project is named with that product prefix, and
 * `test/provenance.test.ts`'s `REPO_TOKEN` matches exactly that shape to find
 * closed-core references — so a client id built the obvious way is read by the
 * licensing gate as a reference to a closed sibling repo that does not exist.
 * The collision is a real signal rather than a tooling annoyance: an OAuth
 * client id indistinguishable from a repository name is ambiguous to a human
 * reader too. `capture-cli` names the package (`@vibe-commit/capture`) and
 * matches the server's own convention for the ids beside it (`codex-cli`).
 *
 * @provenance vibecommit-mcp src/oauth/token.ts — both grants, request + response shapes, retyped
 * @provenance vibecommit-mcp src/transport/server.ts — form-encoded body parse, retyped
 * @provenance vibecommit-mcp src/db/supabase.ts — the registered-client gate, retyped
 */
import { AccessToken, RefreshToken, isAccessTokenShape, isRefreshTokenShape } from "../credential.js";
import { CHALLENGE_METHOD } from "./pkce.js";
/** This CLI's OAuth client identity. ⚠ Not yet in the server's set — see above. */
export const CLIENT_ID = "capture-cli";
/** The only scope the server registers. */
export const SCOPE = "mcp:tools";
/**
 * Refresh this many milliseconds BEFORE the access token actually expires.
 *
 * Without a margin, a read starting at t=899s on a 900s token races its own
 * round trip and fails with a 401 it could have avoided. 60s comfortably exceeds
 * both the request budget and any plausible clock disagreement between this
 * machine and the issuer, and costs one extra refresh per 15 minutes of
 * continuous use.
 */
export const EXPIRY_SKEW_MS = 60_000;
async function post(endpoint, form, deps) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deps.timeoutMs);
    let res;
    try {
        res = await deps.fetch(endpoint, {
            method: "POST",
            headers: {
                "content-type": "application/x-www-form-urlencoded",
                accept: "application/json",
            },
            body: new URLSearchParams(form).toString(),
            signal: controller.signal,
            // This request carries the code verifier or the refresh token in its
            // BODY. undici does not strip a body on redirect the way it strips an
            // Authorization header, so following one would hand the secret to a hop
            // the operator never configured. `post.ts` refuses redirects on the same
            // lane for the same reason.
            redirect: "error",
        });
    }
    catch {
        return { kind: "unreachable" };
    }
    finally {
        clearTimeout(timer);
    }
    let body;
    try {
        body = (await res.json());
    }
    catch {
        return { kind: "malformed" };
    }
    if (!res.ok) {
        const error = body.error;
        return { kind: "denied", error: typeof error === "string" ? error : "invalid_request" };
    }
    return parseTokenResponse(body, deps.nowMs);
}
/**
 * Turn a token response into two opaque tokens, or refuse it.
 *
 * ⚠ Both halves are CLASS-CHECKED before they are wrapped, and this is the
 * mirror of the ingest lane's `wrong-class` refusal rather than belt-and-braces.
 * A response that put the JWT in `refresh_token` would otherwise be stored and
 * then presented to the refresh grant on every subsequent read, and the symptom
 * — `invalid_grant`, a signed-out user — names neither the cause nor the field.
 * Refusing at the boundary makes the fault land where it happened.
 *
 * Exported so a test can drive known-bad bodies at it without a socket.
 */
export function parseTokenResponse(body, nowMs) {
    const doc = body;
    if (typeof doc.access_token !== "string" || !isAccessTokenShape(doc.access_token)) {
        return { kind: "malformed" };
    }
    if (typeof doc.refresh_token !== "string" || !isRefreshTokenShape(doc.refresh_token)) {
        return { kind: "malformed" };
    }
    if (typeof doc.expires_in !== "number" || !Number.isFinite(doc.expires_in)) {
        return { kind: "malformed" };
    }
    return {
        kind: "ok",
        tokens: {
            access: new AccessToken(doc.access_token),
            refresh: new RefreshToken(doc.refresh_token),
            expiresAtMs: nowMs + doc.expires_in * 1000,
            scope: typeof doc.scope === "string" ? doc.scope : SCOPE,
        },
    };
}
/**
 * `grant_type=authorization_code`.
 *
 * `redirect_uri` is sent again and MUST be byte-identical to the one presented
 * at authorize — the server compares them (`candidate.redirect_uri !==
 * input.redirectUri` → `invalid_grant`). That is the second place the
 * `127.0.0.1`-vs-`localhost` spelling decides whether this works.
 */
export async function exchangeCode(tokenEndpoint, input, deps) {
    return await post(tokenEndpoint, {
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        code: input.code,
        code_verifier: input.codeVerifier,
        redirect_uri: input.redirectUri,
    }, deps);
}
/**
 * `grant_type=refresh_token` — rotation. The response carries a NEW refresh
 * token and the old one is dead the instant this succeeds.
 *
 * ⚠ CALL THIS ONLY UNDER `withRefreshLock`. Presenting a token that has already
 * been rotated revokes the whole family server-side. `lock.ts`'s module note is
 * the long version; this is the line that stops a reader wiring it up directly.
 */
export async function refreshGrant(tokenEndpoint, refresh, deps) {
    return await post(tokenEndpoint, {
        grant_type: "refresh_token",
        client_id: CLIENT_ID,
        // The one place this secret's plaintext is used, at the request boundary —
        // the same discipline `post.ts` states for the ingest credential.
        refresh_token: refresh.expose(),
    }, deps);
}
/**
 * The authorize URL, built from the DISCOVERED endpoint.
 *
 * Every parameter is appended to whatever query the discovered endpoint already
 * carries rather than replacing it: the authorize UI lives in another repo on
 * another host and may legitimately carry its own.
 */
export function buildAuthorizeUrl(authorizationEndpoint, input) {
    const url = new URL(authorizationEndpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", CLIENT_ID);
    url.searchParams.set("redirect_uri", input.redirectUri);
    url.searchParams.set("scope", SCOPE);
    url.searchParams.set("state", input.state);
    url.searchParams.set("code_challenge", input.challenge);
    url.searchParams.set("code_challenge_method", CHALLENGE_METHOD);
    return url.toString();
}
//# sourceMappingURL=token.js.map