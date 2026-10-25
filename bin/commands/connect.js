/**
 * `vibecommit connect` — the install moment.
 *
 * This task owns the CONSENT GATE and the runtime floor. Two later tasks own the
 * rest of the screen and must not be front-run:
 *   - `CR-111d` landed the disclosure copy, transcribed from style guide §10.2.
 *     D64 falsified the trust argument the earlier draft used (this repo is
 *     private, so "read the source" is false and BLOCKED). The approved
 *     replacement links `Vibe-Commit/claude-plugin`, which vendors the exact
 *     binary — and "inspect the build" is WEAKER than "read the source" and may
 *     not be dressed up as it.
 *   - `CR-025` owns the ending: capture the current session and print the live
 *     `/app/commits/<sha>` URL. The seam is marked below.
 *
 * `CR-084d` landed the browser sign-in beat (PKCE loopback → a user-principal
 * token for the READ lane) behind `--sign-in`, opt-in because sign-in did not
 * produce an ingest credential.
 *
 * ⚠ `CR-226` CHANGED THAT, AND THIS NOTE USED TO SAY THE OPPOSITE. The server
 * now has a route in front of `mintIngestCredential`, so a fresh machine that
 * reaches the credential beat with a human at the terminal signs in through the
 * browser and mints its own credential there (`browser_credential.ts`) — browser
 * FIRST, with the old warning pointing at `vibecommit auth` as the fallback when
 * any step fails. `--sign-in` keeps its meaning (sign in for the read lane even
 * when a credential exists), and `VIBECOMMIT_TOKEN` still wins over everything.
 *
 * @provenance vibecommit-mcp src/transport/server.ts — POST /oauth/ingest-credential now mints one, verified
 */
