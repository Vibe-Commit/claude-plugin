/**
 * The copy catalogue — CR-090 precondition (1).
 *
 * EVERY user-facing string in this package lives here. Command bodies contain
 * NO inline string literals. This is not a style preference: the claims gate can
 * only check copy it can find, and a literal inside a command body is invisible
 * to it. The capture client is greenfield exactly once, so this constraint is
 * free now and a refactor later.
 *
 * Commit headers are NOT here — they come from `grades.ts`, which is the single
 * renderer that takes the grade. Adding a header string to this file would
 * create the second path that the structural adjacency rule exists to forbid.
 *
 * @provenance vibecommit-mcp src/scrubber/index.ts — [REDACTED:<kind>] marker shape, borrowed
 * @provenance vibecommit-web app/app/commits/page.tsx — route existence, verified
 */
import { EXIT } from "../exit.js";
/** `--help` copy. The `why` line is verbatim-approved (D61 §PS6) — do not reword. */
export const HELP = {
    usage: "vibecommit <command> [options]",
    tagline: "Record Claude Code sessions against the commits they produced.",
    commands: {
        connect: "Connect this repo and capture the current session.",
        status: "Show whether capture is on for this repo and when it last succeeded.",
        off: "Stop capturing for this repo.",
        // VERBATIM-APPROVED (D61 §PS6). Any reword needs a new claims-register row.
        why: "Show the conversation turns recorded against the commit that last changed this line.",
        report: "Summarise capture coverage over a time window.",
    },
    docsUrl: "https://vibecommit.ai/docs/what-we-upload",
};
/**
 * The ENTRY POINT's own chrome and its two usage failures — `CR-090d`.
 *
 * These five strings were inline literals in `src/index.ts` (`:74`, `:76`, `:87`,
 * `:146`, `:163`) — user-facing, and invisible to the claims gate for six waves
 * because the gate can only check copy it can find.
 *
 * ## Why a separate object rather than three more fields on `HELP`
 *
 * `HELP` is the help SCREEN's content — the tagline, the usage line, the per-verb
 * descriptions, the docs URL — and the claims corpus tags the whole object with
 * one surface, `help`. Only three of these five render there. `unknownCommand` is
 * the usage-error path and `notImplemented` is what `why` and `report` print
 * today, so folding them into `HELP` would tag two §13.6 error messages as help
 * copy and check them against the wrong surface. The surface map is only as
 * honest as the objects it keys on, so the entry point gets its own.
 *
 * ⚠ The three labels are LABELS, not sentences: `renderHelp()` composes each with
 * a single space and the result must stay byte-identical at 80 columns
 * (`DESIGN.md` §13.4, `test/help.golden.txt`). A trailing space moved in here
 * would be invisible in review and would move the golden file.
 */
export const USAGE = {
    usageLabel: "Usage:",
    commandsLabel: "Commands:",
    docsLabel: "Docs:",
    /** The unknown-verb line. Help follows it, so this says only what went wrong. */
    unknownCommand: (verb) => `Unknown command: ${verb}`,
    /**
     * `why` and `report` until `CR-086` / `CR-108` land. Deliberately states the
     * state and claims nothing about when it changes — a date here would be a
     * promise the register would have to carry.
     */
    notImplemented: (verb) => `\`${verb}\` is not implemented yet.`,
};
/** `vibecommit status` (CR-021). */
export const STATUS = {
    onForRepo: "Capture is on for this repository.",
    offForRepo: "Capture is off for this repository.",
    neverSent: "No session has been recorded yet.",
    /**
     * The §13.5 gutter keys. LOWERCASE because style guide §10.3 draws them that
     * way, and §10.3 is the ruling (D65) — `lastSuccessLabel` and
     * `dashboardLabel` were title-case and referenced by nothing, so `CR-021`
     * changed them to match the screen rather than changing the screen.
     */
    repoLabel: "repo",
    lastSuccessLabel: "last sent",
    dashboardLabel: "dashboard",
    /** `<slug> (git toplevel <path>)` — §10.3's repo row. */
    repoToplevel: (slug, path) => `${slug} (git toplevel ${path})`,
    /** `4 minutes ago · seq 41`. No turn count — see the module note in status.ts. */
    lastSuccessValue: (age, seq) => `${age} · seq ${seq}`,
    fixCommandLabel: "To reconnect, run",
    /** §10.3's two trailing actions, rendered as an aligned pair. */
    turnOffLabel: "Turn capture off for this repo",
    revokeLabel: "Revoke this machine's credential",
};
/**
 * `vibecommit connect` (CR-025 owns the live-capture ending).
 *
 * ⚠ THE DISCLOSURE PARAGRAPHS ARE NOW HERE — `CR-111d` landed them, transcribed
 * from style guide §10.2 rather than paraphrased. They replaced three
 * placeholder one-liners. D64 falsified the trust argument the earlier draft
 * leaned on: this repo is PRIVATE with MIT intact, so "read the source" is false
 * and BLOCKED by the register. What survives is `Vibe-Commit/claude-plugin`,
 * which vendors the exact binary — and "inspect the build" is WEAKER than "read
 * the source" and may not be dressed up as it (D65 §DR7).
 *
 * The MECHANISM copy sits beside them and belongs to other rows: the prompt, the
 * two answers, the refusals, `CR-025`'s ending and `CR-110`'s fifth beat.
 *
 * Also locked and enforced by the mechanism, not by these strings: default `N`,
 * non-TTY refuses with exit 2, and no reassurance adjectives (*secure, safe,
 * protected, private, encrypted*) anywhere on the screen (D65 §DR7).
 */
