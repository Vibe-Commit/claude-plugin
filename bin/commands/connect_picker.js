/**
 * The `connect` picker flow — style guide §10.12 (0.7.0, PR 3). The order, as of CR-PRB T9b-2a (plan §4.4a, ENG-2, ENG-24):
 *   scan → picker → disclosure → grant y/N → write the grants (and `pending_offer`, ENG-26) → the hooks (commit hooks for every
 *   clone now on, then the agent hooks) → sign in → the joining question (screen 2) → the joined-repos commit-hook pass → (in a
 *   repo) the test capture → "Capture is on" → backfill offer (its inputs: this run's keys and the pending ones still granted,
 *   then `pending_offer` is cleared) → URL.
 * A sign-in that fails leaves the grants and the hooks in place; with no credential, branch (a) of the setup predicate then holds.
 * The hooks never wait on the credential: a hook that finds none writes nothing and says so in the agent session.
 *
 * ⛔ LOADED LAZILY, AND THAT IS THE POINT OF THIS FILE BEING SEPARATE. `connect.ts` imports it with `await import(...)` at
 * the two call sites that reach the picker. `src/index.ts` statically imports every verb, so everything `connect.ts`
 * imports is loaded by EVERY process, a hook's included; the picker, its checklist and the scan engine are a person-at-a-
 * terminal feature and must not ride along on the hook's load path. (Measured: no timing difference at all in 120
 * interleaved starts, so this is for the principle and for the SIGTERM cell's sake, not for a number.)
 * The helpers it shares with the 0.6.0 flow are exported from `connect.ts`; the import is circular only at call time.
 */
import { AGENT_HOOKS, ARGS, COMMANDS, COMMIT_HOOK, CONNECT, PICKER, SCAN, URLS } from "../copy/index.js";
import { EMPTY_GRANTS, GrantsUnreadableError, grantsUnreadable, isCaptureAllowed, isAffirmative, normalizeOwner, normalizeSlug, ownerOfSlug, readAccountState, readGrants, readPendingOffer, revokeProject, updateGrants, } from "../consent.js";
import { loadCredential } from "../credential.js";
import { credentialFingerprint } from "../post.js";
import { excludeFolder, excludedFolders, grantFolder, grantedFolders } from "../folder_grants.js";
import { EXIT } from "../exit.js";
import { mergePending } from "../grants_sync.js";
import { readAccountView, syncForVerb } from "../grants_verb.js";
import { channelCommand, connectCommandFor, installCaptureHooks, installChannel } from "../install.js";
import { workingNames } from "../setup_report.js";
import { agentHookVerdicts } from "../agent_install.js";
import { commitFindingsFor, setupState } from "../setup_state.js";
import { machineCapture, machineSummary, readPerClone } from "../machine_state.js";
import { buildModel, folderCaptureAgents, grantQuestion, grantScopeLines, hasAdditions, isNoChange, NO_CHANGE, notUnderstoodLines, parseTyped, preChange, renderGrantBlock, renderTyped, } from "../picker.js";
import { runChecklist } from "../picker_checklist.js";
import { isHeldDelivery } from "../post.js";
import { resolveProjectKeys } from "../project.js";
import { paint, renderErrorBlock, tildePath, truncatePath, wrap } from "../term.js";
import { terminalSafe } from "../printable.js";
import { signInBeat } from "./browser_credential.js";
import { accountChange, accountNoteLines, changeOps, commitG, joiningMachine, lastAccountState, mintForG, settleG, splitAccountExclusions, } from "./connect_account.js";
import { agentHookBeat, printSetupReport, setupBeatStart, askOrCancel, cancelledLines, disclosure, grantsUnreadableLines, holdLines, holdTail, obtainCredential, pinTestTranscript, sendTestCapture, tail, signInLeftBehind, } from "./connect.js";
import { writeLines } from "./context.js";
import { connectRetryCommand } from "./connect_retry.js";
import { replaceableInline } from "./credential_problem.js";
import { pickerNotListedLines, sawNoSession, scanMachine } from "./scan.js";
/**
 * `connect` from any folder: scan → picker → disclosure → grant y/N → hooks → sign in → "Capture is on" → backfill offer
 * → URL (§10.12). At most three questions in a run (D7 · 3A): the grant, the workspace (inside the mint, only where
 * 0.6.0 already asks it) and the backfill (PR 5's seam).
 *
 * ⛔ **CONSENT STAYS AHEAD OF THE CREDENTIAL, and nothing before the grant opens a transcript.** The scan, the picker and
 * the offer read directory entries and four Codex index columns only. The grant is written BEFORE the sign-in, as the
 * per-clone consent always was.
 */
export async function connectPicker(ctx, options, deps, here, 
/** The working folder's keys, when it is a work tree: the in-repo path probes its session (VQ item 7). */
keys = null, 
/** CR-PRB T12 (4.11): names given on the command line. The checklist is skipped; the names are the whole choice. */
names = null) {
    // ⛔ ONE `finally` FOR `g` (VQ + VT, #88): whatever way a run that holds a credential `g` made ends without committing it — a no,
    // Ctrl+C, Enter, an empty account, a removals-only yes, a failed write, an unexpected throw — it makes one best-effort revoke and
    // clears its write-ahead row. Nothing else revokes: the branches below only SAY how the run ended (`g.end`).
    const g = { credential: null, snapshot: null, origin: "", notes: [], committed: false, end: null };
    try {
        return await connectPickerRun(ctx, options, deps, here, keys, g, names);
    }
    finally {
        await settleG(ctx, deps, g);
    }
}
/**
 * What an ending prints, and its exit (ENG-18). Pure: no context, no I/O, no clock, no environment reads. Every early
 * return in `connectPickerRun` prints through it. A tail ending says which tail to run; the caller runs it after printing.
 */
export function connectEnding(facts) {
    switch (facts.kind) {
        case "grantsUnreadable":
            return {
                stdout: [],
                stderr: grantsUnreadableLines(facts.colour, facts.connectCommand),
                exit: EXIT.failure,
            };
        case "outputNotTerminal":
            return {
                stdout: [],
                stderr: renderErrorBlock({
                    kind: "bad",
                    code: "CONSENT_NEEDS_TTY",
                    what: CONNECT.outputNotTerminalWhat,
                    why: [CONNECT.outputNotTerminalWhy, ARGS.nothingRead],
                    fixLabel: CONNECT.outputNotTerminalFix,
                    fixes: [facts.connectCommand],
                }, facts.colour),
                exit: EXIT.usage,
            };
        case "noTty":
            return {
                stdout: facts.disclosure,
                stderr: renderErrorBlock({
                    kind: "bad",
                    code: "CONSENT_NEEDS_TTY",
                    what: CONNECT.pickerNonInteractiveWhat,
                    why: [CONNECT.pickerNonInteractiveWhy],
                    fixLabel: facts.repoPath !== null ? CONNECT.nonInteractiveFix(facts.repoPath) : CONNECT.pickerNonInteractiveFix,
                    fixes: [facts.connectCommand],
                }, facts.colour),
                exit: EXIT.usage,
            };
        case "mintExit":
            return { stdout: [], stderr: [], exit: facts.code };
        case "cancelled":
            return abandonOutcome(true, facts.holdsCredential);
        case "quit": {
            // 4.4 and 4.4a: where branch (a) holds, the line says setup is unfinished; where only a repair holds, it says the repair.
            // Never a bare "Capture stays on" over either. T10 (4.4a): a faulty credential file says so, with the replace.
            const line = facts.faultyFile
                ? CONNECT.faultyFileQuit(facts.connectCommand)
                : facts.setup === "unfinished"
                    ? PICKER.quitUnfinished(facts.connectCommand)
                    : facts.setup === "repair" && facts.summary !== null
                        ? PICKER.quitRepair(facts.summary, facts.connectCommand)
                        : facts.summary !== null
                            ? PICKER.noChanges(facts.summary)
                            : PICKER.noChangesPlain;
            return { ...abandonOutcome(false, facts.holdsCredential), stdout: ["", ...wrap(line, 2)] };
        }
        case "nothingChosen":
            return {
                ...abandonOutcome(false, facts.holdsCredential),
                stdout: ["", ...wrap(facts.summary !== null ? PICKER.noChanges(facts.summary) : PICKER.nothingGranted(facts.connectCommand), 2)],
            };
        case "declined":
            return {
                ...abandonOutcome(false, facts.holdsCredential),
                // A No with nothing held says so; with a credential held, the `finally` revokes it and prints its own line.
                stdout: [
                    ...(facts.holdsCredential ? [] : ["", ...wrap(CONNECT.declined, 2)]),
                    ...(facts.setupUnfinished ? ["", ...wrap(PICKER.endingUnfinished(facts.connectCommand), 2)] : []),
                ],
            };
        case "removalsOnly":
            return removalsEnding(facts);
        case "stoppedOnNo":
            return stoppedOnEnding(facts);
        case "signInFailed":
            return { stdout: [], stderr: [], exit: facts.code };
        case "notCommitted":
            return { stdout: [], stderr: [], settle: facts.outcome, exit: EXIT.failure };
        case "obtainFailed":
            return { stdout: [], stderr: [], exit: facts.code };
        case "held":
            return {
                stdout: holdLines(facts.colour),
                stderr: [],
                then: { tail: "holdTail", unconfirmed: facts.unconfirmed },
            };
        case "done":
            return {
                stdout: [
                    "",
                    // T7 (4.9): the recap, then the optional note and the Next line, before the one URL line (D19).
                    ...(facts.recap != null ? [`  ${paint(facts.colour, "text", facts.recap)}`] : []),
                    ...(facts.note != null ? [`  ${paint(facts.colour, "muted", facts.note)}`] : []),
                    ...(facts.next != null ? wrap(facts.next, 2) : []),
                    `  ${paint(facts.colour, "accent", facts.url)}`,
                ],
                stderr: [],
                then: { tail: "tail", unconfirmed: facts.unconfirmed },
            };
    }
}
/**
 * How a run that was abandoned ends (`cancelled`, or the No, quit and change-nothing endings): nothing was granted. With a
 * credential held, `g.end` says how it ended and `settleG` revokes it; with none, Ctrl+C prints the cancelled line.
 */
