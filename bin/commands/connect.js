/**
 * `vibecommit connect` — the install moment.
 *
 * This task owns the CONSENT GATE and the runtime floor. Two later tasks own the
 * rest of the screen and must not be front-run:
 *   - `CR-111` owns the disclosure copy. D64 falsified the trust argument the
 *     earlier draft used (this repo is private, so "read the source" is false and
 *     BLOCKED). The approved replacement links `Vibe-Commit/claude-plugin`, which
 *     vendors the exact binary — and "inspect the build" is WEAKER than "read the
 *     source" and may not be dressed up as it. Nothing here improvises it.
 *   - `CR-025` owns the ending: capture the current session and print the live
 *     `/app/commits/<sha>` URL. The seam is marked below.
 *
 * The oauth lane owns the browser sign-in beat (PKCE loopback → a minted,
 * revocable, ingest-audience credential). Until it lands, `VIBECOMMIT_TOKEN` is
 * the supported path — which is what it was added for.
 */
import { CONNECT, COMMANDS, ERRORS, HELP, RUNTIME, STATUS } from "../copy/index.js";
import { grantProject, isAffirmative, isProjectAllowed } from "../consent.js";
import { loadCredential } from "../credential.js";
import { EXIT } from "../exit.js";
import { resolveProjectKey } from "../project.js";
import { meetsNodeFloor, NODE_FLOOR_TEXT } from "../runtime.js";
import { paint, renderErrorBlock, wrap } from "../term.js";
import { writeLines } from "./context.js";
export async function connect(ctx) {
    // (1) The runtime floor refuses LOUDLY here, unlike in the hook: the user is
    // watching and can act, and D57 §DX11 asks for exactly that asymmetry.
    if (!meetsNodeFloor(ctx.nodeVersion)) {
        writeLines(ctx.stderr, renderErrorBlock({
            kind: "bad",
            what: RUNTIME.floorWhat,
            why: [
                `${RUNTIME.floorWhyPrefix} ${NODE_FLOOR_TEXT} ${RUNTIME.floorWhyMiddle} ${ctx.nodeVersion}.`,
            ],
            fixLabel: RUNTIME.floorFix,
            fixes: [COMMANDS.connect],
        }, ctx.colour));
        return EXIT.failure;
    }
    // (2) A project key is the git toplevel. Outside a work tree there is nothing
    // to consent ABOUT, and inventing a key from cwd would grant consent to
    // something the user cannot see in `status`.
    const projectKey = resolveProjectKey(ctx.cwd);
    if (projectKey === null) {
        writeLines(ctx.stderr, renderErrorBlock({ kind: "bad", what: ERRORS.notAGitRepo, why: [] }, ctx.colour));
        return EXIT.failure;
    }
    if (isProjectAllowed(ctx.home, projectKey)) {
        writeLines(ctx.stdout, wrap(CONNECT.alreadyConnected, 2));
        return credentialBeat(ctx);
    }
    // (3) The disclosure, then the gate.
    writeLines(ctx.stdout, disclosure(ctx));
    // (4) Non-TTY REFUSES. A consent prompt that proceeds when nobody can answer
    // it is not a consent prompt (D65 §DR7). Exit 2 — DESIGN.md §13.7 names this
    // case explicitly, so it is a usage error and not a failure.
    if (!ctx.stdinIsTty) {
        writeLines(ctx.stderr, renderErrorBlock({
            kind: "bad",
            what: CONNECT.nonInteractiveWhat,
            why: [CONNECT.nonInteractiveWhy],
            fixLabel: CONNECT.nonInteractiveFix,
            fixes: [COMMANDS.connect],
        }, ctx.colour));
        return EXIT.usage;
    }
    // (5) The default is N. Anything that is not an explicit yes is a no.
    const answer = await ctx.ask(`  ${CONNECT.consentPrompt} ${paint(ctx.colour, "muted", CONNECT.consentAnswers)} `);
    if (!isAffirmative(answer)) {
        writeLines(ctx.stdout, ["", ...wrap(CONNECT.declined, 2)]);
        // Declining is a successful consent flow, not a failure. Exit 0 (§13.7).
        return EXIT.ok;
    }
    grantProject(ctx.home, projectKey, ctx.now());
    writeLines(ctx.stdout, ["", ...wrap(STATUS.onForRepo, 2)]);
    return credentialBeat(ctx);
}
/**
 * The disclosure block.
 *
 * ⚠ PLACEHOLDER SHAPE, NOT PLACEHOLDER RULES. `CR-111` replaces the sentences;
 * what it must preserve is that every noun names something actually uploaded, in
 * the user's vocabulary, and that no reassurance adjective appears. The claims
 * gate in `src/copy/claims.ts` registers four of those adjectives on the
 * `connect` surface so a rewrite cannot reintroduce them silently.
 */
function disclosure(ctx) {
    return [
        ...wrap(CONNECT.consentHeading, 2),
        "",
        ...wrap(CONNECT.consentDetail, 2),
        "",
        // The docs URL has ONE definition, in the copy module. `accent` is allowed
        // on a URL (§13.1) and this line carries no second colour.
        `  ${CONNECT.consentLinkLabel}: ${paint(ctx.colour, "accent", HELP.docsUrl)}`,
        "",
    ];
}
/**
 * The credential beat.
 *
 * `CR-025` replaces this with the real ending: capture the current session and
 * print the live `/app/commits/<sha>` URL. It also owns the PATH-clash check —
 * the npm package `vibecommit` (a different project) installs a bin of the same
 * name, and on npm >= 7 the clash surfaces as EEXIST during the first install of
 * exactly the population that installs commit tooling.
 */
function credentialBeat(ctx) {
    const load = loadCredential({ env: ctx.env, home: ctx.home });
    if (load.kind === "ok") {
        writeLines(ctx.stdout, ["", ...wrap(`${STATUS.fixCommandLabel}: ${COMMANDS.off}`, 2)]);
        return EXIT.ok;
    }
    writeLines(ctx.stderr, renderErrorBlock({
        kind: "warn",
        what: CONNECT.credentialNeededWhat,
        why: [CONNECT.credentialNeededWhy],
        fixLabel: CONNECT.credentialNeededFix,
        fixes: [CONNECT.credentialNeededCommand, COMMANDS.connect],
    }, ctx.colour));
    return EXIT.notConnected;
}
//# sourceMappingURL=connect.js.map