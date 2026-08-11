/**
 * The sign-in flow, and the refresh that keeps it alive.
 *
 * ```
 *   discover  ──►  PKCE + state  ──►  loopback listener on 127.0.0.1:0
 *       │                                      │
 *       │                          browser ────┘  code + state + iss
 *       ▼                                      ▼
 *   authorize URL  ─────────────────────►  exchange  ──►  session.json
 * ```
 *
 * Every step's failure is a NAMED outcome rather than an exception, because each
 * one wants a different fix line: an unreachable discovery document is "the
 * server is down", a denied grant is "you declined", and a malformed token
 * response is ours to fix, not the user's.
 *
 * ## `authorizedAccessToken` is the part to read carefully
 *
 * It is the only caller of `refreshGrant`, and it takes `withRefreshLock` around
 * a **re-read of the session from disk**. That order is the whole control: by
 * the time a waiter gets the lock, the winner has rotated and saved, so the tail
 * the waiter loaded before waiting is already a parent row — and presenting it
 * is the replay that revokes the family and signs the user out everywhere. See
 * `lock.ts`'s module note for why that is a Tuesday and not an edge case.
 */
import { spawn } from "node:child_process";
import { discover } from "./discovery.js";
import { listenForCallback } from "./loopback.js";
import { REFRESH_REQUEST_TIMEOUT_MS, withRefreshLock } from "./lock.js";
import { generatePkce, generateState } from "./pkce.js";
import { callTool } from "./read.js";
import { isFresh, loadSession, saveSession } from "./session.js";
import { buildAuthorizeUrl, exchangeCode, refreshGrant } from "./token.js";
/**
 * How long the browser round trip may take. It contains a full identity-provider
 * login — reading an email, a password manager, possibly a second factor — so
 * the bound is a human's attention span rather than a network budget. Five
 * minutes is long enough not to punish a slow login and short enough that an
 * abandoned attempt does not leave a listener bound for the rest of the session.
 */
export const SIGNIN_DEADLINE_MS = 5 * 60_000;
/** How long each HTTP step gets. Discovery and the code exchange are both fast. */
export const HTTP_TIMEOUT_MS = 10_000;
/**
 * Open a URL in the platform browser.
 *
 * Detached and with its streams discarded: the browser is not this process's
 * child in any meaningful sense, and leaving a pipe attached would keep the CLI
 * alive until the browser exits — which on a long-running browser is forever.
 * Returns false rather than throwing when there is nothing to open with, because
 * a headless machine is a perfectly ordinary place to run this and the URL
 * printed to the terminal is a complete fallback.
 */
export function openBrowser(url) {
    const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    try {
        const child = spawn(command, [url], { detached: true, stdio: "ignore" });
        // An ENOENT from `spawn` arrives asynchronously as an 'error' event, not as
        // a throw. Without this handler it becomes an unhandled exception on a
        // machine that simply has no `xdg-open` — a crash instead of a fallback.
        child.on("error", () => { });
        child.unref();
        return true;
    }
    catch {
        return false;
    }
}
/** Discovery's failure, flattened to the shape the caller renders. */
function noServer(d) {
    return { kind: "no-server", detail: d.kind === "unreachable" ? "unreachable" : d.detail };
}
/** A token-endpoint failure, flattened the same way. */
function fromToken(outcome) {
    if (outcome.kind === "denied")
        return { kind: "rejected", error: outcome.error };
    return outcome.kind === "unreachable" ? { kind: "unreachable" } : { kind: "malformed" };
}
/**
 * Run one sign-in, end to end.
 *
 * The listener is started BEFORE the browser is opened and closed in a
 * `finally`, so there is no window in which the redirect can arrive at a port
 * nobody is listening on, and no path on which a socket outlives the attempt.
 */
export async function signIn(deps) {
    const timeoutMs = deps.timeoutMs ?? HTTP_TIMEOUT_MS;
    const discovery = await discover(deps.mcpEndpoint, { fetch: deps.fetch, timeoutMs });
    if (discovery.kind !== "ok")
        return noServer(discovery);
    const { issuer, authorization_endpoint, token_endpoint } = discovery.metadata;
    const pkce = generatePkce();
    const state = generateState();
    const loopback = await listenForCallback({
        expectedState: state,
        expectedIssuer: issuer,
        deadlineMs: deps.deadlineMs ?? SIGNIN_DEADLINE_MS,
        page: deps.page,
    });
    let callback;
    try {
        const url = buildAuthorizeUrl(authorization_endpoint, {
            challenge: pkce.challenge,
            state,
            redirectUri: loopback.redirectUri,
        });
        deps.onAuthorizeUrl(url, deps.openBrowser(url));
        callback = await loopback.result;
    }
    finally {
        loopback.close();
    }
    if (callback.kind === "timeout")
        return { kind: "timeout" };
    if (callback.kind === "denied")
        return { kind: "denied", error: callback.error };
    const exchanged = await exchangeCode(token_endpoint, {
        code: callback.code,
        codeVerifier: pkce.verifier,
        // Byte-identical to the one presented at authorize — the server compares
        // them and answers `invalid_grant` on any difference.
        redirectUri: loopback.redirectUri,
    }, { fetch: deps.fetch, timeoutMs, nowMs: deps.nowMs() });
    if (exchanged.kind !== "ok")
        return fromToken(exchanged);
    const session = { tokens: exchanged.tokens, issuer, tokenEndpoint: token_endpoint };
    saveSession(deps.home, session);
    return { kind: "ok", session };
}
/**
 * A usable access token, refreshing under the cross-process lock if needed.
 *
 * The fast path takes no lock at all: a fresh access token is the common case
 * and serialising every read behind a lock file would be a needless cost on
 * every command.
 */