function abandonOutcome(ctrlC, holdsCredential) {
    const exit = ctrlC ? EXIT.failure : EXIT.ok;
    if (holdsCredential)
        return { stdout: [], stderr: [], settle: ctrlC ? "cancelled" : "declined", exit };
    return { stdout: ctrlC ? cancelledLines() : [], stderr: [], exit };
}
/**
 * A No that still wrote its stops (3E): the stopped line, then the run ends as a No does. Typed as an exit, so the caller can print it,
 * sync, and settle it, as the removals-only yes does.
 */
function stoppedOnEnding(facts) {
    return {
        ...abandonOutcome(false, facts.holdsCredential),
        stdout: [
            "",
            ...wrap(PICKER.stoppedOnNo(facts.names), 2),
            ...(facts.setupUnfinished ? ["", ...wrap(PICKER.endingUnfinished(facts.connectCommand), 2)] : []),
        ],
    };
}
/**
 * A yes that only removed things: the stopped line, then the run ends as a No does. It is the one ending that syncs between
 * its print and its settlement, so the caller prints it, syncs, and settles it (see `connectPickerRun`).
 */
function removalsEnding(facts) {
    const line = facts.stoppedFolders ? (facts.stoppedRepos ? PICKER.stoppedMixed : PICKER.stoppedFolders) : PICKER.stopped;
    return {
        ...abandonOutcome(false, facts.holdsCredential),
        stdout: ["", ...wrap(line, 2), ...(facts.setupUnfinished ? ["", ...wrap(PICKER.endingUnfinished(facts.connectCommand), 2)] : [])],
    };
}
async function connectPickerRun(ctx, options, deps, here, keys, g, names) {
    /** Print an ending's lines: stdout, then stderr. */
    const print = (out) => {
        writeLines(ctx.stdout, out.stdout);
        writeLines(ctx.stderr, out.stderr);
    };
    /** Record how an exit ending ended in `g` (`settleG`, in the `finally`, revokes a held credential by it), and return its exit. */
    const settle = (out) => {
        if (out.settle !== undefined)
            g.end = out.settle;
        return out.exit;
    };
    /** How the run ended: its lines, then its tail (whose return value is the exit) or its settlement. */
    const end = (out) => {
        print(out);
        if (out.then !== undefined)
            return out.then.tail === "holdTail" ? holdTail(ctx, out.then.unconfirmed) : tail(ctx, out.then.unconfirmed);
        return settle(out);
    };
    if (grantsUnreadable(ctx.home))
        return end(connectEnding({ kind: "grantsUnreadable", colour: ctx.colour, connectCommand: connectCommandFor(ctx.env, ctx.selfPath) }));
    // ENG-31 (CR-PRB T13b): a terminal stdin with a PIPED stdout refuses before the disclosure, the scan and any question (plan 4.5). The
    // typed prompt is no longer the fallback for it. A piped stdin, whatever stdout is, keeps the stdin refusal below, as before.
    if (ctx.stdinIsTty && ctx.stdout.isTTY !== true) {
        return end(connectEnding({ kind: "outputNotTerminal", colour: ctx.colour, connectCommand: connectRetryCommand(ctx.env, ctx.selfPath, [], options) }));
    }
    // ⛔ THE NON-TTY REFUSAL COMES BEFORE THE SCAN (VQ + VT, PR 6 item 6): "Nothing was read and nothing was uploaded" stays
    // literally true, and a CI job that pipes `connect` never walks the filesystem. The disclosure still prints first
    // (CR-117), under the picker heading. It names the folder to run it in when `connect` runs INSIDE a repo (`here.kind === "repo"`,
    // the folder `connectPicker` was already given, never one the scan found), cut from the left as the `local:` refusal does; from a
    // folder that is not a repo, and from `$HOME` (a dotfiles repo there is `kind: "folder"` and the run is machine-level), it names none.
    if (!ctx.stdinIsTty) {
        return end(connectEnding({
            kind: "noTty",
            colour: ctx.colour,
            disclosure: disclosure(ctx, true),
            repoPath: here !== null && here.kind === "repo" ? truncatePath(terminalSafe(tildePath(here.toplevel, ctx.home)), 46) : null,
            connectCommand: connectCommandFor(ctx.env, ctx.selfPath),
        }));
    }
    // D17: one static beat line, overwritten once with `done` on a terminal. `ctx.colour` is false with no terminal and under
    // NO_COLOR, where it prints plainly with no overwrite. No spinner (§13.8): the bytes are the same at any speed.
    const beat = `  ${SCAN.beat}`;
    if (ctx.colour)
        ctx.stdout.write(`\n${beat}`);
    const scanned = (deps.scan ?? scanMachine)(ctx.home, ctx.env);
    // ENG-38 (T9b-2b review): the commit-hook probes run INSIDE the scan beat, before "done" is written, so "Looking for repositories..."
    // is the line on screen while they run. The predicate reads them after the first sync (it does not probe again).
    const hookProbes = scanCommitHooks(ctx, deps, scanned, here);
    ctx.stdout.write(ctx.colour ? `\r${beat}   ${SCAN.beatDone}\n` : `\n${beat}   ${SCAN.beatDone}\n`);
    // ⛔ SLICE 2 (S4 part 3). `deps.account` is the account's network; left out, `connect` talks to nobody about grants and behaves as
    // 0.7.0 did. A machine that ALREADY has a credential syncs first, before the model is built, so the "on your account" group is
    // what the server last said; a machine without one has no account to read until it signs in (`g` is how it asks).
    const account = deps.account ?? null;
    const loaded = loadCredential({ env: ctx.env, home: ctx.home });
    const credentialAtStart = loaded.kind === "ok";
    // T10 (plan 4.4a, spec loop pass 3): a credential FILE that is wrong-class or unreadable. The nothing-chosen endings read it here, locally
    // (`obtainCredential` reads it only after a grant that adds something): Enter goes into the inline replace, and q/Esc names it.
    // 0.17.3 (P6 ruling): only a fault connect REPLACES (`replaceableInline`): a file it could not read is never replaced, so q/Esc must not
    // say "press Enter to replace it"; it is handled as an insecure file is.
    const faultyFile = loaded.kind === "unreadable" ? replaceableInline(loaded) : loaded.kind === "wrong-class" && loaded.source === "file";
    // The first-sync line is said once per run: if this one prints it, the sync after the writes does not.
    let firstSyncSaid = false;
    let syncUnauthorized = false;
    if (account !== null && credentialAtStart) {
        const first = await syncForVerb(ctx, false, account);
        firstSyncSaid = first.kind === "ran" && first.disclosed === true;
        // (e), 4.4a: the first sync answered 401, so the credential is not accepted and Enter finishes setup through the credential path.
        syncUnauthorized = first.kind === "ran" && first.result.kind === "unauthorized";
    }
    // ⛔ ONE PREDICATE RESULT PER RUN (ENG-29, ENG-38; 4.4a): computed here, once, after the first sync (so (e) is known) and before the
    // picker opens. It checks the commit hook of every clone of a repo that is on, and of this repo when it is on, and nothing else.
    const setup = pickerSetup(ctx, deps, hookProbes, syncUnauthorized);
    const finishes = setupNeedsRun(setup);
    const read = readGrants(ctx.home);
    const grants = read.kind === "ok" ? read.grants : EMPTY_GRANTS;
    const perClone = readPerClone(ctx.home);
    const accountView = account !== null && credentialAtStart
        ? readAccountView(ctx.home, perClone.flatMap((clone) => (clone.slug === null ? [] : [clone.slug])), { kind: "skipped" })
        : null;
    const model = buildModel({
        repos: scanned.repos,
        grants,
        perClone,
        notListed: pickerNotListedLines(scanned.notListed, connectCommandFor(ctx.env, ctx.selfPath)),
        sawNothing: sawNoSession(scanned.notListed, ctx.home),
        here,
        accountNotHere: accountView === null ? [] : accountView.notHere,
        folders: scanned.folders ?? [],
        grantedFolders: grantedFolders(ctx.home),
        excludedFolders: excludedFolders(ctx.home),
        folderLabel: (path) => truncatePath(tildePath(path, ctx.home), 46),
        // D-TEMP (T5): absent in a test context, so the rigs' folders keep their rows; the production context sets the default roots.
        tempRoots: ctx.tempRoots ?? [],
    });
    // ⛔ `g` IS OFFERED ONLY WHERE THE CREDENTIAL BEAT WOULD MINT (exception 3): no credential at all (an `absent` file, not a faulty
    // one), a terminal, and a browser to sign in with. The `auth` chain passes no browser and always leaves a credential, so it can
    // never reach this; the same gate as `obtainCredential`'s keeps the two in step.
    const offerAccount = account !== null && loaded.kind === "absent" && ctx.stdinIsTty && deps.browser !== undefined;
    // T1 (ENG-41): the static block (Found, the screen-reader line, `Not listed here:`) prints once per run. The checklist writes it;
    // `choose` (both calls, around `g`) and `typedPick` read this flag so a second screen does not repeat it.
    const shown = { header: false };
    // 4.5: the switch to the typed prompt explains itself, once, when the checklist declined on its own.
    // CR-PRB T12 (4.11): with names there is no checklist and no typed prompt to switch to.
    if (names === null) {
        const choice = checklistChoice(ctx, options, model);
        if (choice.kind === "typed" && choice.why !== null)
            writeLines(ctx.stdout, switchLines(ctx, choice.why));
    }
    let pick = names !== null ? pickFromNames(ctx, model, names) : await choose(ctx, options, deps, model, offerAccount, shown, finishes);
    /** The grant block's heading and the repos `g` named, when the list is the account's own. */
    let accountList = null;
    if (pick.kind === "account" && account !== null) {
        const minted = await mintForG(ctx, options, deps, account);
        if (minted.kind === "exit")
            return end(connectEnding({ kind: "mintExit", code: minted.code }));
        g.credential = minted.credential;
        g.notes = minted.notes;
        g.snapshot = minted.snapshot;
        g.origin = minted.origin;
        const change = minted.snapshot === null ? NO_CHANGE : accountChange(minted.snapshot);
        if (isNoChange(change)) {
            // Screen 1c: the account grants nothing (or could not be read). The credential is held; the person chooses here, and a run
            // that ends with nothing granted revokes it (`settleG`).
            writeLines(ctx.stdout, [
                "",
                ...wrap(minted.snapshot === null ? PICKER.gUnavailable(connectCommandFor(ctx.env, ctx.selfPath)) : PICKER.gEmpty, 2),
                "",
            ]);
            pick = await choose(ctx, options, deps, model, false, shown, finishes);
        }
        else {
            const known = new Set(model.owners.flatMap((group) => group.repos.map((repo) => repo.slug)));
            accountList = { noClone: new Set(change.addRepos.filter((slug) => !known.has(slug))) };
            pick = { kind: "change", change, noClone: accountList.noClone };
        }
    }
    if (pick.kind === "cancel" || pick.kind === "account")
        return end(connectEnding({ kind: "cancelled", holdsCredential: g.credential !== null }));
    if (pick.kind === "quit") {
        // 4.4: q and Esc leave with exit 0. The machine's own summary when it captures; otherwise the plain line. 4.4a: where a setup
        // predicate holds, the line says so and never says "Capture stays on" over it.
        const on = machineCapture(ctx.home);
        return end(connectEnding({
            kind: "quit",
            summary: on.kind === "on" ? machineSummary(on) : null,
            holdsCredential: g.credential !== null,
            setup: setupNote(setup),
            connectCommand: connectCommandFor(ctx.env, ctx.selfPath),
            faultyFile,
        }));
    }
    // 2B (4.4, 4.4a; T9b-2b review): Enter with nothing new, or the typed empty answer, is `finishing`. Where setup is unfinished it runs
    // the SAME tail as a yes (the hooks, the sign-in, the sync after a mint, the joining question, the joined pass, the offer, then
    // "Capture is on"), with no change of its own. Elsewhere it is today's ending.
    const finishing = pick.kind === "none" || isNoChange(pick.change);
    // ⛔ #5 (ENG-26, the crash window): an offer this run still owes is read BEFORE the early return below. A credential saved, then a crash
    // before the offer, leaves its keys in `pending_offer` with complete hooks; the run that reaches here must offer them, not say "No changes".
    const owedOffer = pendingStillGranted(ctx, model, readPendingOffer(ctx.home));
    if (finishing && !finishes && owedOffer.length === 0 && !hereHookMissing(setup, here) && !faultyFile) {
        // Enter is "change nothing" (D5): no grant, no credential, and a completed consent flow (§13.7).
        const on = machineCapture(ctx.home);
        return end(connectEnding({
            kind: "nothingChosen",
            summary: on.kind === "on" ? machineSummary(on) : null,
            connectCommand: connectCommandFor(ctx.env, ctx.selfPath),
            holdsCredential: g.credential !== null,
        }));
    }
    // The ops the account is to hear about go into the SAME write as the grants (a yes only: a finish adds nothing).
    const queueOps = !finishing && account !== null && accountList === null;
    let change = NO_CHANGE;
    /** CEO-12 / ENG-4: the test capture's pinned transcript, set before the grant block when this repo is among this run's additions. */
    let pinned = null;
    if (pick.kind === "change" && !isNoChange(pick.change)) {
        // A repo the ACCOUNT turned off, picked as an ordinary add, is a re-include: it gets its own `turn on` row (the yes wins).
        const accountState = account !== null && accountList === null ? lastAccountState(ctx.home) : null;
        const split = splitAccountExclusions(pick.change, accountState === null ? [] : accountState.excluded);
        change = split.change;
        // One disclosure and one y/N cover additions and removals together, and a No changes nothing. Removals alone skip the
        // disclosure and ask the stop question (§10.12 "The grant y/N").
        const facts = {
            reposHere: reposByOwner(model),
            noClone: pick.noClone,
            accountOff: split.accountOff,
            folderLabels: folderLabels(model),
        };
        // ⛔ CEO-12 / ENG-4: the test capture's transcript is located ONCE, here, before the grant block, and judged against the recency
        // window now. It is pinned only when this repo is among this run's additions (an added repo, an added owner that covers it, or a
        // turn-on), and `--no-backfill` skips it. The send after the yes uses exactly this file, up to the size pinned here.
        // ⛔ Codex rvprb3 F1: on the `g` path the account's exclusions are in the HELD snapshot until `commitG` writes them after the yes.
        // The snapshot's list is passed in, not written early, so the question names no check for a repo the account excludes.
        pinned = pinForAdditions(ctx, options, keys, here, change, g.snapshot?.excluded ?? []);
        writeLines(ctx.stdout, hasAdditions(change) ? ["", ...disclosure(ctx, true)] : [""]);
        writeLines(ctx.stdout, renderGrantBlock(change, facts, ctx.colour, accountList === null ? PICKER.chose : PICKER.accountGrants));
        const check = pinned?.pin.fresh && pinned.pin.age !== null ? { agent: pinned.pin.agent, activity: PICKER.activeAgo(pinned.pin.age) } : null;
        writeLines(ctx.stdout, grantScopeLines(change, check));
        const answer = await askOrCancel(ctx, grantQuestion(change, ctx.colour, CONNECT.consentAnswers, folderLabels(model)));
        if (answer === null)
            return end(connectEnding({ kind: "cancelled", holdsCredential: g.credential !== null }));
        if (!isAffirmative(answer)) {
            // A No on a folder is a decision about it: it is turned off and stops being "undecided" in `status`. (A repo you leave unticked
            // is left as it was: only what the person was ASKED about and refused is recorded.)
            for (const path of change.addFolders ?? [])
                excludeFolder(ctx.home, path, ctx.now());
            if (!hasStops(change)) {
                return end(connectEnding({
                    kind: "declined",
                    holdsCredential: g.credential !== null,
                    setupUnfinished: setupNote(setup) === "unfinished",
                    connectCommand: connectCommandFor(ctx.env, ctx.selfPath),
                }));
            }
            // ⛔ 3E (plan 4.8): a No still writes the STOPS, and writes none of the adds. A stop is a decision the person made, and it is
            // queued for the account in the same write, like a removals-only yes.
            try {
                applyChange(ctx, model, stopsOnly(change), queueOps);
            }
            catch (error) {
                if (!(error instanceof GrantsUnreadableError))
                    throw error;
                return end(connectEnding({ kind: "grantsUnreadable", colour: ctx.colour, connectCommand: connectCommandFor(ctx.env, ctx.selfPath) }));
            }
            const out = stoppedOnEnding({
                kind: "stoppedOnNo",
                names: stopNames(change, folderLabels(model)),
                holdsCredential: g.credential !== null,
                setupUnfinished: setupNote(setup) === "unfinished",
                connectCommand: connectCommandFor(ctx.env, ctx.selfPath),
            });
            print(out);
            if (queueOps && credentialAtStart)
                await syncForVerb(ctx, false, account, { quietFirst: firstSyncSaid });
            return settle(out);
        }
        // The ops the account is to hear about go into the SAME write as the grants: one `updateGrants`, so a crash cannot leave one
        // without the other. The account's own list (`g`) is already on the account and needs none.
        try {
            applyChange(ctx, model, change, queueOps);
        }
        catch (error) {
            if (!(error instanceof GrantsUnreadableError))
                throw error;
            // Raced with an edit of `grants.json` since the check above. Nothing was written. (No `g.end`: the `finally` revokes a held one.)
            return end(connectEnding({ kind: "grantsUnreadable", colour: ctx.colour, connectCommand: connectCommandFor(ctx.env, ctx.selfPath) }));
        }
        if (!hasAdditions(change)) {
            const stoppedFolders = (change.stopFolders ?? []).length > 0;
            const stoppedRepos = change.stopOwners.length + change.stopRepos.length + change.stopClones.length > 0;
            const out = removalsEnding({
                kind: "removalsOnly",
                stoppedFolders,
                stoppedRepos,
                holdsCredential: g.credential !== null,
                setupUnfinished: setupNote(setup) === "unfinished",
                connectCommand: connectCommandFor(ctx.env, ctx.selfPath),
            });
            print(out);
            // Removals reach the account too; nothing more to say about it.
            if (queueOps && credentialAtStart)
                await syncForVerb(ctx, false, account, { quietFirst: firstSyncSaid });
            // A removals-only yes grants nothing: a credential `g` is holding is not kept (`settleG` revokes it).
            return settle(out);
        }
    }
    // ⛔ THE HOOKS BEFORE THE CREDENTIAL (ENG-2, ENG-24; plan §4.4a). The grants are written, so the hooks for every clone now on, then
    // the agent hooks, go in before any sign-in request. A sign-in that fails leaves them in place, and a hook run then says so.
    const on = onSlugs(ctx, model, change);
    const onRepos = scanned.repos.filter((repo) => on(normalizeSlug(repo.slug)));
    const clones = [
        ...new Set([
            ...onRepos.flatMap((repo) => repo.clones.map((clone) => clone.path)),
            ...(here !== null && here.kind === "repo" && on(normalizeSlug(here.slug)) ? [here.toplevel] : []),
        ]),
    ];
    // T8 (4.2): the agents whose file holds our hooks after this run. The proof sentence under "Capture is on" names only them (DX-13).
    let working = [];
    if (finishing && setup.kind === "checked") {
        // A finish that is a repair writes only what the repair names (4.4a). `unknown` takes the full idempotent step below.
        const plugin = installChannel(ctx.env, ctx.selfPath).kind === "plugin";
        // T8b (4.2): the one beat and the one report. A finish that is a repair writes only what the repair names (4.4a).
        // ⛔ #9 (4.4a): on the plugin channel a MISSING hook is still not "setup unfinished", but the current clone's is installed here, as 0.16.0's
        // covered path did. Another granted clone is not touched: the plugin never hooks a clone by itself.
        const hereToplevel = here !== null && here.kind === "repo" ? here.toplevel : null;
        const repairs = setup.commitHooks
            .filter((f) => f.writable && (f.stale || (f.state.kind === "off" && (!plugin || f.toplevel === hereToplevel)) || (!plugin && f.state.kind === "foreign")))
            .map((f) => f.toplevel);
        const agentsToDo = setup.agents.length > 0 || setup.noAgentHooks;
        const work = repairs.length > 0 || agentsToDo;
        setupBeatStart(ctx, work);
        const commit = repairs.length > 0 ? installCommitHooksForReport(ctx, repairs) : null;
        if (agentsToDo)
            working = agentHookBeat(ctx, commit, work);
        else
            printSetupReport(ctx, { work, commit, rows: [], agentBlocks: [] });
    }
    else {
        // T8b (4.2): the one beat and the one report, for the clones this run offers and the agents on this machine.
        const work = clones.length > 0 || agentHookVerdicts(ctx.home, ctx.env, ctx.selfPath).length > 0;
        setupBeatStart(ctx, work);
        const commit = clones.length > 0 ? installCommitHooksForReport(ctx, clones) : null;
        working = agentHookBeat(ctx, commit, work);
    }
    if (options.signIn === true) {
        // 0.17.1 D1: the grants and hooks are written, so a failed beat says what it left behind (`signInLeftBehind`): the signInFailed ending
        // prints nothing after the block, so the block is the only place the user learns that this run's writes stand.
        const code = await signInBeat(ctx, {
            retry: "sign-in",
            verify: true,
            afterWrites: () => signInLeftBehind(ctx),
            ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
        });
        if (code !== EXIT.ok)
            return end(connectEnding({ kind: "signInFailed", code }));
    }
    // ⛔ THE COMMIT, in this order: the grants (written above), then `credentials.json`, then the write-ahead row's deletion.
    const committed = g.credential === null ? "committed" : commitG(ctx, g);
    if (committed !== "committed") {
        // The row was settled by another command, or a concurrent mint holds credentials.json: nothing is saved, the finally revokes the
        // token held in memory, the grants already written stay, and the exit is 1 — never the exit-3 "connected over a dead credential".
        return end(connectEnding({ kind: "notCommitted", outcome: committed }));
    }
    const got = await obtainCredential(ctx, deps, options, "repos");
    if (got.kind === "exit")
        return end(connectEnding({ kind: "obtainFailed", code: got.code }));
    // The credential exists now. A machine that had none was just minted one (by the beat above, or by `g`): its first sync is the
    // moment the server learns what this machine named; one that already had one syncs again only if this run queued something.
    const minted = !credentialAtStart;
    // W2 (P6 review, #2): the sync after the writes runs when the credential CHANGED in this run. A replacement over a 401'd credential
    // is a change too, so it syncs with the new credential (`minted` alone missed it: no first sync, and no sync on an Enter).
    const credentialChanged = loaded.kind !== "ok" || credentialFingerprint(got.credential) !== credentialFingerprint(loaded.credential);
    let joined = [];
    /** What the sync after the writes answered, or `null` when none was needed. A sync that did not tell the account is said under "Capture is on". */
    let accountSync = null;
    /** Ctrl+C at the joining question: a No, and nothing more is asked (the backfill offer below is a question). */
    let askedNoMore = false;
    if (account !== null) {
        if (credentialChanged || queueOps) {
            // ONE bounded sync after the writes and before "Capture is on" (VQ, on VT's question): a repo granted or re-included in this
            // run is admitted in this run, not at the next verb. Silent on failure; `pending` is kept and the line below says so.
            const after = await syncForVerb(ctx, false, account, { quietFirst: firstSyncSaid });
            accountSync = after;
            if (after.kind === "ran" && after.disclosed === true)
                firstSyncSaid = true;
        }
        // ⛔ SCREEN 2 — only for a machine that did NOT know the account when it showed the picker, after its own y/N, the credential
        // and the first sync, and BEFORE the hooks step so the hooks cover every clone named. A machine that already had a credential
        // saw the account's grants in the picker's "on your account" group and chose among them there.
        if (minted && g.credential === null) {
            const join = await joiningMachine(ctx, account, CONNECT.consentAnswers, firstSyncSaid);
            joined = join.names;
            askedNoMore = join.cancelled;
            // The joining question's sync is the latest word on whether the account was told: it gets the same handling.
            if (join.sync !== null)
                accountSync = join.sync;
        }
    }
    // ⛔ THE JOINED-REPOS PASS (ENG-2): the joining question admitted repos this run did not name. Their clones get the commit hook
    // now, and only them; the agent hooks are machine-wide and were already written above.
    const joinedClones = joined.length === 0
        ? []
        : [...new Set(scanned.repos.filter((repo) => joinedRepo(joined, repo.slug)).flatMap((repo) => repo.clones.map((clone) => clone.path)))].filter((path) => !clones.includes(path));
    // T8b (ENG-2, 4.13): when the joining question added clones, a second, shorter report with only the commit-hooks row.
    if (joinedClones.length > 0) {
        setupBeatStart(ctx, true);
        printSetupReport(ctx, { work: true, commit: installCommitHooksForReport(ctx, joinedClones), rows: [], agentBlocks: [] });
    }
    // ⛔ IN A REPO, THE TEST CAPTURE RUNS BEFORE "Capture is on" (VQ item 7, adopting VT). 0.6.0's payoff was evidence — this
    // session, recorded, with a link. So: hooks (L11), then the probe inside ONE hook budget (the same call the `local:` path
    // makes), then "Capture is on" with the session link as the one URL line. From `~` there is no session to probe and nothing changes.
    let probe = null;
    if (pinned !== null) {
        // The pinned file, and only it (ENG-4). Stale or missing: nothing is sent, and the ending has no session link.
        const found = pinned.pin.fresh;
        const { delivery, withheld } = pinned.pin.hasLocator && found === null
            ? { delivery: null, withheld: false }
            : await sendTestCapture(ctx, pinned.keys, got.credential, found);
        probe = { hasLocator: pinned.pin.hasLocator, found, delivery, withheld };
        if (isHeldDelivery(delivery)) {
            // A HOLD (A78): an older server's approval 403 for THIS repo. The generic hold line, never "Capture is on" over it and
            // no offer to upload more into it; the hooks were installed above, and the exit is `tail`'s (0).
            return end(connectEnding({ kind: "held", colour: ctx.colour, unconfirmed: got.unconfirmed }));
        }
    }
    // D18 · D19: "Capture is on" before the optional upload, so it is on screen within seconds of the sign-in.
    // ⛔ Codex rvprb2 N1: the block is printed only when capture is on NOW (read after the send-time re-check above). A kind "on" state
    // always has a non-empty summary (`machineCapture` is "none" when no owner, repo or folder is on), so the block never prints
    // "Capture is on for  on this machine.". A check withheld because consent was withdrawn while sign-in waited prints no block.
    // ⛔ Codex rvprb3 F3 (P6 ruling): the account-sync notes print whether or not the block does. Inside the block they sit where they always
    // did (byte-identical output); with no block they print alone at the same point. One copy of the note lines, built once here.
    const untold = accountNoteLines(ctx, accountSync);
    if (machineCapture(ctx.home).kind === "on") {
        // ⛔ #6: a joined repo's clone (its hooks were just installed above) counts: "no clone of it is here yet" would be false.
        // ⛔ Codex rvprb3 F5: "No clone of it is here yet" only when no clone here exists. A clone here that this change adds and the deny lists refuse
        // is a clone that exists, so the block keeps its names and drops that one sentence.
        // W8 (prb3 F5 follow-up): "here" in that sentence is this MACHINE, so a denied clone anywhere the scan found counts, not only the cwd's.
        const deniedHere = addedCloneDenied(ctx.home, here, scanned.repos, change, g.snapshot?.excluded ?? []);
        captureOnBlock(ctx, model, change, clones.length + joinedClones.length === 0, joined, untold, working, deniedHere);
    }
    else if (untold.length > 0) {
        writeLines(ctx.stdout, ["", ...untold]);
    }
    // Folders granted in this run, said once, after the block that names the repos (R7: the claim is who can read them).
    const grantedNow = change.addFolders ?? [];
    if (grantedNow.length > 0) {
        const names = folderLabels(model);
        // ⛔ Codex rvprb3 F2 (P6 ruling): every name this line prints goes through terminalSafe, the raw-path fallback included.
        writeLines(ctx.stdout, ["", ...wrap(PICKER.onFolders(grantedNow.map((path) => terminalSafe(names.get(path) ?? path)).join(", ")), 2), ...wrap(PICKER.onFoldersProof(folderCaptureAgents()), 2)]);
    }
    // The backfill offer. Left out (`deps.backfill`), no offer is made and the ending is the one after a no. The URL follows
    // what LANDED (D19): the conversations list once at least one session was uploaded, whether the run finished or stopped.
    let url = probeUrl(probe);
    // D-TEMP (T5): the offer leaves out the temporary folders the picker collapsed, unless the person granted them (a granted one is not in
    // `model.temporaryFolders`). The same classifier as the picker, so the offer and the rows cannot disagree.
    // The grants are read again here, because a temporary folder granted in THIS run is no longer collapsed.
    const temporaryPaths = new Set(model.temporaryFolders.map((folder) => folder.path));
    const grantedAtOffer = new Set(grantedFolders(ctx.home));
    const parentFolders = (scanned.folders ?? []).filter((folder) => !temporaryPaths.has(folder.path) || grantedAtOffer.has(folder.path));
    // ⛔ THE OFFER'S INPUTS (4.4a, ENG-26): this run's additions and the joined repos, plus the `pending_offer` keys still granted. The
    // pending key is cleared here, by the run that reaches the offer step, whatever the person answers (or is not asked).
    const pending = readPendingOffer(ctx.home);
    if (pending.length > 0) {
        try {
            updateGrants(ctx.home, (g) => g, { pending_offer: null });
        }
        catch (error) {
            if (!(error instanceof GrantsUnreadableError))
                throw error;
        }
    }
    const offerEntries = [...additionEntries(change), ...joinedEntries(joined), ...pending];
    // ⛔ #6 (4.13): `onRepos` was read BEFORE the joining question, so a joined repo was not in it. The offer reads the grants as they are NOW.
    const onAfterJoin = onSlugs(ctx, model, change);
    const offerRepos = scanned.repos.filter((repo) => onAfterJoin(normalizeSlug(repo.slug)) && offerEntries.some((entry) => entryNamesRepo(entry, repo.slug)));
    // T7 (4.9, B5): the folders are this run's grants plus `pending_offer`'s folders still granted, never every scanned parent folder. A folder
    // granted earlier is not offered again. The temporary-folder rule above (D-TEMP, T5) still applies to what is left.
    const offeredFolderPaths = new Set([...(change.addFolders ?? []), ...pending.filter((entry) => entry.kind === "folder").map((entry) => entry.value)].filter((path) => grantedAtOffer.has(path)));
    const offerFolders = parentFolders.filter((folder) => offeredFolderPaths.has(folder.path));
    // T7 (4.9, B3): `--no-backfill` makes no offer, asks nothing, and the clear above has already emptied `pending_offer`. (Its test-capture
    // skip is `pinForAdditions`'s: no pin, no send.)
    const noBackfill = options.noBackfill === true;
    let uploaded = 0;
    if (deps.backfill !== undefined && !noBackfill && (offerRepos.length > 0 || offerFolders.length > 0) && !askedNoMore) {
        const outcome = await deps.backfill(ctx, offerRepos, offerFolders);
        uploaded = outcome.kind === "declined" ? 0 : outcome.uploaded;
        if (outcome.kind !== "declined" && outcome.uploaded > 0)
            url = URLS.conversations;
    }
    // T7 (4.9): the recap goes before the URL on this ending (it turned something on). The Next line is for an ending that sent nothing: no
    // session link (the dashboard) and no upload (DX-21). `--no-backfill` adds its muted line.
    const capture = machineCapture(ctx.home);
    const recap = capture.kind === "on" ? CONNECT.recap(machineSummary(capture)) : null;
    // Codex rvprb #3: a check withheld at send time says why nothing was sent (the muted note), and the ending is the sent-nothing one.
    const withheld = probe?.withheld === true;
    // ⛔ P6's T20 ruling (2026-11-22): on a withheld run the Next line prints only when capture is still on after the send-time re-check (the
    // recap's own guard). Its "one of them" is then the recap's repos, which no longer include the withheld one; with nothing on, it is dropped.
    const next = url === URLS.dashboard && uploaded === 0 && (!withheld || capture.kind === "on")
        ? CONNECT.nextStep(channelCommand(ctx.env, ctx.selfPath, COMMANDS.status))
        : null;
    return end(connectEnding({
        kind: "done",
        colour: ctx.colour,
        url,
        unconfirmed: got.unconfirmed,
        recap,
        note: withheld ? CONNECT.checkWithheld : noBackfill ? CONNECT.noBackfillRecap : null,
        next,
    }));
}
/**
 * The test capture's pin, when this run's change adds this repo: `null` otherwise (no working folder, `--no-backfill`, or the repo is
 * not among the additions, so the check does not run; plan 4.8, ENG-4).
 */