export const CONNECT = {
    // --- THE DISCLOSURE (CR-111d). Transcribed from style guide §10.2. ---
    /**
     * ⚠ NOT PARAPHRASED. §10.2's rule 4 — *every noun names something actually
     * uploaded, in the USER's vocabulary* — is the one rule no gate can check, so
     * the nouns are transcribed rather than reworded: *"the output of commands it
     * ran"*, never *"Bash tool results"*.
     */
    consentHeading: "VibeCommit uploads your Claude Code transcripts for this repo.",
    /**
     * ⚠ "private-repo paths" IS THE APPROVED WORDING, and it is the reason
     * `private` is deliberately NOT registered in `claims.ts`: a substring gate on
     * it would fire on this very sentence on day one, and the register's own
     * §Lintable-unit section says a gate dies at its third false positive. So
     * `private`-as-reassurance is a HUMAN review item here. This use is
     * descriptive — it names what the paths ARE — and is the opposite of a
     * reassurance.
     */
    consentDetail: "That means the full text of the session: your prompts, the agent's replies, the arguments to every tool call, the file contents inside Edit records, and the output of commands it ran. File paths include private-repo paths.",
    /**
     * ⚠ THE NUMBER AND ITS QUALIFIER ARE ONE UNIT.
     *
     * **12 is `CR-042`'s counted figure** (merged, `6d8ec68`), taken rather than
     * recounted: the patterns live in `vibecommit-mcp/src/scrubber/patterns.ts`,
     * which is closed source and another chain's repo. `CR-042` exists precisely
     * because the draft said 10 — a number is a claim, and this one is counted
     * from code.
     *
     * The qualifier is as load-bearing as the number. Without *"it is a pattern
     * list, not a general secret detector"* and *"a secret it has no pattern for
     * is uploaded"*, the count reads as PROTECTION — which is the reassurance D65
     * §DR7 bans, arriving as arithmetic instead of as an adjective.
     */
    consentScrubber: "A scrubber removes 12 known secret formats (AWS keys, GitHub tokens, and similar). It is a pattern list, not a general secret detector: a secret it has no pattern for is uploaded. Command output is not path-filtered.",
    /** §10.2's first labelled link. Points at `HELP.docsUrl` — one definition. */
    consentDocsLabel: "Read the full list:",
    /**
     * ⚠ THE REPLACEMENT FOR THE OPEN-SOURCE CLAIM, and the ceiling on what it may
     * say. D64 created this repo PRIVATE with MIT intact, so *"read the source"*
     * is FALSE — the register's own signed-receipts failure mode, copy describing
     * a mechanism that does not exist. What survives is `claude-plugin`, which D20
     * keeps public non-negotiably and which vendors the exact binary that runs.
     *
     * **"Inspect the build" is WEAKER than "read the source" and may not be
     * dressed up as it** (D65 §DR7). This line offers the artefact and claims
     * nothing about readable source. All four phrasings are registered BLOCKED on
     * the `connect` surface, so the gate refuses the smuggled version too.
     */
    consentBundleLabel: "The binary that runs is here:",
    consentPrompt: "Continue?",
    declined: "Not connected. Nothing was uploaded.",
    capturing: "Recording this session…",
    doneHeading: "Connected.",
    doneUrlLabel: "View this session",
    // --- Mechanism copy (CR-016). ---
    /** The `[y/N]` suffix. The capital is the default and the default is NO. */
    consentAnswers: "[y/N]",
    /** Non-TTY refusal — DESIGN.md §13.7 exit 2, D65 §DR7. */
    nonInteractiveWhat: "Consent needs an interactive terminal.",
    nonInteractiveWhy: "Standard input is not a terminal, so the consent prompt cannot be answered. Nothing was read and nothing was uploaded.",
    nonInteractiveFix: "Run this in a terminal:",
    alreadyConnected: "Capture is already on for this repository.",
    /**
     * The browser sign-in beat (PKCE loopback → minted ingest credential) is the
     * oauth lane's, not this task's. Until it lands, the supported path is the one
     * `VIBECOMMIT_TOKEN` exists for. This copy states a mechanism, not a promise.
     */
    credentialNeededWhat: "This machine has no ingest credential.",
    credentialNeededWhy: "Consent is recorded for this repository, but nothing can be uploaded without a credential for this machine.",
    credentialNeededFix: "Set one, then run connect again:",
    credentialNeededCommand: "export VIBECOMMIT_TOKEN=…",
    // --- The ending (CR-025). Style guide §10.2's last three lines. ---
    /** `Capture is on for <repo>. Nothing else to do.` */
    doneForRepo: (repo) => `Capture is on for ${repo}. Nothing else to do.`,
    stopLabel: "To stop",
    /**
     * No transcript to record. ONE state — `CR-112` (W8) owns the five-absence
     * grammar as a set, and a sixth phrasing invented here is what that task
     * exists to prevent.
     */
    noTranscriptWhat: "No Claude Code session was found for this repository.",
    noTranscriptWhy: "Consent is recorded, but connect had nothing to record: no transcript exists yet for this project. Capture starts on its own the next time Claude Code runs here.",
    noTranscriptFix: "Nothing to fix. Start a session, then check:",
    // --- The FIFTH beat: org approval required (CR-110, D65 §DR6, D81). ---
    /**
     * ⚠ `warn`, NEVER `bad`, and **EXIT 0, never 1**. That 403 means *later*, not
     * *failed*: the offset holds and the backlog uploads in order on approval. A
     * red exit tells a correctly-installed user they broke something, which moves
     * the confusion report's T+9:00 give-up to T+0:45. `held` and `armed` are the
     * two words doing the work — both mean *ready, not running*.
     *
     * `capture_policy` defaults to `approval_required`, so a member of a
     * multi-member org sees this every time; solo orgs auto-approve inside the
     * insert and never meet it.
     */
    pendingWhat: "Your org needs to approve capture first.",
    /**
     * ⚠ NAMES THE REPO, NOT THE ORG — and that is a deviation from the style
     * guide's drawn example, made deliberately. §10.2 renders *"acohan/repo
     * belongs to the `vibecommit` org"*, and the client cannot produce that name:
     * the 403 body discloses nothing (no org id, no owner list, by design), and
     * `resolveRepoSlug` yields the GIT owner, which is a different thing from the
     * VibeCommit org that holds the capture policy. Inventing one would be a
     * confident lie; the link resolves it, which is what the link is for.
     */
    pendingWhy: (repo) => `${repo} belongs to an org that requires owner approval before capture runs.`,
    /**
     * ⚠ THE SHARED CLAUSE, and it renders on EVERY branch. D81: `owners_notified`
     * `null` = NOT DETERMINABLE, `0` = determinable and nobody was told, `> 0` =
     * N notified — and **`> 0` ADDS to this sentence rather than replacing it**.
     * One shared clause is why the two branches cannot drift apart later; a pair
     * of independent paragraphs is how the false version gets reintroduced.
     *
     * It is also TRUE, and checked rather than inherited: the server upserts a
     * `capture_requests` row BEFORE it emits the 403.
     */
    pendingRecorded: "Your request is recorded.",
    /**
     * ⚠ THE ONLY BRANCH THAT MAY CLAIM A NOTIFICATION, and it is reachable only
     * when the server says `> 0`. Today it never does — the field is hardcoded
     * `null` until `CR-036`, which is provisioning-blocked — so this sentence is
     * built and unreachable ON PURPOSE. **Never render it on the null branch.**
     * D81: a hardcoded *"we notified the owners"* installs the most damaging
     * possible mental model at the moment of highest trust — *the owner knows, so
     * I just wait* — so the pending state would suppress its own workaround. A
     * user told nothing at least asks in Slack.
     *
     * The branch is PERMANENT, not a stopgap: addresses bounce, domains land on
     * suppression lists, and a sole owner's address can be dead. `CR-036` landing
     * does not delete the other branch; it only makes this one reachable.
     */
    pendingNotified: (owners) => owners === 1 ? "We notified the owner." : `We notified the ${owners} owners.`,
    /** True by construction: 403 is `later`, so the offset holds and bytes stay on disk. */
    pendingBuffered: "Nothing is lost while you wait — turns are buffered on this machine and upload in order once an owner approves.",
    pendingTrackLabel: "Track it:",
    /** `armed` = ready, not running. The install is correct; capture is waiting. */
    pendingArmed: (repo) => `Capture is armed for ${repo}.`,
};
/**
 * The PATH clash — `CR-025`, and `DESIGN.md` §13.6's worked example is the spec.
 *
 * D55 accepted a residual bin collision as unlikely; the register corrects that
 * to *closer to certain*, because the squatting package (`vibecommit@1.0.6`) is
 * itself a commit CLI, so the overlap population is exactly developers who
 * install commit tooling. **This detects the collision D55 accepted. It does not
 * reopen the naming decision** — the bin name stays.
 *
 * ⚠ The plugin path in the fix line depends on `CR-027e` (renames the plugin
 * directory to `vibecommit`) and `CR-028` (creates `bin/` at all), both W6, both
 * in `claude-plugin`, both another builder's. Written as §13.6 draws it rather
 * than softened to dodge the dependency.
 */
