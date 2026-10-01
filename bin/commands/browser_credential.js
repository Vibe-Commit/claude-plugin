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
import { AUTH, COMMANDS, SIGNIN } from "../copy/index.js";
import { saveCredential } from "../credential.js";
import { EXIT } from "../exit.js";
import { mcpUrl } from "../oauth/discovery.js";
import { machineLabel } from "../oauth/mint.js";
import { loadSession } from "../oauth/session.js";
import { HTTP_TIMEOUT_MS, mintWithSession, openBrowser as platformOpenBrowser, signIn, } from "../oauth/signin.js";
import { paint, renderErrorBlock, wrap } from "../term.js";
import { writeLines } from "./context.js";
/**
 * The browser sign-in beat — `CR-084d`.
 *
 * Opt-in inside `connect` (`--sign-in`) for the read lane, and the first half of
 * `browserCredential` below. When a session already exists it is a no-op that
 * says so; it never replaces a working session.
 */
export async function signInBeat(ctx, options) {
    if (options.replace !== true && loadSession(ctx.home).kind === "ok") {
        writeLines(ctx.stdout, wrap(SIGNIN.alreadySignedIn, 2));
        return EXIT.ok;
    }
    const endpoint = mcpUrl(ctx.env);
    if (endpoint === null) {
        writeLines(ctx.stderr, signInError(ctx, options.retry, SIGNIN.noServerWhat, SIGNIN.noServerRefusedWhy));
        return EXIT.failure;
    }
    const outcome = await signIn({
        home: ctx.home,
        mcpEndpoint: endpoint,
        fetch: options.fetch ?? fetch,
        nowMs: () => ctx.now().getTime(),
        openBrowser: options.openBrowser ?? platformOpenBrowser,
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
    writeLines(ctx.stderr, ["", ...signInFailure(ctx, options.retry, outcome)]);
    return EXIT.failure;
}
/** §13.6's shape for a sign-in failure. One renderer, six outcomes. */
function signInFailure(ctx, retry, outcome) {
    switch (outcome.kind) {
        case "no-server":
            return signInError(ctx, retry, SIGNIN.noServerWhat, outcome.detail === "unreachable"
                ? SIGNIN.noServerUnreachableWhy
                : SIGNIN.noServerMalformedWhy, SIGNIN.noServerFix);
        case "denied":
            return signInError(ctx, retry, SIGNIN.deniedWhat, SIGNIN.deniedWhy, SIGNIN.deniedFix);
        case "timeout":
            return signInError(ctx, retry, SIGNIN.timeoutWhat, SIGNIN.timeoutWhy, SIGNIN.timeoutFix);
        case "rejected":
            return signInError(ctx, retry, SIGNIN.rejectedWhat, SIGNIN.rejectedWhy, SIGNIN.rejectedFix);
        case "unreachable":
            return signInError(ctx, retry, SIGNIN.unreachableWhat, SIGNIN.unreachableWhy, SIGNIN.unreachableFix);
        case "malformed":
            return signInError(ctx, retry, SIGNIN.malformedWhat, SIGNIN.malformedWhy, SIGNIN.malformedFix);
    }
}
function signInError(ctx, retry, what, why, fixLabel = SIGNIN.noServerFix) {
    return renderErrorBlock({
        kind: "bad",
        what,
        why: [why],
        fixLabel,
        fixes: [
            retry === "auth" ? COMMANDS.auth : retry === "connect" ? COMMANDS.connect : COMMANDS.signIn,
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
export async function browserCredential(ctx, retry, deps = {}) {
    // Resolved ONCE and handed to both halves, so the session and the credential
    // cannot come from two different servers.
    const endpoint = mcpUrl(ctx.env);
    if (endpoint === null) {
        writeLines(ctx.stderr, signInError(ctx, retry, SIGNIN.noServerWhat, SIGNIN.noServerRefusedWhy));
        return { kind: "failed" };
    }
    if ((await signInBeat(ctx, { ...deps, retry })) !== EXIT.ok)
        return { kind: "failed" };
    const label = machineLabel((deps.hostname ?? osHostname)());
    writeLines(ctx.stdout, ["", ...wrap(AUTH.minting(label), 2)]);
    const fetchImpl = deps.fetch ?? fetch;
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
        // Through the CR-216 writer, so the 0700/0600 double-chmod and the
        // wrong-class refusal apply exactly as they do to a pasted credential.
        saveCredential(ctx.home, outcome.credential);
        return { kind: "saved", credential: outcome.credential };
    }
    writeLines(ctx.stderr, ["", ...renderErrorBlock({ kind: "bad", what: AUTH.mintFailedWhat, why: [mintWhy(outcome)] }, ctx.colour)]);
    return { kind: "failed" };
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