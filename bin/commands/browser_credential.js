/**
 * The browser beats — sign in, then buy this machine's ingest credential with
 * that sign-in. `CR-084d` wrote the first; `CR-226` adds the second.
 *
 * ## Why these live together, and outside `connect`
 *
 * Sign-in used to be `connect`'s private beat, reachable only behind
 * `--sign-in`, for a reason its own note gave: *"sign-in cannot mint the
 * credential the rest of `connect` is about."* `CR-226` put a route in front of
 * the minter, so that sentence stopped being true — and two verbs now need the
 * pair. `auth` runs it first and falls back to the paste it has always had;
 * `connect` runs it when a fresh machine reaches the credential beat with a
 * human at the terminal. One copy of the sequence, two callers.
 *
 * ## ⚠ Browser FIRST, never browser ONLY (FOUNDER_OAUTH_PROPOSAL decision 2)
 *
 * Every failure here returns `failed` and leaves the machine exactly as it was:
 * no half-written file, no deleted session. The caller then offers the paste
 * path, which is the path that worked before this module existed. There is no
 * outcome of this function that makes the pre-`CR-226` state worse, and that is
 * the property that made it safe to wire a mechanism that had never run.
 *
 * ## ⚠ And never for a machine that already has a credential
 *
 * `VIBECOMMIT_TOKEN` is read before the file (D56) and still is; this module
 * does not read either. It is the CALLER's job to reach it only when there is
 * nothing to use — `connect` gates on `absent`, and `auth` is the verb a user
 * types precisely to replace what is there.
 */
import { hostname as osHostname } from "node:os";
import { headlessReason } from "../device_mode.js";
import { channelCommand, resolveOnPath } from "../install.js";
import { AUTH, COMMANDS, SIGNIN } from "../copy/index.js";
import { loadCredential } from "../credential.js";
import { EXIT } from "../exit.js";
import { mcpUrl } from "../oauth/discovery.js";
import { machineLabel } from "../oauth/mint.js";
import { loadSession } from "../oauth/session.js";
import { authorizedAccessToken, HTTP_TIMEOUT_MS, mintWithSession, openBrowser as platformOpenBrowser, signIn, } from "../oauth/signin.js";
import { paint, renderErrorBlock, wrap } from "../term.js";
import { writeLines } from "./context.js";
import { deviceCredential } from "./device_credential.js";
import { finishMint } from "./finish_mint.js";
import { probeCredential } from "./probe.js";
// `finishMint` and its types moved to `finish_mint.ts` (`CR-234d`) so the device flow can share them without
// a cycle. Re-exported here because this is where every caller and test has always found them.
export { finishMint } from "./finish_mint.js";
/** The question's scope and the hold, passed down only when set (exactOptionalPropertyTypes). */
function scopeOf(options) {
    return {
        ...(options.scope === undefined ? {} : { scope: options.scope }),
        ...(options.hold === undefined ? {} : { hold: options.hold }),
    };
}
/** `signInBeat`'s sentinel for "no browser, go to the device flow". Never an exit code a verb returns. */
export const NO_BROWSER = -1;
/**
 * The browser sign-in beat — `CR-084d`.
 *
 * Opt-in inside `connect` (`--sign-in`) for the read lane, and the first half of
 * `browserCredential` below. When a session already exists it is a no-op that
 * says so; it never replaces a working session.
 */