function pinForAdditions(ctx, options, keys, here, change, 
/** The `g` path's held account snapshot's exclusions (`g.snapshot`), not yet written (Codex rvprb3 F1). Empty elsewhere. */
heldExcluded = []) {
    if (keys === null || here === null || here.kind !== "repo" || options.noBackfill === true)
        return null;
    const slug = normalizeSlug(here.slug);
    // ⛔ Codex rvprb2 N2 (P6 ruling): an addition this change leaves OFF is not checked, so the question never promises a check the
    // send will withhold (#3's re-check). The question names the check only when the pin is taken.
    return repoAddedBy(slug, change) && !leftOffAfter(ctx.home, slug, change, heldExcluded) ? { keys, pin: pinTestTranscript(ctx, keys.worktree) } : null;
}
/** Is this repo among this change's additions: an added repo, a turn-on, or an added owner that covers it? */
function repoAddedBy(slug, change) {
    return (change.addRepos.some((repo) => normalizeSlug(repo) === slug) ||
        change.turnOn.some((repo) => normalizeSlug(repo) === slug) ||
        change.addOwners.some((owner) => normalizeOwner(owner) === ownerOfSlug(slug)));
}
/**
 * Codex rvprb3 F5 (P6 ruling): a clone on this machine that this change adds, but that the deny lists refuse once it is applied, is a
 * clone that exists. "No clone of it is here yet" is false for it, so the no-clone sentence is not printed. Reuses `leftOffAfter`, the
 * same lists. The cwd's clone counts even when the scan did not list it, and so does any clone the scan found (W8's follow-up: the
 * sentence is about this machine, not the cwd).
 */
