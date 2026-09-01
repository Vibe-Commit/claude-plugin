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
 * `CR-084d` lands the browser sign-in beat (PKCE loopback → a user-principal
 * token for the READ lane) behind `--sign-in`. It is opt-in and not part of the
 * default install for one reason: **sign-in does not produce an ingest
 * credential**, so it cannot replace the beat below. No route in
 * `vibecommit-mcp` mints a `vcik_` — `mintIngestCredential` exists and has no
 * call site outside that repo's own tests — so `VIBECOMMIT_TOKEN` remains the
 * supported path for capture, exactly as before.
 *
 * @provenance vibecommit-mcp src/oauth/ingest_credential.ts — no route mints one, verified
 */
import { CONNECT, COMMANDS, COMMIT_HOOK, ERRORS, HELP, PATH_CLASH, RUNTIME, SIGNIN, URLS, } from "../copy/index.js";
import { dialectFor } from "../agents/registry.js";
import { grantProject, isAffirmative, isProjectAllowed } from "../consent.js";
import { loadCredential } from "../credential.js";
import { EXIT } from "../exit.js";
import { resolveRepoSlug } from "../git.js";
import { confinementRoots, readSpan, DEFAULT_HOOK_BUDGET_MS } from "../hooks/entry.js";
import { classifyInstall, installPostCommitHook } from "../install.js";
import { mcpUrl } from "../oauth/discovery.js";
import { loadSession } from "../oauth/session.js";
import { openBrowser, signIn } from "../oauth/signin.js";
import { CAPTURE_NOT_APPROVED, deliver, ingestUrl, } from "../post.js";
import { resolveProjectKeys } from "../project.js";
import { meetsNodeFloor, NODE_FLOOR_TEXT } from "../runtime.js";
import { paint, renderErrorBlock, truncatePath, wrap } from "../term.js";
import { writeLines } from "./context.js";
export async function connect(ctx, options = {}) {
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
    // (2) BOTH KEYS (`D184 §1`). Outside a work tree there is nothing to consent
    // ABOUT, and inventing a key from cwd would grant consent to something the
    // user cannot see in `status`.
    //
    // ⛔ THE GRANT BELOW IS THE ONLY WRITER OF THE ALLOW LIST, so this verb decides
    // what every gate can ever match. It writes `keys.consent` — the git common
    // dir — which is what admits the worktrees of this clone as well as the clone
    // itself. Granting the toplevel here while `entry.ts` and `post_commit.ts`
    // check the common dir is a TOTAL, SILENT capture outage in every repository
    // (`D184 §9`), and no cell that grants and checks through one helper can see
    // it.
    const keys = resolveProjectKeys(ctx.cwd);
    if (keys === null) {
        writeLines(ctx.stderr, renderErrorBlock({ kind: "bad", what: ERRORS.notAGitRepo, why: [] }, ctx.colour));
        return EXIT.failure;
    }
    if (isProjectAllowed(ctx.home, keys.consent)) {
        writeLines(ctx.stdout, wrap(CONNECT.alreadyConnected, 2));
        return await afterConsent(ctx, keys, options);
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
    grantProject(ctx.home, keys.consent, ctx.now());
    return await afterConsent(ctx, keys, options);
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
async function afterConsent(ctx, keys, options) {
    if (options.signIn === true) {
        const code = await signInBeat(ctx);
        if (code !== EXIT.ok)
            return code;
    }
    return await credentialBeat(ctx, keys);
}
/**
 * The browser sign-in beat — `CR-084d`.
 *
 * Reachable only behind `--sign-in`. That is deliberate and not timidity: an
 * unconditional beat here would open a browser during every `connect`, including
 * the ones run by a wrapper, and sign-in cannot mint the credential the rest of
 * `connect` is about. When a read verb lands (`why` — `CR-086`; `report` —
 * `CR-108`) it calls `readWithSession`, which drives the same session and needs
 * no beat here at all.
 */
async function signInBeat(ctx) {
    if (loadSession(ctx.home).kind === "ok") {
        writeLines(ctx.stdout, wrap(SIGNIN.alreadySignedIn, 2));
        return EXIT.ok;
    }
    const endpoint = mcpUrl(ctx.env);
    if (endpoint === null) {
        writeLines(ctx.stderr, signInError(ctx, SIGNIN.noServerWhat, SIGNIN.noServerRefusedWhy));
        return EXIT.failure;
    }
    const outcome = await signIn({
        home: ctx.home,
        mcpEndpoint: endpoint,
        fetch,
        nowMs: () => ctx.now().getTime(),
        openBrowser,
        onAuthorizeUrl: (url, opened) => {
            writeLines(ctx.stdout, [
                "",
                ...wrap(opened ? SIGNIN.opening : SIGNIN.manualLabel, 2),
                // `accent` on a URL is §13.1's one exception, and the line carries no
                // second colour. Printed on BOTH paths: a user who wants to open it in a
                // different browser than the default should not have to guess it.
                `  ${paint(ctx.colour, "accent", url)}`,
                ...(opened ? wrap(SIGNIN.waiting, 2) : []),
            ]);
        },
        page: { done: SIGNIN.browserDone, refused: SIGNIN.browserRefused },
    });
    if (outcome.kind === "ok") {
        writeLines(ctx.stdout, ["", ...wrap(SIGNIN.done, 2)]);
        return EXIT.ok;
    }
    writeLines(ctx.stderr, ["", ...signInFailure(ctx, outcome)]);
    return EXIT.failure;
}
/** §13.6's shape for a sign-in failure. One renderer, six outcomes. */
function signInFailure(ctx, outcome) {
    switch (outcome.kind) {
        case "no-server":
            return signInError(ctx, SIGNIN.noServerWhat, outcome.detail === "unreachable"
                ? SIGNIN.noServerUnreachableWhy
                : SIGNIN.noServerMalformedWhy, SIGNIN.noServerFix);
        case "denied":
            return signInError(ctx, SIGNIN.deniedWhat, SIGNIN.deniedWhy, SIGNIN.deniedFix);
        case "timeout":
            return signInError(ctx, SIGNIN.timeoutWhat, SIGNIN.timeoutWhy, SIGNIN.timeoutFix);
        case "rejected":
            return signInError(ctx, SIGNIN.rejectedWhat, SIGNIN.rejectedWhy, SIGNIN.rejectedFix);
        case "unreachable":
            return signInError(ctx, SIGNIN.unreachableWhat, SIGNIN.unreachableWhy, SIGNIN.unreachableFix);
        case "malformed":
            return signInError(ctx, SIGNIN.malformedWhat, SIGNIN.malformedWhy, SIGNIN.malformedFix);
    }
}
function signInError(ctx, what, why, fixLabel = SIGNIN.noServerFix) {
    return renderErrorBlock({ kind: "bad", what, why: [why], fixLabel, fixes: [COMMANDS.signIn] }, ctx.colour);
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
function disclosure(ctx) {
    // §10.2 aligns the two link URLs in one column. The width is DERIVED from the
    // labels rather than hardcoded, so editing a label cannot silently break the
    // alignment — and the four trailing spaces are the gutter the guide draws.
    const gutter = Math.max(CONNECT.consentDocsLabel.length, CONNECT.consentBundleLabel.length) + 4;
    return [
        ...wrap(CONNECT.consentHeading, 2),
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
async function credentialBeat(ctx, keys) {
    const load = loadCredential({ env: ctx.env, home: ctx.home });
    if (load.kind === "ok") {
        return await captureBeat(ctx, keys, load.credential);
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
async function captureBeat(ctx, keys, credential) {
    // ⚠ EVERY USE BELOW BUT ONE IS THE TOPLEVEL ROLE — locating the transcript,
    // the `repoKey` binding, the slug, the hook install and the copy the user
    // reads. The exception is the redaction root set at `readSpan`, which takes
    // BOTH keys through `confinementRoots`. Aliased rather than renamed
    // throughout, so the diff shows the line whose ROLE changed and not fourteen
    // that did not.
    const projectKey = keys.worktree;
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
            nowMs: ctx.now().getTime(),
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
        (from, to) => readSpan(found.path, from, to, confinementRoots(keys), ctx.home, ctx.env));
    }
    // THE FIFTH BEAT — `CR-110`, D65 §DR6, D81.
    //
    // ⚠ ONE outcome is branched on, identified by its ERROR CODE. The general rule
    // below still stands: `later` and `never` are transient or per-payload (D58)
    // and the offset holds, so a 503 must still print the ordinary ending.
    const pending = approvalPending(delivery);
    if (pending !== null)
        return approvalPendingBeat(ctx, projectKey, pending.ownersNotified);
    // The beat, then the URL on its own line, then what-now. Every OTHER outcome
    // of the send is deliberately not branched on: telling a user their install
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
    // ⛔ COMMIT CAPTURE IS INSTALLED AND REPORTED HERE (`CR-170`, D154). Three of
    // its failure modes are silent no-ops, so every outcome prints — including
    // success, which is the only place the PER-CLONE cost can be stated at a
    // moment the user can act on it.
    commitHookBeat(ctx, projectKey);
    return pathClash(ctx);
}
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
                fixes: [COMMIT_HOOK.hooksPathFixUnset, COMMIT_HOOK.hooksPathFixManual],
            }, ctx.colour),
        ]);
        return;
    }
    const line = outcome.kind === "installed"
        ? COMMIT_HOOK.installed(repo)
        : outcome.kind === "chained"
            ? COMMIT_HOOK.chained(repo)
            : COMMIT_HOOK.already;
    writeLines(ctx.stdout, ["", ...wrap(line, 2), ...wrap(COMMIT_HOOK.perClone, 2)]);
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
function approvalPending(delivery) {
    if (delivery === null || delivery.kind !== "attempted")
        return null;
    if (delivery.detail?.code !== CAPTURE_NOT_APPROVED)
        return null;
    return { ownersNotified: delivery.detail.ownersNotified ?? null };
}
/**
 * The fifth beat — style guide §10.2, D65 §DR6, D81.
 *
 * ⚠ `warn`, never `bad`. ⚠ **`EXIT.ok`, never `EXIT.failure` and never
 * `EXIT.notConnected`** — the user is correctly installed and capture is armed.
 * That 403 means *later*, not *failed*: `policy.ts` classes it `later`, so the
 * offset holds and the backlog uploads in order once an owner approves. A red
 * exit here tells a correctly-installed user they broke something.
 */
