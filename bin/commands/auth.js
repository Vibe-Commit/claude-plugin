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
 * ## ⭐ Inside a git work tree, a save CONTINUES INTO `connect` (0.6.0, `CR-236`)
 *
 * `/install` and this verb's own ending used to make a new user run two commands back to back — `auth`,
 * then `connect` — for what is one intent. So on a TERMINAL, inside any git work tree
 * (`resolveProjectKeys(cwd) !== null`, the precondition `connect` checks for itself), a SAVED credential
 * goes straight on into `connect`, which asks its own consent question first, and `auth` returns
 * `connect`'s exit code. The gate (`shouldConnect`) is checked on BOTH save paths — the browser's `saved`
 * result and the TTY paste.
 *
 * ⛔ Never on `--stdin` or a non-TTY: CI must keep exit 0 and never meet a consent refusal. Never on
 * `declined`, an empty paste or a wrong-class paste: nothing was saved. Outside a repo the output and
 * the exit are byte-identical to before — that is the escape hatch for a renewal that should not touch
 * the repo you are standing in.
 *
 * ⛔ **NEVER A SECOND SIGN-IN.** `src/index.ts` hands the chained `connect` NO `browser`, so an `absent`
 * credential falls to its warning and never to a mint; this verb just saved one, so it is not absent.
 * `test/auth-connect-chain.test.ts` brace-matches the inner call to keep it so.
 *
 * @provenance vibecommit-mcp src/transport/server.ts — POST /oauth/ingest-credential is the mint route, verified
 * @provenance vibecommit-web app/api/ingest-credentials/route.ts — the dashboard producer the paste path still serves, verified
 */
import { AUTH, DEVICE, PICKER, URLS } from "../copy/index.js";
import { renderVerbHelp } from "../verb_help.js";
import { authCommandFor, channelCommand } from "../install.js";
import { writeLines } from "./context.js";
import { EXIT } from "../exit.js";
import { INGEST_TOKEN_PREFIX, IngestCredential, saveCredential } from "../credential.js";
import { readGrants } from "../consent.js";
import { machineCapture, machineSummary } from "../machine_state.js";
import { credentialsPath } from "../paths.js";
import { resolveProjectKeys } from "../project.js";
import { paint, renderErrorBlock, tildePath, wrap } from "../term.js";
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
            fixes: [channelCommand(ctx.env, ctx.selfPath, AUTH.argvFixPrompt), AUTH.argvFixStdin(authCommandFor(ctx.env, ctx.selfPath))],
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
            why: [AUTH.emptyWhy],
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
            why: [AUTH.wrongClassWhy],
            fixLabel: AUTH.mintFix(URLS.settings),
            fixes: AUTH.mintCommands(authCommandFor(ctx.env, ctx.selfPath)),
        }, ctx.colour));
        return EXIT.failure;
    }
    saveCredential(ctx.home, new IngestCredential(secret, "file"));
    return await saved(ctx, deps, piped);
}
/**
 * The one confirmation, whichever path wrote the file — and the chain's single gate.
 *
 * `shouldConnect` is read here, AFTER a save and nowhere else, so `declined`, empty and wrong-class input
 * (which return before this) can never chain. When it holds, the "Next, connect a repository" fix line is
 * dropped — `connect`'s own output follows — and `connect`'s exit code is returned. When it does not, the
 * block and the exit are exactly what they were.
 */
async function saved(ctx, deps, piped, notes = []) {
    // 0.7.0, D32 · 26A (supersedes only L6's "outside a repository" clause). Inside a work tree the chain is unchanged (L2).
    // Outside one, the continuation is the picker flow, and only on a machine that has nothing captured yet; a machine that
    // already captures prints one line and no picker. ⛔ BOTH of 0.6.0's other guards stay: `piped` (`--stdin`, or no
    // terminal) NEVER continues, so a CI runner with no grant still saves the credential and exits 0 instead of reaching the
    // non-terminal refusal and exiting 2; and the continuation gets no `browser` (`index.ts` hands `connect` none), so a
    // second sign-in cannot start.
    const inRepo = resolveProjectKeys(ctx.cwd) !== null;
    const capture = inRepo || piped || deps.connect === undefined ? null : machineCapture(ctx.home);
    const shouldConnect = !piped && deps.connect !== undefined && (inRepo || capture?.kind === "none");
    const staysOn = capture?.kind === "on";
    writeLines(ctx.stdout, [
        ...renderErrorBlock({
            kind: "ok",
            what: AUTH.savedWhat,
            why: [AUTH.savedWhy(tildePath(credentialsPath(ctx.home), ctx.home)), ...notes],
            ...(shouldConnect || staysOn
                ? {}
                : { fixLabel: AUTH.nextLabel, fixes: [channelCommand(ctx.env, ctx.selfPath, AUTH.nextCommand)] }),
        }, ctx.colour),
        ...(capture?.kind === "on" ? ["", ...wrap(PICKER.authStays(machineSummary(capture)), 2)] : []),
    ]);
    if (shouldConnect && deps.connect !== undefined)
        return await deps.connect(ctx);
    // Not chaining (the chained `connect` syncs for itself): this is the only other place a credential is saved, so it is the other
    // place a new credential row is synced. ⛔ It makes no prompt and prints nothing, so a piped or no-terminal `auth` (which never
    // continues, D32 guard 1) is as quiet as before; a failure is silent and the exit stays what it was.
    // ⛔ A piped, `--stdin` or no-terminal `auth` does NOT sync (L10: "with `--stdin`, or with no terminal, it only saves the credential"): a
    // sync sends this machine's grants, which is more than saving. R3-7 is for a person at a terminal.
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