import { AUTH, CONNECT, PICKER, COMMANDS, AGENT_HOOKS, COMMIT_HOOK, HELP, PATH_CLASH, REJECTED, DEVICE, RUNTIME, URLS, } from "../copy/index.js";
import { dialectFor } from "../agents/registry.js";
import { clearExclusion, grantProject, grantsUnreadable, isAffirmative, isCaptureAllowed, isLocalSlug, } from "../consent.js";
import { loadCredential } from "../credential.js";
import { EXIT } from "../exit.js";
import { onceRepoSlug, resolveRepoSlug } from "../git.js";
import { confinementRoots, hookBudgetMs, readSpan, recordCutter, DEFAULT_HOOK_BUDGET_MS } from "../hooks/entry.js";
import { installAgentHooks } from "../agent_install.js";
import { authCommandFor, channelCommand, classifyInstall, connectCommandFor, installPostCommitHook } from "../install.js";
import { realpathSync } from "node:fs";
import { CAPTURE_NOT_APPROVED, deliver, credentialFingerprint, ingestUrl, } from "../post.js";
import { resolveProjectKeys } from "../project.js";
import { meetsNodeFloor, NODE_FLOOR_TEXT } from "../runtime.js";
import { credentialsPath } from "../paths.js";
import { paint, renderErrorBlock, tildePath, truncatePath, wrap } from "../term.js";
import { renderVerbHelp } from "../verb_help.js";
import { approvalPendingBlock } from "./approval_pending.js";
import { credentialProblem, rejectedCredentialBlock } from "./credential_problem.js";
import { probeCredential } from "./probe.js";
import { writeLines } from "./context.js";
import { signInBeat } from "./browser_credential.js";
export async function connect(ctx, options = {}, deps = {}) {
    // `TODOS[184]`. Checked first, before the node-floor check below — nothing about `--help` on
    // `connect` carries the "already exposed" urgency `auth`'s own positional refusal does, so first is
    // safe here, unlike there. Reads and writes nothing.
    if (options.help === true) {
        const helpVerb = "connect"; // an identifier, not a literal, at the writer: `copy-inline-literals` follows argument positions
        writeLines(ctx.stdout, renderVerbHelp(helpVerb));
        return EXIT.ok;
    }
    // `CR-234d`: sign-in by code waits on a person and ends in a question — a terminal or nothing.
    if (options.device === true && !ctx.stdinIsTty) {
        writeLines(ctx.stderr, renderErrorBlock({
            kind: "bad",
            code: "SIGNIN_CODE_NEEDS_TTY",
            what: DEVICE.needsTerminalWhat,
            why: [DEVICE.needsTerminalWhy],
            fixLabel: DEVICE.needsTerminalFix,
            fixes: [DEVICE.needsTerminalCommand(authCommandFor(ctx.env, ctx.selfPath))],
        }, ctx.colour));
        return EXIT.usage;
    }
    // (1) The runtime floor refuses LOUDLY here, unlike in the hook: the user is
    // watching and can act, and D57 §DX11 asks for exactly that asymmetry.
    if (!meetsNodeFloor(ctx.nodeVersion)) {
        writeLines(ctx.stderr, renderErrorBlock({
            kind: "bad",
            code: "NODE_TOO_OLD",
            what: RUNTIME.floorWhat,
            why: [
                `${RUNTIME.floorWhyPrefix} ${NODE_FLOOR_TEXT} ${RUNTIME.floorWhyMiddle} ${ctx.nodeVersion}.`,
            ],
            fixLabel: RUNTIME.floorFix,
            fixes: [connectCommandFor(ctx.env, ctx.selfPath)],
        }, ctx.colour));
        return EXIT.failure;
    }
    // (2) WHERE ARE WE? (0.7.0, D34.) `connect` no longer needs a work tree: outside one, and from `$HOME` even inside one, it
    // shows the picker. Inside a work tree with a remote it shows the picker with this repo pre-ticked. A repo that is
    // ALREADY covered skips it, and a repo with no remote (`local:`) keeps the 0.6.0 flow: there is no slug to grant.
    //
    // ⛔ THE PER-CLONE GRANT IS STILL THE ONLY WRITER OF `projects.json`, and it writes `keys.consent` — the git common
    // dir (`D184 §1`, `§9`): granting the toplevel while the gates check the common dir is a TOTAL, SILENT capture outage
    // in every repository, and no cell that grants and checks through one helper can see it.
    const keys = resolveProjectKeys(ctx.cwd);
    if (keys === null || atHome(ctx)) {
        // Outside a work tree: nothing to pre-tick. At `$HOME` a dotfiles repo is FLAGGED in the list, never pre-ticked.
        let here = null;
        if (keys !== null) {
            const slug = resolveRepoSlug(keys.worktree);
            if (!isLocalSlug(slug))
                here = { slug, toplevel: keys.worktree, kind: "folder" };
        }
        return await (await import("./connect_picker.js")).connectPicker(ctx, options, deps, here);
    }
    // 0.7.0: the same decision the hooks make. A repo that is excluded (`vibecommit off`) is NOT already connected here
    // even when its common-dir consent survives, so it falls through to the disclosure, and only a yes below clears it.
    const slugOf = onceRepoSlug(keys.worktree);
    if (grantsUnreadable(ctx.home) && !isLocalSlug(slugOf())) {
        writeLines(ctx.stderr, grantsUnreadableBlock(ctx));
        return EXIT.failure;
    }
    if (isCaptureAllowed(ctx.home, keys, slugOf)) {
        writeLines(ctx.stdout, wrap(CONNECT.alreadyConnected, 2));
        return await afterConsent(ctx, keys, options, deps);
    }
    if (!isLocalSlug(slugOf())) {
        return await (await import("./connect_picker.js")).connectPicker(ctx, options, deps, { slug: slugOf(), toplevel: keys.worktree, kind: "repo" }, keys);
    }
    // (3) The disclosure, then the gate. A repo with no remote: the 0.6.0 screen, under its own heading (D35).
    writeLines(ctx.stdout, disclosure(ctx, false));
    // (4) Non-TTY REFUSES. A consent prompt that proceeds when nobody can answer
    // it is not a consent prompt (D65 §DR7). Exit 2 — DESIGN.md §13.7 names this
    // case explicitly, so it is a usage error and not a failure.
    if (!ctx.stdinIsTty) {
        writeLines(ctx.stderr, renderErrorBlock({
            kind: "bad",
            code: "CONSENT_NEEDS_TTY",
            what: CONNECT.nonInteractiveWhat,
            why: [CONNECT.nonInteractiveWhy],
            // PR 6 item 6: names the folder the user is to run it in, cut from the LEFT to fit the line (§13.4).
            fixLabel: CONNECT.nonInteractiveFix(truncatePath(tildePath(keys.worktree, ctx.home), 46)),
            fixes: [connectCommandFor(ctx.env, ctx.selfPath)],
        }, ctx.colour));
        return EXIT.usage;
    }
    // (5) The default is N. Anything that is not an explicit yes is a no. ⛔ A REJECTED QUESTION IS A CANCEL: Ctrl+C at a
    // `readline/promises` question does not raise SIGINT, the promise REJECTS (TODOS[191]), and left to escape it printed
    // the "unexpected error" block for what is ordinary CLI behaviour.
    const answer = await askOrCancel(ctx, `  ${CONNECT.consentPrompt} ${paint(ctx.colour, "muted", CONNECT.consentAnswers)} `);
    if (answer === null)
        return cancelled(ctx);
    if (!isAffirmative(answer)) {
        writeLines(ctx.stdout, ["", ...wrap(CONNECT.declined, 2)]);
        // Declining is a successful consent flow, not a failure. Exit 0 (§13.7).
        return EXIT.ok;
    }
    // A yes is the ONLY thing that lifts an exclusion: `off` recorded the slug, and the disclosure above was shown again.
    // ⛔ `grants.json` FIRST, THE COMMON-DIR CONSENT SECOND (VR #28, on merged #73). `clearExclusion` refuses to touch a file it
    // cannot read BEFORE it writes anything, so a race with an edit of `grants.json` since the check above stops here with
    // nothing written — which keeps "Nothing was changed." true. The other order had already written `projects.json`.
    // A repo with no remote has no slug to exclude and is exempt from an unreadable file (`isCaptureAllowed`), so it skips this.
    if (!isLocalSlug(slugOf()) && clearExclusion(ctx.home, slugOf()) === "unreadable") {
        writeLines(ctx.stderr, grantsUnreadableBlock(ctx));
        return EXIT.failure;
    }
    grantProject(ctx.home, keys.consent, ctx.now());
    return await afterConsent(ctx, keys, options, deps);
}
/** Is the working folder the home directory? Realpaths, so a symlinked home still matches; any failure is "no". */
function atHome(ctx) {
    if (ctx.home === "")
        return false;
    try {
        return realpathSync(ctx.cwd) === realpathSync(ctx.home);
    }
    catch {
        return false;
    }
}
/**
 * Ask a question; `null` when the prompt was aborted. Ctrl+C at a `readline/promises` question closes the interface and
 * REJECTS with an `AbortError` instead of raising SIGINT (TODOS[191]), so every ask site that wants Ctrl+C to be a No
 * goes through here. A rejection means nobody said yes.
 */