export async function authorizedAccessToken(deps) {
    const load = loadSession(deps.home);
    if (load.kind !== "ok")
        return { kind: "no-session", load };
    const { access, expiresAtMs, refresh } = load.session.tokens;
    if (isFresh(load.session, deps.nowMs()))
        return { kind: "ok", access, expiresAtMs, refresh };
    return await rotateUnderLock(deps, refresh);
}
/**
 * Take the cross-process lock and rotate — unless somebody else already did.
 *
 * `superseded` is the refresh token the caller found unusable. Under the lock
 * the session is re-read, and if the stored token is no longer that one, another
 * process rotated while we waited: its token is the live one, and rotating again
 * would present a token that is already a parent row. That is the family revoke,
 * so the check is the point of the function rather than an optimisation.
 *
 * ⚠ `/cso` finding, HIGH: this compares the TOKEN, not the expiry it used to
 * compare. `expiresAtMs` is `nowMs + expires_in * 1000`, so two rotations
 * sampling the same millisecond with the same lifetime produce the SAME number —
 * and the guard would then read "nobody rotated" immediately after somebody did,
 * present the dead token, and revoke the family. Over a real network the
 * round trip makes that collision vanishingly unlikely; over loopback it is
 * merely unlikely. The refresh token is 32 random bytes and cannot collide, so
 * the narrow window closes rather than shrinking.
 */
async function rotateUnderLock(deps, superseded) {
    const locked = await withRefreshLock(deps.home, async () => {
        // ⚠ RE-READ INSIDE THE LOCK, ALWAYS. See the module note: the session was
        // loaded before waiting, and if we waited at all, the winner has already
        // rotated and saved.
        const current = loadSession(deps.home);
        if (current.kind !== "ok")
            return { kind: "no-session", load: current };
        if (current.session.tokens.refresh.expose() !== superseded.expose()) {
            const { access, expiresAtMs, refresh } = current.session.tokens;
            return { kind: "ok", access, expiresAtMs, refresh };
        }
        const rotated = await refreshGrant(current.session.tokenEndpoint, current.session.tokens.refresh, {
            fetch: deps.fetch,
            timeoutMs: deps.timeoutMs ?? REFRESH_REQUEST_TIMEOUT_MS,
            nowMs: deps.nowMs(),
        });
        if (rotated.kind === "denied")
            return { kind: "expired", error: rotated.error };
        if (rotated.kind === "unreachable")
            return { kind: "unreachable" };
        if (rotated.kind === "malformed")
            return { kind: "malformed" };
        // Saved BEFORE returning, and before any read uses it: the old token is dead
        // the instant the server answered, so a crash between here and the save
        // would lose the only live token in the family.
        const next = { ...current.session, tokens: rotated.tokens };
        saveSession(deps.home, next);
        return {
            kind: "ok",
            access: next.tokens.access,
            expiresAtMs: next.tokens.expiresAtMs,
            refresh: next.tokens.refresh,
        };
    });
    return locked.kind === "ok" ? locked.value : { kind: "busy" };
}
/**
 * Call a read tool with the signed-in user's token: refresh ONCE, retry ONCE.
 *
 * The bound is STRUCTURAL rather than a counter — two `callTool` statements, no
 * loop — because "retry until it works" against an endpoint that keeps answering
 * 401 is how a client turns one expired token into a revoked family.
 *
 * The second attempt exists because a token can be fresh by the clock and
 * rejected anyway: a revoked family, a rotated signing key, or a machine whose
 * clock is simply wrong. Those look identical from here, and one retry after a
 * genuine rotation resolves all three or fails honestly.
 */
export async function readWithSession(mcpEndpoint, name, args, deps) {
    const first = await authorizedAccessToken(deps);
    if (first.kind !== "ok")
        return { kind: "not-authorized", authorized: first };
    const outcome = await callTool(mcpEndpoint, first.access, name, args, deps.read);
    if (outcome.kind !== "unauthorized")
        return outcome;
    const second = await rotateUnderLock(deps, first.refresh);
    if (second.kind !== "ok")
        return { kind: "not-authorized", authorized: second };
    return await callTool(mcpEndpoint, second.access, name, args, deps.read);
}
//# sourceMappingURL=signin.js.map