export const PATH_CLASH = {
    foreignWhat: "Another program owns the `vibecommit` command.",
    foreignWhy: (resolved) => `\`vibecommit\` on your PATH resolves to ${resolved}, which belongs to the npm package \`vibecommit\` (a different project). Ours is \`@vibe-commit/capture\`. Hook capture is unaffected — it runs by path — but \`why\`, \`report\` and \`status\` will run the other program.`,
    absentWhat: "The `vibecommit` command is not on your PATH.",
    absentWhy: "Hook capture is unaffected — the plugin runs the binary by path — but typing `vibecommit status`, `why` or `report` will not find it.",
    fixLabel: "Fix, either one:",
    /**
     * FOREIGN only. The uninstall half is wrong for the absent case — telling
     * someone to uninstall a package they demonstrably do not have is the kind of
     * fix line that teaches users to stop reading fix lines. Found by running it.
     */
    fixReplace: "npm uninstall -g vibecommit && npm i -g @vibe-commit/capture",
    /** ABSENT: there is nothing to remove, only something to add. */
    fixInstall: "npm i -g @vibe-commit/capture",
    fixDirectLabel: "or invoke ours directly:",
    /**
     * `node …/bin/index.js`, not `…/bin/vibecommit`, and the difference is not
     * cosmetic: `claude-plugin`'s `bin/` contains `index.js` and no file named
     * `vibecommit`, and `index.js` carries a shebang but is NOT executable — so
     * the shorter form fails twice over. `hooks.json` invokes it exactly this
     * way, which is the shape that demonstrably works.
     *
     * This line asked for something impossible until DESIGN.md §13.6 was
     * corrected — the same defect as the absent case above telling users to
     * uninstall a package they do not have. **A fix line must be runnable, and
     * the way you know is that you ran it.**
     */
    fixDirect: "node ~/.claude/plugins/vibecommit/bin/index.js connect",
};
/**
 * Browser sign-in — `CR-084d`, the beat `connect.ts:175-176` deferred to "the
 * oauth lane" and this task is that lane.
 *
 * ⚠ Two rules these strings are written to, both from the claims register:
 *
 *   1. **No reassurance adjective anywhere** (D65 §DR7 registers *secure, safe,
 *      protected, encrypted* on the `connect` surface, which is where every
 *      string below renders). A sign-in screen is exactly where the temptation
 *      is strongest, and "we'll securely sign you in" says nothing a user can
 *      check.
 *   2. **The `what` line never has "you" as its subject** and never carries a
 *      bare HTTP status (DESIGN.md §13.6). "Sign-in did not finish", not "you
 *      failed to sign in"; the CAUSE goes in the `why` line, in a noun the user
 *      recognises.
 *
 * `browserDone` and `browserRefused` are the only strings in this package a
 * BROWSER renders rather than a terminal, which is why they carry no §13.5
 * gutter and no §13.2 glyph: there is no terminal to degrade to. They are still
 * copy, so they still live here and are still scanned by the claims gate.
 */
