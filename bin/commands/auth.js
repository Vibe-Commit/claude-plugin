/**
 * `vibecommit auth` — save this machine's ingest credential. `CR-216/U2`, D206.
 *
 * ## The defect this closes
 *
 * `~/.vibecommit/credentials.json` was a READ PATH WITH NO PRODUCER. `paths.ts`
 * named it, `credential.ts` parsed it, `readSecretFile` policed its mode and
 * `TROUBLESHOOTING.chmodCredentials` told the user to `chmod 600` it — and
 * nothing in the package ever wrote it. The only credential that reached a hook
 * came from `VIBECOMMIT_TOKEN`, the escape hatch `credential.ts:28` documents as
 * being for headless and CI use. So a `git commit` from any ordinary shell ran
 * the post-commit hook with no credential and bound nothing, and because the
 * hook exit contract makes a missing credential SILENT by design — correctly, so
 * capture never derails a developer's turn — the user got transcript capture,
 * zero commit edges, and no error anywhere to explain it.
 *
 * ## Why this is a verb and not a beat inside `connect`
 *
 * The obvious fix was "`connect` already holds a credential, so persist it". It
 * is circular. `connect`'s `credentialBeat` calls the same `loadCredential`
 * every other surface calls, so the credential it holds came from
 * `VIBECOMMIT_TOKEN` or from the file — there is no third source. Persisting it
 * would mean the file could only ever be seeded from the variable it exists to
 * replace, and on the fresh machine that has the defect there is nothing to
 * persist at all. The plaintext has to enter the machine somewhere explicit, and
 * this verb is that place.
 *
 * ## ⛔ Why the credential may not be an argument
 *
 * `vibecommit auth <token>` is the shape everyone reaches for first, and it is
 * the wrong one: `argv` lands in the shell's history file and, on most systems,
 * in `/proc/<pid>/cmdline` for any local process to read while the command runs.
 * `credential.ts` spends a whole module closing four NARROWER leaks — template
 * interpolation, `JSON.stringify`, `console.error(obj)`, an unhandled rejection
 * — so accepting the secret through a wider channel than all of them would make
 * that discipline theatre. It is refused loudly rather than quietly ignored,
 * because a user who typed it needs to be told it is now in their history.
 *
 * ## ⚠ Browser FIRST since `CR-226`; the paste is the fallback, not gone
 *
 * This note used to say the verb "is not sign-in, and it does not mint", because
 * `mintIngestCredential` in `vibecommit-mcp` had no route in front of it and the
 * only plaintext producer was the web app's `POST /api/ingest-credentials`. The
 * route now exists (`POST /oauth/ingest-credential`), so on a terminal this verb
 * signs in through the browser and mints the credential there
 * (`browser_credential.ts`). The paste below is unchanged and still reached:
 *
 *   - `--stdin`, or no TTY — the CI shape. Never a browser, exactly as before.
 *   - `--paste` — a human who already holds a credential from the dashboard.
 *   - any browser step failing — its reason is printed, then the prompt runs.
 *
 * ⚠ So there is no path on which `CR-226` makes the pre-existing flow worse:
 * every failure lands on the prompt that was the whole verb before it.
 *
 * ## A save ENDS here: `auth` never continues into `connect` (4.12, ENG-25)
 *
 * This reverses `CR-236` and D32 · 26A. A save saves or replaces the credential, prints ONE next-step line
 * and stops. `connect` is the one front door: it signs in if it must and chooses what to capture. So `auth`
 * takes no `connect` dep, and `test/auth-connect-chain.test.ts` pins that no save reaches one.
 *
 * @provenance vibecommit-mcp src/transport/server.ts — POST /oauth/ingest-credential is the mint route, verified
 * @provenance vibecommit-web app/api/ingest-credentials/route.ts — the dashboard producer the paste path still serves, verified
 */
import { AUTH, COMMANDS, DEVICE, PICKER, URLS } from "../copy/index.js";
import { renderVerbHelp } from "../verb_help.js";
import { authCommandFor, channelCommand } from "../install.js";
import { writeLines } from "./context.js";
import { EXIT } from "../exit.js";
import { INGEST_TOKEN_PREFIX, IngestCredential, saveCredential } from "../credential.js";
import { isCaptureAllowed, ownerOfSlug, readGrants, readPendingOffer, slugGrantedHere } from "../consent.js";
import { onceRepoSlug } from "../git.js";
import { grantedFolders } from "../folder_grants.js";
import { machineCapture, machineSummary } from "../machine_state.js";
import { credentialsPath } from "../paths.js";
import { setupState } from "../setup_state.js";
import { resolveProjectKeys } from "../project.js";
import { paint, renderErrorBlock, tildePath, wrap } from "../term.js";
import { verbStartRetryRuns } from "../verb_start.js";
/**
 * `--stdin` forces the pipe even on a terminal — the CI shape, where a job may
 * well have a TTY attached and must not start prompting because of it.
 */
