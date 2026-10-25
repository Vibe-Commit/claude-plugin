/**
 * The `connect` picker flow — style guide §10.12 (0.7.0, PR 3): scan → picker → disclosure → grant y/N → sign in → hooks →
 * (in a repo) the test capture → "Capture is on" or the held beat → backfill offer → URL.
 *
 * ⛔ LOADED LAZILY, AND THAT IS THE POINT OF THIS FILE BEING SEPARATE. `connect.ts` imports it with `await import(...)` at
 * the two call sites that reach the picker. `src/index.ts` statically imports every verb, so everything `connect.ts`
 * imports is loaded by EVERY process, a hook's included; the picker, its checklist and the scan engine are a person-at-a-
 * terminal feature and must not ride along on the hook's load path. (Measured: no timing difference at all in 120
 * interleaved starts, so this is for the principle and for the SIGTERM cell's sake, not for a number.)
 * The helpers it shares with the 0.6.0 flow are exported from `connect.ts`; the import is circular only at call time.
 */
import { dialectFor } from "../agents/registry.js";
import { AGENT_HOOKS, COMMANDS, COMMIT_HOOK, CONNECT, PICKER, SCAN, URLS } from "../copy/index.js";
import { EMPTY_GRANTS, GrantsUnreadableError, grantsUnreadable, isAffirmative, normalizeOwner, normalizeSlug, ownerOfSlug, readGrants, revokeProject, updateGrants, } from "../consent.js";
import { loadCredential } from "../credential.js";
import { EXIT } from "../exit.js";
import { mergePending } from "../grants_sync.js";
import { readAccountView, syncForVerb } from "../grants_verb.js";
import { channelCommand, connectCommandFor, installCaptureHooks } from "../install.js";
import { machineCapture, machineSummary, readPerClone } from "../machine_state.js";
import { buildModel, grantQuestion, hasAdditions, isNoChange, NO_CHANGE, notUnderstoodLines, parseTyped, preChange, renderGrantBlock, renderTyped, } from "../picker.js";
import { runChecklist } from "../picker_checklist.js";
import { credentialFingerprint } from "../post.js";
import { metaFor } from "../credential_meta.js";
import { paint, renderErrorBlock, tildePath, truncatePath, wrap } from "../term.js";
import { signInBeat } from "./browser_credential.js";
import { accountChange, accountNoteLines, changeOps, commitG, joiningMachine, lastAccountState, mintForG, settleG, splitAccountExclusions, } from "./connect_account.js";
import { agentHookBeat, approvalPending, approvalPendingBeat, askOrCancel, cancelled, disclosure, grantsUnreadableBlock, obtainCredential, sendTestCapture, tail, } from "./connect.js";
import { writeLines } from "./context.js";
import { pickerNotListedLines, sawNoSession, scanMachine } from "./scan.js";
/**
 * `connect` from any folder: scan → picker → disclosure → grant y/N → sign in → hooks → "Capture is on" → backfill offer
 * → URL (§10.12). At most three questions in a run (D7 · 3A): the grant, the workspace (inside the mint, only where
 * 0.6.0 already asks it) and the backfill (PR 5's seam).
 *
 * ⛔ **CONSENT STAYS AHEAD OF THE CREDENTIAL, and nothing before the grant opens a transcript.** The scan, the picker and
 * the offer read directory entries and four Codex index columns only. The grant is written BEFORE the sign-in, as the
 * per-clone consent always was.
 */