export const SIGNIN = {
    /** Printed before the browser opens, so the user knows what just happened. */
    opening: "Opening your browser to sign in…",
    /**
     * The headless fallback. NOT an error: a machine with no browser is an
     * ordinary place to run this, and the URL is a complete substitute.
     */
    manualLabel: "Open this URL to finish signing in:",
    waiting: "Waiting for the browser…",
    done: "Signed in.",
    /** What the browser tab shows. One line each — nothing is styled. */
    browserDone: "Signed in. You can close this tab and return to your terminal.",
    browserRefused: "This request did not match the sign-in waiting in your terminal.",
    // --- §13.6 error blocks, one per named outcome of `signIn`. ---
    noServerWhat: "VibeCommit could not find the sign-in service.",
    /** `unreachable` — nothing answered. Says what was tried, not what is wrong. */
    noServerUnreachableWhy: "The server did not answer the request that says where to sign in. It may be down, or this machine may have no route to it.",
    /** Any `malformed` fault. One sentence, because the user's move is the same. */
    noServerMalformedWhy: "The server answered, but the document that says where to sign in is not one this version can use.",
    /**
     * The override was refused before anything was sent. Names the variable and
     * the rule, because this one is entirely in the user's hands to fix.
     */
    noServerRefusedWhy: "VIBECOMMIT_MCP_URL is set to an address this client will not send a sign-in to. Only https, or http on the loopback, is allowed.",
    noServerFix: "Check the service, then run:",
    deniedWhat: "Sign-in was declined.",
    deniedWhy: "The sign-in screen returned without granting access. Nothing was changed on this machine.",
    deniedFix: "To try again, run:",
    timeoutWhat: "Sign-in did not finish in time.",
    timeoutWhy: "The browser did not come back before the deadline. Nothing was changed on this machine.",
    timeoutFix: "To try again, run:",
    rejectedWhat: "The sign-in service refused this client.",
    /**
     * ⚠ `unauthorized_client` is the expected answer TODAY: this CLI's client id
     * is not in the server's registered set (see `src/oauth/token.ts`). The copy
     * names the state without promising when it changes — a date here would be a
     * claim the register would have to carry.
     */
    rejectedWhy: "The service did not accept this client's sign-in request.",
    rejectedFix: "Report this, with the command you ran:",
    unreachableWhat: "VibeCommit could not reach the sign-in service.",
    unreachableWhy: "The request did not complete. Nothing was changed on this machine.",
    unreachableFix: "Check the connection, then run:",
    malformedWhat: "The sign-in service returned an unexpected answer.",
    malformedWhy: "The response was not in the form this version can use. No session was stored.",
    malformedFix: "Report this, with the command you ran:",
    /**
     * A session already exists, so sign-in is a no-op.
     *
     * ⚠ There is deliberately NO copy here for `authorizedAccessToken`'s `busy`
     * and `expired` outcomes. Nothing renders them yet: the read verbs are
     * `CR-086` (`why`, W9) and `CR-108` (`report`, W10), and inventing their
     * wording now would put a phrasing on a screen this task cannot see — the same
     * mistake `CR-112`'s absence-state grammar exists to prevent.
     */
    alreadySignedIn: "Already signed in on this machine.",
};
/** `vibecommit off`. */
export const OFF = {
    done: "Capture is off for this repository.",
    alreadyOff: "Capture was already off for this repository.",
    note: "Sessions already recorded are unaffected.",
};
/**
 * `vibecommit report` (CR-108).
 *
 * NOTE: this surface ships NO durability copy until the E2 metric is defined
 * (D61 §PS6, and the claims-register `Durable / survives / durability` row).
 *
 * ⚠ THE TWO EMPTY-WINDOW STATES MOVED. They were `emptyNoCommits` and
 * `emptyNoCapture` here, and they were the absence clause and NOTHING ELSE — no
 * cause, no remedy. `CR-112` re-homed both into `ABSENCE` below, where they
 * carry the full grammar and sit beside the three `why` states they have to
 * agree with. Do not reintroduce a short form here: two half-states in one
 * module and five whole ones in another is the drift `CR-112` exists to stop.
 */
