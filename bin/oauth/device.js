/**
 * The device-authorization client — RFC 8628 for the capture CLI, `CR-234d`, D219.
 *
 * ## What the grant is FOR
 *
 * A machine with no browser (an SSH box, a devcontainer) cannot run the loopback sign-in. Here the machine
 * asks for a code, shows it, and polls while the person approves on a device that DOES have a browser.
 * What approval yields is not a session: it is a single-use MINT TICKET (`vcmt_…`, R4) that buys exactly one
 * ingest credential at the mint route. Nothing is written to `session.json`.
 *
 * ```
 *   POST <device_authorization_endpoint>   { client_id, machine_label, org_id? }
 *     200 { device_code, user_code, verification_uri, verification_uri_complete, expires_in, interval }
 *     429 { error: "rate_limited", retry_after }  + Retry-After
 *
 *   POST <token_endpoint>   grant_type=urn:ietf:params:oauth:grant-type:device_code & device_code & client_id
 *     400 authorization_pending | slow_down | access_denied | expired_token | invalid_grant | invalid_request
 *     200 { access_token: "vcmt_…", token_type: "mint_ticket", expires_in, account, org_name }
 * ```
 *
 * ⚠ The endpoint is DISCOVERED (`discovery.ts`), never built from the issuer. And a poll answer this client
 * does not recognise is `malformed`, never a quiet "keep waiting" — a loop that cannot tell a new error from
 * a pending one polls a dead code until its deadline.
 *
 * @provenance vibecommit-mcp src/oauth/device.ts — the device_authorization and device_code-grant request and response shapes, retyped
 * @provenance vibecommit-mcp src/transport/server.ts — POST /oauth/device_authorization and the device_code grant on /oauth/token, retyped
 */
import { DeviceCode, MintTicket, isMintTicketShape } from "../credential.js";
import { isAllowedIngestUrl } from "../post.js";
import { CLIENT_ID } from "./token.js";
/** RFC 8628 §3.4. */
export const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
/** The server's default poll spacing when it names none (RFC 8628 §3.2). */
export const DEFAULT_INTERVAL_S = 5;
/** `slow_down` adds this many seconds to the interval for the rest of the flow (RFC 8628 §3.5). */
export const SLOW_DOWN_STEP_S = 5;
/**
 * The `user_code` as the person is shown it. Deliberately loose about the ALPHABET — the server owns that and
 * a client copy of it is a second place for it to drift — but strict about the SHAPE, because this string is
 * printed to a terminal: an escape sequence or a newline from a hostile server must never reach it.
 */
/**
 * The server's `error_description` on an `access_denied` that is the 16C gate rather than a person's "no"
 * (brief A7). Compared EXACTLY: a description this client does not recognise is an ordinary denial, which is
 * the conservative reading — it shows the Denied block and changes nothing.
 */
