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
import { lstatSync } from "node:fs";
import { hostname as osHostname } from "node:os";
import { headlessReason } from "../device_mode.js";
import { authCommandFor, channelCommand, resolveOnPath } from "../install.js";
import { AUTH, COMMANDS, CREDENTIAL, SIGNIN } from "../copy/index.js";
import { credentialFolderWritable, loadCredential } from "../credential.js";
import { EXIT } from "../exit.js";
import { mcpUrl } from "../oauth/discovery.js";
import { machineLabel } from "../oauth/mint.js";
import { loadSession } from "../oauth/session.js";
import { authorizedAccessToken, HTTP_TIMEOUT_MS, mintWithSession, openBrowser as platformOpenBrowser, signIn, } from "../oauth/signin.js";
import { credentialsPath } from "../paths.js";
import { MAX_ROWS, recordGate, withRecordLock } from "../pending_revoke.js";
import { paint, renderErrorBlock, truncatePath, wrap } from "../term.js";
import { terminalSafe } from "../printable.js";
import { credentialProblemBlock } from "./credential_problem.js";
import { writeLines } from "./context.js";
import { deviceCredential } from "./device_credential.js";
import { connectMintBlock, finishMint, mayHaveWrittenBeforeMint, savedChoicesLines, withMintTail, withSignInTail, writeAheadOf, } from "./finish_mint.js";
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
/**
 * The sign-in options that are connect's own (plan 4.12 row 5, DX-7), for every sign-in `browserCredential` starts on connect's path: the
 * saved-choices line, the host it tried, and the device fix. Absent for every other caller, byte-identical.
 */
function connectSignInOf(options, endpoint) {
    if (options.connectPath === undefined)
        return {};
    return {
        ...(options.connectPath.grantsWritten === true ? { savedChoices: true } : {}),
        connectHost: new URL(endpoint).host,
        onConnectPath: true,
    };
}
/** `connect`'s re-run line, passed to `finishMint` only when `connect` is the caller (exactOptionalPropertyTypes). */
function rerunOf(options) {
    return options.connectPath === undefined ? {} : { rerun: options.connectPath.rerun };
}
/** `connect`'s path, handed down to the device flow only when set (exactOptionalPropertyTypes). */
function connectPathOf(options) {
    return options.connectPath === undefined ? {} : { connectPath: options.connectPath };
}
/** `signInBeat`'s sentinel for "no browser, go to the device flow". Never an exit code a verb returns. */
export const NO_BROWSER = -1;
/**
 * 0.17.2 #135 r1 R1 (P7's gate): a failure after `browserCredential`'s LOOPBACK branch ran (`signInBeat` was called): the first sign-in
 * failed, the retry after an `expired` mint failed, the mint failed, or `finishMint` refused the new credential. `auth`'s paste then says
 * no credential was saved. Every other failed result (the device flow, a refusal before any sign-in) stays `{ kind: "failed" }`.
 */
