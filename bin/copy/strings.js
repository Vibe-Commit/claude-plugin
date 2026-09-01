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
 * @provenance vibecommit-schema capture_turns column list — MEASURED ABSENCE, cited (CR-086)
 */
import { EXIT } from "../exit.js";
// Same precedent as `EXIT` above: the prefix is a WIRE FACT, and a copy line that
// spelled `vcik_` out by hand would be a second definition of it — free to drift
// from the one `credential.ts` actually enforces. `credential.ts` imports no copy,
// so this direction does not close a cycle.
import { INGEST_TOKEN_PREFIX } from "../credential.js";
/** `--help` copy. The `why` line is verbatim-approved (D61 §PS6) — do not reword. */
export const HELP = {
    usage: "vibecommit <command> [options]",
    tagline: "Record Claude Code sessions against the commits they produced.",
    commands: {
        // `CR-216/U2`. FIRST in the list because it is first in the sequence: on a
        // new machine there is nothing for `connect` to use until this has run.
        auth: "Save this machine's ingest credential.",
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
 * the usage-error path, so folding it into `HELP` would tag a §13.6 error
 * message as help copy and check it against the wrong surface.
 *
 * ⚠ `notImplemented` LIVED HERE AND IS GONE, REMOVED BY `CR-108`. It was what
 * `why` and `report` printed while unbuilt, and `report` was its last caller —
 * **every verb in `VERBS` is now implemented**, so the string had no route to a
 * screen. Copy that cannot be reached is copy no gate can check, and leaving it
 * would have invited the next reader to wire a sixth verb to it silently. The surface map is only as
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
    /**
     * `CR-216/U3` — the one status fault that is invisible from the outside.
     *
     * `VIBECOMMIT_TOKEN` wins over the saved credential (D56, for CI), so a token
     * left exported in a shell keeps sending under an identity the user stopped
     * choosing, while every other line on this screen still reads normally. It
     * states the precedence and the undo, and makes no claim about which of the
     * two is correct — the client cannot know that.
     */
    credentialShadowed: "VIBECOMMIT_TOKEN is set and takes precedence over the credential saved on this machine. Unset it to use the saved one.",
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
    /**
     * ⛔ **THE SECOND DATA CLASS, AND THE DISCLOSURE DID NOT MENTION IT AT ALL —
     * `T15`, `D190`.**
     *
     * The three paragraphs above enumerate TRANSCRIPT CONTENT. They were the whole
     * disclosure, and commit SHAs have gone on the wire since `CR-170` without a
     * word here. `D190` adds two more headers, one of which is a genuinely new
     * class, so the copy is extended rather than the send being scoped — scoping
     * the send would gut the feature.
     *
     * ## ⛔ WHAT IS HERE IS MEASURED FROM `buildIngestHeaders`, NOT FROM THE PLAN
     *
     * | said here | header | since |
     * |---|---|---|
     * | the commit ID | `x-commits` | `CR-170` |
     * | the branch name | `x-head-branch` | `CR-170` |
     * | the session it was linked to | `x-session-id` | pre-`CR-170` |
     * | how that link was made | `x-commit-attributions` | `D190`, NEW |
     * | the replaced commit's ID | `x-rewrites` | `D190`, NEW |
     *
     * ⛔ **AND WHAT IS DELIBERATELY NOT HERE, BECAUSE IT DOES NOT LEAVE THE
     * MACHINE.** `post_commit.ts` gathers the changed-file list and the committer
     * date because they are free at that moment, and `capSpool` returns only
     * `{shas, attributions, count}`. **Describing them as uploaded would be a FALSE
     * DISCLOSURE, which is as much a claims defect as a missing one** — and it is
     * the easier mistake, because over-disclosing feels safe.
     *
     * ⚠ **`SpoolEntry.branch` and `delta.head.branch` are NOT the same noun.** The
     * per-commit one stays local; the repo's CURRENT branch goes out on every
     * delta as `x-head-branch` (`post.ts:228`, `entry.ts:612`). The branch name is
     * named here on the strength of the second, never the first.
     *
     * ## ⛔ THE REWRITE SENTENCE IS THE ONE THIS STRING EXISTS FOR
     *
     * `x-rewrites` carries LOCAL, UNPUSHED REWRITE HISTORY — `ancestor:successor`
     * pairs whose ancestor is unreachable from every branch and gone after
     * `gc --prune=now`. Telling a user "we upload your transcripts" does not cover
     * "we upload a record of the commits you rewrote before pushing". **Someone who
     * squashes to bury a false start is entitled to know that the false start's ID
     * left the machine.**
     *
     * ⚠ *"may never have left this machine"*, not *"was never pushed"*: you can
     * amend a commit that WAS pushed and force-push it, so the stronger sentence is
     * false in a real case.
     *
     * ## ⛔ NO NEGATIVE LIST, AND THAT IS A DECISION
     *
     * An earlier draft closed with *"commit messages, authors, dates and the
     * changed-file list are not uploaded."* True today (`post.ts:166-174`), and
     * CUT: `D190 §6` says this wire has **no compiler, no schema and no shared
     * type**, so a negative claim in shipping copy goes false the first time anyone
     * adds a header — silently, with no gate able to see it. Positive claims only.
     *
     * ⚠ Opens *"Not only the transcript"* because `consentHeading` still says
     * *"uploads your Claude Code transcripts"*, which is now narrower than the
     * truth. Repairing the scope where a skimmer meets it; the heading itself is a
     * bigger copy change than this task was scoped for.
     */
    consentCommits: "Not only the transcript. Commits you make while a session is recording are uploaded too: the commit ID, the branch name, the session it was linked to, and how that link was made. If you amend or rebase, the ID of the commit you replaced goes with them — that commit may never have left this machine, and git will eventually delete it from here.",
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
    /**
     * `CR-216/U4` REPLACED `export VIBECOMMIT_TOKEN=…` HERE.
     *
     * The old line taught the CI escape hatch as the install fix, and it was the
     * only fix that existed because `credentials.json` had no producer. Following
     * it repaired exactly one shell: the next terminal, and every `git commit` run
     * from any other one, was broken again in the same silent way — the hook found
     * no credential and bound nothing, which the exit contract makes soundless.
     *
     * `VIBECOMMIT_TOKEN` is unchanged and still read first (D56, founder call); it
     * is simply no longer what a stuck human is told to type.
     */
    credentialNeededFix: "Save one for this machine, then connect:",
    credentialNeededCommand: "vibecommit auth",
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
/**
 * The `post-commit` install report — `CR-170`, D154.
 *
 * ⛔ **EVERY OUTCOME SAYS SOMETHING, INCLUDING THE GOOD ONE.** Three of this
 * path's failure modes are silent no-ops (D98's class): `core.hooksPath` makes
 * `.git/hooks` dead, an existing hook must not be clobbered, and neither is
 * visible without a line of output. A user who is told nothing cannot tell a
 * working install from one that observes no commits for the life of the clone.
 *
 * ⚠ **AND IT SAYS "THIS CLONE", EVERY TIME.** Per-clone installation is the real
 * cost of this design and the one thing a user will be surprised by later, so it
 * is stated at the moment they can act on it rather than buried in documentation.
 */
export const COMMIT_HOOK = {
    installed: (repo) => `Commit capture is on for this clone (${repo}). Commits are recorded as they happen, including ones made by \`make\`, \`gh\`, an alias or a script.`,
    chained: (repo) => `Commit capture is on for this clone (${repo}). You already had a \`post-commit\` hook — it was kept and still runs first; ours runs after it.`,
    already: "Commit capture was already on for this clone.",
    perClone: "Run `vibecommit connect` in each clone you want commits recorded for — git hooks are per-clone, not per-account.",
    hooksPathWhat: "Commit capture could NOT be installed for this clone.",
    hooksPathWhy: (configured) => `This repository sets \`core.hooksPath\` to ${configured}, so git ignores \`.git/hooks\` entirely and a hook installed there would never run. Transcript capture is unaffected; only commit observation is.`,
    hooksPathFixLabel: "Fix, either one:",
    hooksPathFixUnset: "git config --unset core.hooksPath",
    hooksPathFixManual: "or add `vibecommit post-commit` to your existing post-commit hook",
    failedWhat: "Commit capture could NOT be installed for this clone.",
    failedWhy: (why) => `Writing the \`post-commit\` hook failed: ${why}. Transcript capture is unaffected; only commit observation is.`,
};
/**
 * Registering capture with the agents on this machine — `CR-195`/U4b.
 *
 * ⛔ **A GLOBAL-SCOPE WRITE, OUTSIDE THE REPOSITORY**, which `CR-195`'s own note
 * calls out as a new responsibility: unlike `.git/hooks`, this touches a file the
 * user shares with every project. So every line names the FILE and the AGENT.
 * "We configured your editor" would be the shape that hides it.
 *
 * ⚠ **Nothing here narrates the credential.** `connect`'s token step is being
 * rewritten to mint and persist through the browser session it already opens, so
 * a line telling the user to paste a `vcik_` would be stale on arrival. What was
 * written and where is durable; how the credential got there is another unit's
 * copy, in another unit's strings.
 */
export const AGENT_HOOKS = {
    installed: (agent, path) => `Session capture is on for ${agent}. Registered Stop, PreCompact and SessionEnd in ${path}.`,
    already: (agent, path) => `Session capture was already on for ${agent}; refreshed the command in ${path}.`,
    kept: (agent) => `Any hooks you already had are untouched and still run — ${agent}'s config was added to, never replaced.`,
    // ⛔ TRUE TODAY AND AFTER THE CREDENTIAL WORK LANDS. This describes Codex's own
    // startup behaviour, not ours: the binary ships the literal option "Continue
    // without trusting (hooks won't run)", so a file written here does not run
    // until the user says so. Claiming success without it would ship exactly the
    // false install claim this unit exists to delete.
    codexTrust: "Codex asks you to trust new hooks the next time it starts — until you do, it will not run them.",
    refusedWhat: (agent) => `Session capture could NOT be set up for ${agent}.`,
    refusedWhy: (path, why) => `${path} could not be read as JSON (${why}), and it was left exactly as it is. Overwriting a file we cannot parse would discard settings we cannot see.`,
    refusedFixLabel: "Fix:",
    refusedFix: (path) => `check ${path} for a syntax error, then run \`vibecommit connect\` again`,
    failedWhat: (agent) => `Session capture could NOT be set up for ${agent}.`,
    failedWhy: (path, why) => `Writing ${path} failed: ${why}. Commit capture and any agent already configured are unaffected.`,
};
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
    /** A session already exists, so sign-in is a no-op. */
    alreadySignedIn: "Already signed in on this machine.",
    // --- `authorizedAccessToken`'s last two outcomes — `CR-086`, W9. ---
    /**
     * ⚠ THE COPY THIS OBJECT DEFERRED BY TASK NUMBER, now written by the first
     * renderer. `why` is that renderer; `report` (`CR-108`, W10) is the second and
     * inherits these rather than inventing a second phrasing.
     *
     * ⚠ AND THIS EXPORT NOW RENDERS ON TWO SURFACES. `SURFACES` in
     * `test/copy-claims.test.ts` gained `why` beside `connect` for exactly these
     * four strings — a surface map that still said `connect` alone would be
     * checking them against the wrong blocked set.
     *
     * `expired` — the refresh grant was REFUSED. The session is over; only a new
     * sign-in fixes it. Distinct from `busy`, which is a wait.
     */
    expiredWhat: "This machine's sign-in has ended.",
    expiredWhy: "The stored sign-in could not be renewed, so nothing could be read. It may have been revoked, or it may simply have run out.",
    expiredFix: "Sign in again, then run the command again:",
    /**
     * `busy` — another process holds the refresh lock and did not release it in
     * time. NOT a failure of the session: the fix is to run it again, and saying
     * "sign in again" here would send a user to re-authenticate over a lock.
     *
     * ⚠ The `what` line's subject is the state, never "you" (DESIGN.md §13.6).
     */
    busyWhat: "Another VibeCommit command is renewing this machine's sign-in.",
    busyWhy: "Only one process may renew a sign-in at a time, and the one holding it did not finish. Nothing was read and the stored sign-in is unchanged.",
    busyFix: "Run it again in a moment:",
};
/** `vibecommit off`. */
export const OFF = {
    done: "Capture is off for this repository.",
    alreadyOff: "Capture was already off for this repository.",
    note: "Sessions already recorded are unaffected.",
};
/**
 * `vibecommit why` — `CR-086`, W9.
 *
 * The screen is drawn in style guide §10.4 (layout), §10.5 (sub-agent
 * attribution) and §10.6-A/B (the two absences this verb owns), and the copy is
 * NORMATIVELY §R3's decision table in `docs/designs/claims-audit-why.md`. §10.4
 * is explicit that §R3 governs and that it must not be paraphrased here, so the
 * per-grade sentences live in `grades.ts` behind the one header renderer and
 * this object holds only what §R3 tables SEPARATELY from the grade.
 *
 * ## ⚠ THE HOLE THIS SURFACE SHIPS WITH, HELD OPEN AND NAMED — `CR-129`
 *
 * §R3's sub-agent attribution table has three rows and **two of them read data
 * nothing produces**. Measured at `vibecommit-schema` `2c77400`,
 * `vibecommit-mcp` `eeda878` and here at `4dcf47d`, every tracked blob read as
 * utf8 (never `grep` — `src/redact.ts` carries literal NUL bytes and `grep -I`
 * skips it silently):
 *
 *   - `capture_turns.subagent_count` — **0 hits in all three repos** at those
 *     SHAs. `TODOS[74]` assumed the column; nothing had added it.
 *     ⚠ **UPDATED BY `CR-129d` (W10): THE COLUMN NOW EXISTS AND STILL HAS NO
 *     PRODUCER.** `CR-129a` added it at `vibecommit-schema` `f3022c5` —
 *     `integer`, nullable, no default. Nothing writes it (mcp's
 *     `insertCaptureTurns` is a seven-key literal) and nothing emits it
 *     (`blame_commit` selects `position, turn_hash`), so the marker still
 *     cannot render from real data. The measurement above is kept because it
 *     is dated and was true; **this note is the correction, not a rewrite.**
 *     ⚠ A six-column tally stood here and is gone — it was an exact
 *     transcription of the original `create table` that three later
 *     migrations emptied, including one renaming `workspace_id` to `org_id`.
 *     D101: write the predicate, never the count.
 *   - `commit_file_attribution` EXISTS (`CR-070`,
 *     `20260814000000_cr070_commit_graph.sql:278`) and **has no writer**:
 *     `CR-072` shipped the edge only and said so
 *     (`vibecommit-mcp/src/conversation/edge_derivation.ts:56-64`). That table
 *     is where `agent_id` lives.
 *
 * So `agent_id` is a column on a table nothing writes, and `subagent_count` is
 * not a column at all. `TODOS[74]` says of that minimum: *"E1 cannot ship
 * without it… silence about a delegated edit is an overclaim about who wrote
 * the code."* Both halves are true, and the resolution is neither to omit the
 * requirement nor to fake it: **the absence renders, in the absence grammar,
 * naming what it is and what would change it.**
 *
 * ⚠ `agent_id` NULL is SEMANTIC — the schema comment says *"NULL = the main
 * thread. The empty string is refused because '' would render as an unnamed
 * sub-agent — a plausible wrong answer rather than an error."* **`null` and
 * ABSENT are therefore different facts**: `null` means we know it was the main
 * thread; absent means we know nothing. An unmarked turn rendered from an
 * absent field is the overclaim, so `why.ts` requires the field to be PRESENT
 * before it renders a turn unmarked, and marks every turn otherwise.
 *
 * ## What is deliberately NOT here
 *
 * No grade word. §13.3: *"Grade words appear in `--json` only. Prose never
 * prints a bare grade"* — the two-tier structural summary plus the per-edge
 * evidence sentence render instead, and the evidence sentence is `grades.ts`'s.
 *
 * No `⛓` / `◇` glyphs. §10.5 draws them for the WEB surface; `DESIGN.md` §13.2's
 * `GLYPH` table has exactly three entries (`ok` / `warn` / `bad`) and neither is
 * in it. The CLI's binding requirement is §R3's prose evidence line, which
 * renders. Inventing a fourth glyph is a report to the orchestrator, not an edit
 * to `term.ts`.
 *
 * No colour on the attribution marker or on the grade (D65 §DR3, §DR4).
 * `agent_id` is an ACTOR IDENTITY, the same class as a branch name, and a
 * green/yellow/red grade ramp asserts a ranking §R3 forbids.
 */
export const WHY = {
    // --- §R3: the turn-list framing. IDENTICAL AT ALL THREE GRADES. ---
    /**
     * ⚠ THIS is where D61 §PS6's file scope lives, and the reason it moved here.
     * `commit_file_attribution` has no line ranges, so every sentence that
     * INTRODUCES TURNS is file-scoped — and §PS6 requires the file scope to render
     * on the same screen as the line number, which it does: the identity line
     * above carries the line, this sentence carries the file.
     *
     * ⚠ §R3 bans a causal vocabulary on this sentence at all grades — *produced,
     * caused, wrote this line, because, the reason, responsible for, explains, led
     * to*. "Touched" is the approved verb and it is the weakest true one.
     */
    turnsIntro: (file) => `Turns that touched ${file} in this commit:`,
    /**
     * §R3's `match_kind` table, the `probable` row — `CR-138d` / `CR-109d`.
     *
     * ⚠ **THE ONLY DIFFERENCE BETWEEN THE TWO VARIANTS, AND IT MUST STAY VISIBLE.**
     * §R3: `exact` renders the squash copy *unqualified* — the pair came from a
     * recorded successor row — while `probable` renders it **plus a stated
     * basis**. Rendering them identically is the folding D67 forbids: *"the
     * disclosure would become the thing that hides the distinction."*
     *
     * ⚠ D105 makes this permanent rather than cosmetic: `match_kind` is in
     * `commit_sha_successors`' primary key and `reject_history_mutation` raises
     * on every UPDATE including `service_role`, **so a wrong row cannot be
     * corrected.** A guess labelled as a guess is the only honest rendering.
     *
     * ⚠ `witnessed` is §R3's own word and the choice is deliberate. The obvious
     * phrasing would have reached for the `observed` family, which is BLOCKED on
     * this surface because it names a mechanism that exists in no repo (D113 §1)
     * — a blocked claim arriving through a synonym nobody was checking. This
     * comment names the trap without spelling the phrase, so a source-text scan
     * does not fire on the note explaining the avoidance.
     */
    squashProbableBasis: "These two commits were matched by patch id rather than by a recorded successor row, so the pairing is read off the commits themselves and is not something capture witnessed.",
    /**
     * ⚠ WHY THE TWO SHAS ON THE SQUASH SCREEN ARE DIFFERENT LENGTHS.
     *
     * Two builders — this one and `CR-101`'s on the web surface — read the
     * asymmetry as a bug, and **the ruling was to explain it rather than remove
     * it** (D120 §1 as revised). Web keeps parity by carrying the full value in
     * the DOM; a terminal line has nowhere to put it, so the line says why.
     *
     * ⚠ **THE SENTENCE DOES NOT TELL THE READER TO RUN `git show` ON IT**, and
     * that restraint is measured rather than cautious: cloned over the git
     * transport after a squash-merge with branch delete, the original object is
     * ABSENT and `git show` fails on the full sha as surely as on a short one.
     * What the full value keeps is that it stays a complete identifier somebody
     * else can look up. Promising a local command that fails in exactly the case
     * this state exists for would be the plausible-wrong-answer class in copy.
     */
    squashShaLengths: "The recorded commit is written out in full because a squashed commit is often missing from a working copy, and a shortened id cannot be looked up once the commit is gone.",
    /** §10.4's turn row: `turn 12  [Edit]  session.ts`. */
    turnLabel: "turn",
    /** §10.4: excerpts are `muted` and `>`-prefixed — verbatim, never a summary. */
    excerptPrefix: ">",
    // --- §R3: the sub-agent attribution table (§10.5). ---
    /** Row 1 — `agent_id IS NOT NULL`. An identity, rendered plain (D65 §DR3). */
    subAgentMarker: (agentId) => `· sub-agent ${agentId}`,
    /**
     * Row 2 — `capture_turns.subagent_count > 0`.
     *
     * ⚠ **NO PRODUCER EXISTS FOR THIS AND THE COLUMN IS NOT IN ANY SCHEMA.** It is
     * implemented against a validated OPTIONAL payload field so that the day the
     * column exists the row renders, and it is exercised in the suite against a
     * synthetic payload — but nothing on the wire can populate it today, and this
     * comment is the only honest place to say so. It is NOT rendered from a zero
     * and NOT rendered from an absent field.
     */
    subAgentCountMarker: (count) => count === 1 ? "· includes 1 sub-agent record" : `· includes ${count} sub-agent records`,
    /**
     * The marker for a turn whose actor we cannot name — `CR-129`'s hole, on the
     * turn itself rather than only in a footnote. §10.5: *"the turn header and the
     * file-attribution table ALWAYS name the actor… hiding an actor"* is the thing
     * that makes a claim. When we cannot name one, we say that, per turn.
     */
    actorUnrecordedMarker: "· actor not recorded",
    /**
     * The `CR-129` note, in the absence grammar — absence, cause, remedy.
     *
     * ⚠ NOT an `ABSENCE` state and it may not become one. Those five are
     * whole-screen empty states that all exit 4; this is a caveat on a screen that
     * HAS content, and `test/copy-absence.test.ts` asserts the set is exactly
     * five. Same ruling the `ABSENCE` docblock already makes for the
     * shallow-clone refusal: not every absence sentence is an absence STATE.
     */
    attributionWhat: "Sub-agent attribution is not recorded for these turns.",
    /**
     * ⚠ "on this screen", not "below" — caught by rendering it. The note sits
     * AFTER the turn list, so a positional word was pointing the wrong way. A
     * sentence that describes its own layout breaks silently when the layout
     * moves; one that names the screen does not.
     */
    attributionWhy: "The per-turn attribution this marker reads has no writer yet, so no turn on this screen can be shown as main-thread work or as delegated work.",
    /**
     * ⚠ THE SECOND SENTENCE IS THE LOAD-BEARING ONE. Without it, an unmarked turn
     * reads as a finding that the main thread wrote it — which is the inversion
     * the register permanently BLOCKS, arriving through silence instead of through
     * a sentence.
     */
    attributionNotAFinding: "An unmarked turn here is a missing record, not a finding about who wrote the code.",
    attributionFix: "Nothing to fix on this machine. The marker renders once attribution is recorded.",
    // --- §R3: the truncation notice, and the L2 no-silent-drops line. ---
    /**
     * §R3, verbatim. ⚠ **The selection rule is ORDINAL AND STATED** — *"in turn
     * order"*, never *"most relevant"*, which is a ranking, which is server-side
     * analysis and reverses D48–D51.
     *
     * ⚠ **Every number here comes from the PAYLOAD.** D60 §D1a: *"the client may
     * render; it may not analyze."* Windowing an already-ordered list for display
     * is rendering; DERIVING the numbers is not, so `why.ts` never counts the
     * array it was handed.
     */
    truncation: (from, to, total) => `Showing turns ${from}-${to} of ${total} that touched this file in this commit, in turn order.`,
    /** §R3's L2: files in the commit whose `turn_hash` is NULL are COUNTED, never dropped. */
    filesWithoutTurn: (count) => `${count} more files in this commit have no linked turn.`,
    /** The one-file form. `1 more files` is the tell that a count was never read. */
    fileWithoutTurn: "1 more file in this commit has no linked turn.",
    // --- Usage. §13.7: a bad argument is exit 2, never exit 1. ---
    usageWhat: "This command needs a file and a line number.",
    usageWhy: "`why` answers for one line, so it cannot run without one. Nothing was read and nothing was sent.",
    usageFix: "Name the file and the line:",
    /**
     * `--json` — the REFUSAL COPY THAT STOOD HERE IS GONE, and its removal is the
     * deliverable rather than a tidy-up (`CR-149`, D122 §2).
     *
     * It read *"`why` cannot produce JSON yet"*, and its docblock argued the
     * refusal was *"the honest minimum rather than a gap"*. That was honest as a
     * STOPGAP and false as a claim about design intent: **§13.3 REQUIRES `--json`
     * on the read verbs**, so the flag was an UNBUILT FEATURE wearing the shape of
     * a designed position — which is the harder defect to see, because a refusal
     * reads as a decision. `src/json.ts` is the document; `status`, `why` and
     * `report` all emit one.
     *
     * Nothing replaces these three constants. A verb that CAN answer the flag has
     * no refusal to word.
     */
    /**
     * The shallow-clone REFUSAL (D67's posture, D98's hazard class).
     *
     * ⚠ A REFUSAL IS NOT AN ABSENCE. `git blame` on a shallow clone attributes to
     * the graft boundary and returns a plausible WRONG commit — a call that fails
     * announces itself; a call that returns a plausible answer is absorbed by the
     * caller. Shallow clones live in CI containers, which is exactly where nobody
     * is watching. The `ABSENCE` docblock already rules on this for `report`: it
     * is not a sixth state and one may not be written there.
     */
    shallowWhat: "This is a shallow clone, so `git blame` cannot be trusted here.",
    shallowWhy: "A shallow clone stops at its graft boundary and attributes every older line to the oldest commit it holds. That answer looks ordinary and is wrong, so it is refused rather than shown.",
    shallowFix: "Fetch the full history, then run this again:",
    shallowFixCommand: "git fetch --unshallow",
    /** `git blame` itself failed — no such file, no such line, or git said no. */
    blameWhat: "`git blame` could not attribute that line.",
    blameWhy: "git did not return a commit for it. The path may not be tracked in this repository, or the file may have fewer lines than the one named.",
    blameFix: "Check the path and the line, then run this again:",
    // --- The read lane. Every arm renders; none exits 0 silent (D61 round 3 §D8). ---
    /**
     * ⚠ A READ-LANE FAILURE MUST PRINT AND EXIT NON-ZERO. The whole reason the
     * exit contract was split is that the hook rule — exit 0, stdout empty — would
     * have made this verb fail SILENTLY on a 5xx. `src/exit.ts` says so at the top.
     *
     * ⚠ And never a bare HTTP status (§13.6). The status is what we know; it is
     * not what the user can act on.
     */
    unreachableWhat: "VibeCommit could not reach the record service.",
    unreachableWhy: "The request did not complete, so no answer was read. The service may be down, or this machine may have no route to it.",
    serverErrorWhat: "The record service could not answer that.",
    serverErrorWhy: "The request reached the service and it returned a failure instead of a record. Nothing on this machine was changed.",
    malformedWhat: "The record service returned an answer this version cannot read.",
    malformedWhy: "The response was not in the form this version expects, so none of it was rendered rather than part of it being guessed at.",
    readFix: "Try again, and report it if it continues:",
    /**
     * ⛔ VERSION SKEW — DISTINCT FROM `malformed`, AND THE DISTINCTION IS THE
     * WHOLE POINT (`U1`, 2026-08-30).
     *
     * `parseBlameCommitPayload` is a STRICT ALLOWLIST on `state`: a value it does
     * not know returns null, and null rendered as "malformed". So the day the
     * server added a state, every client older than that day told the user its
     * ANSWER WAS BROKEN — when the answer was fine and the CLIENT was old.
     * `edge_unreadable` is the first such addition and it would have been the
     * first casualty.
     *
     * ⚠ THE ROOT CAUSE, NOT THE SYMPTOM. Without this, every future state the
     * server adds needs a lockstep client release FOREVER, and the coupling is
     * invisible until a user hits it — worse here than in most protocols, because
     * the vendored bundle in `claude-plugin/bin/` lags this source (10 commits at
     * the time of writing) so "old client" is the NORMAL case, not the edge one.
     *
     * ## Why this is not a sixth ABSENCE state
     *
     * It is not an absence. Nothing is missing from the record — the server
     * answered, and this build cannot render what it said. Same reason the
     * shallow-clone refusal is not one: a REFUSAL and a SKEW are both about this
     * client's limits, and `ABSENCE` is about the record's contents.
     *
     * ⚠ It still follows CR-112's grammar (absence · cause · remedy), because
     * that grammar is what makes a dead end actionable, and here — unlike most of
     * `ABSENCE` — the remedy is real: upgrading genuinely fixes it.
     *
     * ⚠ THE COPY MAY NOT NAME THE STATE IT COULD NOT READ. The whole premise is
     * that this build does not know what that value means; printing it would
     * invite the reader to interpret a token this client cannot interpret either.
     */
    skewWhat: "The record service sent an answer this version is too old to show.",
    skewWhy: "The service described this commit in a way this build does not recognise. The record itself is fine — this copy of the client cannot render it, so it showed nothing rather than guessing at part of it.",
    skewFix: "Reinstall the VibeCommit plugin to pick up the current client, then run this again:",
    /** The bearer is dead after one refresh and one retry. Exit 3, not 1. */
    signedOutWhat: "This machine is not signed in to VibeCommit.",
    signedOutWhy: "Reading a record needs a signed-in user, and no usable sign-in was found on this machine.",
    signedOutFix: "Sign in, then run the command again:",
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
    // --- D67's THREE-PART UNIT. They render TOGETHER OR NOT AT ALL. ---------
    /**
     * ⚠ **THE DEFINITION IS PART OF THE NUMBER, NOT A PREFACE.** D67 cleared
     * §PS6's durability block on stated terms, and the first is that the
     * definition, the percentage and the grade mix render together — *"without
     * them, `observed` correlation-in-time is laundered into a KPI."* A build
     * that ships the number alone does not lift the block.
     *
     * ⚠ **THE REF IS IN THE SENTENCE, ALWAYS** — *"a bare percentage is
     * meaningless because the number is ref-relative."* `commit_coverage` makes
     * `ref` a REQUIRED payload field for exactly this reason.
     */
    definition: (ref) => `Coverage is the share of the commits we hold a recorded session for that are still reachable from ${ref}.`,
    rate: (reachable, held, ref, percent) => `${reachable} of ${held} commits with a recorded session are still reachable from ${ref} (${percent}%).`,
    /** §10.3 draws `Of those:` and then the per-grade split. */
    gradeMixIntro: "Of those:",
    /**
     * ⚠ **THE GRADE WORDS THEMSELVES MAY NOT REACH THE SCREEN**, so the mix is
     * rendered through these labels — DESIGN.md §13.3 (grade words in `--json`
     * only), D65 §DR4 (no grade word on screen), and `test/why.test.ts` already
     * enforces it for the other read verb.
     *
     * ⚠ §10.3's DRAWING VIOLATES THAT RULE and this deliberately departs from it:
     * it draws *"41 observed during a session"*, which prints the bare grade
     * word. D113 §1 makes it worse than a style slip — `observed` is BLOCKED
     * because it names **a mechanism that exists in no repo**, and its listed
     * phrasings include *seen during the session* and *watched*, which are the
     * two shortenings anyone would reach for next. The `observed` label below
     * mirrors `grades.ts`'s own approved sentence, *"This commit appeared while
     * the session was running"*, which says the same fact and claims no witness.
     * The §10.3 fix is owed in `code/` and is not this package's to write.
     */
    // ⚠ FLAT KEYS, NOT A NESTED OBJECT, AND THAT IS A GATE CONSTRAINT RATHER
    // THAN TASTE. `src/copy/claims.ts`'s walker calls `toLowerCase()` on every
    // value it reaches, so a nested object under an exported copy block throws
    // `text.toLowerCase is not a function` and takes the whole claims suite with
    // it. Found by running it, not by reading the walker. Flat keys stay inside
    // the gate; `claims.ts` is fenced this wave (`CR-132d`, W11) and the copy is
    // what moves, not the checker.
    gradeDerivedLabel: "recorded in the transcript",
    gradeObservedLabel: "appeared while the session ran",
    gradeDeclaredLabel: "reported by the agent",
    /** `<n> <label>`, joined by the renderer. Singular and plural read alike. */
    gradeCount: (count, label) => `${count} ${label}`,
    /**
     * ⚠ **THE SEPARATE LABELLED LINE, IN OUR WORDS** — D67: *"only exact
     * `commit_sha_successors` rows count toward the numerator; patch-id matches
     * render as a SEPARATE LABELLED 'probable' LINE and are never folded into the
     * rate."*
     *
     * ⚠ **AND IT IS NOT THE SERVER'S SENTENCE.** `vibecommit-mcp`
     * `src/read/coverage.ts` emits `probable_line.label` — a user-facing string
     * minted in another repository, on this payload. D112 §3 ruled on exactly
     * that shape: **the wire carries the fact, the client owns the words.** That
     * ruling was measured in `src/read/blame.ts` and the class is NOT closed one
     * file over, so this renders here and the wire's label is never printed.
     */
    probable: (count) => `${count} more matched by patch id, reported separately and not counted above.`,
    probableOne: "1 more matched by patch id, reported separately and not counted above.",
    // --- The refusals. A refusal is not an absence and not a sixth state. ---
    /**
     * ⚠ **A SEPARATE PHRASING FROM `WHY.shallowWhat`, AND THE REASON IS THAT IT
     * IS A DIFFERENT FACT.** `why`'s says *"`git blame` cannot be trusted here"*,
     * which is true of blame and says nothing about reachability. On a shallow
     * clone the commits that would answer *"is this sha still reachable"* may
     * simply not be present, so the rate would be wrong rather than missing. The
     * REMEDY is genuinely the same fact, so `shallowFix` and `shallowFixCommand`
     * are SHARED rather than re-worded — that is the duplication to avoid.
     */
    shallowWhat: "This is a shallow clone, so coverage cannot be computed here.",
    shallowWhy: "Coverage asks which recorded commits are still reachable, and a shallow clone does not hold the history that answers it. The number would be wrong rather than missing.",
    /**
     * ⚠ FAILS CLOSED. If git cannot answer reachability for a commit we hold, the
     * rate would be computed over a set we do not actually know — so it refuses.
     * Counting an unanswerable probe as unreachable would DEFLATE the number
     * silently, which is D98's class: no obviously-broken shape.
     */
    unknownReachabilityWhat: "Coverage could not be computed for every recorded commit.",
    unknownReachabilityWhy: "Git could not say whether some recorded commits are still reachable from this ref. A share computed over the rest would be a smaller number presented as a complete one.",
    unknownReachabilityFix: "Fetch the full history, then run this again:",
    refWhat: "This command needs a ref it can name.",
    refWhy: "Coverage is relative to a ref, so the answer is meaningless without one, and HEAD is detached here. Nothing was read and nothing was sent.",
    refFix: "Name the ref:",
    /**
     * The window, as the two empty states name it.
     *
     * ⚠ **THE WINDOW BOUNDS THE LOCAL HALF ONLY.** `commit_coverage` accepts no
     * `since`, so the server's totals are repository-wide and the RATE claims no
     * window — see `report.ts`. This string appears only on the two empty states,
     * which are answered from the clone.
     */
    window: (since) => `the window since ${since}`,
    usageWhat: "This command needs a start date.",
    usageWhy: "The window bounds which commits are counted, so the answer is not defined without one. Nothing was read and nothing was sent.",
    usageFix: "Name the date the window starts:",
    sinceWhat: "That start date could not be read.",
    sinceWhy: "The window must be a calendar date, written as YYYY-MM-DD. A date git cannot read would silently widen the window.",
    sinceFix: "Write the date as YYYY-MM-DD:",
};
export const ABSENCE = {
    /**
     * 1 — COLD START. Owner: `CR-086` (W9), and `CR-086` CORRECTED ITS SCOPE.
     *
     * ## ⚠ It said MACHINE; the state it names is a REPOSITORY
     *
     * The shipped text was *"No sessions have been recorded on this MACHINE
     * yet"*, and neither half of that survived measurement. `why`'s answer is
     * repository-scoped — the payload that selects this state answers for one
     * repo — and a developer with capture running in three repos and none here
     * would have been told capture had never run at all. Nothing in the client
     * holds a machine-wide "never captured" fact either: `state.ts` keys sends by
     * project.
     *
     * ## Why it does not render §10.6-A's two extra facts, and that is deliberate
     *
     * §10.6-A and §R3 draw *"That commit predates capture on this repo (first
     * capture 2026-08-08). … 14 commits captured since."* **Both numbers are
     * facts this client does not hold.** `state.ts` records `lastSendForRepo` —
     * the LAST send, never a FIRST-capture date — and the commit count is
     * `commit_coverage`'s, a server figure behind `CR-085`. D81's order applies:
     * make the claim honest before building the mechanism.
     *
     * So the state says the thing that IMPLIES §10.6-A's headline without
     * asserting either number: **if no session was ever recorded for this
     * repository, then every commit in it predates capture** — including this
     * one. That is §10.6-A's meaning, carried by a fact the payload can state.
     * The date and the count are registered as owed (see the PR) rather than
     * approximated, because a first-capture date guessed from a last-send record
     * is D98's plausible-wrong-answer class exactly.
     *
     * ⚠ NO SIXTH STATE WAS ADDED, and none may be: `test/copy-absence.test.ts`
     * asserts the EXACT set of five.
     */
    coldStart: {
        what: "No session has been recorded for this repository yet.",
        why: "Capture has not sent anything for this repository, so no commit in it has a conversation record — including this one.",
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
    /**
     * 6 — EDGE UNREADABLE. ⛔ THE SET IS NOW SIX, AND THIS IS THE FIRST ADDITION.
     * Owner: `U1`. ⛔ **FOUNDER-RATIFIED, 2026-08-31 — `D203`.** Not an
     * implementer's judgement call: three independent tripwires forbade a sixth
     * state, they all fired, and the decision to clear them was put to the
     * founder and ruled rather than argued past. `D203` carries the reasoning and
     * the cost that was spent (reversibility — a field promotes to a state later,
     * a shipped state does not un-ship).
     *
     * ⚠ The tripwires are CLOSURE TRIPWIRES, not a cap, and they did exactly what
     * they exist for: this state could not enter the set without a reviewer being
     * made to read the argument for it.
     *
     * ## ⚠ THIS IS THE ONE ABSENCE STATE THAT IS NOT AN ABSENCE OF RECORD
     *
     * The other five say some version of "we hold nothing here". This one says
     * the OPPOSITE: **we hold a link for this commit and could not render the
     * conversation behind it.** Reading it as "no session" inverts it.
     *
     * It exists because mcp used to return `no_edge` for this case, which
     * reported "this repository is captured and this commit has no linked
     * session" about a commit we demonstrably hold a link for — a false negative
     * on the only question `why` asks. `blame.ts` now emits `edge_unreadable`
     * and this is its rendering.
     *
     * ⚠ IT IS THE DIRECT-EDGE TWIN OF `squashResolved`, which already carries
     * exactly this shape one hop later (a mapping we resolved whose evidence will
     * not render). Same fact, different route to it. That symmetry is the reason
     * this is a sixth state rather than a caveat note: `attributionNote`'s shape
     * is a caveat on a screen WITH content, and this screen has none.
     *
     * ## ⚠ THE `fix` MAY NOT PROMISE A REPAIR
     *
     * CR-112 requires the remedy to say what would CHANGE the state, and here the
     * honest answer is often "nothing the reader can do": if the turn content was
     * erased, or was never uploaded, the evidence is gone and the link stays.
     * Saying "re-run capture" would be a plausible-wrong-answer (D98) — it
     * repairs neither case. So the line states the two conditions and stops.
     *
     * ⚠ NOT "corrupt", "lost", or "missing data" — all three are diagnoses of a
     * cause this client did not measure. What we know is that the server held a
     * link and returned no readable turns; the reason is the server's and is not
     * on the wire.
     */
    edgeUnreadable: {
        what: "A recorded session is linked to this commit, but its conversation could not be read.",
        why: "The link between this commit and a session is on record. The turns behind that link came back without readable content, so there is a record here and no conversation to show for it. This is a gap in what can be displayed, not a missing link.",
        fix: "Nothing to fix from here. Turn content can be unreadable because it was erased on request or was never uploaded, and neither is repaired by re-running capture.",
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
    /**
     * `CR-216/U4`. The fix COMMAND is named here rather than left to the caller,
     * because the caller passed `COMMANDS.connect` and `connect` has never written
     * the credential file — "reconnecting" re-read the same bad bytes and printed
     * the same fault. Every credential fix now names a verb that can change the
     * thing being complained about, and `credential-fix-copy.test.ts` enforces it.
     */
    wrongClassFix: "Save a fresh one for this machine:",
    wrongClassCommand: "vibecommit auth",
    insecureFileWhat: "The credential file is readable by other accounts on this machine.",
    insecureFileWhyLabel: "file",
    insecureFileModeLabel: "mode",
    insecureFileWhy: "It was not read. A credential file must be readable only by its owner.",
    insecureFileFix: "Restore the mode, then reconnect:",
    unreadableWhat: "The credential file could not be read.",
    unreadableWhy: "It exists but does not contain a credential in the expected form.",
    /** `CR-216/U4`. Was "Replace it by reconnecting:" — see `wrongClassFix` above. */
    unreadableFix: "Replace it:",
    unreadableCommand: "vibecommit auth",
};
/**
 * `vibecommit auth` — `CR-216/U2`, D206.
 *
 * The verb that gives `credentials.json` a producer. Until it existed the file
 * had a reader, a permission check and a `chmod` instruction in this very object
 * (`TROUBLESHOOTING.chmodCredentials`) and nothing that ever wrote it.
 *
 * ⚠ `argvWhy` IS THE ONE LINE HERE THAT HAS TO BE EXACT. It is not a usage
 * scolding — it tells a user who already typed the secret that it is now in
 * their shell history, which is a thing they must go and act on. Softening it to
 * "invalid usage" would leave a live credential in `.zsh_history` with the user
 * believing the command simply failed. It names the two channels and no more:
 * this package does not know which shell they run or whether history is on.
 *
 * No reassurance adjectives anywhere below (D65 §DR7) — nothing here is called
 * secure, safe, protected or encrypted. The mode is stated as a fact instead.
 */
export const AUTH = {
    /** Trailing space: a prompt, not a sentence. Reaches a TTY only. */
    prompt: "Ingest credential for this machine: ",
    savedWhat: "Credential saved for this machine.",
    /** `mode 0600` stated, never adjectives. §13.6's `why` shape. */
    savedWhy: (path) => `Written to ${path}, mode 0600.`,
    nextLabel: "Next, connect a repository:",
    nextCommand: "vibecommit connect",
    emptyWhat: "No credential was given.",
    emptyWhy: "Nothing was read, so nothing was written.",
    emptyFix: "Mint one, then run:",
    wrongClassWhat: "That is not a VibeCommit ingest credential.",
    wrongClassWhy: `An ingest credential begins ${INGEST_TOKEN_PREFIX}. Nothing was written and nothing was sent.`,
    wrongClassFix: "Mint one, then run:",
    argvWhat: "A credential must not be passed as an argument.",
    argvWhy: "Arguments are written to your shell history and are readable by other processes on this machine while the command runs. Treat the one you just typed as exposed and revoke it.",
    argvFix: "Read it from the terminal, or from a pipe:",
    argvFixPrompt: "vibecommit auth",
    argvFixStdin: 'printf %s "$TOKEN" | vibecommit auth --stdin',
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
    /** `CR-216/U2`. The only verb that writes this machine's ingest credential. */
    auth: "vibecommit auth",
    /** `CR-084d`. A FLAG, not a verb — `--help`'s verb list and its golden file do not move. */
    signIn: "vibecommit connect --sign-in",
    status: "vibecommit status",
    /**
     * `CR-108`. The ARGUMENT SHAPE, shown once so the usage error and the retry
     * fix line cannot drift apart — the same convention `why` uses.
     */
    report: "vibecommit report --since 2026-07-08",
    /** The ref form, for the detached-HEAD refusal. */
    reportRef: "vibecommit report --since 2026-07-08 --ref main",
    off: "vibecommit off",
    /**
     * `CR-086`. The ARGUMENT SHAPE, shown once so the usage error and the retry
     * fix line cannot drift apart. There is no argument parser in this package —
     * `connect` reads `argv.includes("--sign-in")` and that is the whole
     * convention — so `file:line` is the smallest shape that satisfies the
     * verbatim-approved `--help` sentence, and it is the form editors and `grep`
     * already print.
     */
    why: "vibecommit why src/auth/session.ts:47",
    chmodCredentials: "chmod 600 ~/.vibecommit/credentials.json",
    /**
     * ⛔ THE INSTALL COMMAND, TRANSCRIBED FROM `claude-plugin/README.md:12` — and
     * it is deliberately NOT an invented update verb (`U1`, 2026-08-30).
     *
     * The skew remedy wants "get a newer client". There is **no documented update
     * command anywhere in this product**: grepped `claude-plugin/README.md`, its
     * manifests, and this package — the README documents `marketplace add` and
     * `install`, and nothing else. Printing `/plugin update vibecommit` because it
     * reads plausibly is D98's class exactly: a command-shaped string that may not
     * exist, handed to a user who is already stuck.
     *
     * So the fix line names the install command that IS documented, and
     * `WHY.skewFix` is worded as REINSTALL rather than update, which is true of
     * this string. ⚠ If a real update verb is ever documented, change both
     * together — the wording and the command are one unit.
     */
    pluginInstall: "/plugin install vibecommit@vibecommit-capture",
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