function addedCloneDenied(home, here, repos, change, held) {
    const denied = (slug) => repoAddedBy(slug, change) && leftOffAfter(home, slug, change, held);
    if (here !== null && here.kind === "repo" && denied(normalizeSlug(here.slug)))
        return true;
    return repos.some((repo) => repo.clones.length > 0 && denied(normalizeSlug(repo.slug)));
}
/**
 * Codex rvprb2 N2: is this repo left off once `change` is applied? It reads the EXISTING deny lists, with no new one: `grants.json`'s
 * `excluded` and `refused`, and the account file's `refused` and its own `excluded` (the same four lists `isCaptureAllowed` denies on).
 * A turn-on lifts a local exclusion, so a repo in `turnOn` is not denied. A repo this change stops is off too, and so is a clone row it
 * stops (clone rows are keyed by slug).
 */
function leftOffAfter(home, slug, change, heldExcluded) {
    if (change.stopRepos.some((repo) => normalizeSlug(repo) === slug) || change.stopClones.some((clone) => normalizeSlug(clone) === slug)) {
        return true;
    }
    if (change.turnOn.some((repo) => normalizeSlug(repo) === slug))
        return false;
    const read = readGrants(home);
    const grants = read.kind === "ok" ? read.grants : EMPTY_GRANTS;
    const account = readAccountState(home);
    // Codex rvprb3 F1: the held `g` snapshot's exclusions count too; `commitG` writes them only after the yes.
    return [grants.excluded, grants.refused, account.refused, account.account?.excluded ?? [], heldExcluded].some((list) => list.includes(slug));
}
/**
 * The one URL line after "Capture is on". From `~` (no probe) it is the dashboard, as after a no. In a repo it is the
 * recorded session's own page when the 2xx carried its id (`DX D8`); the captures list where 0.6.0 falls back to it (a
 * delivery with no id, an agent with no locator); and the dashboard when there was no transcript to link.
 */
