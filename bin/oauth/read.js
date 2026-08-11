/**
 * The read transport: ONE `tools/call` POST to the EXISTING `/mcp` endpoint.
 *
 * ## What this is not
 *
 * There is no REST `/read` route, no second Fly app, no second hostname and no
 * second PRM document (D73, which closed `CR-083` as unnecessary and recorded
 * the "2nd Fly app (read lane)" provisioning item as CLOSED — NOT NEEDED). A
 * read is the same endpoint the agent already talks to, with a user-principal
 * bearer instead of a machine one.
 *
 * There is also no third audience set. The access token is minted at
 * `mcpAcceptedAudiences`, which is typed `readonly [string]` and populated as a
 * ONE-element tuple. `readAcceptedAudiences` is GONE — `CR-084b` deleted it
 * (merged after this client was written, re-verified against it), and the claim
 * it encoded (that a machine credential can read) was false as built anyway: a
 * `vcik_` is opaque base64url with no dots, so the JWT verifier rejects it
 * before any audience check runs.
 *
 * ## The envelope
 *
 * A successful `tools/call` returns `result.content[0].text` carrying a JSON
 * DOCUMENT — every tool in the server ends
 * `{ content: [{ type: "text", text: JSON.stringify(payload) }] }`. So the
 * caller parses that string; it does not read a typed result off the JSON-RPC
 * envelope directly.
 *
 * ⚠ A tool's OWN failures travel the same way — one text part with a JSON body,
 * plus `isError: true`. They are not JSON-RPC errors and not HTTP errors, and a
 * caller that only branched on the transport would read one as success. So
 * `document` is returned uninterpreted with `isError` beside it: parse ONCE,
 * branch after, which is exactly what the server's seam says this client does.
 *
 * `CR-084b` pins both forms with a golden test and names this client as the
 * envelope's external consumer, so the shape is a contract with an owner rather
 * than a convention that happens to hold.
 *
 * @provenance vibecommit-mcp src/handshake/router.ts — JSON-RPC methods, retyped
 * @provenance vibecommit-mcp src/handshake/tools.ts — `tools/call` params, retyped
 * @provenance vibecommit-mcp src/tools/query_history.ts — `content[0].text` envelope, retyped
 */
/** JSON-RPC 2.0. The server rejects anything else at `validateRequest`. */
const JSONRPC_VERSION = "2.0";
/**
 * Call one read tool.
 *
 * `id` is fixed at 1: this is a single request/response over a fresh connection
 * with no batching and no notifications, so a counter would be state kept for
 * nobody. The server echoes it and nothing correlates on it.
 */
export async function callTool(mcpEndpoint, access, name, args, deps) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deps.timeoutMs);
    let res;
    try {
        res = await deps.fetch(mcpEndpoint, {
            method: "POST",
            headers: {
                // The one place this token's plaintext is used — the request boundary,
                // the same discipline `post.ts` states for the ingest credential.
                authorization: `Bearer ${access.expose()}`,
                "content-type": "application/json",
                accept: "application/json",
            },
            body: JSON.stringify({
                jsonrpc: JSONRPC_VERSION,
                id: 1,
                method: "tools/call",
                params: { name, arguments: args },
            }),
            signal: controller.signal,
            // undici strips Authorization across origins, so a followed redirect would
            // arrive unauthenticated and read as a mysterious 401 — and one that did
            // NOT cross origins would carry the bearer somewhere unconfigured.
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
        return { kind: "malformed" };
    }
    const envelope = body;
    if (envelope.error !== undefined && envelope.error !== null) {
        const { code, message } = envelope.error;
        return {
            kind: "rpc-error",
            code: typeof code === "number" ? code : 0,
            message: typeof message === "string" ? message : "",
        };
    }
    const content = envelope.result?.content;
    if (!Array.isArray(content) || content.length === 0)
        return { kind: "malformed" };
    const text = content[0].text;
    if (typeof text !== "string")
        return { kind: "malformed" };
    try {
        return {
            kind: "ok",
            document: JSON.parse(text),
            // Strictly `=== true`: the field is OPTIONAL on the wire, so an absent one
            // must read as "not an error" rather than as anything truthy-ish.
            isError: envelope.result?.isError === true,
        };
    }
    catch {
        return { kind: "malformed" };
    }
}
//# sourceMappingURL=read.js.map