const LOOPBACK_FAILED = { kind: "failed", afterLoopback: true };
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
            writeLines(ctx.stdout, wrap(options.forMint === true ? SIGNIN.reusedForMint : SIGNIN.alreadySignedIn, 2));
            return EXIT.ok;
        }
        // The refresh grant was refused: the session is over. Sign in again below.
    }
    const endpoint = mcpUrl(ctx.env);
    if (endpoint === null) {
        writeLines(ctx.stderr, signInError(ctx, options.retry, "SIGNIN_SERVICE_NOT_FOUND", SIGNIN.noServerWhat, SIGNIN.noServerRefusedWhy, undefined, options.savedChoices === true, null, options.onConnectPath === true, options.afterWrites ?? null));
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
    writeLines(ctx.stderr, ["", ...signInFailure(ctx, options.retry, outcome, options.savedChoices === true, options.connectHost ?? null, options.onConnectPath === true, options.afterWrites ?? null, options.mayHaveWritten === true)]);
    return EXIT.failure;
}
/** §13.6's shape for a sign-in failure. One renderer, six outcomes. `savedChoices`: connect's grants are already written (T10 DX-7). */
function signInFailure(ctx, retry, outcome, savedChoices, connectHost, onConnectPath, afterWrites, mayHaveWritten) {
    const failure = (code, what, why, fixLabel) => signInError(ctx, retry, code, what, why, fixLabel, savedChoices, null, onConnectPath, afterWrites);
    // 0.17.1: a why that ended "Nothing was changed on this machine." is its base plus the path's tail: connect's `--sign-in` beat (D1) says
    // no sign-in was saved; connect's own sign-in (B) says no credential was saved; every other caller keeps 0.17.0's words.
    const tailed = (base) => afterWrites !== null ? `${base} ${SIGNIN.signInNotSavedTail}` : withSignInTail(base, onConnectPath || mayHaveWritten);
    // DX-7 (T10, connect's path only): an unreachable sign-in service names the host it tried, the variable by name, and says to retry
    // once, then check the network. Every other caller keeps the block above, byte-identical.
    const unreachable = (code, what, why, fixLabel) => connectHost === null
        ? failure(code, what, why, fixLabel)
        : signInError(ctx, retry, code, what, why, AUTH.unreachableFix, savedChoices, AUTH.unreachableTried(connectHost), onConnectPath, afterWrites);
    switch (outcome.kind) {
        case "no-server":
            if (outcome.detail === "unreachable") {
                return unreachable("SIGNIN_SERVICE_NOT_FOUND", SIGNIN.noServerWhat, SIGNIN.noServerUnreachableWhy, SIGNIN.noServerFix);
            }
            return failure("SIGNIN_SERVICE_NOT_FOUND", SIGNIN.noServerWhat, SIGNIN.noServerMalformedWhy, SIGNIN.noServerFix);
        case "denied":
            return failure("SIGNIN_DENIED", SIGNIN.deniedWhat, tailed(SIGNIN.deniedWhy), SIGNIN.deniedFix);
        case "timeout":
            // prc1 S9(b): a loopback timeout shares this renderer, so connect's path gets DX-7's unreachable recovery (host, name, retry once).
            return unreachable("SIGNIN_TIMED_OUT", SIGNIN.timeoutWhat, tailed(SIGNIN.timeoutWhy), SIGNIN.timeoutFix);
        case "rejected":
            return failure("SIGNIN_CLIENT_REFUSED", SIGNIN.rejectedWhat, SIGNIN.rejectedWhy, SIGNIN.rejectedFix);
        case "unreachable":
            return unreachable("SIGNIN_UNREACHABLE", SIGNIN.unreachableWhat, tailed(SIGNIN.unreachableWhy), SIGNIN.unreachableFix);
        case "malformed":
            return failure("SIGNIN_ANSWER_UNUSABLE", SIGNIN.malformedWhat, SIGNIN.malformedWhy, SIGNIN.malformedFix);
    }
}
function signInError(ctx, retry, code, what, why, fixLabel = SIGNIN.noServerFix, savedChoices = false, extraWhy = null, onConnectPath = false, afterWrites = null) {
    return renderErrorBlock({
        kind: "bad",
        code,
        what,
        // T10 (DX-7): on connect's path, once the grants are written, a failed sign-in says what it left behind (the saved choices). 0.17.1 D1:
        // connect's `--sign-in` beat says it with the lines its caller computes NOW, when the block prints.
        why: [
            why,
            ...(extraWhy === null ? [] : [extraWhy]),
            ...(afterWrites !== null ? afterWrites() : savedChoices ? [AUTH.savedChoicesWhy] : []),
        ],
        fixLabel,
        fixes: [
            channelCommand(ctx.env, ctx.selfPath, retry === "auth" ? COMMANDS.auth : retry === "connect" ? COMMANDS.connect : COMMANDS.signIn),
            // Plan 4.12 row 5: connect's path also names the device flow (no browser here). Absent otherwise: byte-identical.
            ...(onConnectPath && retry === "connect" ? [channelCommand(ctx.env, ctx.selfPath, COMMANDS.connectDevice)] : []),
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
    // ⛔ T10 (B4, plan 4.12) and prc1 S1/S8: the state a new credential would be saved into must be sound BEFORE the session, the
    // browser or the device code. Every caller, auth included: a credential the server creates and this machine cannot save is a live
    // credential nobody holds. The same check `connect` makes at its top (`signInPreflight`).
    const fixCommand = options.connectPath?.rerun ?? authCommandFor(ctx.env, ctx.selfPath);
    const stateDir = stateDirPreflight(ctx.home);
    if (stateDir.kind === "refused") {
        writeLines(ctx.stderr, ["", ...renderErrorBlock(stateDir.block, ctx.colour)]);
        return { kind: "failed" };
    }
    // Resolved ONCE and handed to both halves, so the session and the credential
    // cannot come from two different servers.
    const endpoint = mcpUrl(ctx.env);
    if (endpoint === null) {
        writeLines(ctx.stderr, signInError(ctx, retry, "SIGNIN_SERVICE_NOT_FOUND", SIGNIN.noServerWhat, SIGNIN.noServerRefusedWhy, undefined, options.connectPath?.grantsWritten === true, null, options.connectPath !== undefined));
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
    // ⛔ prc1 S3 (P6's condition 3): a mint that will HOLD its credential (connect's replace, `writeAhead`; `g`, `hold`) needs a record it
    // can be written to. connect's 401 replace is known only after the probe above, so the queue is checked HERE, after the probe and before
    // any browser or device open: refused, nothing is requested. A mint that holds nothing (auth, connect's first sign-in) does not depend
    // on the record; connect's top checks the queue for its own mint paths (S8).
    if (options.connectPath?.writeAhead !== undefined || options.hold !== undefined) {
        const queue = queuePreflight(ctx.home, { fixCommand, statusCommand: channelCommand(ctx.env, ctx.selfPath, COMMANDS.status) });
        if (queue.kind === "refused") {
            writeLines(ctx.stderr, ["", ...renderErrorBlock(queue.block, ctx.colour)]);
            return { kind: "failed" };
        }
    }
    // ⛔ DEVICE MODE (`CR-234d`, plan item 7). By request (`--device`), or because this machine has no browser
    // of its own: an SSH session, or a Linux box with no display. The loopback sign-in would open a browser
    // nobody can see and wait out its deadline, so the machine asks for a code instead. The prefilled link is
    // opened only where a browser plausibly exists — `--device` on a desktop — never on a headless box.
    const headless = headlessReason(ctx.env, deps.platform ?? process.platform);
    if (options.device === true || headless !== null) {
        return await deviceCredential(ctx, { endpoint, prior, openLink: headless === null, ...scopeOf(options), ...connectPathOf(options) }, deps);
    }
    const signedIn = await signInBeat(ctx, {
        ...deps,
        retry,
        forMint: true,
        // 2(a): ask the authorize page to bind the org the old credential belongs to. Only on a 200 —
        // an org the server would not vouch for is not worth asking for.
        ...(prior?.who.kind === "ok" ? { orgId: prior.who.orgId } : {}),
        ...connectSignInOf(options, endpoint),
        // A browser that cannot be opened is a headless machine the check above did not recognise: go to
        // the device flow rather than print a URL and wait for a callback nobody can make.
        fallbackToDevice: true,
        openBrowser: deps.openBrowser ?? ((url) => canOpenBrowser(ctx.env, deps.platform ?? process.platform) && platformOpenBrowser(url)),
    });
    if (signedIn === NO_BROWSER) {
        return await deviceCredential(ctx, { endpoint, prior, openLink: false, ...scopeOf(options), ...connectPathOf(options) }, deps);
    }
    if (signedIn !== EXIT.ok) {
        return LOOPBACK_FAILED;
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
        // prc1 S9(a): the retry is the same connect sign-in as the first call, with the same recovery lines (saved choices, host, device).
        // 0.17.2 (P7): this retry follows the first sign-in step, which may have written session.json, so its denied, timeout and
        // unreachable whys say no credential was saved, on `auth` too (`mayHaveWritten`). The FIRST sign-in's failures keep their words.
        if ((await signInBeat(ctx, { ...deps, retry, forMint: true, ...connectSignInOf(options, endpoint), replace: true, mayHaveWritten: true })) !== EXIT.ok) {
            return LOOPBACK_FAILED;
        }
        outcome = await mint();
    }
    if (outcome.kind === "ok") {
        const finished = await finishMint(ctx, {
            minted: outcome.credential,
            facts: outcome.facts,
            prior,
            endpoint,
            fetch: fetchImpl,
            via: "browser",
            // The block guards a re-auth that lands in a DIFFERENT workspace. The device flow passes
            // "always" — there the approver is not the person at this terminal. T10 (plan 4.12): `connect`
            // over a 401'd or faulty FILE credential asks ALWAYS, because `on-replace` asks only when the old
            // credential probed ok (`finish_mint.ts` `askUnnamed`), and a 401'd one never did.
            confirm: options.connectPath?.replacing === true ? "always" : "on-replace",
            ...rerunOf(options),
            ...connectPathOf(options),
            ...writeAheadOf(options.connectPath),
            ...scopeOf(options),
        });
        return finished.kind === "failed" ? LOOPBACK_FAILED : finished;
    }
    // T10 (B5, DX-7): connect's path names the recovery for the failures it can (rate limited, not a member, unreachable). Every other
    // caller prints today's block.
    const connectBlock = options.connectPath === undefined ? null : connectMintBlock(outcome, options.connectPath, endpoint, ctx.now());
    // 0.17.2 (P7): the browser path's first sign-in step may have written session.json, so `auth` takes connect's tail here too.
    const mayHaveWritten = mayHaveWrittenBeforeMint(options.connectPath, "browser");
    writeLines(ctx.stderr, [
        "",
        ...renderErrorBlock(
        // 0.17.1 (P7): the session and malformed outcomes reach this block on connect's path too, so the tail is the path's.
        connectBlock ?? {
            kind: "bad",
            code: mintCode(outcome),
            what: AUTH.mintFailedWhat,
            why: [withMintTail(mintWhy(outcome), mayHaveWritten), ...savedChoicesLines(options.connectPath)],
        }, ctx.colour),
    ]);
    return LOOPBACK_FAILED;
}
/**
 * prc1 S1/S3/S8 (P6's split, 2026-11-22): the checks a sign-in makes before anything is requested, minted or opened. ONE predicate for
 * each, used by `browserCredential` and by `connect`'s top, never duplicated.
 *   - `stateDirPreflight`, for EVERY sign-in: `~/.vibecommit` writable (B4), and the credential path absent or a regular file (S1: a
 *     directory or other non-file there cannot be saved over, and a read error is the unreadable fault, never "absent").
 *   - `queuePreflight`, for a mint that may have to be recorded: the pending-revoke record passes `recordGate` (the SAME predicate
 *     `addPendingRevoke` records with) and has room (S3).
 *   - `signInPreflight`, `connect`'s top (S8): the first always, the second when that run can mint (`queue: true`).
 * `fixCommand` is the verb a fix names (connect's own command on connect's path, `auth`'s otherwise). `statusCommand` is THIS install's
 * `vibecommit status` (`channelCommand`), the full record's fix: `status` retries the waiting revokes at its start (cli.ts).
 */
export function signInPreflight(home, options) {
    const stateDir = stateDirPreflight(home);
    if (stateDir.kind === "refused" || !options.queue)
        return stateDir;
    return queuePreflight(home, options);
}
/** prc1 S1/S8: `~/.vibecommit` writable, and the credential path absent or a regular file. For every sign-in. */
export function stateDirPreflight(home) {
    const folder = credentialFolderWritable(home);
    if (folder.kind === "unwritable")
        return { kind: "refused", block: folderUnwritableErrorBlock(folder.path) };
    const credential = credentialsPath(home);
    let isFile = true;
    try {
        isFile = lstatSync(credential).isFile();
    }
    catch (error) {
        // ENOENT: nothing saved yet, which is the normal first sign-in. Any other error is not a file this check can vouch for.
        isFile = error.code === "ENOENT";
    }
    if (!isFile)
        return { kind: "refused", block: notAFileErrorBlock(credential) };
    return { kind: "ok" };
}
/** prc1 S3: the pending-revoke record passes `recordGate` (the record predicate) and has room. For a mint that may be recorded. */
export function queuePreflight(home, fixes) {
    // prc1 S5: read under the record's lock, so the preflight and the write see the same record. A lock not taken in time refuses too.
    const gate = withRecordLock(home, () => recordGate(home));
    if (gate === null)
        return { kind: "refused", block: queueBusyErrorBlock() };
    if (gate.kind === "refused") {
        if (gate.read.kind === "insecure-file")
            return { kind: "refused", block: credentialProblemBlock(gate.read, fixes.fixCommand) };
        return { kind: "refused", block: queueUnreadableErrorBlock(gate.path) };
    }
    if (gate.rows.length >= MAX_ROWS)
        return { kind: "refused", block: queueFullErrorBlock(fixes.statusCommand) };
    return { kind: "ok" };
}
function folderUnwritableErrorBlock(path) {
    return {
        kind: "bad",
        code: "CREDENTIAL_FOLDER_UNWRITABLE",
        what: CREDENTIAL.unwritableWhat,
        why: [`${CREDENTIAL.insecureDirWhyLabel} ${truncatePath(terminalSafe(path), 60)}`, CREDENTIAL.unwritableWhy],
        fixLabel: CREDENTIAL.unwritableFix,
        fixes: [COMMANDS.chmodDirectory],
    };
}
function notAFileErrorBlock(path) {
    return {
        kind: "bad",
        code: "CREDENTIAL_FILE_UNREADABLE",
        what: CREDENTIAL.notAFileWhat,
        why: [`${CREDENTIAL.insecureFileWhyLabel} ${truncatePath(terminalSafe(path), 60)}`, CREDENTIAL.notAFileWhy],
        fixLabel: CREDENTIAL.notAFileFix,
    };
}
function queueUnreadableErrorBlock(path) {
    return {
        kind: "bad",
        code: "PENDING_REVOKE_UNREADABLE",
        what: CREDENTIAL.queueUnreadableWhat,
        why: [`${CREDENTIAL.insecureFileWhyLabel} ${truncatePath(terminalSafe(path), 60)}`, CREDENTIAL.queueUnreadableWhy],
        fixLabel: CREDENTIAL.queueUnreadableFix,
    };
}
function queueBusyErrorBlock() {
    return {
        kind: "bad",
        code: "PENDING_REVOKE_BUSY",
        what: CREDENTIAL.queueBusyWhat,
        why: [CREDENTIAL.queueBusyWhy],
        fixLabel: CREDENTIAL.queueBusyFix,
    };
}
function queueFullErrorBlock(statusCommand) {
    return {
        kind: "bad",
        code: "PENDING_REVOKE_FULL",
        what: CREDENTIAL.queueFullWhat(MAX_ROWS),
        why: [CREDENTIAL.queueFullWhy],
        fixLabel: CREDENTIAL.queueFullFix,
        fixes: [statusCommand],
    };
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