function probeUrl(probe) {
    if (probe === null)
        return URLS.dashboard;
    if (probe.withheld)
        return URLS.dashboard;
    if (probe.hasLocator && probe.found === null)
        return URLS.dashboard;
    const id = probe.delivery?.kind === "attempted" ? probe.delivery.conversationId : undefined;
    return id === undefined ? URLS.commits : URLS.conversation(id);
}
function checklistChoice(ctx, options, model) {
    if (options.typed === true || !ctx.stdinIsTty)
        return { kind: "typed", why: null };
    // (A piped stdout never reaches here: `connectPickerRun` refuses it first, ENG-31.)
    const out = ctx.stdout;
    // FA5: nothing to list means no list on any terminal, so no switch line may promise one (checked before TERM and the width).
    // A folder counts (4.5), a temporary one too (T5c): a machine whose sessions are all in folders outside a repo gets the checklist.
    const listed = model.onNow.length + model.owners.length + model.account.length + model.turnedOff.length + model.folders.length + model.temporaryFolders.length;
    if (listed === 0)
        return { kind: "typed", why: null };
    if (ctx.env.TERM === "dumb")
        return { kind: "typed", why: { kind: "dumb" } };
    // The frame is erased by line count, so a terminal narrower than the frame (which soft-wraps) would leave debris. A width
    // of 0 or none is a terminal that does not say, which is not a narrow one.
    if (out.columns !== undefined && out.columns > 0 && out.columns < 80)
        return { kind: "typed", why: { kind: "narrow", columns: out.columns } };
    return { kind: "checklist" };
}
/** The two muted lines that explain the switch (4.5), wrapped at the window's known width. */
function switchLines(ctx, why) {
    // The arrow-key list needs 80 (DESIGN.md §13.4); a `dumb` terminal wraps at the same 80-column rule.
    const width = why.kind === "narrow" ? why.columns : 80;
    const first = why.kind === "narrow" ? PICKER.narrowWindow(why.columns) : PICKER.noArrowKeys;
    const second = PICKER.chooseTyped(connectCommandFor(ctx.env, ctx.selfPath));
    return [...wrap(first, 2, 2, width), ...wrap(second, 2, 2, width)].map((line) => paint(ctx.colour, "muted", line));
}
async function choose(ctx, options, deps, model, 
/** Slice 2: `g` is a choice here (screen 1a). */
offerAccount, 
/** T1: whether the static block has been printed this run (shared with `typedPick`). */
shown, 
/** 4.4a: Enter with nothing new finishes setup (the count line says so). */
finishes) {
    const nowMs = ctx.now().getTime();
    if (checklistChoice(ctx, options, model).kind === "checklist") {
        const result = await runChecklist(model, {
            colour: ctx.colour,
            nowMs,
            typedCommand: channelCommand(ctx.env, ctx.selfPath, COMMANDS.connectTyped),
            offerAccount,
            enterFinishesSetup: finishes,
            headerPrinted: shown.header,
            columns: () => ctx.stdout.columns,
        }, { input: deps.checklist?.input ?? process.stdin, output: ctx.stdout, ...deps.checklist });
        // The checklist has printed the static block by now, whatever it resolves with.
        shown.header = true;
        if (result.kind === "cancel")
            return { kind: "cancel" };
        if (result.kind === "quit")
            return { kind: "quit" };
        if (result.kind === "account")
            return { kind: "account" };
        if (result.kind === "done")
            return { kind: "change", change: result.change, noClone: new Set() };
        // `t`: the typed prompt, from the same model.
    }
    return await typedPick(ctx, model, nowMs, offerAccount, shown);
}
/** How many answers in a row the typed prompt will refuse before it gives up. */
const MAX_MISSES = 10;
/** The typed prompt (§10.12 "The picker, typed"): re-asks on any token it does not understand, never applying part. */
async function typedPick(ctx, model, nowMs, offerAccount, shown) {
    const pre = preChange(model);
    let showAll = false;
    for (;;) {
        writeLines(ctx.stdout, renderTyped(model, { colour: ctx.colour, nowMs, showAll, offerAccount, headerPrinted: shown.header }));
        // FA4: the static block is printed once per run, so every later typed screen (after `g`, or `more`) starts at its rows.
        shown.header = true;
        let misses = 0;
        for (;;) {
            const answer = await askOrCancel(ctx, `  ${PICKER.promptMark}`);
            if (answer === null)
                return { kind: "cancel" };
            const parsed = parseTyped(answer, model, showAll, offerAccount);
            if (parsed.kind === "account")
                return { kind: "account" };
            if (parsed.kind === "more") {
                // `more` reprints with every repo shown and numbered afresh, then asks again. Nothing is chosen yet.
                // FD7 (review 2): the answer's line is the last thing on screen, so the reprint gets its one blank line here, and only here.
                writeLines(ctx.stdout, [""]);
                showAll = true;
                break;
            }
            if (parsed.kind === "error") {
                writeLines(ctx.stdout, notUnderstoodLines(parsed.tokens));
                // A prompt that re-asks without end is a hang for anything driving it (a closed input, a script). Ten misses in a
                // row is somebody who is not going to get there: treat it as the Ctrl+C it is, which changes nothing.
                misses += 1;
                if (misses >= MAX_MISSES)
                    return { kind: "cancel" };
                continue;
            }
            if (parsed.kind === "empty") {
                // Enter. A pre-selected repo (D34) is the one thing Enter leads to the y/N with; otherwise it changes nothing.
                return pre === null ? { kind: "none" } : { kind: "change", change: pre, noClone: new Set() };
            }
            return { kind: "change", change: parsed.change, noClone: new Set(parsed.noClone) };
        }
    }
}
/** How many repos an owner row covers HERE: the same count the owner row printed (`a1  all 2 repos here`), so they agree. */
function reposByOwner(model) {
    return new Map(model.owners.map((group) => [normalizeOwner(group.owner), group.repos.length]));
}
/**
 * CR-PRB T12 (4.11): the names as a change, with no checklist. An owner, or a repo, that is already on is reported (`<name> is
 * already on.`) and skipped while the rest proceed. A turned-off repo is turned back on. A name with no clone here is accepted and
 * flagged in the grant block. Nothing new gives `none`, so the run ends as Enter does (or finishes setup, 4.4a).
 */
