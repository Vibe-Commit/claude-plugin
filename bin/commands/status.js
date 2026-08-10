/**
 * `vibecommit status` and `vibecommit off`.
 *
 * ⚠ `CR-021` owns the OUTPUT SPEC for both — the four questions in fixed order
 * (on for *this* repo? last successful send? where do I look? what do I type to
 * fix it?) plus the revoke link, on the §13.5 label gutter. What is here is the
 * mechanism it will render: consent state, credential presence and its source.
 *
 * The `last sent` row is deliberately ABSENT rather than blank. It needs the
 * per-(repo, session, file) offset state that `CR-017` owns, and a row that says
 * "never" when we simply have nowhere to record it would be a false statement
 * about capture rather than a missing feature.
 */
import { COMMANDS, CREDENTIAL, ERRORS, OFF, STATUS, URLS } from "../copy/index.js";
import { isProjectAllowed, revokeProject } from "../consent.js";
import { loadCredential } from "../credential.js";
import { EXIT } from "../exit.js";
import { resolveProjectKey } from "../project.js";
import { glyph, labelled, paint, renderErrorBlock, truncatePath, wrap } from "../term.js";
import { writeLines } from "./context.js";
export function status(ctx) {
    const projectKey = resolveProjectKey(ctx.cwd);
    if (projectKey === null) {
        writeLines(ctx.stderr, renderErrorBlock({ kind: "bad", what: ERRORS.notAGitRepo, why: [] }, ctx.colour));
        return EXIT.failure;
    }
    const on = isProjectAllowed(ctx.home, projectKey);
    const kind = on ? "ok" : "warn";
    const lines = [
        `  ${paint(ctx.colour, kind, glyph(ctx.colour, kind))} ${paint(ctx.colour, "strong", on ? STATUS.onForRepo : STATUS.offForRepo)}`,
        labelled(4, "repo", truncatePath(projectKey, 60)),
        labelled(4, "dashboard", paint(ctx.colour, "accent", URLS.dashboard)),
    ];
    // CR-017's seam: `last sent` lands here once the offset state exists.
    if (!on)
        lines.push("", ...wrap(`${STATUS.fixCommandLabel}: ${COMMANDS.connect}`, 2));
    const load = loadCredential({ env: ctx.env, home: ctx.home });
    if (load.kind !== "ok" && load.kind !== "absent") {
        writeLines(ctx.stdout, lines);
        writeLines(ctx.stderr, credentialProblem(load, ctx.colour));
        return EXIT.failure;
    }
    if (load.kind === "absent" && on)
        lines.push("", ...wrap(STATUS.neverSent, 2));
    lines.push("", ...wrap(`${STATUS.revokeLabel}: ${URLS.settings}`, 2));
    writeLines(ctx.stdout, lines);
    return on ? EXIT.ok : EXIT.notConnected;
}
export function off(ctx) {
    const projectKey = resolveProjectKey(ctx.cwd);
    if (projectKey === null) {
        writeLines(ctx.stderr, renderErrorBlock({ kind: "bad", what: ERRORS.notAGitRepo, why: [] }, ctx.colour));
        return EXIT.failure;
    }
    const changed = revokeProject(ctx.home, projectKey);
    writeLines(ctx.stdout, [
        ...wrap(changed ? OFF.done : OFF.alreadyOff, 2),
        ...wrap(OFF.note, 2),
    ]);
    return EXIT.ok;
}
/**
 * The three credential problems that are worth four different fixes on an
 * interactive surface. The hook collapses them to one `systemMessage`; here the
 * user can act, so §13.6 gets its full what / why / fix.
 *
 * None of these lines can carry credential bytes: the plaintext leaves
 * `IngestCredential` only through `expose()`, and no copy path calls it.
 */
function credentialProblem(load, colour) {
    switch (load.kind) {
        case "wrong-class":
            return renderErrorBlock({
                kind: "bad",
                what: CREDENTIAL.wrongClassWhat,
                why: [
                    load.source === "env"
                        ? CREDENTIAL.wrongClassEnvWhy
                        : CREDENTIAL.wrongClassFileWhy,
                ],
                fixLabel: CREDENTIAL.wrongClassFix,
                fixes: [COMMANDS.connect],
            }, colour);
        case "insecure-file":
            return renderErrorBlock({
                kind: "bad",
                what: CREDENTIAL.insecureFileWhat,
                why: [
                    `${CREDENTIAL.insecureFileWhyLabel} ${truncatePath(load.path, 60)}`,
                    `${CREDENTIAL.insecureFileModeLabel} ${load.mode}`,
                    CREDENTIAL.insecureFileWhy,
                ],
                fixLabel: CREDENTIAL.insecureFileFix,
                fixes: [COMMANDS.chmodCredentials],
            }, colour);
        case "unreadable":
            return renderErrorBlock({
                kind: "bad",
                what: CREDENTIAL.unreadableWhat,
                why: [
                    `${CREDENTIAL.insecureFileWhyLabel} ${truncatePath(load.path, 60)}`,
                    CREDENTIAL.unreadableWhy,
                ],
                fixLabel: CREDENTIAL.unreadableFix,
                fixes: [COMMANDS.connect],
            }, colour);
    }
}
//# sourceMappingURL=status.js.map