export const GATE_OFF_DESCRIPTION = "code sign-in is off for this account";
const USER_CODE_SHAPE = /^[A-Z0-9]{3,6}-[A-Z0-9]{3,6}$/;
async function postWithTimeout(url, init, http) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), http.timeoutMs);
    try {
        const res = await http.fetch(url, {
            method: "POST",
            headers: { "content-type": init.contentType, accept: "application/json" },
            body: init.body,
            signal: controller.signal,
            // Same reason as every other lane: a followed redirect carries the body somewhere unconfigured.
            redirect: "error",
        });
        return { res };
    }
    catch {
        return null;
    }
    finally {
        clearTimeout(timer);
    }
}
async function readJson(res) {
    try {
        const body = (await res.json());
        return body !== null && typeof body === "object" && !Array.isArray(body) ? body : null;
    }
    catch {
        return null;
    }
}
/** `Retry-After` as whole seconds, or null. `Number(null)` is 0, which is why this does not use it. */
function retryAfterSeconds(res, body) {
    const fromBody = body?.retry_after;
    if (typeof fromBody === "number" && Number.isFinite(fromBody) && fromBody > 0)
        return Math.ceil(fromBody);
    const header = res.headers.get("retry-after");
    if (header === null)
        return null;
    const n = Number(header);
    return Number.isFinite(n) && n > 0 ? Math.ceil(n) : null;
}
function positiveInt(value) {
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}
/** Ask the server for a device code. */
export async function startDeviceAuthorization(endpoint, request, http) {
    const sent = await postWithTimeout(endpoint, {
        contentType: "application/json",
        body: JSON.stringify({
            client_id: CLIENT_ID,
            machine_label: request.machineLabel,
            ...(request.orgId === undefined ? {} : { org_id: request.orgId }),
        }),
    }, http);
    if (sent === null)
        return { kind: "unreachable" };
    const { res } = sent;
    const doc = await readJson(res);
    if (res.status === 429)
        return { kind: "rate-limited", retryAfterS: retryAfterSeconds(res, doc) };
    if (res.status !== 200) {
        return { kind: "refused", status: res.status, error: typeof doc?.error === "string" ? doc.error : "" };
    }
    if (doc === null)
        return { kind: "malformed" };
    const { device_code, user_code, verification_uri, verification_uri_complete } = doc;
    const expiresInS = positiveInt(doc.expires_in);
    if (typeof device_code !== "string" ||
        device_code === "" ||
        typeof user_code !== "string" ||
        !USER_CODE_SHAPE.test(user_code.toUpperCase()) ||
        typeof verification_uri !== "string" ||
        typeof verification_uri_complete !== "string" ||
        expiresInS === null) {
        return { kind: "malformed" };
    }
    // Both URIs are printed or opened on the person's machine: https, or http on a loopback, and nothing else.
    if (!isAllowedIngestUrl(verification_uri) || !isAllowedIngestUrl(verification_uri_complete)) {
        return { kind: "malformed" };
    }
    return {
        kind: "ok",
        grant: {
            deviceCode: new DeviceCode(device_code),
            userCode: user_code.toUpperCase(),
            verificationUri: verification_uri,
            verificationUriComplete: verification_uri_complete,
            expiresInS,
            intervalS: positiveInt(doc.interval) ?? DEFAULT_INTERVAL_S,
        },
    };
}
/** One poll of the token endpoint. */
export async function pollDeviceToken(tokenEndpoint, deviceCode, http) {
    const sent = await postWithTimeout(tokenEndpoint, {
        contentType: "application/x-www-form-urlencoded",
        body: new URLSearchParams({
            grant_type: DEVICE_GRANT_TYPE,
            // The request boundary — the one place this secret's plaintext is used.
            device_code: deviceCode.expose(),
            client_id: CLIENT_ID,
        }).toString(),
    }, http);
    if (sent === null)
        return { kind: "unreachable" };
    const { res } = sent;
    const doc = await readJson(res);
    if (res.status === 429)
        return { kind: "rate-limited", retryAfterS: retryAfterSeconds(res, doc) };
    if (res.status >= 500)
        return { kind: "server-error" };
    if (res.status === 200) {
        if (doc === null)
            return { kind: "malformed" };
        const token = doc.access_token;
        // Both halves of the class check: the prefix, and the type the server says it is. A bearer that is
        // not a mint ticket must never be spent at the mint route as one.
        if (typeof token !== "string" || !isMintTicketShape(token) || doc.token_type !== "mint_ticket") {
            return { kind: "malformed" };
        }
        const text = (v) => (typeof v === "string" && v !== "" ? v : null);
        return {
            kind: "ticket",
            ticket: new MintTicket(token),
            expiresInS: positiveInt(doc.expires_in),
            account: text(doc.account),
            orgName: text(doc.org_name),
        };
    }
    switch (typeof doc?.error === "string" ? doc.error : "") {
        case "authorization_pending":
            return { kind: "pending" };
        case "slow_down":
            return { kind: "slow-down" };
        case "access_denied":
            return doc?.error_description === GATE_OFF_DESCRIPTION ? { kind: "code-signin-off" } : { kind: "denied" };
        case "expired_token":
            return { kind: "expired" };
        case "invalid_grant":
            return { kind: "invalid" };
        default:
            // `invalid_request`, `unauthorized_client`, a body with no `error`, a 3xx/4xx nobody documented.
            return { kind: "malformed" };
    }
}
//# sourceMappingURL=device.js.map