function pickFromNames(ctx, model, names) {
    const read = readGrants(ctx.home);
    const grants = read.kind === "ok" ? read.grants : EMPTY_GRANTS;
    const cloneSlugs = new Set(model.onNow.filter((r) => r.kind === "clone").map((r) => r.key));
    const offSlugs = new Set(model.turnedOff.map((r) => r.slug));
    const knownOwners = new Set(model.owners.map((group) => normalizeOwner(group.owner)));
    const knownRepos = new Set(model.owners.flatMap((group) => group.repos.map((repo) => repo.slug)));
    const addOwners = new Set();
    const addRepos = new Set();
    const turnOn = new Set();
    const noClone = new Set();
    const alreadyOn = [];
    for (const name of names) {
        if (name.kind === "owner") {
            if (grants.owners.includes(name.key) || model.onNow.some((r) => r.kind === "owner" && r.key === name.key)) {
                alreadyOn.push(name.token);
                continue;
            }
            addOwners.add(name.key);
            if (!knownOwners.has(name.key))
                noClone.add(`${name.key}/`);
        }
        else if (offSlugs.has(name.key)) {
            turnOn.add(name.key);
        }
        else if (grants.repos.includes(name.key) || cloneSlugs.has(name.key) || grants.owners.includes(ownerOfSlug(name.key))) {
            alreadyOn.push(name.token);
        }
        else {
            addRepos.add(name.key);
            if (!knownRepos.has(name.key))
                noClone.add(name.key);
        }
    }
    if (alreadyOn.length > 0)
        writeLines(ctx.stdout, alreadyOn.map((token) => `  ${PICKER.namedAlreadyOn(token)}`));
    const change = {
        addOwners: [...addOwners],
        addRepos: [...addRepos].filter((slug) => ![...addOwners].includes(ownerOfSlug(slug))),
        turnOn: [...turnOn],
        stopOwners: [],
        stopRepos: [],
        stopClones: [],
    };
    if (!hasAdditions(change))
        return { kind: "none" };
    return { kind: "change", change, noClone: noClone };
}
/** The predicate's note for an ending (4.4a): branch (a), a repair, or nothing. */
function setupNote(setup) {
    if (setup.kind !== "checked")
        return null;
    if (setup.noCredential)
        return "unfinished";
    return setup.repair ? "repair" : null;
}
/**
 * The `pending_offer` entries an offer can still name (#5, ENG-26): a repo that is on, an owner still granted, a folder still granted.
 * A stale entry (revoked since the run that wrote it) is left out here; the offer step clears the whole list either way.
 */