const STDIN_FLAG = "--stdin";
/** `CR-226`. Skip the browser and go straight to the prompt. */
const PASTE_FLAG = "--paste";
/** `CR-234d`. Sign in by CODE, approved on another device — TTY only. */
const DEVICE_FLAG = "--device";
export async function auth(ctx, argv, deps = {}) {
    // ⛔ THE ARGV REFUSAL COMES FIRST, before stdin is read, resumed or opened.
    // Anything else would mean the secret in `argv` had already been accepted by
    // the time we objected to it.
    const positional = argv.filter((arg) => !arg.startsWith("-"));
    if (positional.length > 0) {
        writeLines(ctx.stderr, renderErrorBlock({
            kind: "bad",
            code: "CREDENTIAL_IN_ARGV",
            what: AUTH.argvWhat,
            why: [AUTH.argvWhy],
            fixLabel: AUTH.argvFix,
            fixes: [channelCommand(ctx.env, ctx.selfPath, COMMANDS.authPaste), AUTH.argvFixStdin(authCommandFor(ctx.env, ctx.selfPath))],
        }, ctx.colour));
        return EXIT.usage;
    }
    // `TODOS[184]`. SECOND, deliberately — VG's V3-1: a credential typed as an argument must still be
    // flagged for revocation even if `--help` also appears in `argv`, so the refusal above (which makes
    // exactly that a usage error) runs first. By the time this is reached, `positional.length === 0`, so
    // `--help` still has no side effects — nothing below has read or written anything yet either way.
    if (argv.includes("--help") || argv.includes("-h")) {
        const helpVerb = "auth"; // an identifier, not a literal, at the writer: `copy-inline-literals` follows argument positions
        writeLines(ctx.stdout, renderVerbHelp(helpVerb));
        return EXIT.ok;
    }
    const piped = argv.includes(STDIN_FLAG) || !ctx.stdinIsTty;
    // `CR-234d`: `--device` is TTY only (the approval is a person's) and is the opposite of `--paste`.
    if (argv.includes(DEVICE_FLAG) && (piped || argv.includes(PASTE_FLAG))) {
        writeLines(ctx.stderr, renderErrorBlock(piped
            ? {
                kind: "bad",
                code: "SIGNIN_CODE_NEEDS_TTY",
                what: DEVICE.needsTerminalWhat,
                why: [DEVICE.needsTerminalWhy],
                fixLabel: DEVICE.needsTerminalFix,
                fixes: [DEVICE.needsTerminalCommand(authCommandFor(ctx.env, ctx.selfPath))],
            }
            : {
                kind: "bad",
                code: "AUTH_FLAGS_CONFLICT",
                what: DEVICE.conflictWhat,
                why: [DEVICE.conflictWhy],
                fixLabel: DEVICE.conflictFix,
                fixes: [authCommandFor(ctx.env, ctx.selfPath), `${authCommandFor(ctx.env, ctx.selfPath)} ${PASTE_FLAG}`],
            }, ctx.colour));
        return EXIT.usage;
    }
    // 0.17.4 (P7 FINAL; P6's binding gate): the paste's refusals say no CREDENTIAL was saved wherever the verb-start revoke retry ran (it
    // may have rewritten or deleted pending-revoke.json): at a terminal, `--paste` and the paste after ANY browser or device failure. The
    // gate IS the CLI's own skip decision, never a re-derived `piped`, so the words cannot drift from whether the retry ran. Piped and
    // `--stdin` `auth` runs no retry and keeps 0.17.0's words.
    const retryRan = verbStartRetryRuns("auth", argv, ctx);
    // ── `CR-226`: the browser, first, on a terminal only. ──────────────────────
    if (!piped && !argv.includes(PASTE_FLAG) && deps.browser !== undefined) {
        const minted = await deps.browser(ctx, "auth", { device: argv.includes(DEVICE_FLAG) });
        if (minted.kind === "saved")
            return await saved(ctx, deps, piped, minted.notes);
        // The user said NO at the replace confirmation: not a failure of the browser, so no paste prompt.
        if (minted.kind === "declined")
            return EXIT.failure;
        // The reason is already on stderr. The documented fallback is the paste
        // this verb has always had, with the page that mints one named first.
        writeLines(ctx.stdout, [
            "",
            ...wrap(AUTH.pasteInsteadLabel, 2),
            // `accent` on a URL — §13.1's one exception, one colour on the line.
            `  ${paint(ctx.colour, "accent", URLS.settings)}`,
            "",
        ]);
    }
    const raw = piped
        ? await (deps.readStdin ?? (() => Promise.resolve("")))()
        : await (deps.readSecret ?? (() => Promise.resolve("")))(AUTH.prompt);
    // One `trim` for both lanes. A paste carries a trailing newline and a pipe may
    // carry `\r\n`; neither is part of the credential, and an untrimmed byte would
    // fail the prefix check further down for a reason the user cannot see.
    const secret = raw.trim();
    if (secret === "") {
        writeLines(ctx.stderr, renderErrorBlock({
            kind: "bad",
            code: "CREDENTIAL_EMPTY",
            what: AUTH.emptyWhat,
            why: [retryRan ? AUTH.emptyWhyAfterSignIn : AUTH.emptyWhy],
            fixLabel: AUTH.mintFix(URLS.settings),
            fixes: AUTH.mintCommands(authCommandFor(ctx.env, ctx.selfPath)),
        }, ctx.colour));
        return EXIT.failure;
    }
    // The class check happens HERE as well as at the write boundary, and the
    // duplication is deliberate: this one renders a fix for a human who pasted the
    // wrong string, and `saveCredential`'s throws for a caller who should not have
    // asked. Neither is the other's fallback.
    if (!secret.startsWith(INGEST_TOKEN_PREFIX)) {
        writeLines(ctx.stderr, renderErrorBlock({
            kind: "bad",
            code: "CREDENTIAL_NOT_INGEST",
            what: AUTH.wrongClassWhat,
            why: [retryRan ? AUTH.wrongClassWhyAfterSignIn : AUTH.wrongClassWhy],
            fixLabel: AUTH.mintFix(URLS.settings),
            fixes: AUTH.mintCommands(authCommandFor(ctx.env, ctx.selfPath)),
        }, ctx.colour));
        return EXIT.failure;
    }
    saveCredential(ctx.home, new IngestCredential(secret, "file"));
    return await saved(ctx, deps, piped);
}
/**
 * The line a terminal `auth` that does not chain prints after a save, for the setup state it found (4.12, ENG-25). Pure.
 * (a) cannot hold right after a save (4.4a's per-caller rule); (b), (c) and (f) can. An `unknown` finding gets the
 * plain line: no guess about the hooks. The plain line is `PICKER.authStays`, the text `auth` has always printed.
 */