export async function signInBeat(ctx, options) {
    if (options.replace !== true && loadSession(ctx.home).kind === "ok") {
        const live = options.verify === true
            ? await authorizedAccessToken({
                home: ctx.home,
                fetch: options.fetch ?? fetch,
                nowMs: () => ctx.now().getTime(),
            })
            : null;
        if (live === null || live.kind !== "expired") {
            writeLines(ctx.stdout, wrap(SIGNIN.alreadySignedIn, 2));
            return EXIT.ok;
        }
        // The refresh grant was refused: the session is over. Sign in again below.
    }
    const endpoint = mcpUrl(ctx.env);
    if (endpoint === null) {
        writeLines(ctx.stderr, signInError(ctx, options.retry, "SIGNIN_SERVICE_NOT_FOUND", SIGNIN.noServerWhat, SIGNIN.noServerRefusedWhy));
        return EXIT.failure;
    }
    const outcome = await signIn({
        home: ctx.home,
        mcpEndpoint: endpoint,
        fetch: options.fetch ?? fetch,
        nowMs: () => ctx.now().getTime(),
        openBrowser: options.openBrowser ?? platformOpenBrowser,
        ...(options.orgId === undefined ? {} : { orgId: options.orgId }),
        ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
        ...(options.fallbackToDevice === true ? { fallbackOnNoBrowser: true } : {}),
        onAuthorizeUrl: (url, opened) => {
            writeLines(ctx.stdout, [
                "",
                ...wrap(opened ? SIGNIN.opening : SIGNIN.manualLabel, 2),
                // `accent` on a URL is §13.1's one exception, and the line carries no
                // second colour. Printed on BOTH paths: a user who wants to open it in a
                // different browser than the default should not have to guess it.
                `  ${paint(ctx.colour, "accent", url)}`,
                ...(opened ? wrap(SIGNIN.waiting, 2) : []),
            ]);
        },
        page: { done: SIGNIN.browserDone, refused: SIGNIN.browserRefused },
    });
    if (outcome.kind === "ok") {
        writeLines(ctx.stdout, ["", ...wrap(SIGNIN.done, 2)]);
        return EXIT.ok;
    }
    if (outcome.kind === "no-browser")
        return NO_BROWSER;
    writeLines(ctx.stderr, ["", ...signInFailure(ctx, options.retry, outcome)]);
    return EXIT.failure;
}
/** §13.6's shape for a sign-in failure. One renderer, six outcomes. */
function signInFailure(ctx, retry, outcome) {
    switch (outcome.kind) {
        case "no-server":
            return signInError(ctx, retry, "SIGNIN_SERVICE_NOT_FOUND", SIGNIN.noServerWhat, outcome.detail === "unreachable"
                ? SIGNIN.noServerUnreachableWhy
                : SIGNIN.noServerMalformedWhy, SIGNIN.noServerFix);
        case "denied":
            return signInError(ctx, retry, "SIGNIN_DENIED", SIGNIN.deniedWhat, SIGNIN.deniedWhy, SIGNIN.deniedFix);
        case "timeout":
            return signInError(ctx, retry, "SIGNIN_TIMED_OUT", SIGNIN.timeoutWhat, SIGNIN.timeoutWhy, SIGNIN.timeoutFix);
        case "rejected":
            return signInError(ctx, retry, "SIGNIN_CLIENT_REFUSED", SIGNIN.rejectedWhat, SIGNIN.rejectedWhy, SIGNIN.rejectedFix);
        case "unreachable":
            return signInError(ctx, retry, "SIGNIN_UNREACHABLE", SIGNIN.unreachableWhat, SIGNIN.unreachableWhy, SIGNIN.unreachableFix);
        case "malformed":
            return signInError(ctx, retry, "SIGNIN_ANSWER_UNUSABLE", SIGNIN.malformedWhat, SIGNIN.malformedWhy, SIGNIN.malformedFix);
    }
}
function signInError(ctx, retry, code, what, why, fixLabel = SIGNIN.noServerFix) {
    return renderErrorBlock({
        kind: "bad",
        code,
        what,
        why: [why],
        fixLabel,
        fixes: [
            channelCommand(ctx.env, ctx.selfPath, retry === "auth" ? COMMANDS.auth : retry === "connect" ? COMMANDS.connect : COMMANDS.signIn),
        ],
    }, ctx.colour);
}
/**
 * Sign in if needed, mint this machine's credential, save it — `CR-226`.
 *
 * Prints its own progress and its own failure; prints NOTHING on success,
 * because what comes next differs by caller (`auth` ends, `connect` goes on to
 * capture) and a confirmation here would be a second one.
 */