function pendingStillGranted(ctx, model, pending) {
    if (pending.length === 0)
        return [];
    const read = readGrants(ctx.home);
    const grants = read.kind === "ok" ? read.grants : EMPTY_GRANTS;
    const on = onSlugs(ctx, model, NO_CHANGE);
    const folders = new Set(grantedFolders(ctx.home));
    return pending.filter((entry) => {
        if (entry.kind === "folder")
            return folders.has(entry.value);
        if (entry.kind === "owner")
            return grants.owners.includes(entry.value);
        return on(normalizeSlug(entry.value));
    });
}
/**
 * Is the current clone's commit hook missing (#9)? On the plugin channel that is not "setup unfinished" (4.4a), yet Enter in this clone
 * installs it, so Enter must not return "No changes" over it.
 */
function hereHookMissing(setup, here) {
    if (setup.kind !== "checked" || here === null || here.kind !== "repo")
        return false;
    return setup.commitHooks.some((f) => f.toplevel === here.toplevel && f.writable && f.state.kind === "off");
}
/** Does Enter with nothing new finish setup (2B)? Branch (a) or a repair holds. `unknown` writes nothing, so it does not. */
function setupNeedsRun(setup) {
    return setup.kind === "unknown" || (setup.kind === "checked" && (setup.noCredential || setup.repair));
}
/** The clones whose commit hook the predicate checks (4.4a): the clones of repos that are on, and this repo when it is on. */
function onToplevels(ctx, scanned, here) {
    const capture = machineCapture(ctx.home);
    const on = new Set(capture.kind === "on" ? capture.repoEntries.map((entry) => entry.key) : []);
    const isOn = (slug) => on.has(normalizeSlug(slug));
    // ⛔ #8 (4.4a): `repoEntries` leaves out a repo an OWNER grant covers (counted once, under the owner: machine_state.ts). Its clones are
    // admitted by the hooks' own test, `isCaptureAllowed`, so the predicate checks their commit hooks too.
    const owners = capture.kind === "on" ? capture.grants.owners : [];
    const admitted = (slug, toplevel) => isOn(slug) ||
        (owners.includes(ownerOfSlug(normalizeSlug(slug))) && isCaptureAllowed(ctx.home, resolveProjectKeys(toplevel), normalizeSlug(slug)));
    return [
        ...new Set([
            ...scanned.repos.flatMap((repo) => repo.clones.filter((clone) => admitted(repo.slug, clone.path)).map((clone) => clone.path)),
            ...(here !== null && here.kind === "repo" && admitted(here.slug, here.toplevel) ? [here.toplevel] : []),
        ]),
    ];
}
function scanCommitHooks(ctx, deps, scanned, here) {
    const toplevels = onToplevels(ctx, scanned, here);
    return { toplevels, findings: commitFindingsFor(toplevels, ctx.selfPath, deps.setup) };
}
/**
 * The one predicate result for this run (4.4a): grants on, the commit-hook findings probed in the scan beat, and the first sync's 401.
 * Injected probes (`deps.setup`) are for tests only.
 */
