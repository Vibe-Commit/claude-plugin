/**
 * The device sign-in beat — `CR-234d`, D219, plan item 7 (capture half), T8/T9.
 *
 * `browserCredential`'s sibling for a machine whose browser is not on this machine: it asks for a code,
 * shows it, polls while the person approves elsewhere, spends the resulting mint ticket on ONE credential,
 * and hands the credential to the SAME `finishMint` the loopback flow ends in.
 *
 * ```
 *   discover → POST device_authorization → print URL + code (always) → [open the prefilled link]
 *     → poll /oauth/token  ─ pending / slow_down ─┐
 *                          ├ denied | expired | rate-limited → a §13.6 block, nothing changed
 *                          └ ticket → mint (Bearer vcmt_) → finishMint({ confirm: "always", ticket })
 * ```
 *
 * ## ⛔ What the shared tail guarantees, and why the device flow is the case it exists for
 *
 * In the loopback flow the approver IS the person at this terminal. Here they are not — the code may have
 * been typed by someone a phishing script sent it to (the reverse attack, RFC 8628 §5.4). So the CLI's own
 * confirmation (`account / workspace`, one default-NO question) is the control, and `confirm: "always"`
 * means it is never skipped: not by an unanswered probe, not by a missing handle. The ticket response's
 * `account` and `org_name` stand in when whoami(new) is not answered, and if there is nothing to show at
 * all `finishMint` FAILS CLOSED (A4 §3).
 *
 * ## ⚠ Nothing here writes `session.json`
 *
 * A ticket buys a machine credential, not a read session (D219). The read lane is still `--sign-in`.
 *
 * ## ⚠ The wait is STATIC
 *
 * No spinner and no ticking countdown (DESIGN.md §13.8): the waiting line is printed once, and the expiry is
 * an absolute local time so the screen stays true in a scrollback. The poll loop's clock and sleep are
 * injected — a test advances a virtual clock rather than waiting out five-second intervals.
 */