export const REPORT = {
    coverageLabel: "Commits with a recorded session",
    gradeMixLabel: "Evidence",
};
export const ABSENCE = {
    /**
     * 1 — COLD START. Nothing has been captured yet, so `why` has no record to
     * consult at all. Owner: `CR-086` (W9).
     */
    coldStart: {
        what: "No sessions have been recorded on this machine yet.",
        why: "Capture has not run here, so there is no session to look up for any commit.",
        fix: "Connect this repository, then work as usual:",
        exit: EXIT.empty,
    },
    /**
     * 2 — NO-EDGE EMPTY. Capture is working; the commit `git blame` returned has
     * no edge. Owner: `CR-086` (W9).
     *
     * ⚠ The `why` states a DEFINITION, not a diagnosis. "This commit was made
     * without an agent" is the permanently BLOCKED claim (see `exit.ts`), and a
     * sentence guessing at the cause of one absent record is one edit away from
     * it. What is safe is what makes a record exist at all.
     */
    noEdge: {
        what: "No recorded session is linked to this commit.",
        why: "A commit is linked to a session only when capture was running for the session that produced it. This is a missing record, not a finding about the commit.",
        fix: "Nothing to fix. A record cannot be added to a commit after the fact.",
        exit: EXIT.empty,
    },
    /**
     * 3 — `report` EMPTY WINDOW A: NO COMMITS. Owner: `CR-108` (W10).
     *
     * Names the WINDOW and the REF, because the answer is relative to both: there
     * may be commits on another branch, or outside these dates, and a sentence
     * that named neither would read as a claim about the repository.
     *
     * Written unqualified — see the clone contract above.
     */
    reportNoCommits: {
        what: (ref, window) => `No commits on ${ref} in ${window}.`,
        why: (ref) => `The window and the ref bound this answer. Commits on a branch other than ${ref}, or outside these dates, were not counted.`,
        fix: "Widen the window, or name a different ref, and run this again.",
        exit: EXIT.empty,
    },
    /**
     * 4 — `report` EMPTY WINDOW B: COMMITS, NO SESSIONS. Owner: `CR-108` (W10).
     *
     * ⚠ 3 and 4 are DIFFERENT FACTS and collapsing them reads as a coverage claim
     * we cannot make. The counted commits are the whole difference: this window
     * has them and has no session for them, which is not the same as having
     * nothing in it.
     */
    reportNoSessions: {
        what: (count, window) => `No recorded sessions for the ${count} commits in ${window}.`,
        why: "A commit has a recorded session only when capture was running for the session that produced it. The window bounds this answer.",
        fix: "Work with capture on, then run this again over a window that includes those commits.",
        exit: EXIT.empty,
    },
    /**
     * 5 — SQUASH-RESOLVED. `git blame` returns the squashed SHA on `main` while
     * every edge we hold binds a pre-squash original. Owner: `CR-109`.
     *
     * ⚠ D65 §DR5: if the blamed SHA is not a SHA we hold an edge for, the header
     * MAY NOT claim the transcript recorded it. **Both SHAs render** — a
     * single-SHA sentence here is exactly the overclaim this state exists to
     * prevent. This is GitHub's DEFAULT merge button, so it is the common path.
     */
    squashResolved: {
        what: (blamed, recorded) => `This line is attributed to ${blamed}; the session we hold was recorded against ${recorded}.`,
        why: (blamed) => `The original commit was squashed when it merged, so ${blamed} is not a commit that capture recorded. The session below is the record of the original, and it is not a record of ${blamed}.`,
        fix: "Nothing to fix. Read the session as the record of the original commit.",
        exit: EXIT.empty,
    },
};
// ⚠ NO `ALL_ABSENCE_STATES` EXPORT HERE, DELIBERATELY. The expected set lives in
// `test/copy-absence.test.ts`, because a list exported from this file and then
// compared against this file's own keys asserts nothing — it is the tautology
// the brief for this task names. `test/copy-grades.test.ts` keeps its expected
// table in the test for the same reason.
/** Failure-class copy (CR-018). Three classes: later / never / fatal. */
export const ERRORS = {
    notConnected: "This repository is not connected. Run `vibecommit connect`.",
    networkLater: "Could not reach VibeCommit. This session will be recorded on the next turn.",
    authFatal: "VibeCommit could not authenticate. Run `vibecommit connect` to reconnect.",
    payloadNever: "This session was too large to record and has been skipped.",
    notAGitRepo: "Not a git repository.",
};
/**
 * The interactive top-level catch (CR-022).
 *
 * **The hook half of the contract does not apply here** (D61 round 3 §D8). A hook
 * swallows everything and exits 0 because a non-zero hook derails the developer's
 * live turn; an interactive verb that did the same would report success for work
 * it did not do. So an unexpected exception gets §13.6's shape — what, why, fix —
 * and exit 1.
 *
 * ⚠ The `why` line says only what we actually know. "Nothing was uploaded" would
 * be a claim, not a fact: an exception can land after a send, and copy that
 * guesses in the reassuring direction is the failure the claims register exists
 * to stop.
 */
