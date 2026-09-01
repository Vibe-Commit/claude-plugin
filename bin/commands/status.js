/**
 * `vibecommit status` and `vibecommit off` — the screen, `CR-021`.
 *
 * Style guide §10.3 draws it and D65 makes that drawing the ruling, so this
 * module renders it rather than designing it: four questions in fixed order
 * (on for *this* repo? last successful send? where do I look? what do I type to
 * fix it?), then the revoke link, on §13.5's `LABEL_GUTTER`.
 *
 * ## What is deliberately NOT on the screen
 *
 * §10.3's `last sent` row reads `4 minutes ago · 3 turns · seq 41`. **The turn
 * count is not rendered and must not be.** Counting turns means parsing the
 * transcript's NDJSON and deciding what a turn is, and that is the analysis the
 * client is barred from holding — D60 §D6: *the client may render; it may not
 * analyze, hash, or canonicalize*. The one recorded deviation is `CR-024d`'s
 * redaction parse, authorised by name; there is no such authorisation here, and
 * the server is the only thing holding sealed turns to count. The age and the
 * `seq` are both facts this client already wrote down, so both render.
 *
 * ## Absence is not a blank
 *
 * When nothing has been delivered for this repo the row is OMITTED and
 * `STATUS.neverSent` says so in a sentence. No sixth absence phrasing is
 * invented here: `CR-112` (W8) owns the five-absence grammar as one set, and
 * adding a variant now is what that task exists to prevent.
 */
import { COMMANDS, CREDENTIAL, ERRORS, OFF, STATUS, URLS, relativeAge } from "../copy/index.js";
import { isProjectAllowed, revokeProject } from "../consent.js";
import { loadCredential, savedCredentialExists } from "../credential.js";
import { EXIT } from "../exit.js";
import { resolveRepoSlug } from "../git.js";
import { emitJson } from "../json.js";
import { resolveProjectKeys } from "../project.js";
import { lastSendForRepo } from "../state.js";
import { LABEL_GUTTER, WRAP_COLUMNS, glyph, labelled, paint, renderErrorBlock, tildePath, truncatePath, wrap, } from "../term.js";
import { writeLines } from "./context.js";
/** §10.3 indents the gutter rows four columns under the state line. */
const ROW_INDENT = 4;
export function status(ctx, argv = []) {
    // ⛔ THIS SCREEN USES BOTH ROLES AT ONCE (`D184 §1`), which is why the whole
    // function is not flipped: `on` below is CONSENT STATE and keys on the git
    // common dir, while the repo row, the send scan and the `--json` document are
    // REPO IDENTITY and stay on the worktree toplevel. The `--json` field is
    // literally named `toplevel`, so moving it would make the document lie.
    const keys = resolveProjectKeys(ctx.cwd);
    if (keys === null) {
        writeLines(ctx.stderr, renderErrorBlock({ kind: "bad", what: ERRORS.notAGitRepo, why: [] }, ctx.colour));
        return EXIT.failure;
    }
    const projectKey = keys.worktree;
    // ⛔ CONSENT STATE, on the common dir. A worktree of a consented clone must
    // report ON here, because the hook that runs there is now admitted — a
    // `status` still keyed on the toplevel would tell that user they are
    // disconnected while their session was being captured.
    const on = isProjectAllowed(ctx.home, keys.consent);
    const kind = on ? "ok" : "warn";
    const lines = [
        `  ${paint(ctx.colour, kind, glyph(ctx.colour, kind))} ${paint(ctx.colour, "strong", on ? STATUS.onForRepo : STATUS.offForRepo)}`,
        labelled(ROW_INDENT, STATUS.repoLabel, repoValue(ctx, projectKey)),
    ];
    // Question 2: the last successful send FOR THIS REPO. `status` has no
    // session_id — it is interactive — so this is a scan of the repo's session
    // files rather than a lookup (`lastSendForRepo`).
    const lastSend = lastSendForRepo(ctx.home, projectKey);
    if (lastSend !== null) {
        lines.push(labelled(ROW_INDENT, STATUS.lastSuccessLabel, STATUS.lastSuccessValue(relativeAge(lastSend.at, ctx.now().getTime()), lastSend.seq)));
    }
    lines.push(labelled(ROW_INDENT, STATUS.dashboardLabel, paint(ctx.colour, "accent", URLS.dashboard)));
    const load = loadCredential({ env: ctx.env, home: ctx.home });
    // §13.3 — `--json` emits NOTHING BUT the JSON document on stdout, so the
    // screen assembled above is DISCARDED rather than printed beside it.
    //
    // The credential fault below still refuses, and it refuses the same way it
    // does in prose: §13.6's block to stderr, nothing on stdout, exit 1. A failure
    // is not an answer, so it gets no document — `src/json.ts`'s docblock states
    // that split and why it is a builder's reading of §13.3 rather than a ruling.
    //
    // ⚠ `last_send` is `null` when nothing has been delivered, never a zeroed
    // object: absence here is *nothing has been sent*, and a `{ at_ms: 0 }` would
    // be a timestamp claim. §13.2's glyph rule has no glyph on this surface, so
    // `outcome` carries the on/off distinction the glyph carries on screen.
    if (argv.includes("--json")) {
        if (load.kind !== "ok" && load.kind !== "absent") {
            writeLines(ctx.stderr, credentialProblem(load, ctx.colour));
            return EXIT.failure;
        }
        emitJson(ctx.stdout, "status", on ? "on" : "off", {
            repo: resolveRepoSlug(projectKey),
            toplevel: projectKey,
            last_send: lastSend === null ? null : { at_ms: lastSend.at, seq: lastSend.seq },
            dashboard: URLS.dashboard,
            // `CR-216/U3`. A SOURCE NAME, never the credential — `IngestCredential.source`
            // is documented safe to log for exactly this. `null` is "no credential",
            // which is a different answer from either source and must not collapse into
            // one. D98 detection 3 holds the key set; this key is a contract change and
            // `json-read-verbs.test.ts` records it as one.
            credential: load.kind === "ok" ? load.credential.source : null,
        });
        return on ? EXIT.ok : EXIT.notConnected;
    }
    if (load.kind !== "ok" && load.kind !== "absent") {
        writeLines(ctx.stdout, lines);
        writeLines(ctx.stderr, credentialProblem(load, ctx.colour));
        return EXIT.failure;
    }
    // Absence is a SENTENCE, not a blank row. Triggered on the send record rather
    // than on the credential: a repo that has delivered and then lost its
    // credential has still recorded a session, and saying otherwise would be false.
    if (on && lastSend === null)
        lines.push("", ...wrap(STATUS.neverSent, 2));
    // `CR-216/U3`. Same precedent as `neverSent` above: a SENTENCE, not a fifth
    // gutter row — §10.3 draws four questions in a fixed order and the order is the
    // feature. Only when the env var is actually overriding something: CI sets the
    // variable deliberately with no file to shadow and must not be nagged for it.
    if (load.kind === "ok" && load.credential.source === "env" && savedCredentialExists(ctx.home)) {
        lines.push("", ...wrap(STATUS.credentialShadowed, 2));
    }
    lines.push("", ...actionLines(ctx, on));
    writeLines(ctx.stdout, lines);
    return on ? EXIT.ok : EXIT.notConnected;
}
/**
 * §10.3's repo row: `owner/name (git toplevel ~/path)`.
 *
 * The slug is `CR-019d`'s — the same value that goes on the wire as
 * `X-Repo-Slug` — so what `status` shows is what the server will resolve, which
 * is the point of `status` being the debugging tool (D57 §DX1). A repo with no
 * GitHub remote shows its `local:` identity rather than hiding it: that IS the
 * answer to "why does the dashboard not show my repo under its name?".
 *
 * The path is truncated from the LEFT (§13.4) against what the line actually has
 * left, not a fixed 60, so the row cannot exceed 80 columns for a long slug.
 */
