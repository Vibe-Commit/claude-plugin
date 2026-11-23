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
import { setupState } from "../setup_state.js";
import { machineCapture } from "../machine_state.js";
import { ARGS, AUTH, CONNECT, PICKER, SETUP, COMMANDS, AGENT_HOOKS, COMMIT_HOOK, HELP, PATH_CLASH, REJECTED, DEVICE, RUNTIME, SIGNIN, URLS, relativeAge, } from "../copy/index.js";
import { dialectFor } from "../agents/registry.js";
import { TEST_CAPTURE_RECENT_MS } from "../agents/types.js";
import { clearExclusion, grantProject, grantsUnreadable, isAffirmative, isCaptureAllowed, isLocalSlug, } from "../consent.js";
import { loadCredential } from "../credential.js";
import { EXIT } from "../exit.js";
import { onceRepoSlug, resolveRepoSlug } from "../git.js";
import { shownToken } from "../args.js";
import { confinementRoots, hookBudgetMs, readSpan, recordCutter, DEFAULT_HOOK_BUDGET_MS } from "../hooks/entry.js";
import { installAgentHooks } from "../agent_install.js";
import { authCommandFor, channelCommand, classifyInstall, connectCommandFor, installChannel, installPostCommitHook } from "../install.js";
import { realpathSync } from "node:fs";
import { deliver, credentialFingerprint, ingestUrl, isHeldDelivery, } from "../post.js";
import { resolveProjectKeys } from "../project.js";
import { meetsNodeFloor, NODE_FLOOR_TEXT } from "../runtime.js";
import { credentialsPath } from "../paths.js";
import { terminalSafe } from "../printable.js";
import { paint, renderErrorBlock, tildePath, truncatePath, wrap } from "../term.js";
import { isWorking, setupReportLines } from "../setup_report.js";
import { renderVerbHelp } from "../verb_help.js";
import { credentialProblem, credentialProblemBlock, rejectedCredentialBlock, replaceableInline } from "./credential_problem.js";
import { probeCredential } from "./probe.js";
import { writeLines } from "./context.js";
import { connectRetryCommand } from "./connect_retry.js";
import { signInBeat, signInPreflight } from "./browser_credential.js";
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
            // T10 (plan 4.12): connect's own command, run in a terminal. `auth --device --stdin` is not connect's fix (A4).
            fixLabel: CONNECT.deviceNeedsTerminalFix,
            fixes: [channelCommand(ctx.env, ctx.selfPath, COMMANDS.connectDevice)],
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
    // prc1 S8 (P6's ruling): ONE preflight at the top of connect's flow, before any grant write and before any browser or device open. The state
    // directory always; the queue only when this run can mint (no credential that loads, a faulty or unreadable file, or --sign-in). A
    // healthy credential is not checked here: a 401 is known only after the probe, and browserCredential checks the queue itself.
    const preflight = connectPreflight(ctx, options);
    if (preflight !== null) {
        writeLines(ctx.stderr, renderErrorBlock(preflight, ctx.colour));
        return EXIT.notConnected;
    }
    // CR-PRB T12 (4.11): names are the whole choice. Their checks come before anything is read, echoed or asked (DX-3), so a refused
    // name never reaches the scan beat, and the covered path below is not taken for them.
    if (options.names !== undefined && options.names.length > 0)
        return await connectNamed(ctx, options.names, options, deps);
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
        if (isLocalSlug(slugOf())) {
            // The local: repo keeps the 0.6.0 flow (4.10): its line, the sync, and the ending.
            writeLines(ctx.stdout, wrap(CONNECT.alreadyConnectedLocal, 2));
            // Slice 2: a verb that runs on a machine with a credential is where queued changes get delivered (bounded, silent on failure).
            if (deps.account !== undefined)
                await (await import("../grants_verb.js")).syncForVerb(ctx, false, deps.account);
            return await afterConsent(ctx, keys, options, deps, false);
        }
        writeLines(ctx.stdout, wrap(CONNECT.alreadyConnected(slugOf()), 2));
        // CR-PRB T11 (plan §4.10, C1 = 3F; ENG-30). On a terminal (stdin and stdout), the picker opens with this repo as `this repo`, and
        // its Enter finishes any repair (4.4a). Without one, the repair path below asks nothing and says what it did.
        if (ctx.stdinIsTty && ctx.stdout.isTTY === true) {
            return await (await import("./connect_picker.js")).connectPicker(ctx, options, deps, { slug: slugOf(), toplevel: keys.worktree, kind: "repo" }, keys);
        }
        return await coveredRepairs(ctx, keys, deps);
    }
    if (!isLocalSlug(slugOf())) {
        return await (await import("./connect_picker.js")).connectPicker(ctx, options, deps, { slug: slugOf(), toplevel: keys.worktree, kind: "repo" }, keys);
    }
    // ENG-31 (CR-PRB T13b): a terminal stdin with a piped stdout refuses before the disclosure and before any question (plan 4.5). A piped
    // stdin keeps the stdin refusal below, after the disclosure, as it was.
    if (ctx.stdinIsTty && ctx.stdout.isTTY !== true) {
        writeLines(ctx.stderr, renderErrorBlock({
            kind: "bad",
            code: "CONSENT_NEEDS_TTY",
            what: CONNECT.outputNotTerminalWhat,
            why: [CONNECT.outputNotTerminalWhy, ARGS.nothingRead],
            fixLabel: CONNECT.outputNotTerminalFix,
            fixes: [connectRetryCommand(ctx.env, ctx.selfPath, [], options)],
        }, ctx.colour));
        return EXIT.usage;
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
            fixLabel: CONNECT.nonInteractiveFix(truncatePath(terminalSafe(tildePath(keys.worktree, ctx.home)), 46)),
            fixes: [connectCommandFor(ctx.env, ctx.selfPath)],
        }, ctx.colour));
        return EXIT.usage;
    }
    // ⛔ Codex rvprb #4 (plan 4.8: CEO-12 / ENG-4 applied to `local:`): the test capture's transcript is located ONCE, here, before the question,
    // with the picker's rules (`pinTestTranscript`). The question names the check when a fresh one exists, and the send after the yes uses
    // exactly this file, up to the size pinned here. `--no-backfill` pins nothing and names nothing.
    const pinned = options.noBackfill === true ? null : pinTestTranscript(ctx, keys.worktree);
    if (pinned?.fresh && pinned.age !== null) {
        // The picker's own check sentence and its ending (grantScopeLines), reused: no new words.
        writeLines(ctx.stdout, ["", ...wrap([PICKER.grantScopeCheck(pinned.agent, PICKER.activeAgo(pinned.age)), PICKER.grantScopeEndChecked].join(" "), 2), ""]);
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
    return await afterConsent(ctx, keys, options, deps, true, pinned);
}
/**
 * CR-PRB T12 (plan §4.11): `connect owner/repo | owner/…`. Each name is checked with the one validator (`checkName`, picker.ts). A
 * refusal names the token and its fix, and exits 2 before the scan beat. `--typed` with names is CONNECT_ARGS_CONFLICT. Without a
 * terminal (stdin AND stdout) the run is refused with the exact command, names and flags included (ENG-31, DX-23). Otherwise the
 * picker runs with the names as its whole choice.
 */