export function setupStayLines(finding, summary, connect) {
    if (finding.kind === "checked" && finding.noAgentHooks)
        return wrap(AUTH.setupNoAgentHooks(connect), 2);
    // `repair` is (b) or (c) here: `auth` passes no sync-unauthorized flag, so (e) cannot hold. (b) is the commit hook; (c) an agent.
    if (finding.kind === "checked" && finding.repair)
        return wrap(AUTH.setupRepairs(summary, connect), 2);
    return wrap(PICKER.authStays(summary), 2);
}
/**
 * The setup line for a terminal save on a machine that captures (4.12, ENG-25). Read-only, with no account sync. Inside a git work
 * tree the commit hook is checked for THAT toplevel, so (b) can hold there; outside one no toplevel is probed.
 */
function staysLines(ctx, summary) {
    const keys = resolveProjectKeys(ctx.cwd);
    // prc1 W4: only a worktree that capture admits is checked for repair (4.4a). An ungranted repo's hook is not capture's to repair.
    const admitted = keys !== null && isCaptureAllowed(ctx.home, keys, onceRepoSlug(keys.worktree));
    const finding = setupState({
        home: ctx.home,
        env: ctx.env,
        selfPath: ctx.selfPath,
        grantsOn: true,
        toplevels: keys !== null && admitted ? [keys.worktree] : [],
        syncUnauthorized: false,
    });
    return setupStayLines(finding, summary, channelCommand(ctx.env, ctx.selfPath, COMMANDS.connect));
}
/**
 * The next-step line after a terminal save (4.12, ENG-25, D-SIGNIN). A machine with nothing on, or with setup unfinished,
 * gets `Next, choose what to capture: <connect>`. A machine that captures gets the stays line, with its repair when a hook needs one.
 * An unreadable `grants.json` is not "on", so it gets the first line and never a claim that capture is on.
 */
