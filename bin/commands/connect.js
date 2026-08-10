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
import { readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { CONNECT, COMMANDS, ERRORS, HELP, PATH_CLASH, RUNTIME, URLS } from "../copy/index.js";
import { grantProject, isAffirmative, isProjectAllowed } from "../consent.js";
import { loadCredential } from "../credential.js";
import { EXIT } from "../exit.js";
import { resolveRepoSlug } from "../git.js";
import { readSpan, DEFAULT_HOOK_BUDGET_MS } from "../hooks/entry.js";
import { classifyInstall } from "../install.js";
import { isInside, transcriptRoot } from "../paths.js";
import { deliver, ingestUrl } from "../post.js";
import { resolveProjectKey } from "../project.js";
import { meetsNodeFloor, NODE_FLOOR_TEXT } from "../runtime.js";
import { paint, renderErrorBlock, truncatePath, wrap } from "../term.js";
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
        return await credentialBeat(ctx, projectKey);
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
    return await credentialBeat(ctx, projectKey);
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
async function credentialBeat(ctx, projectKey) {
    const load = loadCredential({ env: ctx.env, home: ctx.home });
    if (load.kind === "ok") {
        return await captureBeat(ctx, projectKey, load.credential);
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
/**
 * The ending — D57 §DX5's Sentry-wizard test-event pattern.
 *
 * The install does not end on "configured", it ends on EVIDENCE: record this
 * session, then hand over a URL that resolves. §10.2 draws it.
 *
 * Two things §10.2 draws that are deliberately NOT here:
 *   - **`4 turns · 1 commit`.** Counting turns means parsing the transcript, and
 *     the client may render but may not analyze (D60 §D6). It is not obtainable
 *     from the server either: `send()` returns a status and discards the body,
 *     so no id, sha or count exists on this side of the wire.
 *   - **`Opening your browser to sign in...`.** That beat is the oauth lane's.
 *     Until PKCE lands, `VIBECOMMIT_TOKEN` is the supported path.
 */
async function captureBeat(ctx, projectKey, credential) {
    const found = findCurrentTranscript(ctx, projectKey);
    if (found === null) {
        writeLines(ctx.stderr, renderErrorBlock({
            kind: "warn",
            what: CONNECT.noTranscriptWhat,
            why: [CONNECT.noTranscriptWhy],
            fixLabel: CONNECT.noTranscriptFix,
            fixes: [COMMANDS.status],
        }, ctx.colour));
        return EXIT.failure;
    }
    const url = ingestUrl(ctx.env);
    if (url !== null) {
        // Through `deliver()`, so the offset ledger, the failure policy and
        // `CR-024d`'s redaction all apply exactly as they do for a hook. A second
        // upload path here would bypass all three.
        await deliver({
            home: ctx.home,
            env: ctx.env,
            url,
            credential,
            repoKey: projectKey,
            repoSlug: resolveRepoSlug(projectKey),
            sessionId: found.sessionId,
            fileKey: "main",
            timeoutMs: DEFAULT_HOOK_BUDGET_MS,
            nowMs: ctx.now().getTime(),
        }, found.size, (from, to) => readSpan(found.path, from, to, projectKey));
    }
    // The beat, then the URL on its own line, then what-now. The outcome of the
    // send is deliberately not branched on: `later` and `never` are transient or
    // per-payload (D58) and the offset holds, so telling a user their install
    // failed because one POST 503'd would be false.
    writeLines(ctx.stdout, [
        "",
        ...wrap(`${CONNECT.capturing} ${CONNECT.doneHeading}`, 2),
        "",
        `  ${paint(ctx.colour, "accent", URLS.commits)}`,
        "",
        ...wrap(CONNECT.doneForRepo(truncatePath(projectKey, 52)), 2),
        ...wrap(`${CONNECT.stopLabel}: ${COMMANDS.off}`, 2),
    ]);
    return pathClash(ctx);
}
/**
 * The transcript for the session running right now.
 *
 * A hook is HANDED `transcript_path` on stdin. `connect` is typed by a human and
 * gets nothing, so it has to find one: Claude Code stores transcripts at
 * `<transcriptRoot>/<encoded-project-path>/<session-id>.jsonl`, where the
 * encoding replaces `/` and `.` with `-`. That was derived by comparing every
 * directory on this machine against the `cwd` its transcripts record — 15 of 17
 * matched exactly, and both misses were sessions whose `cwd` MOVED mid-session,
 * not a different encoding.
 *
 * Which is also why this looks up the directory for THIS project rather than
 * taking the newest transcript anywhere: a session that started in another
 * project and `cd`'d here lives under that project's directory, and uploading it
 * would attach one project's session to another's repo — the same confusion
 * `CR-017d`'s key exists to prevent.
 *
 * **Confined.** `isInside(transcriptRoot(...))` gates the result, because this is
 * a NEW reader of transcript bytes and `/cso` finding 1 is about exactly this
 * class of read. A candidate that resolves outside the root is not returned.
 */
function findCurrentTranscript(ctx, projectKey) {
    const root = transcriptRoot(ctx.home, ctx.env);
    const dir = join(root, projectKey.replace(/[/.]/g, "-"));
    let entries;
    try {
        entries = readdirSync(dir);
    }
    catch {
        return null;
    }
    let best = null;
    for (const entry of entries) {
        if (!entry.endsWith(".jsonl"))
            continue;
        const path = join(dir, entry);
        if (!isInside(root, path))
            continue;
        let stat;
        try {
            stat = statSync(path);
        }
        catch {
            continue;
        }
        if (!stat.isFile() || stat.size === 0)
            continue;
        if (best === null || stat.mtimeMs > best.mtime) {
            best = {
                path,
                sessionId: basename(entry, ".jsonl"),
                size: stat.size,
                mtime: stat.mtimeMs,
            };
        }
    }
    return best === null ? null : { path: best.path, sessionId: best.sessionId, size: best.size };
}
/**
 * Does the `vibecommit` a user types belong to us? — `DESIGN.md` §13.6's worked
 * example, which was drawn for this check.
 *
 * **Runs LAST, deliberately.** The clash is about the verbs a human types, not
 * about whether capture works; running it first would refuse to connect a user
 * whose install is otherwise fine, and hook capture is unaffected either way
 * because the plugin invokes the binary by path.
 *
 * Exit 1, not 2 and not 3: the user typed nothing wrong (2 is usage) and may be
 * perfectly well connected (3 is not-connected). §13.7.
 */
function pathClash(ctx) {
    const verdict = classifyInstall(ctx.env, ctx.selfPath);
    if (verdict.kind === "ours")
        return EXIT.ok;
    writeLines(ctx.stderr, renderErrorBlock({
        kind: "bad",
        what: verdict.kind === "foreign" ? PATH_CLASH.foreignWhat : PATH_CLASH.absentWhat,
        why: [
            verdict.kind === "foreign"
                ? PATH_CLASH.foreignWhy(truncatePath(verdict.resolved, 52))
                : PATH_CLASH.absentWhy,
        ],
        fixLabel: PATH_CLASH.fixLabel,
        fixes: [
            verdict.kind === "foreign" ? PATH_CLASH.fixReplace : PATH_CLASH.fixInstall,
            PATH_CLASH.fixDirectLabel,
            PATH_CLASH.fixDirect,
        ],
    }, ctx.colour));
    return EXIT.failure;
}
//# sourceMappingURL=connect.js.map