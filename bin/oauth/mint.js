/**
 * The machine-credential mint: ONE POST, with the signed-in user's access token,
 * that returns this machine's ingest credential — `CR-226`.
 *
 * ## The gap this closes
 *
 * Sign-in (`signin.ts`) has worked since `CR-084d` and ends in `session.json`: a
 * USER principal for the read lane. The hook lane needs something else, a `vcik_`
 * MACHINE credential in `credentials.json`, and until this module the only way to
 * get one was to open the web app, mint it there, copy it, and paste it into
 * `vibecommit auth`. The server-side minter existed the whole time with no route
 * in front of it. This is the client half of the route that now fronts it.
 *
 * ## ⚠ OAuth OBTAINS the credential; it does not REPLACE it (D206)
 *
 * The access token is a 15-minute JWT that needs a browser to renew its family
 * and a refresh lock to rotate safely. A hook firing at `git commit` time has
 * neither, which is why the lanes are separate on purpose. So this module spends
 * the access token exactly once, to buy the long-lived opaque credential the hook
 * path actually uses, and the two files stay two files.
 *
 * ## The wire, retyped
 *
 * ```
 *   POST <mcp origin>/oauth/ingest-credential
 *   Authorization: Bearer <access token>       { "label": "<1..128>" }
 *
 *   201 { status, token, credential: { id, label, created_at, expires_at }, audience }
 *   401                                        bearer rejected — refresh once, retry once
 *   403 { error: "client_not_permitted" }      token predates the client claim — same
 *   403 { error: "not_a_member" } · 400 · 429 · 500     refused; no retry helps
 * ```
 *
 * ⚠ Only the `token` field is read out of a 201. The rest is the server's
 * record of the row and this client has no use for it: the credential is opaque,
 * and its expiry is the server's to enforce.
 *
 * @provenance vibecommit-mcp src/transport/server.ts — POST /oauth/ingest-credential request and response shapes, retyped
 */
import { IngestCredential, INGEST_TOKEN_PREFIX } from "../credential.js";
/** Same origin as `/mcp` — one host, one issuer (D73). */
export const MINT_PATH = "/oauth/ingest-credential";
/** The table's `length(label) between 1 and 128`, mirrored so the server never has to 400. */
export const LABEL_MAX = 128;
/** Used when the hostname is empty. Still a label a person can recognise in the dashboard list. */
const FALLBACK_LABEL = "vibecommit CLI";
/**
 * A plaintext credential as the server mints it: the prefix, then base64url.
 * Checked on the way IN so a 201 carrying anything else is `malformed` rather
 * than a file this package would then refuse to read.
 */
const MINTED_SHAPE = new RegExp(`^${INGEST_TOKEN_PREFIX}[A-Za-z0-9_-]+$`);
/** The mint URL, on the same origin as the `/mcp` endpoint already validated by `mcpUrl`. */
export function mintUrl(mcpEndpoint) {
    return new URL(MINT_PATH, mcpEndpoint).toString();
}
/**
 * What the credential is called in `/app/settings`. Revocation is per credential,
 * so a user looking at three rows has to be able to tell which machine is which;
 * the hostname is what they would have typed into the web form anyway.
 */
export function machineLabel(hostname) {
    const trimmed = hostname.trim();
    return trimmed === "" ? FALLBACK_LABEL : trimmed.slice(0, LABEL_MAX);
}
/**
 * Ask the server for this machine's credential.
 *
 * Retrying is the CALLER's decision (`mintWithSession`), and it is safe only
 * because neither retried outcome mints: a 401 or a `client_not_permitted` is
 * refused before the server touches the table, so a retry cannot leave two live
 * credentials where the user expected one.
 */
export async function requestMint(endpoint, access, label, deps) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deps.timeoutMs);
    let res;
    try {
        res = await deps.fetch(endpoint, {
            method: "POST",
            headers: {
                // The request boundary — the one place this token's plaintext is used.
                authorization: `Bearer ${access.expose()}`,
                "content-type": "application/json",
                accept: "application/json",
            },
            body: JSON.stringify({ label }),
            signal: controller.signal,
            // Same reason as the read lane: a followed redirect either arrives
            // unauthenticated or carries the bearer somewhere unconfigured.
            redirect: "error",
        });
    }
    catch {
        return { kind: "unreachable" };
    }
    finally {
        clearTimeout(timer);
    }
    if (res.status === 401)
        return { kind: "unauthorized" };
    let body;
    try {
        body = (await res.json());
    }
    catch {
        return res.status === 201 ? { kind: "malformed" } : { kind: "refused", status: res.status, error: "" };
    }
    const doc = (body ?? {});
    if (res.status !== 201) {
        const error = typeof doc.error === "string" ? doc.error : "";
        if (res.status === 403 && error === "client_not_permitted")
            return { kind: "wrong-client" };
        return { kind: "refused", status: res.status, error };
    }
    if (typeof doc.token !== "string" || !MINTED_SHAPE.test(doc.token))
        return { kind: "malformed" };
    return { kind: "ok", credential: new IngestCredential(doc.token, "file") };
}
//# sourceMappingURL=mint.js.map