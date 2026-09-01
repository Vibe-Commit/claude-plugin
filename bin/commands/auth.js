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
 * ## What this verb is NOT
 *
 * It is not sign-in, and it does not mint. `mintIngestCredential` exists in
 * `vibecommit-mcp` with no route in front of it, so on this side of the wire the
 * plaintext still comes from the web app's `POST /api/ingest-credentials`, shown
 * once, and the human carries it here. Putting a route in front of the minter is
 * the PKCE work `connect.ts` defers; this verb makes the paste path first-class,
 * it does not remove the paste.
 *
 * @provenance vibecommit-mcp src/oauth/ingest_credential.ts — no route mints one, re-verified
 * @provenance vibecommit-web app/api/ingest-credentials/route.ts — the only producer, verified
 */
import { AUTH, URLS } from "../copy/index.js";
import { writeLines } from "./context.js";
import { EXIT } from "../exit.js";
import { INGEST_TOKEN_PREFIX, IngestCredential, saveCredential } from "../credential.js";
import { credentialsPath } from "../paths.js";
import { renderErrorBlock, tildePath } from "../term.js";
/**
 * `--stdin` forces the pipe even on a terminal — the CI shape, where a job may
 * well have a TTY attached and must not start prompting because of it.
 */
const STDIN_FLAG = "--stdin";
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
    const piped = argv.includes(STDIN_FLAG) || !ctx.stdinIsTty;
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