export async function connectPicker(ctx, options, deps, here, 
/** The working folder's keys, when it is a work tree: the in-repo path probes its session (VQ item 7). */
keys = null) {
    // ⛔ ONE `finally` FOR `g` (VQ + VT, #88): whatever way a run that holds a credential `g` made ends without committing it — a no,
    // Ctrl+C, Enter, an empty account, a removals-only yes, a failed write, an unexpected throw — it makes one best-effort revoke and
    // clears its write-ahead row. Nothing else revokes: the branches below only SAY how the run ended (`g.end`).
    const g = { credential: null, snapshot: null, origin: "", notes: [], committed: false, end: null };
    try {
        return await connectPickerRun(ctx, options, deps, here, keys, g);
    }
    finally {
        await settleG(ctx, deps, g);
    }
}
async function connectPickerRun(ctx, options, deps, here, keys, g) {
    if (grantsUnreadable(ctx.home)) {
        writeLines(ctx.stderr, grantsUnreadableBlock(ctx));
        return EXIT.failure;
    }
    // ⛔ THE NON-TTY REFUSAL COMES BEFORE THE SCAN (VQ + VT, PR 6 item 6): "Nothing was read and nothing was uploaded" stays
    // literally true, and a CI job that pipes `connect` never walks the filesystem. The disclosure still prints first
    // (CR-117), under the picker heading. It names the folder to run it in when `connect` runs INSIDE a repo (`here.kind === "repo"`,
    // the folder `connectPicker` was already given, never one the scan found), cut from the left as the `local:` refusal does; from a
    // folder that is not a repo, and from `$HOME` (a dotfiles repo there is `kind: "folder"` and the run is machine-level), it names none.
    if (!ctx.stdinIsTty) {
        writeLines(ctx.stdout, disclosure(ctx, true));
        writeLines(ctx.stderr, renderErrorBlock({
            kind: "bad",
            code: "CONSENT_NEEDS_TTY",
            what: CONNECT.pickerNonInteractiveWhat,
            why: [CONNECT.pickerNonInteractiveWhy],
            fixLabel: here !== null && here.kind === "repo"
                ? CONNECT.nonInteractiveFix(truncatePath(tildePath(here.toplevel, ctx.home), 46))
                : CONNECT.pickerNonInteractiveFix,
            fixes: [connectCommandFor(ctx.env, ctx.selfPath)],
        }, ctx.colour));
        return EXIT.usage;
    }
    // D17: one static beat line, overwritten once with `done` on a terminal. `ctx.colour` is false with no terminal and under
    // NO_COLOR, where it prints plainly with no overwrite. No spinner (§13.8): the bytes are the same at any speed.
    const beat = `  ${SCAN.beat}`;
    if (ctx.colour)
        ctx.stdout.write(`\n${beat}`);
    const scanned = (deps.scan ?? scanMachine)(ctx.home, ctx.env);
    ctx.stdout.write(ctx.colour ? `\r${beat}   ${SCAN.beatDone}\n` : `\n${beat}   ${SCAN.beatDone}\n`);
    // ⛔ SLICE 2 (S4 part 3). `deps.account` is the account's network; left out, `connect` talks to nobody about grants and behaves as
    // 0.7.0 did. A machine that ALREADY has a credential syncs first, before the model is built, so the "on your account" group is
    // what the server last said; a machine without one has no account to read until it signs in (`g` is how it asks).
    const account = deps.account ?? null;
    const loaded = loadCredential({ env: ctx.env, home: ctx.home });
    const credentialAtStart = loaded.kind === "ok";
    // The first-sync line is said once per run: if this one prints it, the sync after the writes does not.
    let firstSyncSaid = false;
    if (account !== null && credentialAtStart) {
        const first = await syncForVerb(ctx, false, account);
        firstSyncSaid = first.kind === "ran" && first.disclosed === true;
    }
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
    });
    // ⛔ `g` IS OFFERED ONLY WHERE THE CREDENTIAL BEAT WOULD MINT (exception 3): no credential at all (an `absent` file, not a faulty
    // one), a terminal, and a browser to sign in with. The `auth` chain passes no browser and always leaves a credential, so it can
    // never reach this; the same gate as `obtainCredential`'s keeps the two in step.
    const offerAccount = account !== null && loaded.kind === "absent" && ctx.stdinIsTty && deps.browser !== undefined;
    let pick = await choose(ctx, options, deps, model, offerAccount);
    /** The grant block's heading and the repos `g` named, when the list is the account's own. */
    let accountList = null;
    if (pick.kind === "account" && account !== null) {
        const minted = await mintForG(ctx, options, deps, account);
        if (minted.kind === "exit")
            return minted.code;
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
            ]);
            pick = await choose(ctx, options, deps, model, false);
        }
        else {
            const known = new Set(model.owners.flatMap((group) => group.repos.map((repo) => repo.slug)));
            accountList = { noClone: new Set(change.addRepos.filter((slug) => !known.has(slug))) };
            pick = { kind: "change", change, noClone: accountList.noClone };
        }
    }
    /** Nothing was granted: say how the run ended. With a credential `g` made, `settleG` (the `finally`) revokes it and prints the line. */
    const abandon = (ctrlC) => {
        if (g.credential === null)
            return ctrlC ? cancelled(ctx) : EXIT.ok;
        g.end = ctrlC ? "cancelled" : "declined";
        return ctrlC ? EXIT.failure : EXIT.ok;
    };
    if (pick.kind === "cancel" || pick.kind === "account")
        return abandon(true);
    if (pick.kind === "none" || isNoChange(pick.change)) {
        // Enter is "change nothing" (D5): no grant, no credential, and a completed consent flow (§13.7).
        const on = machineCapture(ctx.home);
        const line = on.kind === "on" ? PICKER.noChanges(machineSummary(on)) : PICKER.nothingGranted(connectCommandFor(ctx.env, ctx.selfPath));
        writeLines(ctx.stdout, ["", ...wrap(line, 2)]);
        return abandon(false);
    }
    // A repo the ACCOUNT turned off, picked as an ordinary add, is a re-include: it gets its own `turn on` row (the yes wins).
    const accountState = account !== null && accountList === null ? lastAccountState(ctx.home) : null;
    const split = splitAccountExclusions(pick.change, accountState === null ? [] : accountState.excluded);
    const change = split.change;
    // One disclosure and one y/N cover additions and removals together, and a No changes nothing. Removals alone skip the
    // disclosure and ask the stop question (§10.12 "The grant y/N").
    const facts = { reposHere: reposByOwner(model), noClone: pick.noClone, accountOff: split.accountOff };
    writeLines(ctx.stdout, hasAdditions(change) ? ["", ...disclosure(ctx, true)] : [""]);
    writeLines(ctx.stdout, renderGrantBlock(change, facts, ctx.colour, accountList === null ? PICKER.chose : PICKER.accountGrants));
    const answer = await askOrCancel(ctx, grantQuestion(change, ctx.colour, CONNECT.consentAnswers));
    if (answer === null)
        return abandon(true);
    if (!isAffirmative(answer)) {
        if (g.credential === null)
            writeLines(ctx.stdout, ["", ...wrap(CONNECT.declined, 2)]);
        return abandon(false);
    }
    // The ops the account is to hear about go into the SAME write as the grants: one `updateGrants`, so a crash cannot leave one
    // without the other. The account's own list (`g`) is already on the account and needs none.
    const queueOps = account !== null && accountList === null;
    try {
        applyChange(ctx, model, change, queueOps);
    }
    catch (error) {
        if (!(error instanceof GrantsUnreadableError))
            throw error;
        // Raced with an edit of `grants.json` since the check above. Nothing was written.
        writeLines(ctx.stderr, grantsUnreadableBlock(ctx));
        return EXIT.failure;
    }
    if (!hasAdditions(change)) {
        writeLines(ctx.stdout, ["", ...wrap(PICKER.stopped, 2)]);
        // Removals reach the account too; nothing more to say about it.
        if (queueOps && credentialAtStart)
            await syncForVerb(ctx, false, account, { quietFirst: firstSyncSaid });
        // A removals-only yes grants nothing: a credential `g` is holding is not kept (`settleG` revokes it).
        return abandon(false);
    }
    if (options.signIn === true) {
        const code = await signInBeat(ctx, { retry: "sign-in", verify: true, ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }) });
        if (code !== EXIT.ok)
            return code;
    }
    // ⛔ THE COMMIT, in this order: the grants (written above), then `credentials.json`, then the write-ahead row's deletion.
    const committed = g.credential === null ? "committed" : commitG(ctx, g);
    if (committed !== "committed") {
        // The row was settled by another command, or a concurrent mint holds credentials.json: nothing is saved, the finally revokes the
        // token held in memory, the grants already written stay, and the exit is 1 — never the exit-3 "connected over a dead credential".
        g.end = committed;
        return EXIT.failure;
    }
    const got = await obtainCredential(ctx, deps, options, "repos");
    if (got.kind === "exit")
        return got.code;
    // The credential exists now. A machine that had none was just minted one (by the beat above, or by `g`): its first sync is the
    // moment the server learns what this machine named; one that already had one syncs again only if this run queued something.
    const minted = !credentialAtStart;
    let joined = [];
    /** What the sync after the writes answered, or `null` when none was needed. A sync that did not tell the account is said under "Capture is on". */
    let accountSync = null;
    /** Ctrl+C at the joining question: a No, and nothing more is asked (the backfill offer below is a question). */
    let askedNoMore = false;
    if (account !== null) {
        if (minted || queueOps) {
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
    // L11: the hooks print first. Commit hooks for every clone found of what is now on, then the agent hooks.
    const on = onSlugs(ctx, model, change);
    const onRepos = scanned.repos.filter((repo) => on(normalizeSlug(repo.slug)));
    const clones = [
        ...new Set([
            ...onRepos.flatMap((repo) => repo.clones.map((clone) => clone.path)),
            ...(here !== null && here.kind === "repo" && on(normalizeSlug(here.slug)) ? [here.toplevel] : []),
        ]),
    ];
    commitHooksStep(ctx, clones);
    agentHookBeat(ctx);
    // ⛔ IN A REPO, THE TEST CAPTURE RUNS BEFORE "Capture is on", AND ITS OUTCOME PICKS THE ENDING (VQ item 7, adopting VT).
    // 0.6.0's payoff was evidence — this session, recorded, with a link — and "Capture is on" printed ahead of a result that
    // can contradict it (an org that has not approved capture) would say the opposite of what happens next. So: hooks
    // (L11), then the probe inside ONE hook budget (the same call the `local:` path makes), then either the held beat or
    // "Capture is on" with the session link as the one URL line. From `~` there is no session to probe and nothing changes.
    let probe = null;
    if (keys !== null && here !== null && here.kind === "repo" && on(normalizeSlug(here.slug))) {
        const { hasLocator, found } = locateTranscript(ctx, keys.worktree);
        const { delivery } = hasLocator && found === null
            ? { delivery: null }
            : await sendTestCapture(ctx, keys, got.credential, found);
        probe = { hasLocator, found, delivery };
        const pending = approvalPending(delivery);
        if (pending !== null) {
            // `capture_not_approved` for THIS repo (CR-110, D81): armed, waiting on an owner. Never "Capture is on" over it, and no
            // offer to upload more into a refusal. `deliver` has recorded it, so `status` says the same.
            approvalPendingBeat(ctx, keys.worktree, pending.ownersNotified);
            return tail(ctx, got.unconfirmed);
        }
    }
    // D18 · D19: "Capture is on" before the optional upload, so it is on screen within seconds of the sign-in.
    // The block cannot know whether an organization has approved capture for a repo it did not probe: it says one may need to,
    // when a granted owner is not the person's own account. In a repo the owner the test capture CHECKED is left out.
    const checkedOwner = probe !== null && here !== null && answeredWith2xx(probe.delivery) ? ownerOfSlug(normalizeSlug(here.slug)) : null;
    captureOnBlock(ctx, model, change, clones.length === 0, otherOwnersCaveat(ctx, got.credential, checkedOwner), joined, accountNoteLines(ctx, accountSync));
    // The backfill offer. Left out (`deps.backfill`), no offer is made and the ending is the one after a no. The URL follows
    // what LANDED (D19): the conversations list once at least one session was uploaded, whether the run finished or stopped.
    let url = probeUrl(probe);
    if (deps.backfill !== undefined && onRepos.length > 0 && !askedNoMore) {
        const outcome = await deps.backfill(ctx, onRepos);
        if (outcome.kind !== "declined" && outcome.uploaded > 0)
            url = URLS.conversations;
    }
    writeLines(ctx.stdout, ["", `  ${paint(ctx.colour, "accent", url)}`]);
    return tail(ctx, got.unconfirmed);
}
/** Where the current session's transcript is, per the dialect's locator: `hasLocator` is false for an agent that has none. */
function locateTranscript(ctx, projectKey) {
    const locate = dialectFor(ctx.agentId).locateCurrentTranscript;
    return { hasLocator: locate !== undefined, found: locate === undefined ? null : locate(ctx.home, ctx.env, projectKey) };
}
/** Did the server answer any delta of the test capture with a 2xx? (`ok`, or a `later` that carries delta 1's session id.) */
function answeredWith2xx(delivery) {
    return delivery?.kind === "attempted" && (delivery.disposition === "ok" || delivery.conversationId !== undefined);
}
/**
 * Does any granted owner differ from the signed-in person's own GitHub handle? (Alexander, 2026-10-24: "Caveat for other
 * owners".) Compared case-insensitively over the owners granted whole AND the owners of repos granted one by one; an `account`
 * the server did not give (`null`) cannot be shown to match, so it counts as differing. Nothing granted, nothing to caveat.
 * `account` is whatever the whoami probe or the mint recorded for this credential, so it is known by the time the block prints.
 *
 * ⛔ **IN A REPO, THE CHECKED OWNER DOES NOT COUNT** (Alexander, 17:20). "Checked" means the server answered ANY delta of the
 * test capture with a 2xx — the delivery is `ok`, or it carries a `conversationId` (after PR 4a a big session can get a 2xx on
 * delta 1 and a timeout on delta 2, which combines to `later` with delta 1's id; a 2xx proves the org approved). Every other
 * outcome — no transcript, a `later`, a network loss — leaves this repo's owner unchecked, and it counts like any other.
 */
function otherOwnersCaveat(ctx, credential, checkedOwner) {
    const on = machineCapture(ctx.home);
    if (on.kind !== "on")
        return false;
    // The owner of the repo the test capture just checked is not "another owner": the server answered for it (see `checkedOwner`).
    const skip = checkedOwner === null ? null : checkedOwner.toLowerCase();
    const owners = [...on.grants.owners, ...on.grants.repos.map(ownerOfSlug)].filter((o) => o !== "" && o.toLowerCase() !== skip);
    if (owners.length === 0)
        return false;
    const account = metaFor(ctx.home, credentialFingerprint(credential))?.account ?? null;
    if (account === null)
        return true;
    const own = account.toLowerCase();
    return owners.some((owner) => owner.toLowerCase() !== own);
}
/**
 * The one URL line after "Capture is on". From `~` (no probe) it is the dashboard, as after a no. In a repo it is the
 * recorded session's own page when the 2xx carried its id (`DX D8`); the captures list where 0.6.0 falls back to it (a
 * delivery with no id, an agent with no locator); and the dashboard when there was no transcript to link.
 */
function probeUrl(probe) {
    if (probe === null)
        return URLS.dashboard;
    if (probe.hasLocator && probe.found === null)
        return URLS.dashboard;
    const id = probe.delivery?.kind === "attempted" ? probe.delivery.conversationId : undefined;
    return id === undefined ? URLS.commits : URLS.conversation(id);
}
/** The checklist when a person is driving a real terminal (D28); the typed prompt otherwise. */
function useChecklist(ctx, options, model) {
    if (options.typed === true || !ctx.stdinIsTty)
        return false;
    const out = ctx.stdout;
    if (out.isTTY !== true || ctx.env.TERM === "dumb")
        return false;
    // The frame is erased by line count, so a terminal narrower than the frame (which soft-wraps) would leave debris. A width
    // of 0 or none is a terminal that does not say, which is not a narrow one.
    if (out.columns !== undefined && out.columns > 0 && out.columns < 80)
        return false;
    return model.onNow.length + model.owners.length + model.account.length + model.turnedOff.length > 0;
}
async function choose(ctx, options, deps, model, 
/** Slice 2: `g` is a choice here (screen 1a). */
offerAccount) {
    const nowMs = ctx.now().getTime();
    if (useChecklist(ctx, options, model)) {
        const result = await runChecklist(model, { colour: ctx.colour, nowMs, typedCommand: channelCommand(ctx.env, ctx.selfPath, COMMANDS.connectTyped), offerAccount }, { input: deps.checklist?.input ?? process.stdin, output: ctx.stdout, ...deps.checklist });
        if (result.kind === "cancel")
            return { kind: "cancel" };
        if (result.kind === "account")
            return { kind: "account" };
        if (result.kind === "done")
            return { kind: "change", change: result.change, noClone: new Set() };
        // `t`: the typed prompt, from the same model.
    }
    return await typedPick(ctx, model, nowMs, offerAccount);
}
/** How many answers in a row the typed prompt will refuse before it gives up. */
const MAX_MISSES = 10;
/** The typed prompt (§10.12 "The picker, typed"): re-asks on any token it does not understand, never applying part. */
async function typedPick(ctx, model, nowMs, offerAccount) {
    const pre = preChange(model);
    let showAll = false;
    for (;;) {
        writeLines(ctx.stdout, renderTyped(model, { colour: ctx.colour, nowMs, showAll, offerAccount }));
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
 * Write the change. `grants.json` first (atomic, and it THROWS rather than overwrite a file it cannot read), then the
 * per-clone consents a removal withdraws. A turned-off repo that is chosen again is re-included here: removing it from
 * `excluded` is the exclusion lifting, and only this yes does it (`off`'s contract). It joins `repos` unless an owner
 * grant already covers it.
 */
function applyChange(ctx, model, change, queueOps) {
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
            excluded: g.excluded.filter((x) => !change.turnOn.includes(x)),
            refused: g.refused,
            // Slice 2: what the account is to hear, queued in the same write (the last word on each axis wins: `mergePending`).
            pending: queueOps ? mergePending(g.pending, changeOps(change, covered), ctx.now()) : g.pending,
            synced_at: g.synced_at,
        };
    });
    for (const slug of change.stopClones) {
        for (const row of model.onNow) {
            if (row.kind !== "clone" || row.key !== slug)
                continue;
            for (const commonDir of row.commonDirs)
                revokeProject(ctx.home, commonDir);
        }
    }
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
    return `    ${paint(ctx.colour, "muted", `${truncatePath(tildePath(path, ctx.home), room)}   ${reason}`)}`;
}
/**
 * The hooks step (D13 · 7A): one beat line with a count, then an exceptions block naming ONLY the clones where hooks were
 * not added, each with its path and reason, the fix last. `connect` runs with the user watching, so it chains a clone's
 * existing hook (kept, runs first) and counts it as added. The only skip is `core.hooksPath`; a failed write is listed too.
 * ⚠ Never changes the exit code, for `commitHookBeat`'s reason.
 */
function commitHooksStep(ctx, clones) {
    if (clones.length === 0)
        return;
    const beat = `  ${PICKER.hooksBeat(clones.length)}`;
    if (ctx.colour)
        ctx.stdout.write(`\n${beat}`);
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
    const done = `${beat.padEnd(45)}   ${PICKER.hooksDone}`;
    ctx.stdout.write(ctx.colour ? `\r${done}\n` : `\n${done}\n`);
    writeLines(ctx.stdout, [`    ${paint(ctx.colour, "muted", PICKER.hooksCount(added, chained, skipped.length))}`]);
    if (skipped.length === 0)
        return;
    // ⛔ EACH EXCEPTION GETS ITS OWN FIX, and only its own: `core.hooksPath` gets the shipped unset/chain pair, a write that
    // failed gets `vibecommit connect` (run in that clone, it adds the hook with the person watching), and neither is
    // shown the other's. Session capture is unaffected by either, so that is said once.
    const hooksPathHit = skipped.some((s) => s.hooksPath);
    const failedHit = skipped.some((s) => !s.hooksPath);
    writeLines(ctx.stdout, [
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
    ]);
}
/**
 * "Capture is on" (D18 · 12A, D19 · 13A): what is on, then the first proof to expect (§10.1 state 4). A new laptop whose
 * granted owner has no clone here gets its own block. ⛔ **No variant says "Nothing else to do"**: that line stays on the
 * 0.6.0 in-repo screen only.
 */
function captureOnBlock(ctx, model, change, noClones, 
/** The "other owners" caveat, for owners the test capture did not check: see `otherOwnersCaveat`. */
caveat, 
/** What the joining-machine question (screen 2) named here, for the new-laptop line. */
joined = [], 
/** Muted lines under the block when the sync after the writes did not tell the account (`accountNoteLines`). */
untold = []) {
    // What is on NOW, read back from disk after the write: the same counts `status` and `auth` give.
    const summary = machineSummary(machineCapture(ctx.home));
    if (noClones) {
        const names = [
            ...model.onNow.filter((r) => !change.stopOwners.includes(r.key) && !change.stopRepos.includes(r.key) && !change.stopClones.includes(r.key)).map((r) => (r.kind === "owner" ? `${r.key}/` : r.key)),
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
                why: [PICKER.onNewLaptopProof, AGENT_HOOKS.codexTrust, ...(caveat ? [PICKER.ownerApproval(channelCommand(ctx.env, ctx.selfPath, COMMANDS.status))] : [])],
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
            why: [PICKER.onProof, AGENT_HOOKS.codexTrust, ...(caveat ? [PICKER.ownerApproval(channelCommand(ctx.env, ctx.selfPath, COMMANDS.status))] : [])],
        }, ctx.colour),
        ...untold,
        ...wrap(`${PICKER.stopOne} ${channelCommand(ctx.env, ctx.selfPath, COMMANDS.off)}`, 2),
    ]);
}
//# sourceMappingURL=connect_picker.js.map