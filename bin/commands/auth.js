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
 * @provenance vibecommit-mcp src/transport/server.ts — POST /oauth/ingest-credential is the mint route, verified
 * @provenance vibecommit-web app/api/ingest-credentials/route.ts — the dashboard producer the paste path still serves, verified
 */
import { AUTH, HELP, URLS } from "../copy/index.js";
import { writeLines } from "./context.js";
import { EXIT } from "../exit.js";
import { INGEST_TOKEN_PREFIX, IngestCredential, saveCredential } from "../credential.js";
import { credentialsPath } from "../paths.js";
import { paint, renderErrorBlock, tildePath, wrap } from "../term.js";
/**
 * `--stdin` forces the pipe even on a terminal — the CI shape, where a job may
 * well have a TTY attached and must not start prompting because of it.
 */
const STDIN_FLAG = "--stdin";
/** `CR-226`. Skip the browser and go straight to the prompt. */
const PASTE_FLAG = "--paste";
export async function auth(ctx, argv, deps = {}) {
    // ⛔ THE ARGV REFUSAL COMES FIRST, before stdin is read, resumed or opened.
    // Anything else would mean the secret in `argv` had already been accepted by
    // the time we objected to it.
    const positional = argv.filter((arg) => !arg.startsWith("-"));
    if (positional.length > 0) {
        writeLines(ctx.stderr, renderErrorBlock({
            kind: "bad",
            what: AUTH.argvWhat,
            why: [AUTH.argvWhy],
            fixLabel: AUTH.argvFix,
            fixes: [AUTH.argvFixPrompt, AUTH.argvFixStdin],
        }, ctx.colour));
        return EXIT.usage;
    }
    // `TODOS[184]`. SECOND, deliberately — VG's V3-1: a credential typed as an argument must still be
    // flagged for revocation even if `--help` also appears in `argv`, so the refusal above (which makes
    // exactly that a usage error) runs first. By the time this is reached, `positional.length === 0`, so
    // `--help` still has no side effects — nothing below has read or written anything yet either way.
    if (argv.includes("--help") || argv.includes("-h")) {
        writeLines(ctx.stdout, [HELP.commands.auth]);
        return EXIT.ok;
    }
    const piped = argv.includes(STDIN_FLAG) || !ctx.stdinIsTty;
    // ── `CR-226`: the browser, first, on a terminal only. ──────────────────────
    if (!piped && !argv.includes(PASTE_FLAG) && deps.browser !== undefined) {
        const minted = await deps.browser(ctx, "auth");
        if (minted.kind === "saved")
            return saved(ctx);
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
            what: AUTH.emptyWhat,
            why: [AUTH.emptyWhy],
            fixLabel: AUTH.emptyFix,
            fixes: [URLS.settings],
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
            what: AUTH.wrongClassWhat,
            why: [AUTH.wrongClassWhy],
            fixLabel: AUTH.wrongClassFix,
            fixes: [URLS.settings],
        }, ctx.colour));
        return EXIT.failure;
    }
    saveCredential(ctx.home, new IngestCredential(secret, "file"));
    return saved(ctx);
}
/** The one confirmation, whichever path wrote the file. */
function saved(ctx) {
    writeLines(ctx.stdout, renderErrorBlock({
        kind: "ok",
        what: AUTH.savedWhat,
        why: [AUTH.savedWhy(tildePath(credentialsPath(ctx.home), ctx.home))],
        fixLabel: AUTH.nextLabel,
        fixes: [AUTH.nextCommand],
    }, ctx.colour));
    return EXIT.ok;
}
//# sourceMappingURL=auth.js.map