export async function browserCredential(ctx, retry, deps = {}, options = {}) {
    // Resolved ONCE and handed to both halves, so the session and the credential
    // cannot come from two different servers.
    const endpoint = mcpUrl(ctx.env);
    if (endpoint === null) {
        writeLines(ctx.stderr, signInError(ctx, retry, "SIGNIN_SERVICE_NOT_FOUND", SIGNIN.noServerWhat, SIGNIN.noServerRefusedWhy));
        return { kind: "failed" };
    }
    const fetchImpl = deps.fetch ?? fetch;
    // ⛔ THE CREDENTIAL THIS RE-AUTH REPLACES, and only from the FILE (plan item 2). `VIBECOMMIT_TOKEN`
    // wins `loadCredential`, so an exported variable makes `source` "env" and `prior` null: an
    // environment credential is the CI path (D56) and is never probed, bound or retired from here.
    const loaded = loadCredential({ env: ctx.env, home: ctx.home });
    const prior = loaded.kind === "ok" && loaded.credential.source === "file"
        ? {
            credential: loaded.credential,
            // Not recorded: it is about to be replaced, and its facts must not outlive it.
            who: await probeCredential(ctx, loaded.credential, fetchImpl, { record: false }),
        }
        : null;
    // ⛔ DEVICE MODE (`CR-234d`, plan item 7). By request (`--device`), or because this machine has no browser
    // of its own: an SSH session, or a Linux box with no display. The loopback sign-in would open a browser
    // nobody can see and wait out its deadline, so the machine asks for a code instead. The prefilled link is
    // opened only where a browser plausibly exists — `--device` on a desktop — never on a headless box.
    const headless = headlessReason(ctx.env, deps.platform ?? process.platform);
    if (options.device === true || headless !== null) {
        return await deviceCredential(ctx, { endpoint, prior, openLink: headless === null, ...scopeOf(options) }, deps);
    }
    const signedIn = await signInBeat(ctx, {
        ...deps,
        retry,
        // 2(a): ask the authorize page to bind the org the old credential belongs to. Only on a 200 —
        // an org the server would not vouch for is not worth asking for.
        ...(prior?.who.kind === "ok" ? { orgId: prior.who.orgId } : {}),
        // A browser that cannot be opened is a headless machine the check above did not recognise: go to
        // the device flow rather than print a URL and wait for a callback nobody can make.
        fallbackToDevice: true,
        openBrowser: deps.openBrowser ?? ((url) => canOpenBrowser(ctx.env, deps.platform ?? process.platform) && platformOpenBrowser(url)),
    });
    if (signedIn === NO_BROWSER) {
        return await deviceCredential(ctx, { endpoint, prior, openLink: false, ...scopeOf(options) }, deps);
    }
    if (signedIn !== EXIT.ok) {
        return { kind: "failed" };
    }
    const label = machineLabel((deps.hostname ?? osHostname)());
    writeLines(ctx.stdout, ["", ...wrap(AUTH.minting(label), 2)]);
    const mint = () => mintWithSession(endpoint, label, {
        home: ctx.home,
        fetch: fetchImpl,
        nowMs: () => ctx.now().getTime(),
        mint: { fetch: fetchImpl, timeoutMs: HTTP_TIMEOUT_MS },
    });
    let outcome = await mint();
    // ⚠ A SESSION THE SERVER WILL NOT RENEW IS OVER, and a stored file that loads
    // is not the same as a session that works. `signInBeat` above declines to
    // replace any session that LOADS — correct for the read lane, and a dead end
    // here: the user would be told to sign in by a verb that then says "already
    // signed in". So an `expired` (the refresh grant was refused) gets exactly one
    // fresh sign-in and one more mint. Nothing else does: a `busy` lock or an
    // unreachable server is not fixed by a browser.
    if (outcome.kind === "not-authorized" && outcome.authorized.kind === "expired") {
        if ((await signInBeat(ctx, { ...deps, retry, replace: true })) !== EXIT.ok) {
            return { kind: "failed" };
        }
        outcome = await mint();
    }
    if (outcome.kind === "ok") {
        return await finishMint(ctx, {
            minted: outcome.credential,
            facts: outcome.facts,
            prior,
            endpoint,
            fetch: fetchImpl,
            // The block guards a re-auth that lands in a DIFFERENT workspace. The device flow passes
            // "always" — there the approver is not the person at this terminal.
            confirm: "on-replace",
            ...scopeOf(options),
        });
    }
    writeLines(ctx.stderr, ["", ...renderErrorBlock({ kind: "bad", code: mintCode(outcome), what: AUTH.mintFailedWhat, why: [mintWhy(outcome)] }, ctx.colour)]);
    return { kind: "failed" };
}
/**
 * Is there anything on this machine that could open a URL? `openBrowser` reports `true` once `spawn` returns,
 * and a missing `xdg-open` only surfaces later as an asynchronous error — so on Linux the answer is checked
 * up front. macOS and Windows ship `open` and `start`.
 */
function canOpenBrowser(env, platform) {
    return platform !== "linux" || resolveOnPath(env, "xdg-open") !== null;
}
/**
 * The code for a failed mint. Eight reasons share `MINT_FAILED`; two are split off because the action differs (join or
 * ask the workspace owner; wait until the stated time) — VQ's Q3.
 */
function mintCode(outcome) {
    if (outcome.kind === "refused" && outcome.error === "not_a_member")
        return "MINT_NOT_A_MEMBER";
    if (outcome.kind === "refused" && outcome.error === "rate_limited")
        return "MINT_RATE_LIMITED";
    return "MINT_FAILED";
}
/** One `why` per way the mint can fail. No status codes on screen (§13.6). */
function mintWhy(outcome) {
    switch (outcome.kind) {
        case "not-authorized":
        case "unauthorized":
        case "wrong-client":
            return AUTH.mintSessionWhy;
        case "refused":
            if (outcome.error === "not_a_member")
                return AUTH.mintNotMemberWhy;
            if (outcome.error === "rate_limited")
                return AUTH.mintRateLimitedWhy;
            return AUTH.mintRefusedWhy;
        case "unreachable":
            return AUTH.mintUnreachableWhy;
        case "malformed":
            return AUTH.mintMalformedWhy;
    }
}
//# sourceMappingURL=browser_credential.js.map