export const INTERNAL = {
    unexpectedWhat: "VibeCommit stopped on an unexpected error.",
    unexpectedWhy: "The command did not finish.",
    unexpectedFix: "Run it again with the error detail shown:",
    unexpectedDebugCommand: "VIBECOMMIT_DEBUG=1 vibecommit <command>",
};
/**
 * Credential-loading failures (CR-016).
 *
 * §13.6's shape — what, why, fix, fix last. **The `what` line never has "you" as
 * its subject** and never carries a bare HTTP status. None of these strings
 * contains any part of a credential, and none can: the plaintext only leaves
 * `IngestCredential` through `expose()`, which no copy path calls.
 */
export const CREDENTIAL = {
    wrongClassWhat: "The credential set for this machine is not an ingest credential.",
    wrongClassEnvWhy: "VIBECOMMIT_TOKEN is set, but its value is not a VibeCommit ingest credential. It was not sent anywhere.",
    wrongClassFileWhy: "The credential on disk is not a VibeCommit ingest credential. It was not sent anywhere.",
    wrongClassFix: "Mint a fresh one:",
    insecureFileWhat: "The credential file is readable by other accounts on this machine.",
    insecureFileWhyLabel: "file",
    insecureFileModeLabel: "mode",
    insecureFileWhy: "It was not read. A credential file must be readable only by its owner.",
    insecureFileFix: "Restore the mode, then reconnect:",
    unreadableWhat: "The credential file could not be read.",
    unreadableWhy: "It exists but does not contain a credential in the expected form.",
    unreadableFix: "Replace it by reconnecting:",
};
/**
 * The Node floor (D57 plan §DX11). `NODE_FLOOR_TEXT` and the running version are
 * interpolated by the caller so there is still exactly one copy of the sentence.
 */