async function connectNamed(ctx, tokens, options, deps) {
    const { checkName, fixTarget } = await import("../picker.js");
    const verb = "connect"; // an identifier, not a literal, at the writer: `copy-inline-literals` follows argument positions
    const named = [];
    for (const token of tokens) {
        const check = checkName(token);
        if (!check.ok) {
            // DX-2: the last line is runnable. The corrected command where the token has one, else `--help`. A bare word gets `--help`,
            // never a suggested `owner/` (the broadest grant).
            const target = fixTarget(token);
            const fix = target === null ? ARGS.helpCommand("connect") : `vibecommit connect ${target}`;
            writeLines(ctx.stderr, renderErrorBlock({
                kind: "bad",
                code: "UNRECOGNIZED_ARGUMENT",
                what: ARGS.unrecognizedWhat(shownToken(token), verb),
                why: [CONNECT.nameWhy, ARGS.nothingRead],
                fixLabel: target === null ? ARGS.fixLabel : ARGS.fixLabelCorrected,
                fixes: [channelCommand(ctx.env, ctx.selfPath, fix)],
            }, ctx.colour));
            return EXIT.usage;
        }
        named.push({ token, kind: check.kind, key: check.key });
    }
    if (options.typed === true) {
        writeLines(ctx.stderr, renderErrorBlock({
            kind: "bad",
            code: "CONNECT_ARGS_CONFLICT",
            what: CONNECT.argsConflictWhat,
            why: [CONNECT.argsConflictWhy],
            fixLabel: CONNECT.argsConflictFix,
            fixes: [namedCommand(ctx, tokens, options)],
        }, ctx.colour));
        return EXIT.usage;
    }
    // ENG-31: a run that asks needs a terminal on stdin AND stdout. The fix line is the exact command, with the names and every
    // accepted argument given (DX-23), so an agent can relay it as it is. A piped stdout names the output; a piped stdin names the choice.
    if (!ctx.stdinIsTty || ctx.stdout.isTTY !== true) {
        const stdinPiped = !ctx.stdinIsTty;
        writeLines(ctx.stderr, renderErrorBlock({
            kind: "bad",
            code: "CONSENT_NEEDS_TTY",
            what: stdinPiped ? CONNECT.pickerNonInteractiveWhat : CONNECT.outputNotTerminalWhat,
            why: stdinPiped ? [CONNECT.pickerNonInteractiveWhy] : [CONNECT.outputNotTerminalWhy, ARGS.nothingRead],
            fixLabel: stdinPiped ? CONNECT.pickerNonInteractiveFix : CONNECT.outputNotTerminalFix,
            fixes: [namedCommand(ctx, tokens, options)],
        }, ctx.colour));
        return EXIT.usage;
    }
    const keys = resolveProjectKeys(ctx.cwd);
    let here = null;
    if (keys !== null) {
        const slug = resolveRepoSlug(keys.worktree);
        if (!isLocalSlug(slug))
            here = { slug, toplevel: keys.worktree, kind: atHome(ctx) ? "folder" : "repo" };
    }
    return await (await import("./connect_picker.js")).connectPicker(ctx, options, deps, here, keys, named);
}
/** The command a names refusal repeats: `connect`, the names, then every accepted argument the run was given (DX-23). `--typed` is left out. */
function namedCommand(ctx, tokens, options) {
    return connectRetryCommand(ctx.env, ctx.selfPath, tokens, options);
}
/**
 * CR-PRB T11 (plan §4.10, ENG-30): a covered repo with a remote, without a terminal. It asks nothing, shows no consent text and
 * sends no test capture. It runs the account sync (as today), then the repairs that need no question ((b) the commit hook of this
 * repo, (c) and (f) the agent hooks, each only where the predicate names one), then the credential probe. A sign-in that is needed
 * ((a), (e) or a 401) prints a block whose fix is `connect`, run in a terminal, and exits 3; it never names `auth` (3I). Otherwise 0.
 */