export async function askOrCancel(ctx, question) {
    try {
        return await ctx.ask(question);
    }
    catch {
        return null;
    }
}
/** §10.11: Ctrl+C at the picker or the grant y/N is a No. Exit 1, and nothing was changed. */
export function cancelled(ctx) {
    // The terminal left the cursor at the end of the prompt line, so one empty line ends it and a second leaves the blank
    // line the drawn screen has.
    writeLines(ctx.stdout, ["", "", ...wrap(PICKER.cancelled, 2)]);
    return EXIT.failure;
}
export function grantsUnreadableBlock(ctx) {
    return renderErrorBlock({
        kind: "bad",
        code: "GRANTS_UNREADABLE",
        what: CONNECT.grantsUnreadableWhat,
        why: [CONNECT.grantsUnreadableWhy],
        fixLabel: CONNECT.grantsUnreadableFixLabel,
        fixes: [connectCommandFor(ctx.env, ctx.selfPath)],
    }, ctx.colour);
}
/**
 * Consent is settled. Sign in if asked, then do the credential beat.
 *
 * The two are sequential and NOT conditional on each other, because they are
 * different lanes: sign-in establishes the user principal the READ lane needs,
 * and the credential beat is about the machine credential the HOOK lane needs.
 * A failure in one says nothing about the other — which is why a failed sign-in
 * returns here rather than falling through to report the install as fine.
 */
async function afterConsent(ctx, keys, options, deps) {
    if (options.signIn === true) {
        // `G8a`: `verify` — a session file that loads but that the server refuses to renew is expired,
        // and "already signed in" over it was the bug.
        const code = await signInBeat(ctx, { retry: "sign-in", verify: true, ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }) });
        if (code !== EXIT.ok)
            return code;
    }
    return await credentialBeat(ctx, keys, deps, options);
}
/**
 * The disclosure block — `CR-111d`, style guide §10.2 transcribed.
 *
 * FOUR paragraphs and two labelled links: what is uploaded, what that means
 * concretely, the scrubber's STATED LIMIT, and — `T15` — the COMMITS, which are
 * a second data class the first three never mentioned. Then the docs list and
 * the public bundle.
 *
 * ⚠ The rules it satisfies that no gate can check (§10.2 rules 3-6): every noun
 * names something actually uploaded IN THE USER'S VOCABULARY (*"the output of
 * commands it ran"*, never *"Bash tool results"*); the scrubber is a pattern
 * list with a stated limit, never protection; no reassurance adjective appears;
 * and "open source" does not. The claims gate registers four of the five
 * adjectives on this surface — **`private` is deliberately NOT registered**,
 * because the approved copy itself says "private-repo paths", so a substring
 * gate would fire on approved copy on day one. That one is a HUMAN review item.
 */
