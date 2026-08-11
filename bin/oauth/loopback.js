/**
 * The one-shot loopback listener that catches the authorization redirect.
 *
 * ## ⚠ THE HOST IS THE LITERAL `127.0.0.1`, NEVER `localhost`
 *
 * The server's redirect-URI policy (`vibecommit-mcp/src/oauth/loopback.ts`,
 * read for its RULE and not imported — closed source, D60 §D1a) accepts
 * `http://127.0.0.1:<any port>` and `http://[::1]:<any port>` per RFC 8252 §7.3,
 * and REJECTS the literal string `localhost` with `localhost_disallowed`,
 * because DNS resolution of `localhost` is OS-configurable and could point at a
 * different host. So `redirect_uri` is built from the literal below, and the
 * socket is bound to that same literal.
 *
 * **A client that builds `http://localhost:<port>` fails in a way that looks
 * like a config problem rather than a spelling one** — the browser round-trip
 * works, the listener receives nothing, and the visible symptom is a hang. That
 * is why `test/oauth-loopback.test.ts` asserts the host rather than asserting
 * that the flow completes.
 *
 * ## What this listener refuses
 *
 * `state` (RFC 6749 §10.12) and `iss` (RFC 9207) are both checked, and a request
 * failing either is answered 400 and **does not end the wait**. Ending the wait
 * on a bad request would let anything able to reach the port cancel a sign-in;
 * accepting it would be a CSRF hole with a green happy-path suite over it, which
 * is the specific vacuity this task was briefed on.
 *
 * @provenance vibecommit-mcp src/oauth/loopback.ts — redirect-URI policy, retyped
 * @provenance vibecommit-mcp src/transport/server.ts — the code+state+iss handoff, retyped
 */
import { createServer } from "node:http";
import { statesMatch } from "./pkce.js";
/**
 * The literal the server's policy admits. **Not a default — a requirement.**
 * Changing this to `localhost` is refused by the authorization server.
 */
export const LOOPBACK_HOST = "127.0.0.1";
/** The path the redirect lands on. Any path is legal; a fixed one is readable. */
export const CALLBACK_PATH = "/callback";
/**
 * Bind an ephemeral loopback port and wait for one authorization redirect.
 *
 * Port 0 rather than a fixed port: RFC 8252 §7.3 requires the AS to accept any
 * port on the loopback for exactly this reason, and a fixed port collides with a
 * second terminal and with whatever else on the machine wanted it.
 */
export async function listenForCallback(opts) {
    let settle;
    const result = new Promise((resolve) => {
        settle = resolve;
    });
    const server = createServer((req, res) => {
        // `req.url` is a path with a query, so it needs a base to parse. The base is
        // this listener's own address and is never used for anything else.
        const url = new URL(req.url ?? "/", `http://${LOOPBACK_HOST}`);
        const verdict = classify(url.searchParams, opts);
        if (verdict === null) {
            // Neither acceptable nor a recognised denial: answer, and keep waiting.
            // A stray request must not be able to cancel somebody's sign-in.
            res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
            res.end(opts.page.refused);
            return;
        }
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        res.end(verdict.kind === "code" ? opts.page.done : opts.page.refused);
        finish(verdict);
    });
    const timer = setTimeout(() => finish({ kind: "timeout" }), opts.deadlineMs);
    // The deadline must not by itself hold the process open — the flow is awaited
    // elsewhere, and a stray timer keeping Node alive after a `close()` is the
    // same class of bug as the socket this module is careful to shut.
    timer.unref();
    let closed = false;
    const close = () => {
        if (closed)
            return;
        closed = true;
        clearTimeout(timer);
        // ⚠ `close()` alone waits for KEEP-ALIVE sockets to go idle, and a browser
        // holds one open after the tab renders. Without this the CLI sits there with
        // the code already exchanged, which reads to a user as a hang at the last
        // step. `closeAllConnections` is why the listener actually goes away.
        server.closeAllConnections();
        server.close();
    };
    const finish = (value) => {
        close();
        settle(value);
    };
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        // The LITERAL, both here and in the redirect_uri below. See the module note.
        server.listen(0, LOOPBACK_HOST, resolve);
    });
    const { port } = server.address();
    return { redirectUri: `http://${LOOPBACK_HOST}:${port}${CALLBACK_PATH}`, result, close };
}
/**
 * Decide what one inbound request is: the callback, a denial, or noise.
 *
 * Null means "not this attempt's callback" — the caller keeps waiting. The
 * ORDER matters: `state` is checked before anything is read out of the query,
 * so an unauthenticated caller cannot use the `error` branch to end a wait it
 * does not own.
 */
function classify(params, opts) {
    const state = params.get("state");
    if (state === null || !statesMatch(opts.expectedState, state))
        return null;
    // RFC 9207 issuer identification, D26's exact-string match. Applied to the
    // ERROR redirect too: a mix-up attack is not less of one because the response
    // it forged happens to be a refusal.
    const iss = params.get("iss");
    if (iss !== opts.expectedIssuer)
        return null;
    const error = params.get("error");
    if (error !== null && error !== "")
        return { kind: "denied", error };
    const code = params.get("code");
    if (code === null || code === "")
        return null;
    return { kind: "code", code };
}
//# sourceMappingURL=loopback.js.map