async function coveredRepairs(ctx, keys, deps) {
    let unauthorized = false;
    if (deps.account !== undefined) {
        const synced = await (await import("../grants_verb.js")).syncForVerb(ctx, false, deps.account);
        unauthorized = synced.kind === "ran" && synced.result.kind === "unauthorized";
    }
    const setup = setupState({
        home: ctx.home,
        env: ctx.env,
        selfPath: ctx.selfPath,
        grantsOn: machineCapture(ctx.home).kind === "on",
        toplevels: [keys.worktree],
        syncUnauthorized: unauthorized,
    }, deps.setup);
    if (setup.kind === "checked") {
        const plugin = installChannel(ctx.env, ctx.selfPath).kind === "plugin";
        // ⛔ #9 (4.4a): the plugin's `connect` installs a MISSING hook in this clone (as 0.16.0's covered path did); the probe is this clone only.
        const commitRepair = setup.commitHooks.some((f) => f.writable && (f.stale || f.state.kind === "off" || (!plugin && f.state.kind === "foreign")));
        // T8b (4.2): the one beat and the one report. Nothing to install (no repair, no agent) prints nothing.
        const agentsToDo = setup.agents.length > 0 || setup.noAgentHooks;
        const work = commitRepair || agentsToDo;
        setupBeatStart(ctx, work);
        const commit = commitRepair ? installOneCommitHook(ctx, keys.worktree) : null;
        if (agentsToDo)
            agentHookBeat(ctx, commit, work);
        else
            printSetupReport(ctx, { work, commit, rows: [], agentBlocks: [] });
    }
    else if (setup.kind === "unknown") {
        // `unknown` counts as a repair (4.4a): the full idempotent step; the installer refuses a file it could not read.
        setupBeatStart(ctx, true);
        agentHookBeat(ctx, installOneCommitHook(ctx, keys.worktree), true);
    }
    const connectCmd = channelCommand(ctx.env, ctx.selfPath, COMMANDS.connect);
    const load = loadCredential({ env: ctx.env, home: ctx.home });
    if (unauthorized && load.kind === "ok") {
        writeLines(ctx.stderr, rejectedCredentialBlock({ home: ctx.home, fingerprint: credentialFingerprint(load.credential), nowMs: ctx.now().getTime(), authCommand: connectCmd, colour: ctx.colour, standing: false }));
        return EXIT.notConnected;
    }
    if (load.kind !== "ok" && load.kind !== "absent") {
        writeLines(ctx.stderr, credentialProblem(load, ctx.colour, connectCmd));
        return EXIT.notConnected;
    }
    const noCredential = setup.kind === "checked" ? setup.noCredential : load.kind === "absent";
    if (noCredential || unauthorized) {
        writeLines(ctx.stderr, renderErrorBlock({ kind: "warn", what: CONNECT.credentialNeededWhat, why: [CONNECT.credentialNeededWhy], fixLabel: CONNECT.coveredSignInFixLabel, fixes: [connectCmd] }, ctx.colour));
        return EXIT.notConnected;
    }
    if (load.kind === "ok") {
        const probe = await probeCredential(ctx, load.credential, deps.fetch);
        if (probe.kind === "unauthorized") {
            writeLines(ctx.stderr, rejectedCredentialBlock({ home: ctx.home, fingerprint: credentialFingerprint(load.credential), nowMs: ctx.now().getTime(), authCommand: connectCmd, colour: ctx.colour, standing: false }));
            return EXIT.notConnected;
        }
    }
    return EXIT.ok;
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
    writeLines(ctx.stdout, cancelledLines());
    return EXIT.failure;
}
/** The cancelled screen's lines: the terminal left the cursor at the end of the prompt line, so one empty line ends it and a second leaves the blank line the drawn screen has. */
export function cancelledLines() {
    return ["", "", ...wrap(PICKER.cancelled, 2)];
}
export function grantsUnreadableBlock(ctx) {
    return grantsUnreadableLines(ctx.colour, connectCommandFor(ctx.env, ctx.selfPath));
}
/** The GRANTS_UNREADABLE block (stderr), given the command the fix names. */
export function grantsUnreadableLines(colour, connectCommand) {
    return renderErrorBlock({
        kind: "bad",
        code: "GRANTS_UNREADABLE",
        what: CONNECT.grantsUnreadableWhat,
        why: [CONNECT.grantsUnreadableWhy],
        fixLabel: CONNECT.grantsUnreadableFixLabel,
        fixes: [connectCommand],
    }, colour);
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
async function afterConsent(ctx, keys, options, deps, 
/** This run added the repo (the consent just written): only then may the test capture check it (ENG-4). */
addedNow, 
/** Codex rvprb #4: the transcript pinned before the consent question. Undefined (a repo already on) means "locate now". */
pinned) {
    // ⛔ THE HOOKS BEFORE THE CREDENTIAL (ENG-24; plan §4.4a). The commit hook and the agent hooks are written before any sign-in
    // request, so a sign-in that fails leaves them in place, and a hook run then returns the `not_connected` notice.
    // T8b (4.2): the one beat, the commit row and the agent rows, in one report.
    setupBeatStart(ctx, true);
    agentHookBeat(ctx, installOneCommitHook(ctx, keys.worktree), true);
    if (options.signIn === true) {
        // `G8a`: `verify` — a session file that loads but that the server refuses to renew is expired,
        // and "already signed in" over it was the bug.
        // 0.17.1 D1: the hooks are written, so a failed beat says what it left behind (`signInLeftBehind`), not "Nothing was changed".
        const code = await signInBeat(ctx, {
            retry: "sign-in",
            verify: true,
            afterWrites: () => signInLeftBehind(ctx),
            ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
        });
        if (code !== EXIT.ok) {
            writeLines(ctx.stdout, localSetupLines(ctx));
            return code;
        }
    }
    return await credentialBeat(ctx, keys, deps, options, addedNow, pinned);
}
/**
 * CR-PRB T9b-2b (4.4a): the `local:` path's ending says setup is unfinished when branch (a) holds after its sign-in failed. Empty
 * otherwise. The grant was just written, so the machine is on; `toplevels` is empty because the hooks were written before the sign-in.
 */
function localSetupLines(ctx) {
    const finding = setupState({ home: ctx.home, env: ctx.env, selfPath: ctx.selfPath, grantsOn: true, toplevels: [], syncUnauthorized: false });
    if (finding.kind !== "checked" || !finding.noCredential)
        return [];
    return ["", ...wrap(PICKER.endingUnfinished(channelCommand(ctx.env, ctx.selfPath, COMMANDS.connect)), 2)];
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
async function credentialBeat(ctx, keys, deps, options = {}, addedNow = false, pinned) {
    const got = await obtainCredential(ctx, deps, options);
    if (got.kind === "exit") {
        writeLines(ctx.stdout, localSetupLines(ctx));
        return got.code;
    }
    return await captureBeat(ctx, keys, got.credential, got.unconfirmed, options, addedNow, pinned);
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
            // T10 (plan 4.12, row 2): a 401'd FILE credential is replaced inline by a person at a terminal. An env token is never replaced
            // (VIBECOMMIT_TOKEN wins over everything), so it keeps today's block with today's `auth` fix.
            const browser = inlineBrowser(ctx, deps);
            if (!envTokenSet(ctx) && browser !== null) {
                writeLines(ctx.stderr, renderErrorBlock({ kind: "warn", what: CONNECT.noLongerAccepted, why: [] }, ctx.colour));
                return await replaceInline(ctx, browser, options, scope);
            }
            writeLines(ctx.stderr, rejectedCredentialBlock({
                home: ctx.home,
                fingerprint: credentialFingerprint(load.credential),
                nowMs: ctx.now().getTime(),
                authCommand: envTokenSet(ctx) ? authCommandFor(ctx.env, ctx.selfPath) : connectCommandOf(ctx),
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
    //     insecure is a FAULT, named first. T10 (plan 4.12 row 3, reversing D206
    //     §5) replaces a faulty FILE inline below, after its block; an insecure
    //     file and an env token keep their fix.
    //   - `stdinIsTty`: a wrapper or a CI job runs `connect` too, and a browser
    //     opened there waits five minutes for nobody. The old warning is the
    //     right answer for them, and it is what they still get.
    if (load.kind === "absent" && ctx.stdinIsTty && deps.browser !== undefined) {
        const minted = await deps.browser(ctx, "connect", {
            device: options.device === true,
            ...(scope === undefined ? {} : { scope }),
            connectPath: { rerun: connectCommandOf(ctx), replacing: false, grantsWritten: grantsWritten(ctx) },
        });
        if (minted.kind === "saved") {
            savedBlock(ctx, minted.notes ?? []);
            // Already probed by the mint (`finishMint`), so no second probe here.
            return { kind: "credential", credential: minted.credential, unconfirmed: false };
        }
        // Declined at the replace confirmation: the reason is already on screen, and the user said NO.
        if (minted.kind === "declined")
            return { kind: "exit", code: EXIT.failure };
        // T10 (F-A3): a failed sign-in printed its own block on stderr (the SIGNIN error, or the mint's DX-7 block). Print nothing more.
        return { kind: "exit", code: EXIT.notConnected };
    }
    // ⛔ R15 (T10, plan 4.12 row 3): a FAULTY file is named as the fault it is, not as "no credential". A wrong-class FILE, or one whose form
    // is wrong, is then replaced inline by a person at a terminal, with no `auth` fix line: the fix follows inline. An env token and an
    // insecure file keep today's block (a `chmod` for the file, and for the env token the variable). 0.17.3 (P6 ruling): so does a file that
    // could not be READ (refused, not a file, a closed or unchecked folder, a failed read): it may hold a live credential a `chmod` restores.
    if (load.kind !== "absent") {
        const browser = inlineBrowser(ctx, deps);
        if (envTokenSet(ctx) || browser === null || !replaceableInline(load)) {
            writeLines(ctx.stderr, credentialProblem(load, ctx.colour, envTokenSet(ctx) ? authCommandFor(ctx.env, ctx.selfPath) : connectCommandOf(ctx)));
            return { kind: "exit", code: EXIT.notConnected };
        }
        const { fixLabel: _fixLabel, fixes: _fixes, ...faultWithoutFix } = credentialProblemBlock(load, connectCommandOf(ctx));
        writeLines(ctx.stderr, renderErrorBlock(faultWithoutFix, ctx.colour));
        writeLines(ctx.stderr, wrap(CONNECT.replacingIt, 2));
        return await replaceInline(ctx, browser, options, scope);
    }
    // A machine with no credential and no inline sign-in (no terminal, or no browser): nothing was tried, so the block names connect.
    signInFailedBlock(ctx);
    return { kind: "exit", code: EXIT.notConnected };
}
/**
 * prc1 S8: the refusal block for connect's top preflight, or null when the run may go on. `queue` is set only for a run that can mint:
 * no credential that loads (absent, faulty or unreadable file), or an explicit `--sign-in`. An env token never mints, so it never queues.
 */
function connectPreflight(ctx, options) {
    const loaded = loadCredential({ env: ctx.env, home: ctx.home });
    const queue = !envTokenSet(ctx) && (loaded.kind !== "ok" || options.signIn === true);
    const result = signInPreflight(ctx.home, {
        queue,
        fixCommand: connectCommandOf(ctx),
        statusCommand: channelCommand(ctx.env, ctx.selfPath, COMMANDS.status),
    });
    return result.kind === "refused" ? result.block : null;
}
/**
 * T10 (plan 4.12): `connect` signs in inline only with a person at a terminal and a browser. Without either, today's blocks print.
 */
function inlineBrowser(ctx, deps) {
    return ctx.stdinIsTty && deps.browser !== undefined ? deps.browser : null;
}
/** T10: `VIBECOMMIT_TOKEN` is set. A sign-in cannot replace an environment variable, so connect never mints over it (4.12, P6). */
function envTokenSet(ctx) {
    return (ctx.env.VIBECOMMIT_TOKEN ?? "").trim() !== "";
}
/** T10: connect's own command through the channel (`finishMint`'s `rerun` and every re-run line on connect's path). */
function connectCommandOf(ctx) {
    return channelCommand(ctx.env, ctx.selfPath, COMMANDS.connect);
}
/**
 * T10 (plan 4.12): the inline mint over a 401'd or faulty file. It passes connect's path, so the replace question is ALWAYS asked (`replacing`)
 * and the re-run line is connect's. `grantsWritten` is computed at the call (`grantsWritten`), and `writeAhead` records the new credential
 * for revoking the moment it is handed over (Amendment 1).
 */
async function replaceInline(ctx, browser, options, scope) {
    // Amendment 1 (T10): the fresh credential is written ahead for the whole question. The builder lives in connect_account.ts, which imports
    // this module, so it is a DYNAMIC import here: a static one would be a cycle and would put connect_account on every process's load path.
    const { writeAheadHold, printUnrecorded } = await import("./connect_account.js");
    const written = writeAheadHold(ctx);
    const minted = await browser(ctx, "connect", {
        device: options.device === true,
        ...(scope === undefined ? {} : { scope }),
        connectPath: { rerun: connectCommandOf(ctx), replacing: true, grantsWritten: grantsWritten(ctx), writeAhead: written.hold },
    });
    if (minted.kind === "saved") {
        savedBlock(ctx, minted.notes ?? []);
        return { kind: "credential", credential: minted.credential, unconfirmed: false };
    }
    // The No at the replace question: the reason (and the DX-7 line) is already on screen, and the user said NO.
    if (minted.kind === "declined")
        return { kind: "exit", code: EXIT.failure };
    // Amendment 1: the write-ahead row could not be written, so the new credential was revoked in memory and nothing was saved.
    if (minted.kind === "unrecorded") {
        printUnrecorded(ctx, written.refusal(), minted.revoked, { rerun: connectCommandOf(ctx), which: "replace" });
        return { kind: "exit", code: EXIT.notConnected };
    }
    // T10 (F-A3): a failed sign-in printed its own block (the SIGNIN error, or the mint's DX-7 block). Print nothing more.
    return { kind: "exit", code: EXIT.notConnected };
}
/**
 * T10 (plan 4.12, DX-7): the block for a machine with no credential where NO sign-in was tried (no terminal, or no browser beat). After a
 * sign-in that was tried and failed, the browser's own block is the only one (F-A3). It states the saved choices only when there are some,
 * and names connect (it resumes, D-SIGNIN) and `connect --device` (no browser here). `auth` is not named.
 */
function signInFailedBlock(ctx) {
    writeLines(ctx.stderr, renderErrorBlock({
        kind: "warn",
        what: CONNECT.credentialNeededWhat,
        // Gated (F-A3): the saved-choices line only when a grant this run relies on exists; otherwise today's line.
        why: [grantsWritten(ctx) ? AUTH.savedChoicesWhy : CONNECT.credentialNeededWhy],
        fixLabel: CONNECT.signInFailedFix,
        fixes: [COMMANDS.connect, COMMANDS.connectDevice].map((fix) => channelCommand(ctx.env, ctx.selfPath, fix)),
    }, ctx.colour));
}
/**
 * T10 (plan 4.12, DX-7): `connectPath.grantsWritten`, computed at the call. True only when this machine holds a grant at that moment, so a
 * No says "Your choices are saved" only when that is true. The picker writes its grants before the sign-in, so it is true there; an Enter
 * on a faulty file with no grants is false. Nothing is written here.
 */
function grantsWritten(ctx) {
    return machineCapture(ctx.home).kind === "on";
}
/**
 * 0.17.1 D1 (P7 ruling, 2026-11-22): what a failed `--sign-in` beat left behind, decided when its block prints. The beat runs after the grants
 * and hooks are written (connect.ts's local path, connect_picker.ts's picker path). With a grant held and no credential that loads
 * (`loadCredential`, VIBECOMMIT_TOKEN first, the loader uploads use), nothing uploads yet: `AUTH.savedChoicesWhy`. With a grant and a credential
 * that loads, uploads may go on, so the line claims nothing about them: `SIGNIN.choicesSaved`. With no grant, nothing.
 */
export function signInLeftBehind(ctx) {
    if (!grantsWritten(ctx))
        return [];
    return loadCredential({ env: ctx.env, home: ctx.home }).kind === "ok" ? [SIGNIN.choicesSaved] : [AUTH.savedChoicesWhy];
}
/** "Saved to <credentials.json>" — what the credential beat says once a credential is on disk (and `g`, once its yes has put it there). */
export function savedBlock(ctx, notes) {
    writeLines(ctx.stdout, [
        "",
        ...renderErrorBlock({ kind: "ok", what: AUTH.savedWhat, why: [AUTH.savedWhy(tildePath(credentialsPath(ctx.home), ctx.home)), ...notes] }, ctx.colour),
    ]);
}
/**
 * The test capture: send the current session's transcript through `deliver()` so the ending can name evidence (D57 §DX5's
 * Sentry-wizard pattern). Shared by the 0.6.0 ending (`captureBeat`) and the in-repo picker path (0.7.0, VQ item 7), so the
 * two cannot drift: one budget (`hookBudgetMs`, PR 4a), one redaction root set, one place that reads a 2xx body.
 *
 * `found` is the located transcript, or `null` when there is none (no locator, or the agent has not run here). Returns the
 * delivery, or `null` when nothing was sent. `withheld` is true when a check was due and the repo is no longer admitted.
 */
export async function sendTestCapture(ctx, keys, credential, found) {
    const projectKey = keys.worktree;
    const url = ingestUrl(ctx.env);
    // ⛔ Codex rvprb #3 (P6 ruling): consent is re-checked IMMEDIATELY before the send. A sign-in that waited while the person ran `off`, or
    // an exclusion kept for this repo, must not upload the check. The browser credential arrives after the question, so the answer given
    // then is not enough.
    if (found !== null && url !== null && !isCaptureAllowed(ctx.home, keys, () => resolveRepoSlug(projectKey)))
        return { delivery: null, withheld: true };
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
        (from, to) => readSpan(found.path, from, to, confinementRoots(keys), ctx.home, ctx.env, { kind: "repo", ownRoots: confinementRoots(keys) }), recordCutter(found.path));
    }
    return { delivery, withheld: false };
}
/**
 * The ending when this run sent nothing: no beat, no session link (4.8, ENG-4, `--no-backfill`, DX-21). One helper for every
 * sent-nothing branch: the recap-less "Capture is on", the Next line (`CONNECT.nextStepHere`, DX-21), the dashboard URL, and the stop line.
 * The layout is W8's, not the plan's verbatim (a DRAFT, see the commit body).
 * ⛔ Codex rvprb2 N1 + P6's T20 ruling (2026-11-22): `withheld` (the check was withheld at send time) means capture is OFF for this repo
 * now. So no "Capture is on", no stop line, and no Next line either: a session started here would never arrive. After the caller's
 * checkWithheld note, the ending is the dashboard URL alone.
 */
function sentNothingLines(ctx, projectKey, withheld = false) {
    if (withheld)
        return ["", `  ${paint(ctx.colour, "accent", URLS.dashboard)}`];
    return [
        "",
        ...wrap(CONNECT.capturedForRepoNothingSent(truncatePath(terminalSafe(projectKey), 52)), 2),
        // T10 (DX-21, P7 ruling): this is the single-repo `local:` ending, so "here", not "in one of them".
        ...wrap(CONNECT.nextStepHere(channelCommand(ctx.env, ctx.selfPath, COMMANDS.status)), 2),
        "",
        `  ${paint(ctx.colour, "accent", URLS.dashboard)}`,
        "",
        ...wrap(`${CONNECT.stopLabel}: ${channelCommand(ctx.env, ctx.selfPath, COMMANDS.off)}`, 2),
    ];
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
 * branch — no transcript or the normal ending — so the last
 * thing a new user sees is "Connected." and the session link, not ten lines of
 * hook paths that scrolled it away. After the outcome come, in this order, the
 * unconfirmed note and `pathClash`, which runs EXACTLY ONCE, here, and not in
 * any branch (a branch that ended in its own call would print the clash block twice).
 *
 * ⚠ The hole this closes: the two hook beats sat AFTER early returns, so a repo
 * Claude Code had never run in got NO hooks while the screen said "Capture
 * starts on its own". That was not true on the npm channel.
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
unconfirmed, options, 
/** This run added the repo; a repo already on is not re-checked (ENG-4). */
addedNow, 
/** The transcript pinned before the consent question (Codex rvprb #4). Undefined means "locate now" (a repo already on). */
pre) {
    // ⚠ EVERY USE BELOW BUT ONE IS THE TOPLEVEL ROLE — locating the transcript,
    // the `repoKey` binding, the slug, the hook install and the copy the user
    // reads. The exception is the redaction root set at `readSpan`, which takes
    // BOTH keys through `confinementRoots`. Aliased rather than renamed
    // throughout, so the diff shows the line whose ROLE changed and not fourteen
    // that did not.
    const projectKey = keys.worktree;
    // ⛔ THE HOOKS (commit and agent) were installed and reported in `afterConsent`, before the sign-in (ENG-24). What is left here is
    // the transcript and the test capture.
    // ⛔ SKIPPED ENTIRELY ON A DIALECT WITH NO LOCATOR — `CR-183`. `connect` is
    // typed by a human and is handed no `transcript_path`, so finding the running
    // session is a per-agent capability rather than something this verb can do.
    // The absence is a real answer and not a gap to fill: the available fallback
    // is reading a `cwd` out of the transcript's own records, which is ANALYSIS
    // and D60 §D6 forbids it. The refusal below would also be a false statement —
    // it names Claude Code, and this is not that agent.
    // ⛔ CEO-12 / ENG-4, ENG-5, ENG-16: the transcript is located ONCE and judged now. Only a fresh one is sent, and only the file pinned
    // here, up to the size pinned here. A stale one gets one muted line, and a missing one the no-session block. `--no-backfill` sends
    // nothing and prints no check (T7's seam, `options.noBackfill`).
    // ⛔ Codex rvprb #4: the send uses the pin taken before the question, never a re-location here (the mutant that re-locates is red).
    const pinned = pre !== undefined ? pre : options.noBackfill === true ? null : pinTestTranscript(ctx, projectKey);
    // Only this run's addition may be checked (ENG-4). A repo already on is judged like any other (a missing or stale transcript still
    // says so), but nothing is sent for it.
    const check = addedNow ? (pinned?.fresh ?? null) : null;
    if (pinned !== null && pinned.hasLocator && pinned.fresh === null) {
        if (pinned.located !== null && pinned.age !== null) {
            // The muted line, then the same ending as any run that sent nothing (4.8, DX-21).
            writeLines(ctx.stdout, ["", ...wrap(CONNECT.staleTranscript(pinned.age), 2).map((line) => paint(ctx.colour, "muted", line))]);
            writeLines(ctx.stdout, sentNothingLines(ctx, projectKey));
            return tail(ctx, unconfirmed);
        }
        // ⛔ STDOUT AND EXIT `pathClash`'s — `eng-review D4 = A`. The hooks are installed above, so this is
        // no longer "a silent nothing": setup is complete and capture starts on its own the next time Claude
        // Code runs here. This file's stream rule puts stderr with a NON-ZERO exit
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
    // ⛔ Codex rvprb #12 (P6 ruling): ANY run that sent no check (the repo is already on, `--no-backfill`, or a dialect with no locator)
    // prints no beat and no session link. The sent-nothing ending keys on "no check ran", not on the dialect having a locator.
    if (check === null) {
        writeLines(ctx.stdout, sentNothingLines(ctx, projectKey));
        return tail(ctx, unconfirmed);
    }
    const { delivery, withheld } = await sendTestCapture(ctx, keys, credential, check);
    // Codex rvprb #3: the check was due but consent was withdrawn while the sign-in waited. Nothing was sent, and the ending says so.
    if (withheld) {
        writeLines(ctx.stdout, ["", ...wrap(CONNECT.checkWithheld, 2).map((line) => paint(ctx.colour, "muted", line))]);
        writeLines(ctx.stdout, sentNothingLines(ctx, projectKey, true));
        return tail(ctx, unconfirmed);
    }
    // A HOLD (A78): an older server's approval 403. The hooks are already installed above, so this is the whole ending:
    // the generic hold line, exit 0 (`tail`'s), never "Connected" over a refusal.
    if (isHeldDelivery(delivery)) {
        holdBeat(ctx);
        return holdTail(ctx, unconfirmed);
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
        ...wrap(CONNECT.doneForRepo(truncatePath(terminalSafe(projectKey), 52)), 2),
        ...wrap(`${CONNECT.stopLabel}: ${channelCommand(ctx.env, ctx.selfPath, COMMANDS.off)}`, 2),
    ]);
    return tail(ctx, unconfirmed);
}
/** The generic hold line (A78). `warn`, never `bad`; STDOUT, because the exit is 0 and this is the install's outcome. */
export function holdBeat(ctx) {
    writeLines(ctx.stdout, holdLines(ctx.colour));
}
/** The generic hold block's lines (stdout), given the colour flag. */
export function holdLines(colour) {
    return ["", ...renderErrorBlock({ kind: "warn", what: CONNECT.holdWhat, why: [CONNECT.holdBuffered] }, colour)];
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
 * The ending of a legacy HOLD (A78): the same unconfirmed note and the same PATH diagnostic text as `tail`, but the EXIT is 0.
 * A hold is "later, not failed" and the hooks are installed, so a PATH problem must not turn it into a failure.
 */
export function holdTail(ctx, unconfirmed) {
    tail(ctx, unconfirmed);
    return EXIT.ok;
}
/**
 * Register capture with every agent on this machine and SAY WHAT HAPPENED.
 *
 * T8 (4.2): returns the agents whose file holds our hooks after this run (the proof sentence names only them, DX-13).
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
export function agentHookBeat(ctx, commit = null, work = true) {
    const outcomes = installAgentHooks(ctx.home, ctx.env, ctx.selfPath);
    const rows = [];
    const blocks = [];
    for (const outcome of outcomes) {
        // Absent agents say nothing at all. A line per tool the user does not have is the noise DX3's one-line rule exists to avoid.
        if (outcome.install === null)
            continue;
        const agent = AGENT_LABELS[outcome.agentId];
        // T8 (4.2): one row per agent, in one table. The path is cut from the left to fit the table (`setupReportLines`), and the failure
        // blocks below keep their own truncation.
        const install = outcome.install;
        if (install.kind === "refused" || install.kind === "failed") {
            const refused = install.kind === "refused";
            rows.push({ agentId: outcome.agentId, label: agent, path: outcome.path, outcome: refused ? "refused" : "failed", changed: false });
            // N3 (b) (CR-PRB2): the path and the why (which can quote the path) go through terminalSafe before they print.
            const path = truncatePath(terminalSafe(outcome.path), 56);
            // ⛔ EVERY FAILURE PRINTS ITS FIX (DX-13): a refusal gets the `refused` fix, a failed write gets the permissions fix.
            const fix = refused
                ? { label: AGENT_HOOKS.refusedFixLabel, lines: [AGENT_HOOKS.refusedFix(path, connectCommandFor(ctx.env, ctx.selfPath))] }
                : { label: AGENT_HOOKS.refusedFixLabel, lines: [AGENT_HOOKS.failedFix(connectCommandFor(ctx.env, ctx.selfPath))] };
            blocks.push([
                "",
                ...renderErrorBlock({
                    kind: "warn",
                    what: refused ? AGENT_HOOKS.refusedWhat(agent) : AGENT_HOOKS.failedWhat(agent),
                    // N3 (b) (CR-PRB2): install.why can quote the config path (a write error's message, an unreadable file's OS reason), so it is cleaned too.
                    why: [refused ? AGENT_HOOKS.refusedWhy(path, terminalSafe(install.why)) : AGENT_HOOKS.failedWhy(path, terminalSafe(install.why))],
                    fixLabel: fix.label,
                    fixes: fix.lines,
                }, ctx.colour),
            ]);
            continue;
        }
        rows.push({
            agentId: outcome.agentId,
            label: agent,
            path: outcome.path,
            outcome: install.kind === "installed" ? "added" : "already",
            changed: install.changed,
        });
    }
    printSetupReport(ctx, { work, commit, rows, agentBlocks: blocks });
    return rows.filter(isWorking).map((row) => row.agentId);
}
/**
 * The setup report's beat (plan 4.2, §13.8, T8b). On a terminal with colour the beat is written now, without its newline, and the
 * report overwrites it once with `done`. Without a terminal, or under NO_COLOR, nothing is written here: the report prints the whole beat
 * as one plain line after the work. `work` is whether anything will be installed (a clone or an agent), so an empty run prints no beat.
 */
export function setupBeatStart(ctx, work) {
    if (work && ctx.colour)
        ctx.stdout.write(`\n  ${SETUP.beat}`);
}
/**
 * The setup report (T8b, 4.2): the beat's `done` line (overwriting the started beat on a terminal, or printed once on its own without
 * one), then the table (the commit-hooks row, then one row per agent), then the §13.6 blocks under the table. Prints nothing when `work`
 * is false.
 */
export function printSetupReport(ctx, input) {
    if (!input.work)
        return;
    const done = `${`  ${SETUP.beat}`.padEnd(45)}   ${PICKER.hooksDone}`;
    ctx.stdout.write(ctx.colour ? `\r${done}\n` : `\n${done}\n`);
    const table = setupReportLines(input.rows, ctx.colour, input.commit?.report ?? null);
    if (table.length > 0)
        writeLines(ctx.stdout, table);
    if ((input.commit?.notes ?? []).length > 0)
        writeLines(ctx.stdout, input.commit?.notes ?? []);
    for (const block of [...(input.commit?.blocks ?? []), ...input.agentBlocks])
        writeLines(ctx.stdout, block);
}
/** What each agent is called in prose. The ids are wire values, not labels. */
const AGENT_LABELS = {
    "claude-code": "Claude Code",
    "codex-cli": "Codex CLI",
    cursor: "Cursor",
};
/** Pin the test capture's transcript for `projectKey`, judging its age now. Reads only. */
export function pinTestTranscript(ctx, projectKey) {
    const dialect = dialectFor(ctx.agentId);
    const agent = AGENT_LABELS[dialect.id];
    const locate = dialect.locateCurrentTranscript;
    if (locate === undefined)
        return { hasLocator: false, located: null, fresh: null, agent, age: null };
    const nowMs = ctx.now().getTime();
    const located = locate(ctx.home, ctx.env, projectKey, { now: nowMs, maxAgeMs: Number.POSITIVE_INFINITY });
    if (located === null)
        return { hasLocator: true, located: null, fresh: null, agent, age: null };
    const fresh = nowMs - located.mtimeMs <= TEST_CAPTURE_RECENT_MS ? located : null;
    return { hasLocator: true, located, fresh, agent, age: relativeAge(located.mtimeMs, nowMs) };
}
/**
 * Install the `post-commit` hook for this clone, and return what the setup report needs (T8b). Never changes the exit code, for the
 * reason it never did: commit observation is an addition to transcript capture. A `core.hooksPath` or a failed write is a §13.6 block.
 */
export function installOneCommitHook(ctx, projectKey) {
    const outcome = installPostCommitHook(projectKey, ctx.selfPath);
    if (outcome.kind === "hooks-path" || outcome.kind === "failed") {
        const repo = truncatePath(projectKey, 52);
        void repo;
        return {
            report: { clones: 0, chained: 0 },
            notes: [],
            blocks: [
                [
                    "",
                    ...renderErrorBlock({
                        kind: "warn",
                        what: outcome.kind === "hooks-path" ? COMMIT_HOOK.hooksPathWhat : COMMIT_HOOK.failedWhat,
                        why: [
                            outcome.kind === "hooks-path"
                                ? COMMIT_HOOK.hooksPathWhy(terminalSafe(outcome.configured))
                                : COMMIT_HOOK.failedWhy(terminalSafe(outcome.why)),
                        ],
                        fixLabel: COMMIT_HOOK.hooksPathFixLabel,
                        fixes: [COMMIT_HOOK.hooksPathFixUnset, COMMIT_HOOK.hooksPathFixManual(channelCommand(ctx.env, ctx.selfPath, COMMANDS.postCommit))],
                    }, ctx.colour),
                ],
            ],
        };
    }
    // The per-clone sentence is the channel's own: the plugin installs no git hooks, so only it names a command to run elsewhere.
    const perClone = installChannel(ctx.env, ctx.selfPath).kind === "plugin"
        ? COMMIT_HOOK.perClonePlugin(connectCommandFor(ctx.env, ctx.selfPath))
        : COMMIT_HOOK.perCloneNpm;
    return { report: { clones: 1, chained: outcome.kind === "chained" ? 1 : 0 }, blocks: [], notes: wrap(perClone, 2) };
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
                ? PATH_CLASH.foreignWhy(truncatePath(terminalSafe(verdict.resolved), 52))
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