function approvalPendingBeat(ctx, projectKey, ownersNotified) {
    // ⚠ THE SHARED CLAUSE FIRST, THE NOTIFICATION SECOND — it ADDS, it does not
    // replace (D81). Composed here rather than as two independent paragraphs, so
    // the branches cannot drift apart: there is exactly one place the
    // recorded-request sentence exists.
    //
    // ⚠ AND `null` NEVER REACHES THE NOTIFICATION CLAUSE. `null` = not
    // determinable, `0` = determinable and nobody was told; both render the
    // recorded-go-ask branch alone. The owner genuinely is not emailed until
    // `CR-036`, which is provisioning-blocked — disclosed, not concealed.
    const why = ownersNotified !== null && ownersNotified > 0
        ? `${CONNECT.pendingRecorded} ${CONNECT.pendingNotified(ownersNotified)}`
        : CONNECT.pendingRecorded;
    // ⚠ STDOUT, not stderr, and the rule is consistent in this file: stderr
    // accompanies a NON-ZERO exit here (`credentialBeat` → 3, `noTranscript` → 1,
    // `pathClash` → 1, the sign-in failures → 1). This beat exits 0, so it is the
    // install's OUTCOME rather than a diagnostic — and §10.2 draws it as one
    // screen, which `2>/dev/null` would otherwise cut in half, leaving "Capture is
    // armed" with the reason stripped off it.
    writeLines(ctx.stdout, [
        "",
        ...renderErrorBlock({
            kind: "warn",
            what: CONNECT.pendingWhat,
            why: [CONNECT.pendingWhy(resolveRepoSlug(projectKey)), why, CONNECT.pendingBuffered],
            fixLabel: CONNECT.pendingTrackLabel,
            fixes: [URLS.captureAccess],
        }, ctx.colour),
        "",
        ...wrap(CONNECT.pendingArmed(truncatePath(projectKey, 52)), 2),
    ]);
    // The PATH clash still runs — it is about the verbs a human types and is
    // orthogonal to whether capture is approved. It can still exit 1.
    return pathClash(ctx);
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