export const RUNTIME = {
    floorWhat: "VibeCommit needs a newer Node.",
    floorWhyPrefix: "This package requires Node",
    floorWhyMiddle: "or newer. It is running on Node",
    floorFix: "Upgrade Node, then run:",
};
/**
 * The `systemMessage` channel — style guide §10.1, three states, once per
 * session (D57 plan §DX3).
 *
 * ⚠ Four rules that are easy to break and expensive to notice:
 *   1. ONE LINE each. Two lines in an agent transcript reads as tool noise and
 *      gets tuned out, which returns us to the failure DX3 exists to fix.
 *   2. NO SGR ESCAPES, ever. This is a JSON string field rendered by Claude
 *      Code's own UI; embedded escapes are undefined behaviour (DESIGN.md §13.9).
 *   3. All three are FAILURE states. The positive fourth state (`capture
 *      confirmed`) is `CR-023`, and it is a two-clause amendment — it inverts
 *      "stdout empty on the happy path". Do not add it here as if it were a
 *      shape-preserving addition.
 *   4. No URL longer than the line.
 */
export const SYSTEM_MESSAGE = {
    notConnected: "VibeCommit is installed but not connected. Run `vibecommit connect` to start capturing.",
    credentialRevoked: "VibeCommit capture stopped: this machine's credential was revoked. Run `vibecommit connect`.",
    /** Templated on both versions — style guide §10.1 state 3. */
    unsupportedRuntime: (floor, running) => `VibeCommit needs Node ${floor} or newer; hooks are running on Node ${running}. Nothing is being captured.`,
    /**
     * State 4 — style guide §10.1, and the ONLY positive one. `CR-023d`.
     *
     * Templated on the URL rather than inlining it, for the same reason
     * `unsupportedRuntime` is templated: `URLS` is declared below this object, so
     * a direct reference would read it in its temporal dead zone.
     *
     * ⚠ The style guide's example ends `.../app/commits/a8f2c91`, which is
     * ILLUSTRATIVE and not constructible here. A hook cannot know which commit a
     * session will resolve to — that mapping happens server-side and
     * asynchronously, long after this process has exited — so the generic
     * dashboard URL is substituted. See the PR.
     *
     * Claims-register: "captured" is not a blocked phrase, and it is a weaker
     * claim than the register's own boundary line ("the record is append-only for
     * users and its hash chain detects post-write tampering").
     */
    captureConfirmed: (dashboardUrl) => `VibeCommit captured this session. ${dashboardUrl}`,
};
/**
 * The out-of-tree redaction marker — `CR-024d`, D57 §OV8d.
 *
 * User-visible: it lands in the record a customer reads back, so it clears
 * `docs/claims-register.md`. It says WHAT HAPPENED and nothing about how safe
 * anything is — no *secure / safe / protected / private / encrypted* — and it
 * claims no completeness, because OV8d's redaction is explicitly PARTIAL
 * (`capture-refactor-three-buyers.md`:387) and "complete / all / every" is a
 * blocked claim unless the count and the selection rule render inline.
 *
 * The byte count IS the count rendering inline, and "outside this repository"
 * is the selection rule. Both are literally true of the span replaced.
 *
 * Shape borrowed from the server scrubber's `[REDACTED:<kind>]` — read for its
 * shape only, never imported: this package is MIT and `vibecommit-mcp` is
 * closed, so lifting code across would be a licensing violation (D60 §D1a).
 */