function nextLines(ctx, capture) {
    if (capture.kind === "on")
        return staysLines(ctx, machineSummary(capture));
    return wrap(AUTH.setupNoAgentHooks(channelCommand(ctx.env, ctx.selfPath, COMMANDS.connect)), 2);
}
/**
 * The "Earlier sessions … weren't offered" line (4.12, ENG-25, ENG-44): what a `connect` whose sign-in failed left in
 * `pending_offer`. Built ONLY from the entries still granted: an owner still in `owners`; a repo still granted (listed, or under a
 * granted owner) and not turned off, and not counted again under a granted owner; a folder still granted. The count goes through
 * `PICKER.summary`, the formatter `machineSummary` uses, but over these entries and not the whole machine. Null when none is still
 * granted. Reads only: `auth` never writes or clears `grants.json` (ENG-44).
 */
function earlierNotOfferedLine(ctx) {
    const pending = readPendingOffer(ctx.home);
    if (pending.length === 0)
        return null;
    const read = readGrants(ctx.home);
    if (read.kind !== "ok")
        return null;
    const grants = read.grants;
    const folders = new Set(grantedFolders(ctx.home));
    const owners = pending.filter((e) => e.kind === "owner" && grants.owners.includes(e.value)).map((e) => e.value);
    const granted = new Set(owners);
    // A repo counts only if the shared check says consent still names it, with no deny list (this file's and the account's) naming it.
    const repos = pending.filter((e) => e.kind === "repo" && !granted.has(ownerOfSlug(e.value)) && slugGrantedHere(ctx.home, e.value)).length;
    const folderCount = pending.filter((e) => e.kind === "folder" && folders.has(e.value)).length;
    // Nothing still granted is no line at all. (`PICKER.summary` returns "0 repos" for zeros, so the count is what is tested.)
    if (owners.length + repos + folderCount === 0)
        return null;
    const summary = PICKER.summary(owners.length, repos, folderCount);
    return wrap(AUTH.earlierNotOffered(summary, channelCommand(ctx.env, ctx.selfPath, COMMANDS.backfill)), 2);
}
/**
 * The one confirmation, whichever path wrote the file. It prints the saved block, then, on a terminal, one next-step line
 * (`nextLines`) and any "Earlier sessions" line, and returns EXIT.ok. It never continues into `connect` (4.12).
 *
 * A piped or `--stdin` `auth` prints today's saved block with its next-step fix and nothing else (L10). ⛔ It never clears
 * `pending_offer` and never writes `grants.json`.
 */
async function saved(ctx, deps, piped, notes = []) {
    const capture = piped ? null : machineCapture(ctx.home);
    const next = capture === null ? [] : ["", ...nextLines(ctx, capture)];
    const earlier = piped ? null : earlierNotOfferedLine(ctx);
    writeLines(ctx.stdout, [
        ...renderErrorBlock({
            kind: "ok",
            what: AUTH.savedWhat,
            why: [AUTH.savedWhy(tildePath(credentialsPath(ctx.home), ctx.home)), ...notes],
            ...(piped ? { fixLabel: AUTH.nextLabel, fixes: [channelCommand(ctx.env, ctx.selfPath, AUTH.nextCommand)] } : {}),
        }, ctx.colour),
        ...next,
        ...(earlier === null ? [] : ["", ...earlier]),
    ]);
    // The only other place a credential is saved, so the only other place a new credential row is synced. ⛔ Only for a person at a
    // terminal: a piped or `--stdin` `auth` only saves (L10), and a sync sends this machine's grants, which is more than saving.
    // It makes no prompt and prints nothing; a failure is silent and the exit stays what it was.
    if (!piped)
        await syncNewCredential(ctx, deps);
    return EXIT.ok;
}
/**
 * R3-7, for a TERMINAL `auth` only (the caller skips a piped one). Only a machine that HAS synced (`grants.json`'s `synced_at`) syncs here: a machine that never has would be making a FIRST
 * sync, which prints what it is saving and belongs to `connect`/`status`/`off`, not to a verb whose job is to save a credential.
 * Bounded at 3 s and silent on failure (`syncForVerb` never throws).
 */
async function syncNewCredential(ctx, deps) {
    if (deps.account === undefined)
        return;
    const read = readGrants(ctx.home);
    if (read.kind !== "ok" || read.grants.synced_at === null)
        return;
    await (await import("../grants_verb.js")).syncForVerb(ctx, false, deps.account);
}
//# sourceMappingURL=auth.js.map