export function disclosure(ctx, picker) {
    // §10.2 aligns the two link URLs in one column. The width is DERIVED from the
    // labels rather than hardcoded, so editing a label cannot silently break the
    // alignment — and the four trailing spaces are the gutter the guide draws.
    const gutter = Math.max(CONNECT.consentDocsLabel.length, CONNECT.consentBundleLabel.length) + 4;
    return [
        // D23 · D35: the picker path and the no-remote path each have their own heading (a new constant, passing the same
        // content gates). The four paragraphs under either are byte-identical, and the picker path adds ONE sentence.
        ...wrap(picker ? CONNECT.consentHeadingPicker : CONNECT.consentHeading, 2),
        ...(picker ? wrap(CONNECT.consentScope, 2) : []),
        "",
        ...wrap(CONNECT.consentDetail, 2),
        "",
        ...wrap(CONNECT.consentScrubber, 2),
        "",
        // ⛔ THE SECOND DATA CLASS (`T15`, `D190`). The three paragraphs above are
        // TRANSCRIPT CONTENT and were the whole disclosure; commit SHAs have been on
        // the wire since `CR-170` with no word here, and `D190` adds the attribution
        // rung and LOCAL, UNPUSHED REWRITE HISTORY. Placed AFTER the scrubber so the
        // transcript thread — what is uploaded, then that its secret scrubbing has a
        // stated limit — is not split by a different subject.
        ...wrap(CONNECT.consentCommits, 2),
        "",
        // Both URLs have ONE definition each, in the copy module. `accent` is
        // allowed on a URL (§13.1) and neither line carries a second colour.
        `  ${CONNECT.consentDocsLabel.padEnd(gutter)}${paint(ctx.colour, "accent", HELP.docsUrl)}`,
        // ⚠ THE HONEST REPLACEMENT FOR THE OPEN-SOURCE CLAIM. D64 made this repo
        // private with MIT intact, so "read the source" is false and is registered
        // BLOCKED on this surface. `claude-plugin` is public non-negotiably (D20)
        // and vendors the binary — an artefact to inspect, which is WEAKER than
        // readable source and is not dressed up as it (D65 §DR7).
        `  ${CONNECT.consentBundleLabel.padEnd(gutter)}${paint(ctx.colour, "accent", URLS.pluginBundle)}`,
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
async function credentialBeat(ctx, keys, deps, options = {}) {
    const got = await obtainCredential(ctx, deps, options);
    if (got.kind === "exit")
        return got.code;
    return await captureBeat(ctx, keys, got.credential, got.unconfirmed);
}
/**
 * Get a credential this machine can send with — the beat both endings share (the 0.6.0 one and the picker's).
 * `scope: "repos"` is the picker path: the workspace question names the repos chosen, not the machine (D7 · 3A).
 */
export async function obtainCredential(ctx, deps, options = {}, scope) {
    const load = loadCredential({ env: ctx.env, home: ctx.home });
    if (load.kind === "ok") {
        // ⛔ ASK THE SERVER BEFORE SENDING — `R12` (D13 = A), G1. `connect` used to send whatever loaded
        // and print "Recording… Connected." over the 401, and the hook's own 401 copy sent users here to
        // reconnect. The probe runs FIRST so a dead credential never writes a stop (the send is skipped
        // and the turns stay held), and so nothing below can say "Connected" without the server's yes.
        const probe = await probeCredential(ctx, load.credential, deps.fetch);
        if (probe.kind === "unauthorized") {
            writeLines(ctx.stderr, rejectedCredentialBlock({
                home: ctx.home,
                fingerprint: credentialFingerprint(load.credential),
                nowMs: ctx.now().getTime(),
                authCommand: authCommandFor(ctx.env, ctx.selfPath),
                colour: ctx.colour,
                standing: false,
            }));
            return { kind: "exit", code: EXIT.notConnected };
        }
        // Only a 401 proves the credential dead. A 5xx, a 404 from a server that predates the route, a
        // timeout or a network error says nothing about it — and "a blip is not a failed install" is the
        // rule `captureBeat` already keeps for the send. So: today's ending, plus one muted line.
        return { kind: "credential", credential: load.credential, unconfirmed: probe.kind === "unavailable" };
    }
    // ⛔ ONLY FOR `absent`, AND ONLY WITH A HUMAN AT THE TERMINAL (`CR-226`).
    //   - `absent`: a credential that is present but wrong-class, unreadable or
    //     insecure is a FAULT, and a fault's fix is `vibecommit auth` (D206 §5,
    //     `credential-fix-copy.test.ts`). Minting over it would hide the fault.
    //   - `stdinIsTty`: a wrapper or a CI job runs `connect` too, and a browser
    //     opened there waits five minutes for nobody. The old warning is the
    //     right answer for them, and it is what they still get.
    if (load.kind === "absent" && ctx.stdinIsTty && deps.browser !== undefined) {
        const minted = await deps.browser(ctx, "connect", {
            device: options.device === true,
            ...(scope === undefined ? {} : { scope }),
        });
        if (minted.kind === "saved") {
            writeLines(ctx.stdout, [
                "",
                ...renderErrorBlock({
                    kind: "ok",
                    what: AUTH.savedWhat,
                    why: [AUTH.savedWhy(tildePath(credentialsPath(ctx.home), ctx.home)), ...(minted.notes ?? [])],
                }, ctx.colour),
            ]);
            // Already probed by the mint (`finishMint`), so no second probe here.
            return { kind: "credential", credential: minted.credential, unconfirmed: false };
        }
        // Declined at the replace confirmation: the reason is already on screen, and the user said NO.
        if (minted.kind === "declined")
            return { kind: "exit", code: EXIT.failure };
        // Failed: the reason is already on stderr. Fall through to the paste path.
    }
    // ⛔ R15: a FAULTY file is named as the fault it is, not as "no credential". The fix for a fault is
    // `auth` (or a `chmod`), and `connect` still never mints over one (D206 §5).
    if (load.kind !== "absent") {
        writeLines(ctx.stderr, credentialProblem(load, ctx.colour, authCommandFor(ctx.env, ctx.selfPath)));
        return { kind: "exit", code: EXIT.notConnected };
    }
    writeLines(ctx.stderr, renderErrorBlock({
        kind: "warn",
        what: CONNECT.credentialNeededWhat,
        why: [CONNECT.credentialNeededWhy],
        fixLabel: CONNECT.credentialNeededFix,
        fixes: [CONNECT.credentialNeededCommand, COMMANDS.connect].map((fix) => channelCommand(ctx.env, ctx.selfPath, fix)),
    }, ctx.colour));
    return { kind: "exit", code: EXIT.notConnected };
}
/**
 * The test capture: send the current session's transcript through `deliver()` so the ending can name evidence (D57 §DX5's
 * Sentry-wizard pattern). Shared by the 0.6.0 ending (`captureBeat`) and the in-repo picker path (0.7.0, VQ item 7), so the
 * two cannot drift: one budget (`hookBudgetMs`, PR 4a), one redaction root set, one place that reads a 2xx body.
 *
 * `found` is the located transcript, or `null` when there is none (no locator, or the agent has not run here). Returns the
 * delivery, or `null` when nothing was sent.
 */
export async function sendTestCapture(ctx, keys, credential, found) {
    const projectKey = keys.worktree;
    const url = ingestUrl(ctx.env);
    let delivery = null;
    if (found !== null && url !== null) {
        // Through `deliver()`, so the offset ledger, the failure policy and
        // `CR-024d`'s redaction all apply exactly as they do for a hook. A second
        // upload path here would bypass all three.
        delivery = await deliver({
            home: ctx.home,
            env: ctx.env,
            url,
            credential,
            repoKey: projectKey,
            repoSlug: resolveRepoSlug(projectKey),
            sessionId: found.sessionId,
            fileKey: "main",
            // ⛔ The LOCATED path (`CR-204`), so this test capture names its producer
            // on the wire exactly as a hook's would — and names it the same way,
            // from the root that contains the file rather than from `ctx.agentId`.
            // ⚠ The LOCATOR above is still the flag's: `connect` is looking FOR a
            // transcript, so there is no path yet to ask a root about.
            transcriptPath: found.path,
            timeoutMs: DEFAULT_HOOK_BUDGET_MS,
            // PR 4a — ONE HOOK BUDGET (Alexander's ruling, design doc Next Steps 4a). A large session is sent in deltas, and this
            // test capture sends what fits in a single hook's budget, then prints its ending: `connect` must not sit through a
            // multi-minute upload that the session's own hooks, `finalize` and the backfill offer will do anyway. What is left
            // is NOT written off: the offset stays where the last acknowledged delta put it. The ending below is unchanged for a
            // partial delivery, and so is the conversation-id link (the id comes from the first delta that carries it).
            deadlineAtMs: Date.now() + hookBudgetMs(ctx.env, ctx.agentId ?? ""),
            nowMs: ctx.now().getTime(),
            // ⛔ NOT A HOOK. `connect` backfills the located transcript, which is not evidence that the session is alive: it
            // would otherwise rewrite an old session's state file and (under the mtime clock) make it "live" — the D2 shape.
            byHook: false,
            // ⛔ THE ONLY CALLER THAT READS A 2xx BODY (`eng-2 D2 = A`): for the session link. Hooks and
            // `finalize` leave this unset, so the hook's hot path never reads, awaits or parses one.
            readConversationId: true,
        }, found.size, 
        // ⛔ THE ROOT SET, and it is `confinementRoots` — THE SAME FUNCTION THE
        // HOOK PATH CALLS (`entry.ts`), not a set built here. `D184 §3`: the
        // confinement root is `[worktree, mainToplevel]` and the consent key is
        // NEVER a member, so this does not follow the flip above.
        //
        // ⚠ WHY IT CANNOT STAY THE SINGLETON IT WAS: `connect` runs in whatever
        // cwd a human typed it in, which is reachable from inside a worktree. With
        // one root, this preview would redact main-clone content that the hook
        // path transmits — the two would disagree SILENTLY, and the preview is the
        // artefact the user reads to decide whether redaction works. `isInside`
        // fail-closes an unresolvable path to REDACT, so the disagreement shows up
        // as a plausible, well-formed, emptier payload rather than an error.
        (from, to) => readSpan(found.path, from, to, confinementRoots(keys), ctx.home, ctx.env), recordCutter(found.path));
    }
    return { delivery };
}
/**
 * The ending — D57 §DX5's Sentry-wizard test-event pattern.
 *
 * The install does not end on "configured", it ends on EVIDENCE: record this
 * session, then hand over a URL that resolves. §10.2 draws it.
 *
 * ## Order: setup first, payoff last (`DX D9`)
 *
 * The git hook and the agent hooks are installed and REPORTED FIRST, on every
 * branch — no transcript, approval pending, or the normal ending — so the last
 * thing a new user sees is "Connected." and the session link, not ten lines of
 * hook paths that scrolled it away. After the outcome come, in this order, the
 * unconfirmed note and `pathClash`, which runs EXACTLY ONCE, here, and not in
 * any branch (`approvalPendingBeat` used to end in its own call; with a shared
 * tail the clash block would print twice on the pending path).
 *
 * ⚠ Both pre-existing holes this closes were the same shape: the two hook beats
 * sat AFTER two early returns (no transcript, approval pending), so an org
 * awaiting approval, and a repo Claude Code had never run in, got NO hooks while
 * the screen said "Capture is armed" / "Capture starts on its own". Neither was
 * true on the npm channel.
 *
 * Two things §10.2 draws that are deliberately NOT here:
 *   - **`4 turns · 1 commit`.** Counting turns means parsing the transcript, and
 *     the client may render but may not analyze (D60 §D6). It is not obtainable
 *     from the server either: `send()` returns a status, and on `connect`'s opt-in
 *     reads ONE field of a 2xx body — the `conversation_id` for the session link
 *     (`DX D8`) — so no sha or count exists on this side of the wire.
 *   - **`Opening your browser to sign in...`.** That beat runs BEFORE this one
 *     now (`credentialBeat` → `browser_credential.ts`, `CR-226`), and only when
 *     there was no credential to start with — by the time this function runs,
 *     the credential exists however it arrived.
 */
async function captureBeat(ctx, keys, credential, 
/** The probe could not answer (`R12`): say so once, last, and carry on. Never changes the exit. */
unconfirmed) {
    // ⚠ EVERY USE BELOW BUT ONE IS THE TOPLEVEL ROLE — locating the transcript,
    // the `repoKey` binding, the slug, the hook install and the copy the user
    // reads. The exception is the redaction root set at `readSpan`, which takes
    // BOTH keys through `confinementRoots`. Aliased rather than renamed
    // throughout, so the diff shows the line whose ROLE changed and not fourteen
    // that did not.
    const projectKey = keys.worktree;
    // ⛔ COMMIT CAPTURE IS INSTALLED AND REPORTED HERE (`CR-170`, D154), BEFORE ANY BRANCH — see "Order"
    // in the docblock. Three of its failure modes are silent no-ops, so every outcome prints — including
    // success, which is the only place the PER-CLONE cost can be stated at a moment the user can act on it.
    commitHookBeat(ctx, projectKey);
    // ⛔ SESSION CAPTURE IS REGISTERED AND REPORTED NEXT (`CR-195`/U4b). This is the beat `/install` has
    // been describing since before it existed — until it, `connect` wrote GIT hooks only and the npm path
    // gave a user no session capture at all. It runs AFTER the commit beat because the two are independent
    // and the commit one is per-clone: reporting the per-clone thing beside the global one, in that order,
    // is what makes the scope difference legible rather than a detail in a sentence.
    agentHookBeat(ctx);
    // ⛔ SKIPPED ENTIRELY ON A DIALECT WITH NO LOCATOR — `CR-183`. `connect` is
    // typed by a human and is handed no `transcript_path`, so finding the running
    // session is a per-agent capability rather than something this verb can do.
    // The absence is a real answer and not a gap to fill: the available fallback
    // is reading a `cwd` out of the transcript's own records, which is ANALYSIS
    // and D60 §D6 forbids it. The refusal below would also be a false statement —
    // it names Claude Code, and this is not that agent.
    const locate = dialectFor(ctx.agentId).locateCurrentTranscript;
    const found = locate === undefined ? null : locate(ctx.home, ctx.env, projectKey);
    if (locate !== undefined && found === null) {
        // ⛔ STDOUT AND EXIT `pathClash`'s — `eng-review D4 = A`. The hooks are installed above, so this is
        // no longer "a silent nothing": setup is complete and capture starts on its own the next time Claude
        // Code runs here. This file's stream rule (`approvalPendingBeat`) puts stderr with a NON-ZERO exit
        // and an install's OUTCOME on stdout.
        // ⚠ This REVERSES the W6 brief rule "When there is no transcript, say so and exit non-zero"
        // (`AGENT_BRIEFS/capture-refactor/_drafts/w6-capture-plugin.py:620`). Its reason — a plain-shell run
        // doing nothing, silently — no longer holds: the warning still prints and the hooks are installed.
        // And a fresh user's first `vibecommit auth` in a new repo (which now chains here) lands on exactly
        // this path and must not report failure after a complete setup. A PATH clash still exits 1.
        writeLines(ctx.stdout, [
            "",
            ...renderErrorBlock({
                kind: "warn",
                what: CONNECT.noTranscriptWhat,
                why: [CONNECT.noTranscriptWhy],
                fixLabel: CONNECT.noTranscriptFix,
                fixes: [channelCommand(ctx.env, ctx.selfPath, COMMANDS.status)],
            }, ctx.colour),
        ]);
        return tail(ctx, unconfirmed);
    }
    const { delivery } = await sendTestCapture(ctx, keys, credential, found);
    // THE FIFTH BEAT — `CR-110`, D65 §DR6, D81.
    //
    // ⚠ ONE outcome is branched on, identified by its ERROR CODE. The general rule
    // below still stands: `later` and `never` are transient or per-payload (D58)
    // and the offset holds, so a 503 must still print the ordinary ending.
    const pending = approvalPending(delivery);
    if (pending !== null) {
        approvalPendingBeat(ctx, projectKey, pending.ownersNotified);
        return tail(ctx, unconfirmed);
    }
    // The beat, then the URL on its own line, then what-now. Every OTHER outcome
    // of the send is deliberately not branched on: telling a user their install
    // failed because one POST 503'd would be false.
    //
    // The URL is the recorded session's own page when the 2xx carried its id (`DX D8`) and the captures
    // index otherwise: a missing, malformed, stalled or `nothing-to-send` delivery all land on the index,
    // and never on `/conversations/undefined`. `conversationId` is only ever set on an `ok` attempt.
    const conversationId = delivery?.kind === "attempted" ? delivery.conversationId : undefined;
    writeLines(ctx.stdout, [
        "",
        ...wrap(`${CONNECT.capturing} ${CONNECT.doneHeading}`, 2),
        "",
        `  ${paint(ctx.colour, "accent", conversationId === undefined ? URLS.commits : URLS.conversation(conversationId))}`,
        "",
        ...wrap(CONNECT.doneForRepo(truncatePath(projectKey, 52)), 2),
        ...wrap(`${CONNECT.stopLabel}: ${channelCommand(ctx.env, ctx.selfPath, COMMANDS.off)}`, 2),
    ]);
    return tail(ctx, unconfirmed);
}
/**
 * What follows the outcome on EVERY branch of `captureBeat`, in this order: the unconfirmed note, then
 * the PATH-clash check. The one place `pathClash` is called — a branch that called it too would print
 * the clash block twice.
 */
export function tail(ctx, unconfirmed) {
    if (unconfirmed) {
        writeLines(ctx.stdout, [
            "",
            // Two short lines, never one wrapped: the backticked command must not be split (see `REJECTED`).
            `  ${paint(ctx.colour, "muted", REJECTED.unconfirmedWhat)}`,
            `  ${paint(ctx.colour, "muted", REJECTED.unconfirmedFix(channelCommand(ctx.env, ctx.selfPath, COMMANDS.status)))}`,
        ]);
    }
    return pathClash(ctx);
}
/**
 * Register capture with every agent on this machine and SAY WHAT HAPPENED.
 *
 * ⚠ **Never changes the exit code**, for `commitHookBeat`'s reason: an agent
 * whose config we could not parse does not make the connection fail, and
 * exiting non-zero would tell the user their whole connect failed when one file
 * of three was unreadable.
 *
 * ⛔ **EVERY OUTCOME PRINTS THE PATH.** This is a write OUTSIDE the repository,
 * into a file shared by every project — the one new responsibility `CR-195`
 * names — so "we configured your editor" is the shape this must not take.
 */
export function agentHookBeat(ctx) {
    const outcomes = installAgentHooks(ctx.home, ctx.env, ctx.selfPath);
    for (const outcome of outcomes) {
        // Absent agents say nothing at all. A line per tool the user does not have
        // is the noise DX3's one-line rule exists to avoid, and it would bury the
        // agents that WERE wired under a list of ones that were not.
        if (outcome.install === null)
            continue;
        const agent = AGENT_LABELS[outcome.agentId];
        // ⛔ TRUNCATED, exactly as `commitHookBeat` truncates the repo path. DESIGN.md
        // §13.4 caps every line at 80 columns and `wrap` cannot break a path — it has
        // no spaces — so an untruncated `~/.claude/settings.json` under a long temp
        // or home prefix silently blows the width contract. `test/connect-ending.ts`
        // caught this at 96 columns; the elision keeps the filename, which is the
        // half that identifies the file.
        const path = truncatePath(outcome.path, 56);
        if (outcome.install.kind === "refused" || outcome.install.kind === "failed") {
            const refused = outcome.install.kind === "refused";
            writeLines(ctx.stdout, [
                "",
                ...renderErrorBlock({
                    kind: "warn",
                    what: refused
                        ? AGENT_HOOKS.refusedWhat(agent)
                        : AGENT_HOOKS.failedWhat(agent),
                    why: [
                        refused
                            ? AGENT_HOOKS.refusedWhy(path, outcome.install.why)
                            : AGENT_HOOKS.failedWhy(path, outcome.install.why),
                    ],
                    ...(refused
                        ? {
                            fixLabel: AGENT_HOOKS.refusedFixLabel,
                            fixes: [AGENT_HOOKS.refusedFix(path, connectCommandFor(ctx.env, ctx.selfPath))],
                        }
                        : {}),
                }, ctx.colour),
            ]);
            continue;
        }
        const line = outcome.install.kind === "installed"
            ? AGENT_HOOKS.installed(agent, path)
            : AGENT_HOOKS.already(agent, path);
        writeLines(ctx.stdout, [
            "",
            ...wrap(line, 2),
            ...wrap(AGENT_HOOKS.kept(agent), 2),
            // ⛔ Codex only, and it is not optional politeness: Codex ships the literal
            // option "Continue without trusting (hooks won't run)", so the file we
            // just wrote does NOT run until the user trusts it. Printing `installed`
            // without this would be a true-sounding claim that is not yet true.
            ...(outcome.agentId === "codex-cli" ? wrap(AGENT_HOOKS.codexTrust, 2) : []),
        ]);
    }
}
/** What each agent is called in prose. The ids are wire values, not labels. */
const AGENT_LABELS = {
    "claude-code": "Claude Code",
    "codex-cli": "Codex CLI",
    cursor: "Cursor",
};
/**
 * Install the `post-commit` hook for this clone and SAY WHAT HAPPENED.
 *
 * ⚠ **Never changes the exit code.** Commit observation is an addition to
 * transcript capture, not a precondition for it: a repository whose
 * `core.hooksPath` points elsewhere still captures transcripts perfectly, and
 * exiting non-zero would tell the user their connection failed when it did not.
 * The report is the whole response.
 */
function commitHookBeat(ctx, projectKey) {
    const outcome = installPostCommitHook(projectKey, ctx.selfPath);
    const repo = truncatePath(projectKey, 52);
    if (outcome.kind === "hooks-path" || outcome.kind === "failed") {
        writeLines(ctx.stdout, [
            "",
            ...renderErrorBlock({
                kind: "warn",
                what: outcome.kind === "hooks-path" ? COMMIT_HOOK.hooksPathWhat : COMMIT_HOOK.failedWhat,
                why: [
                    outcome.kind === "hooks-path"
                        ? COMMIT_HOOK.hooksPathWhy(outcome.configured)
                        : COMMIT_HOOK.failedWhy(outcome.why),
                ],
                fixLabel: COMMIT_HOOK.hooksPathFixLabel,
                fixes: [COMMIT_HOOK.hooksPathFixUnset, COMMIT_HOOK.hooksPathFixManual(channelCommand(ctx.env, ctx.selfPath, COMMANDS.postCommit))],
            }, ctx.colour),
        ]);
        return;
    }
    const line = outcome.kind === "installed"
        ? COMMIT_HOOK.installed(repo)
        : outcome.kind === "chained"
            ? COMMIT_HOOK.chained(repo)
            : COMMIT_HOOK.already;
    writeLines(ctx.stdout, ["", ...wrap(line, 2), ...wrap(COMMIT_HOOK.perClone(connectCommandFor(ctx.env, ctx.selfPath)), 2)]);
}
/**
 * Is this delivery the org-approval-pending outcome, and nothing else?
 *
 * ⚠ **BRANCHES ON THE ERROR CODE, NEVER ON THE 403 STATUS**, and that is the
 * whole correctness content of this function. `repository_forbidden` is ALSO a
 * 403 and deliberately carries no `owners_notified` — so a client that keyed on
 * the status would tell a user whose repository simply is not theirs that *their
 * org needs to approve capture*: a false statement about someone else's org, at
 * the moment of highest trust. A test asserting "a 403 prints the pending beat"
 * passes against exactly that defect, which is why the suite drives both codes.
 *
 * Returns the `owners_notified` value on a match. `undefined` — the key absent —
 * is normalised to `null`, because both mean *not determinable* to the copy and
 * neither may assert delivery.
 */
export function approvalPending(delivery) {
    if (delivery === null || delivery.kind !== "attempted")
        return null;
    if (delivery.detail?.code !== CAPTURE_NOT_APPROVED)
        return null;
    return { ownersNotified: delivery.detail.ownersNotified ?? null };
}
/**
 * The fifth beat — style guide §10.2, D65 §DR6, D81.
 *
 * ⚠ `warn`, never `bad`. ⚠ **The exit is `captureBeat`'s `tail`'s — `EXIT.ok` unless a PATH clash, never
 * `EXIT.failure` for the 403 and never `EXIT.notConnected`** — the user is correctly installed and capture
 * is armed (the hooks were installed before this beat, so "armed" is true on the npm channel).
 * That 403 means *later*, not *failed*: `policy.ts` classes it `later`, so the
 * offset holds and the backlog uploads in order once an owner approves. A red
 * exit here tells a correctly-installed user they broke something.
 */
export function approvalPendingBeat(ctx, projectKey, ownersNotified) {
    // The block itself is `approval_pending.ts`'s, shared with `status`: the shared clause first, the notification second
    // (it ADDS, it does not replace, D81), and `null` never reaches the notification clause.
    // ⚠ STDOUT, not stderr, and the rule is consistent in this file: stderr
    // accompanies a NON-ZERO exit here (`credentialBeat` → 3, `noTranscript` → 1,
    // `pathClash` → 1, the sign-in failures → 1). This beat exits 0, so it is the
    // install's OUTCOME rather than a diagnostic — and §10.2 draws it as one
    // screen, which `2>/dev/null` would otherwise cut in half, leaving "Capture is
    // armed" with the reason stripped off it.
    writeLines(ctx.stdout, [
        "",
        ...approvalPendingBlock(ctx.colour, resolveRepoSlug(projectKey), ownersNotified),
        "",
        ...wrap(CONNECT.pendingArmed(truncatePath(projectKey, 52)), 2),
    ]);
    // No `pathClash` here: `captureBeat`'s `tail` runs it once for every branch. It is about the verbs a
    // human types and orthogonal to whether capture is approved, and it can still exit 1.
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
        code: verdict.kind === "foreign" ? "PATH_COMMAND_FOREIGN" : "PATH_COMMAND_ABSENT",
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