export const REDACTION = {
    /** Padded to the exact byte length of what it replaces — see `redact.ts`. */
    head: (bytes) => `[OUT-OF-TREE: ${bytes} bytes withheld`,
    /** Fill between head and tail. ASCII, one byte per column. */
    fill: ".",
    tail: "]",
    /** For spans too short for the counted form. */
    short: "[OUT-OF-TREE]",
};
/** Commands the copy points at. One definition, so a rename cannot half-land. */
export const COMMANDS = {
    connect: "vibecommit connect",
    /** `CR-084d`. A FLAG, not a verb — `--help`'s verb list and its golden file do not move. */
    signIn: "vibecommit connect --sign-in",
    status: "vibecommit status",
    off: "vibecommit off",
    chmodCredentials: "chmod 600 ~/.vibecommit/credentials.json",
};
/**
 * Every URL the CLI prints. Here rather than inline for the same reason as the
 * rest: a link is user-visible copy, the claims gate can only check what it can
 * find, and `CR-114` is moving `/app`'s information architecture underneath us.
 */
export const URLS = {
    dashboard: "https://vibecommit.ai/app",
    settings: "https://vibecommit.ai/app/settings",
    /**
     * The captures INDEX — `CR-025`. Style guide §10.2 draws
     * `/app/commits/<a-sha>`, and that route DOES NOT EXIST: `CR-114` (W3) created
     * `app/app/commits/page.tsx`, a flat index, with no `[sha]` segment and no
     * rewrite, so a per-commit URL 404s. Verified against `vibecommit-web`
     * `origin/main` rather than assumed.
     *
     * Printing a URL that 404s at the moment of highest trust is the specific
     * failure this ending exists to avoid. `CR-101` (W10) adds the detail page;
     * deepening this constant is that task's, not a later guess.
     */
    commits: "https://vibecommit.ai/app/commits",
    /**
     * Where an org member goes to see their pending capture request — `CR-110`.
     *
     * ⚠ VERIFIED BY FILE, NOT BY PROBE. Every `/app/*` path on that site returns
     * an identical 307 whether or not the route exists, so a 307 is NEVER evidence
     * a route is real. This one was confirmed by reading
     * `vibecommit-web/app/app/settings/capture-access/page.tsx` on `origin/main`,
     * with `app/api/capture-access/{policy,decide}/route.ts` beside it (`CR-035c`).
     *
     * Deeper than the style guide's drawn `/app`, deliberately: the beat's whole
     * job is to be actionable, and the generic dashboard does not show the request.
     */
    captureAccess: "https://vibecommit.ai/app/settings/capture-access",
    /**
     * The public bundle that vendors the exact binary — `CR-111d`, D20, D64.
     *
     * ⚠ THE ONLY HONEST TRUST OFFER LEFT. D64 made `vibecommit-capture` PRIVATE
     * (MIT intact — the licence is the invariant, the visibility is not), so
     * linking this repo would be linking a 404 and claiming readable source would
     * be false. D20 keeps `claude-plugin` public non-negotiably.
     *
     * ⚠ AND THE SENTENCE BESIDE IT IS ONLY TRUE ONCE `CR-029e` LANDS. Measured at
     * `claude-plugin` `1349896`, `bin/` was vendored from `vibecommit-capture`
     * `8e772f1` — nine commits and eight tasks behind, with no `redact.js` at all.
     * `CR-029e` re-vendors it. Written as §10.2 draws it, with the dependency
     * disclosed in the PR rather than silently shipped.
     */
    pluginBundle: "https://github.com/Vibe-Commit/claude-plugin",
};
//# sourceMappingURL=strings.js.map