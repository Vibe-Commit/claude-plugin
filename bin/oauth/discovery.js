/**
 * RFC 9728 + RFC 8414 discovery — where the authorize and token endpoints are.
 *
 * **The authorize URL is DISCOVERED, never constructed.** `vibecommit-mcp`
 * deliberately does not route `/oauth/authorize`: the authorize UI lives in
 * `vibecommit-web` on a different host in production, and the server carries its
 * address as configuration (`DiscoveryUrls.authorizeEndpointUrl`, whose own
 * docblock says *"there is no correct cross-repo default (any `${issuer}/...`
 * 404s on the MCP host)"*). A hardcoded path has already cost this project once:
 * the constant pointed at `/oauth/authorize` while the live route was
 * `/auth/claude`, and every failure read as a config problem.
 *
 * So the chain is:
 *
 *   1. `GET <resource-origin>/.well-known/oauth-protected-resource` → RFC 9728
 *      protected-resource metadata → `authorization_servers[0]` is the issuer.
 *   2. `GET <issuer>/.well-known/oauth-authorization-server` → RFC 8414
 *      authorization-server metadata → `authorization_endpoint`, `token_endpoint`.
 *
 * ## The issuer check is not paperwork
 *
 * RFC 8414 §3.3 requires the `issuer` INSIDE the metadata to equal the issuer
 * the document was fetched from. That exact-string equality is the same
 * constraint D26 records on the other side of the wire — the authorization
 * response carries RFC 9207 `iss`, and it must string-equal both the PRM
 * `authorization_servers[]` entry and this document's `issuer`. Three places,
 * one string; a mismatch anywhere is a mix-up attack or a misconfiguration, and
 * either way the flow must stop rather than proceed against an issuer nobody
 * vouched for.
 *
 * Nothing is imported from `vibecommit-mcp` and nothing may be: it is closed
 * source and this package is MIT (D60 §D1a). The two documents below are the
 * WIRE SHAPE, retyped from reading it.
 *
 * @provenance vibecommit-mcp src/oauth/discovery.ts — both metadata documents, retyped
 * @provenance vibecommit-mcp src/transport/server.ts — both `.well-known` routes, retyped
 * @provenance vibecommit-web /auth/* — authorize UI is hosted there, not on the MCP host
 */
import { isAllowedIngestUrl } from "../post.js";
import { CHALLENGE_METHOD } from "./pkce.js";
/** RFC 9728 §3.1. */
export const PROTECTED_RESOURCE_PATH = "/.well-known/oauth-protected-resource";
/** RFC 8414 §3. */
export const AUTHORIZATION_SERVER_PATH = "/.well-known/oauth-authorization-server";
/**
 * The `/mcp` resource this client reads from. One `tools/call` POST goes here
 * with the user token as bearer — there is no second Fly app, no `/read` route
 * and no second hostname (D73, which closed `CR-083` as not needed).
 */
export const DEFAULT_MCP_URL = "https://api.vibecommit.ai/mcp";
/** Override for tests and for a self-hosted server, same shape as the ingest lane's. */
export function mcpUrl(env) {
    const override = env.VIBECOMMIT_MCP_URL;
    if (override === undefined || override.trim() === "")
        return DEFAULT_MCP_URL;
    const candidate = override.trim();
    return isAllowedIngestUrl(candidate) ? candidate : null;
}
async function getJson(url, deps) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deps.timeoutMs);
    try {
        const res = await deps.fetch(url, {
            method: "GET",
            headers: { accept: "application/json" },
            signal: controller.signal,
            // A discovery document that redirects is a document from somewhere the
            // operator did not configure. `post.ts` refuses redirects on the same
            // reasoning and for the same lane.
            redirect: "error",
        });
        if (!res.ok)
            return { ok: false };
        return { ok: true, body: (await res.json()) };
    }
    catch {
        return { ok: false };
    }
    finally {
        clearTimeout(timer);
    }
}
/** `https://host/mcp` → `https://host`. The `.well-known` paths sit at the root. */
function originOf(url) {
    return new URL(url).origin;
}
/**
 * Discover the authorization server for `resourceUrl`.
 *
 * `resourceUrl` is the `/mcp` endpoint. Both documents are public by design
 * (RFC 9728/8414 §"no auth"), so nothing here carries a credential.
 */