function pickerSetup(ctx, deps, probes, syncUnauthorized) {
    const capture = machineCapture(ctx.home);
    return setupState({
        home: ctx.home,
        env: ctx.env,
        selfPath: ctx.selfPath,
        grantsOn: capture.kind === "on",
        toplevels: probes.toplevels,
        syncUnauthorized,
        commitHooks: probes.findings,
    }, deps.setup);
}
/** What this run added, as `pending_offer` entries: owners, repos (including a re-include), and folders. */
function additionEntries(change) {
    return [
        ...change.addOwners.map((value) => ({ kind: "owner", value })),
        ...change.addRepos.map((value) => ({ kind: "repo", value })),
        ...change.turnOn.map((value) => ({ kind: "repo", value })),
        ...(change.addFolders ?? []).map((value) => ({ kind: "folder", value })),
    ];
}
/** The joining question's names as offer entries: `owner/` is an owner, anything else a repo. */
function joinedEntries(names) {
    return names.map((name) => (name.endsWith("/") ? { kind: "owner", value: name.slice(0, -1) } : { kind: "repo", value: name }));
}
/** Does one offer entry cover this repo? A repo by its slug, an owner by the owner of its slug. */
function entryNamesRepo(entry, slug) {
    if (entry.kind === "repo")
        return normalizeSlug(entry.value) === normalizeSlug(slug);
    if (entry.kind === "owner")
        return ownerOfSlug(normalizeSlug(slug)) === normalizeOwner(entry.value);
    return false;
}
/** Was this repo named by the joining question (an owner or a repo)? */
function joinedRepo(names, slug) {
    return joinedEntries(names).some((entry) => entryNamesRepo(entry, slug));
}
function applyChange(ctx, model, change, queueOps) {
    // ⛔ ENG-26 (4.4a, the B5 carry-over): this run's additions join `pending_offer` in the SAME atomic write as the grants, so a
    // kill cannot leave a grant the next run does not know to offer. A run with no additions passes no patch and keeps the key.
    const additions = additionEntries(change);
    const patch = additions.length > 0 ? { pending_offer: [...readPendingOffer(ctx.home), ...additions] } : undefined;
    updateGrants(ctx.home, (g) => {
        const owners = [...new Set([...g.owners.filter((o) => !change.stopOwners.includes(o)), ...change.addOwners])];
        const covered = (slug) => owners.includes(ownerOfSlug(slug));
        return {
            disclosed_at: hasAdditions(change) ? ctx.now().toISOString() : g.disclosed_at,
            owners,
            repos: [
                ...g.repos.filter((r) => !change.stopRepos.includes(r)),
                ...change.addRepos,
                ...change.turnOn.filter((slug) => !covered(slug)),
            ],
            // ⛔ Codex rvprb #2 (plan 3E, 4.8): a repo this change stops, and that an owner grant still covers after it (new in this change,
            // or already held), is EXCLUDED, the mechanism `off` uses, so the owner cannot re-admit it. `isCaptureAllowed` admits any repo an
            // owner covers unless a deny list names it. A stopped repo no owner covers needs no exclusion: removing its grant stops it (W8: an
            // exclusion there would also keep it off if its owner were granted later, which the stop never asked for).
            excluded: [
                ...g.excluded.filter((x) => !change.turnOn.includes(x)),
                ...change.stopRepos.filter((slug) => covered(slug) && !g.excluded.includes(slug)),
            ],
            refused: g.refused,
            // Slice 2: what the account is to hear, queued in the same write (the last word on each axis wins: `mergePending`).
            pending: queueOps ? mergePending(g.pending, changeOps(change, covered), ctx.now()) : g.pending,
            synced_at: g.synced_at,
        };
    }, patch);
    for (const slug of change.stopClones) {
        for (const row of model.onNow) {
            if (row.kind !== "clone" || row.key !== slug)
                continue;
            for (const commonDir of row.commonDirs)
                revokeProject(ctx.home, commonDir);
        }
    }
    // Folder grants are client-side only (R3): their own file, never queued for the account, which has no word for a path.
    for (const path of change.addFolders ?? [])
        grantFolder(ctx.home, path, ctx.now());
    // A removal is a decision, not a forgetting: the folder is turned OFF (and offered again), so `status` does not call it undecided.
    for (const path of change.stopFolders ?? [])
        excludeFolder(ctx.home, path, ctx.now());
}
/** Does the change stop anything? */
function hasStops(change) {
    return change.stopOwners.length + change.stopRepos.length + change.stopClones.length + (change.stopFolders ?? []).length > 0;
}
/** The change with its adds taken out: what a No still writes (3E). */
function stopsOnly(change) {
    return { ...change, addOwners: [], addRepos: [], turnOn: [], addFolders: [] };
}
/** The names a stop line lists: owners with `/`, repositories and clones by key, folders by their labels. */
function stopNames(change, labels) {
    return [
        ...change.stopOwners.map((owner) => `${owner}/`),
        ...change.stopRepos,
        ...change.stopClones,
        ...(change.stopFolders ?? []).map((path) => labels.get(path) ?? path),
    ].join(", ");
}
/** How every folder the picker knows is shown, so the grant block names a folder the way its row did. */
function folderLabels(model) {
    return new Map([
        ...model.folders.map((folder) => [folder.path, folder.label]),
        ...model.temporaryFolders.map((folder) => [folder.path, folder.label]),
        // ⛔ Codex rvprb3 F2: an expanded temporary folder is granted like a folder, so its label is here too (it fell back to the raw path).
        ...model.onNow.filter((row) => row.kind === "folder").map((row) => [row.key, row.label ?? row.key]),
    ]);
}
/** Is this slug on once `change` is applied? Reads the grants just written, and keeps the per-clone consents not withdrawn. */
function onSlugs(ctx, model, change) {
    const read = readGrants(ctx.home);
    const grants = read.kind === "ok" ? read.grants : EMPTY_GRANTS;
    const kept = new Set(model.onNow.filter((r) => r.kind === "clone" && !change.stopClones.includes(r.key)).map((r) => r.key));
    return (slug) => !grants.excluded.includes(slug) &&
        (grants.owners.includes(ownerOfSlug(slug)) || grants.repos.includes(slug) || kept.has(slug));
}
/** `~/code/x   core.hooksPath is set` — one exception row, the path cut from the left to leave the reason room (§13.4). */
function exceptionRow(ctx, path, reason) {
    const room = 80 - 4 - 3 - reason.length;
    return `    ${paint(ctx.colour, "muted", `${truncatePath(terminalSafe(tildePath(path, ctx.home)), room)}   ${reason}`)}`;
}
/**
 * The hooks step's install (T8b, 4.2), with no output: each clone's commit hook, and the exceptions the setup report prints under its
 * table (`hooksPath` and a failed write, each with its own fix, see `commitExceptionLines`). Never changes the exit code.
 */
function installCommitHooksForReport(ctx, clones) {
    let added = 0;
    let chained = 0;
    const skipped = [];
    for (const path of clones) {
        const verdict = installCaptureHooks(path, ctx.selfPath).commit;
        if (verdict.kind === "hooks-path")
            skipped.push({ path, reason: PICKER.hooksPathReason, hooksPath: true });
        else if (verdict.kind === "failed")
            skipped.push({ path, reason: PICKER.hooksFailedReason, hooksPath: false });
        else {
            added += 1;
            if (verdict.kind === "chained")
                chained += 1;
        }
    }
    return { report: { clones: added, chained }, blocks: skipped.length === 0 ? [] : [commitExceptionLines(ctx, skipped)], notes: [] };
}
/**
 * The exceptions block under the setup report's table: only the clones where hooks were not added, each with its path and reason. Each
 * exception gets its own fix and no other's: `core.hooksPath` the shipped unset/chain pair, a failed write `vibecommit connect`.
 */
function commitExceptionLines(ctx, skipped) {
    const hooksPathHit = skipped.some((s) => s.hooksPath);
    const failedHit = skipped.some((s) => !s.hooksPath);
    return [
        "",
        paint(ctx.colour, "warn", `  ${PICKER.hooksNotAdded(skipped.length)}`),
        ...skipped.map((s) => exceptionRow(ctx, s.path, s.reason)),
        ...wrap(hooksPathHit ? PICKER.hooksStillCaptured : PICKER.hooksStillCapturedOther, 2),
        ...(hooksPathHit
            ? [COMMIT_HOOK.hooksPathFixUnset, COMMIT_HOOK.hooksPathFixManual(channelCommand(ctx.env, ctx.selfPath, COMMANDS.postCommit))].map((fix) => `    ${paint(ctx.colour, "accent", fix)}`)
            : []),
        ...(failedHit
            ? [...wrap(PICKER.hooksFailedFixLabel, 2), `    ${paint(ctx.colour, "accent", connectCommandFor(ctx.env, ctx.selfPath))}`]
            : []),
    ];
}
/**
 * "Capture is on" (D18 · 12A, D19 · 13A): what is on, then the first proof to expect (§10.1 state 4). A new laptop whose
 * granted owner has no clone here gets its own block. ⛔ **No variant says "Nothing else to do"**: that line stays on the
 * 0.6.0 in-repo screen only.
 */
function captureOnBlock(ctx, model, change, noClones, 
/** What the joining-machine question (screen 2) named here, for the new-laptop line. */
joined = [], 
/** Muted lines under the block when the sync after the writes did not tell the account (`accountNoteLines`). */
untold = [], 
/** T8 (4.2, DX-13): the agents set up this run. The proof names only these; with none, there is no proof sentence. */
working = [], 
/** Codex rvprb3 F5: a clone here that this change adds is refused by the deny lists, so it exists: no "No clone of it is here yet". */
cloneDenied = false) {
    // What is on NOW, read back from disk after the write: the same counts `status` and `auth` give.
    const summary = machineSummary(machineCapture(ctx.home));
    if (noClones) {
        const names = [
            ...model.onNow.filter((r) => r.kind !== "folder" && !change.stopOwners.includes(r.key) && !change.stopRepos.includes(r.key) && !change.stopClones.includes(r.key)).map((r) => (r.kind === "owner" ? `${r.key}/` : r.key)),
            ...change.addOwners.map((o) => `${o}/`),
            ...change.addRepos,
            ...change.turnOn,
            ...joined,
        ];
        writeLines(ctx.stdout, [
            "",
            ...renderErrorBlock({
                kind: "ok",
                what: PICKER.onNewLaptop(names.length <= 3 ? names.join(", ") : summary),
                why: cloneDenied ? [] : [PICKER.onNewLaptopProof],
            }, ctx.colour),
            ...untold,
        ]);
        return;
    }
    writeLines(ctx.stdout, [
        "",
        ...renderErrorBlock({
            kind: "ok",
            what: PICKER.onFor(summary),
            why: proofWhy(working),
        }, ctx.colour),
        ...untold,
        ...wrap(`${PICKER.stopOne} ${channelCommand(ctx.env, ctx.selfPath, COMMANDS.off)}`, 2),
    ]);
}
/** The proof sentence for the agents set up this run (DX-13): none when none were set up, and Claude Code's line only when it is among them. */
function proofWhy(working) {
    if (working.length === 0)
        return [];
    return [AGENT_HOOKS.proof(workingNames(working.map(agentProofLabel)), working.includes("claude-code"))];
}
/** The agent's name in the proof sentence ("Claude Code, Codex or Cursor"). */
function agentProofLabel(id) {
    return id === "claude-code" ? "Claude Code" : id === "codex-cli" ? "Codex" : "Cursor";
}
//# sourceMappingURL=connect_picker.js.map