import { hostname as osHostname } from "node:os";
import { connectDeviceCommandFor } from "../install.js";
import { AUTH, DEVICE, SIGNIN } from "../copy/index.js";
import { discover } from "../oauth/discovery.js";
import { DEFAULT_INTERVAL_S, pollDeviceToken, SLOW_DOWN_STEP_S, startDeviceAuthorization, } from "../oauth/device.js";
import { machineLabel, mintUrl, requestMint } from "../oauth/mint.js";
import { HTTP_TIMEOUT_MS, openBrowser as platformOpenBrowser } from "../oauth/signin.js";
import { paint, renderErrorBlock, wrap } from "../term.js";
import { finishMint } from "./finish_mint.js";
import { writeLines } from "./context.js";
/** Poll failures in a row (a deploy, a blip) before the wait gives up on the service. */
const MAX_TRANSIENT = 3;
/** 429s in a row on the poll before it is reported as a rate limit. */
const MAX_LIMITED = 5;
/** Slack past `expires_in` before the CLIENT calls the code expired; the server's own `expired_token` normally lands first. */
const DEADLINE_GRACE_S = 15;
/** `14:32`, local time, 24-hour — an absolute clock reading, never "in 5 minutes". */
export function clockTime(date) {
    const two = (n) => String(n).padStart(2, "0");
    return `${two(date.getHours())}:${two(date.getMinutes())}`;
}
/** The real SIGINT wait: resolves on the first Ctrl+C, and `dispose` puts the default behaviour back. */
function sigintOnce() {
    let handler = null;
    const promise = new Promise((resolve) => {
        handler = () => resolve();
        process.once("SIGINT", handler);
    });
    return {
        promise,
        dispose: () => {
            if (handler !== null)
                process.removeListener("SIGINT", handler);
        },
    };
}
const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function errorBlock(ctx, code, what, why, fixLabel, fixes) {
    return renderErrorBlock({
        kind: "bad",
        code,
        what,
        why: [why],
        ...(fixLabel === undefined || fixes === undefined ? {} : { fixLabel, fixes }),
    }, ctx.colour);
}
/** The static waiting block (plan decision 4A): URL accent, code strong, the rest muted. */
function waitingBlock(ctx, grant) {
    const expiresAt = new Date(ctx.now().getTime() + grant.expiresInS * 1000);
    const muted = (text) => wrap(text, 2).map((line) => paint(ctx.colour, "muted", line));
    return [
        "",
        ...muted(DEVICE.heading),
        "",
        `    ${paint(ctx.colour, "accent", grant.verificationUri)}`,
        `    ${DEVICE.codeLabel}  ${paint(ctx.colour, "strong", grant.userCode)}`,
        "",
        ...muted(DEVICE.expires(clockTime(expiresAt))),
        ...muted(DEVICE.shareWarning),
        "",
        paint(ctx.colour, "muted", `  ${DEVICE.waiting}`),
    ];
}
export async function deviceCredential(ctx, input, deps = {}) {
    const fetchImpl = deps.fetch ?? fetch;
    const rerun = connectDeviceCommandFor(ctx.env, ctx.selfPath);
    const discovery = await discover(input.endpoint, { fetch: fetchImpl, timeoutMs: HTTP_TIMEOUT_MS });
    if (discovery.kind !== "ok") {
        writeLines(ctx.stderr, [
            "",
            ...errorBlock(ctx, "SIGNIN_SERVICE_NOT_FOUND", SIGNIN.noServerWhat, discovery.kind === "unreachable" ? SIGNIN.noServerUnreachableWhy : SIGNIN.noServerMalformedWhy, DEVICE.retryFix, [rerun]),
        ]);
        return { kind: "failed" };
    }
    const { device_authorization_endpoint, token_endpoint } = discovery.metadata;
    if (device_authorization_endpoint === undefined) {
        writeLines(ctx.stderr, ["", ...errorBlock(ctx, "SIGNIN_CODE_UNSUPPORTED", DEVICE.unsupportedWhat, DEVICE.unsupportedWhy)]);
        return { kind: "failed" };
    }
    const label = machineLabel((deps.hostname ?? osHostname)());
    const http = { fetch: fetchImpl, timeoutMs: HTTP_TIMEOUT_MS };
    const started = await startDeviceAuthorization(device_authorization_endpoint, {
        machineLabel: label,
        // 15A: the org the replaced credential belongs to, only on a 200 — a HINT the approver can change.
        ...(input.prior?.who.kind === "ok" ? { orgId: input.prior.who.orgId } : {}),
    }, http);
    switch (started.kind) {
        case "ok":
            break;
        case "rate-limited":
            writeLines(ctx.stderr, ["", ...rateLimitedBlock(ctx, started.retryAfterS, rerun)]);
            return { kind: "declined" };
        case "refused":
            writeLines(ctx.stderr, ["", ...errorBlock(ctx, "SIGNIN_CODE_REFUSED", DEVICE.refusedWhat, DEVICE.refusedWhy, DEVICE.retryFix, [rerun])]);
            return { kind: "failed" };
        case "unreachable":
            writeLines(ctx.stderr, ["", ...errorBlock(ctx, "SIGNIN_UNREACHABLE", DEVICE.unreachableWhat, DEVICE.unreachableWhy, DEVICE.retryFix, [rerun])]);
            return { kind: "failed" };
        case "malformed":
            writeLines(ctx.stderr, ["", ...errorBlock(ctx, "SIGNIN_ANSWER_UNUSABLE", DEVICE.malformedWhat, DEVICE.malformedWhy, SIGNIN.malformedFix, [rerun])]);
            return { kind: "failed" };
    }
    const grant = started.grant;
    // Printed ALWAYS — whether or not a browser opens (RFC 8628 §3.3.1) — and BEFORE the open, so a
    // browser that steals focus cannot leave the person with nothing to type.
    writeLines(ctx.stdout, waitingBlock(ctx, grant));
    if (input.openLink)
        (deps.openBrowser ?? platformOpenBrowser)(grant.verificationUriComplete);
    const polled = await waitForApproval(ctx, grant, token_endpoint, http, deps);
    if (polled.kind !== "ticket") {
        switch (polled.kind) {
            case "cancelled":
                writeLines(ctx.stdout, ["", paint(ctx.colour, "muted", `  ${DEVICE.cancelled}`)]);
                return { kind: "declined" };
            case "denied":
                writeLines(ctx.stderr, ["", ...errorBlock(ctx, "SIGNIN_DENIED", DEVICE.deniedWhat, DEVICE.deniedWhy, DEVICE.deniedFix, [rerun])]);
                return { kind: "declined" };
            case "code-signin-off":
                writeLines(ctx.stderr, ["", ...gateOffBlock(ctx, rerun)]);
                return { kind: "declined" };
            case "expired":
                writeLines(ctx.stderr, ["", ...errorBlock(ctx, "SIGNIN_TIMED_OUT", DEVICE.expiredWhat, DEVICE.expiredWhy, DEVICE.expiredFix, [rerun])]);
                return { kind: "declined" };
            case "rate-limited":
                writeLines(ctx.stderr, ["", ...rateLimitedBlock(ctx, polled.retryAfterS, rerun)]);
                return { kind: "declined" };
            case "invalid":
                writeLines(ctx.stderr, ["", ...errorBlock(ctx, "SIGNIN_CODE_INVALID", DEVICE.invalidWhat, DEVICE.invalidWhy, DEVICE.retryFix, [rerun])]);
                return { kind: "failed" };
            case "unreachable":
                writeLines(ctx.stderr, ["", ...errorBlock(ctx, "SIGNIN_UNREACHABLE", DEVICE.unreachableWhat, DEVICE.unreachableWhy, DEVICE.retryFix, [rerun])]);
                return { kind: "failed" };
            case "malformed":
                writeLines(ctx.stderr, ["", ...errorBlock(ctx, "SIGNIN_ANSWER_UNUSABLE", DEVICE.malformedWhat, DEVICE.malformedWhy, SIGNIN.malformedFix, [rerun])]);
                return { kind: "failed" };
        }
    }
    // Approved. Spend the ticket on ONE credential.
    writeLines(ctx.stdout, ["", ...wrap(AUTH.minting(label), 2)]);
    const minted = await requestMint(mintUrl(input.endpoint), polled.ticket, label, {
        fetch: fetchImpl,
        timeoutMs: HTTP_TIMEOUT_MS,
    });
    if (minted.kind === "refused" && minted.error === "code_signin_off") {
        writeLines(ctx.stderr, ["", ...gateOffBlock(ctx, rerun)]);
        return { kind: "declined" };
    }
    if (minted.kind !== "ok") {
        writeLines(ctx.stderr, [
            "",
            ...errorBlock(ctx, minted.kind === "refused" && minted.error === "rate_limited" ? "MINT_RATE_LIMITED" : "MINT_FAILED", AUTH.mintFailedWhat, minted.kind === "unreachable"
                ? AUTH.mintUnreachableWhy
                : minted.kind === "refused" && minted.error === "rate_limited"
                    ? AUTH.mintRateLimitedWhy
                    : minted.kind === "malformed"
                        ? AUTH.mintMalformedWhy
                        : DEVICE.redeemFailedWhy, DEVICE.retryFix, [rerun]),
        ]);
        return { kind: "failed" };
    }
    return await finishMint(ctx, {
        minted: minted.credential,
        facts: minted.facts,
        prior: input.prior,
        endpoint: input.endpoint,
        fetch: fetchImpl,
        // The approver is not necessarily the person at this terminal: the question is never skipped (A4 §3).
        confirm: "always",
        ticket: { account: polled.account, orgName: polled.orgName },
        rerun,
        ...(input.scope === undefined ? {} : { scope: input.scope }),
    });
}
function gateOffBlock(ctx, rerun) {
    return errorBlock(ctx, "SIGNIN_CODE_DISABLED", DEVICE.gateOffWhat, DEVICE.gateOffWhy, DEVICE.gateOffFix, [rerun]);
}
function rateLimitedBlock(ctx, retryAfterS, rerun) {
    const fixLabel = retryAfterS === null
        ? DEVICE.rateLimitedFixUnknown
        : DEVICE.rateLimitedFix(clockTime(new Date(ctx.now().getTime() + retryAfterS * 1000)));
    return errorBlock(ctx, "SIGNIN_RATE_LIMITED", DEVICE.rateLimitedWhat, DEVICE.rateLimitedWhy, fixLabel, [rerun]);
}
/**
 * RFC 8628 §3.5's loop. The interval is the server's, `slow_down` raises it for good, and every poll is
 * raced against Ctrl+C — a Ctrl+C during a ten-second request must not wait for the request.
 */