export async function discover(resourceUrl, deps) {
    const prmUrl = `${originOf(resourceUrl)}${PROTECTED_RESOURCE_PATH}`;
    const prm = await getJson(prmUrl, deps);
    if (!prm.ok)
        return { kind: "unreachable", url: prmUrl };
    const servers = prm.body.authorization_servers;
    const issuer = Array.isArray(servers) && typeof servers[0] === "string" ? servers[0] : null;
    if (issuer === null || issuer === "") {
        return { kind: "malformed", url: prmUrl, detail: "no_authorization_server" };
    }
    // ⚠ `/cso` finding, MEDIUM. VALIDATE BEFORE FETCHING, not after. The issuer
    // arrives INSIDE a document, so it is remote input, and the next line turns it
    // into an outbound request from the user's machine. Validating only the two
    // ENDPOINTS below — which is what this did — left the AS-metadata GET itself
    // unchecked, so a hostile or compromised discovery document could aim it at
    // `http://169.254.169.254`, a private RFC 1918 address, or an arbitrary
    // internal port: a blind SSRF probe with the request coming from inside the
    // network. The response cannot be read back by the attacker, which is what
    // keeps this MEDIUM rather than HIGH.
    //
    // Same predicate the endpoints get, applied one step earlier so the rule is
    // consistent: every URL this module fetches passed it first.
    if (!isAllowedIngestUrl(issuer)) {
        return { kind: "malformed", url: prmUrl, detail: "insecure_endpoint" };
    }
    const asUrl = `${issuer.replace(/\/+$/, "")}${AUTHORIZATION_SERVER_PATH}`;
    const as = await getJson(asUrl, deps);
    if (!as.ok)
        return { kind: "unreachable", url: asUrl };
    const doc = as.body;
    // RFC 8414 §3.3, and D26's exact-string rule. Not normalised, not
    // case-folded, not trailing-slash-tolerant: the whole value of the check is
    // that it is the SAME comparison the RFC 9207 `iss` check makes later, so a
    // server whose three copies of this string disagree fails here rather than
    // three steps further on where it reads as something else.
    if (doc.issuer !== issuer)
        return { kind: "malformed", url: asUrl, detail: "issuer_mismatch" };
    if (typeof doc.authorization_endpoint !== "string" || doc.authorization_endpoint === "") {
        return { kind: "malformed", url: asUrl, detail: "no_authorize_endpoint" };
    }
    if (typeof doc.token_endpoint !== "string" || doc.token_endpoint === "") {
        return { kind: "malformed", url: asUrl, detail: "no_token_endpoint" };
    }
    // The token endpoint receives the verifier and returns the refresh token, and
    // the authorize endpoint receives the challenge. Neither may be plaintext off
    // the loopback. Same predicate as the ingest lane: https, or http to a
    // loopback host. (⚠ NOT the redirect-URI rule — that one additionally
    // forbids the literal `localhost`, and it lives in `loopback.ts` because it is
    // the SERVER's policy about a value we send it, not ours about where we send.)
    for (const endpoint of [doc.authorization_endpoint, doc.token_endpoint]) {
        if (!isAllowedIngestUrl(endpoint)) {
            return { kind: "malformed", url: asUrl, detail: "insecure_endpoint" };
        }
    }
    // Absent means "unstated", and RFC 8414 §2 says a client that needs S256 must
    // not assume it. We need it: it is the only method this client can produce.
    const methods = doc.code_challenge_methods_supported;
    if (!Array.isArray(methods) || !methods.includes(CHALLENGE_METHOD)) {
        return { kind: "malformed", url: asUrl, detail: "no_s256" };
    }
    return {
        kind: "ok",
        metadata: {
            issuer,
            authorization_endpoint: doc.authorization_endpoint,
            token_endpoint: doc.token_endpoint,
            code_challenge_methods_supported: methods,
        },
    };
}
//# sourceMappingURL=discovery.js.map