function repoValue(ctx, toplevel) {
    const slug = resolveRepoSlug(toplevel);
    const shown = tildePath(toplevel, ctx.home);
    const overhead = ROW_INDENT + LABEL_GUTTER + STATUS.repoToplevel(slug, "").length;
    let budget = Math.max(12, WRAP_COLUMNS - overhead);
    let value = STATUS.repoToplevel(slug, truncatePath(shown, budget));
    // Fit the row by BYTES as well as by columns, and pay the difference only on
    // rows that actually truncate. `truncatePath`'s `…` is one column but three
    // UTF-8 bytes, so a row filled to exactly 80 columns is 82 bytes — which
    // passes §13.4 (a terminal renders one column) and fails the byte-counting
    // `awk` check the verify recipe uses. BSD awk counts bytes whatever the
    // locale, so satisfying the stricter measure is cheaper than arguing about
    // which one is right: it costs at most two columns, and only here.
    while (ROW_INDENT + LABEL_GUTTER + Buffer.byteLength(value) > WRAP_COLUMNS && budget > 12) {
        budget -= 1;
        value = STATUS.repoToplevel(slug, truncatePath(shown, budget));
    }
    return value;
}
/**
 * The two trailing actions, aligned as one pair — §10.3 draws their values in a
 * shared column, which only holds if both labels pad to the longer of the two.
 *
 * When capture is OFF the first line is the reconnect command instead: there is
 * nothing to turn off, and §10.3 only draws the on-state.
 */
function actionLines(ctx, on) {
    const pairs = on
        ? [
            [STATUS.turnOffLabel, COMMANDS.off],
            [STATUS.revokeLabel, URLS.settings],
        ]
        : [
            [STATUS.fixCommandLabel, COMMANDS.connect],
            [STATUS.revokeLabel, URLS.settings],
        ];
    const width = Math.max(...pairs.map(([label]) => label.length));
    return pairs.map(([label, value]) => {
        const painted = value.startsWith("https://") ? paint(ctx.colour, "accent", value) : value;
        return `  ${`${label}:`.padEnd(width + 2)}${painted}`;
    });
}
export function off(ctx) {
    const keys = resolveProjectKeys(ctx.cwd);
    if (keys === null) {
        writeLines(ctx.stderr, renderErrorBlock({ kind: "bad", what: ERRORS.notAGitRepo, why: [] }, ctx.colour));
        return EXIT.failure;
    }
    // ⛔ THE REVOKE SIDE, AND IT MUST DELETE THE KEY `connect` WROTE (`D184 §9`).
    // `revokeProject` deletes by exact string and reports `false` when the key is
    // absent — so a revoke still keyed on the toplevel would find nothing, print
    // "already off", and LEAVE THE GRANT IN PLACE. The user believes they
    // withdrew consent; capture continues. That is the worse direction of this
    // same bug, and it is the second mutation the cells below pin.
    const changed = revokeProject(ctx.home, keys.consent);
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
                fixes: [CREDENTIAL.wrongClassCommand],
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
                fixes: [CREDENTIAL.unreadableCommand],
            }, colour);
    }
}
//# sourceMappingURL=status.js.map