async function waitForApproval(ctx, grant, tokenEndpoint, http, deps) {
    const sleep = deps.sleep ?? realSleep;
    const interrupt = (deps.interrupt ?? sigintOnce)();
    const CANCEL = Symbol("cancel");
    const cancelled = interrupt.promise.then(() => CANCEL);
    const startMs = ctx.now().getTime();
    const deadlineMs = startMs + (grant.expiresInS + DEADLINE_GRACE_S) * 1000;
    let intervalS = grant.intervalS > 0 ? grant.intervalS : DEFAULT_INTERVAL_S;
    let transient = 0;
    let limited = 0;
    try {
        for (;;) {
            if ((await Promise.race([sleep(intervalS * 1000).then(() => null), cancelled])) === CANCEL) {
                return { kind: "cancelled" };
            }
            if (ctx.now().getTime() > deadlineMs)
                return { kind: "expired" };
            const polled = await Promise.race([pollDeviceToken(tokenEndpoint, grant.deviceCode, http), cancelled]);
            if (polled === CANCEL)
                return { kind: "cancelled" };
            switch (polled.kind) {
                case "ticket":
                    return polled;
                case "pending":
                    transient = 0;
                    limited = 0;
                    break;
                case "slow-down":
                    transient = 0;
                    intervalS += SLOW_DOWN_STEP_S;
                    break;
                case "denied":
                case "code-signin-off":
                case "expired":
                case "invalid":
                case "malformed":
                    return polled;
                case "rate-limited":
                    // The poll endpoint's own limiter. Back off like `slow_down`, and only report it when it persists.
                    limited += 1;
                    if (limited >= MAX_LIMITED)
                        return polled;
                    intervalS += SLOW_DOWN_STEP_S;
                    break;
                case "server-error":
                case "unreachable":
                    transient += 1;
                    if (transient >= MAX_TRANSIENT)
                        return { kind: "unreachable" };
                    break;
            }
        }
    }
    finally {
        interrupt.dispose();
    }
}
//# sourceMappingURL=device_credential.js.map