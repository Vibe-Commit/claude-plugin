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
        // `CR-216/U2`. FIRST in the list by habit, not by sequence: that "nothing for `connect` to use until
        // this has run" reason has been false since `CR-226` (`connect` signs in itself on a machine with no
        // credential). `connect` is the golden path; this verb renews or replaces the credential, and on a terminal it
        // then continues into `connect` — inside a git work tree, or (0.7.0, D32) outside one on a machine that captures
        // nothing yet. With `--stdin` or no terminal it saves the credential and stops there.
        auth: "Renew or replace this machine's credential. On a terminal it then goes on to connect: in a git repo, or on a machine that captures nothing yet. Otherwise it only saves the credential.",
        // 0.7.0 (D34): from any folder. A repo with a remote is chosen in the picker; a repo with no remote keeps the old flow.
        connect: "Choose the repositories to capture, from any folder, and connect them. On a machine with no credential it signs you in after you say yes, unless you choose g, which signs in first to read your account's grants.",
        // `D33 · 27A`. A public verb so an AI agent can list capturable repos without entering a consent
        // flow. It opens no session file and changes no setting, which is what lets it be run before `connect`.
        // ⚠ NOT "changes nothing" (PR 1 F1): opening Codex's index read-only makes SQLite create its own
        // `-wal`/`-shm` journal files beside it, as any SQLite reader does, so the line claims only what is true.
        scan: "List the repositories coding agents have been used in on this machine. Uploads nothing and changes no setting.",
        // `D14`/`D15`. Offered by `connect` too. Asks first (default N) and says what it will not do.
        backfill: "Upload earlier coding-agent sessions still on this machine, for the repositories you chose. Asks first; no commit links.",
        status: "Show whether capture is on for this repo, or for this machine outside a repo, and when it last succeeded.",
        off: "Stop capturing for this repo.",
        // VERBATIM-APPROVED (D61 §PS6). Any reword needs a new claims-register row.
        why: "Show the conversation turns recorded against the commit that last changed this line.",
        report: "Summarise capture coverage over a time window.",
        // `TODOS[146]`. Typed by a person or a script AFTER a one-shot run, so it is in the list.
        finalize: "Close a finished session's last turn so commits made in it can be recorded.",
    },
    docsUrl: "https://vibecommit.ai/docs/what-we-upload",
    /**
     * PR 6 item 2 (devex review): what `<verb> --help` prints BEYOND the one sentence above, which stays the first
     * paragraph. Agents read `--help` first, and until now the flags and exit codes existed only in the README.
     *
     * ⚠ Every flag here is one the verb's own argv reader acts on (`src/index.ts`, and each verb's parser), and every exit
     * code is one the verb returns (`src/exit.ts`). A flag the verb ignores, or a code it never returns, would be copy no
     * gate can check, so `test/verb-help.test.ts` ties each list to the source it describes.
     */
    verbs: {
        connect: {
            usage: "vibecommit connect [--device] [--sign-in] [--typed]",
            options: [
                ["--device", "Sign in with a code approved on another device, for a machine with no browser."],
                ["--sign-in", "Sign in through the browser before connecting."],
                ["--typed", "Use the typed prompt even on a terminal, for a screen reader."],
            ],
            exits: [
                ["0", "Done."],
                ["1", "Failed, or a replacement credential was declined."],
                ["2", "Bad arguments, or no person at a terminal to answer the consent question."],
                ["3", "Not connected: this machine's credential is not accepted."],
            ],
        },
        auth: {
            usage: "vibecommit auth [--stdin | --paste | --device]",
            options: [
                ["--stdin", "Read the credential from standard input and stop after saving it."],
                ["--paste", "Skip the browser and paste a credential made in Settings."],
                ["--device", "Sign in with a code approved on another device."],
            ],
            exits: [
                ["0", "Credential saved."],
                ["1", "Nothing was saved."],
                ["2", "Bad arguments, such as a credential passed as an argument."],
            ],
        },
        scan: {
            usage: "vibecommit scan [--json]",
            options: [["--json", "Print one JSON document instead of text."]],
            exits: [
                ["0", "Repositories found."],
                ["4", "None found."],
            ],
        },
        backfill: {
            usage: "vibecommit backfill",
            options: [],
            exits: [
                ["0", "Done, declined at the question, or interrupted with Ctrl+C. Sessions held for an organization's approval count as done."],
                ["1", "The server stopped the run, could not be reached or refused this machine's credential, or it could not run. Nothing already sent is lost; run it again to resume."],
                ["2", "No terminal, or an argument was given."],
                ["3", "Not connected."],
                ["4", "Nothing to upload."],
            ],
        },
        status: {
            usage: "vibecommit status [--json]",
            options: [["--json", "Print one JSON document instead of text."]],
            exits: [
                ["0", "Reported."],
                ["1", "Failed."],
                ["2", "Bad arguments."],
                ["3", "Not connected."],
            ],
        },
        why: {
            usage: "vibecommit why <file>:<line> [--json]",
            options: [["--json", "Print one JSON document instead of text."]],
            exits: [
                ["0", "Answered."],
                ["1", "Failed."],
                ["2", "Bad arguments."],
                ["3", "Not connected."],
            ],
        },
        report: {
            usage: "vibecommit report --since <date> [--ref <ref>] [--json]",
            options: [
                ["--since", "Start of the window, as YYYY-MM-DD. Required."],
                ["--ref", "The branch or commit to count. Default: the current branch."],
                ["--json", "Print one JSON document instead of text."],
            ],
            exits: [
                ["0", "Reported."],
                ["1", "Failed."],
                ["2", "Bad arguments."],
                ["3", "Not connected."],
                ["4", "The window is empty: nothing to report."],
            ],
        },
        finalize: {
            usage: "vibecommit finalize --session <id> | --latest [--force]",
            options: [
                ["--session", "The session to close."],
                ["--latest", "The most recent session, when only one is recent."],
                ["--force", "Skip the check that the transcript has stopped changing. Only for a session that is over."],
            ],
            exits: [
                ["0", "Closed: the server confirmed the last turn is recorded."],
                ["1", "Not confirmed closed: not a git repository, a transcript that cannot be read, a credential that is no longer accepted, or a delivery that failed."],
                ["2", "Nothing was sent: bad arguments, an unknown or still-running session, or several recent sessions for --latest."],
                ["3", "Not connected: this repo is not captured, or this machine has no credential."],
                ["5", "Delivered, but the server did not confirm it. Treat it as not closed."],
            ],
        },
    },
    /** The two section labels of a verb's help. */
    optionsLabel: "Options:",
    /** A verb with no flags of its own (`backfill`) says so under the label, so "Options:" never sits over nothing. */
    noOptions: "None. It takes no arguments.",
    exitCodesLabel: "Exit codes:",
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
    /**
     * The unknown-verb block (PR 7, Q6: `UNKNOWN_COMMAND`, routed through the shared renderer). The help text is no longer
     * dumped after it, so the fix — the way to the list of commands — is the last thing on screen. The verb is whatever
     * the user typed, so it is cut to a length the line can hold.
     */
    unknownCommandWhat: (verb) => `\`${verb.length > 40 ? `${verb.slice(0, 39)}…` : verb}\` is not a vibecommit command.`,
    unknownCommandFix: "See the commands:",
    unknownCommandHelp: "vibecommit --help",
};
/** `vibecommit status` (CR-021). */
/**
 * `323,147`. The locale is PINNED: the host's would make the same state render
 * two ways on two machines, and a byte count is a number a user may paste.
 */
const BYTE_COUNT = new Intl.NumberFormat("en-US");
/**
 * `TODOS[184]` — up to 3 session ids, then "and N more." Shared by `STATUS.liveStuck`/`heldIdle` so the
 * naming rule lives in exactly one place. The id named here is the state-file STEM, not necessarily the
 * raw session id (`paths.ts`'s `sanitise`: `[^A-Za-z0-9._-]` → `_`, truncated to 128 chars) — an exotic id
 * and its stem can differ, but `finalize --session <stem>` still fails SAFELY on a mismatch
 * (`FINALIZE.unknownSession`/`transcriptMissing`) rather than ever finding a different real session by
 * accident, because the lookup is an exact file match. Claude Code's own ids are UUIDs, so stem === id.
 */
function namedIds(ids) {
    if (ids.length === 0)
        return "";
    const shown = ids.slice(0, 3).join(", ");
    return ids.length > 3 ? `${shown} and ${ids.length - 3} more` : shown;
}
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
    /** 0.7.0, D6 · 2A: why this repo is on. One row under `repo`, only inside a repo that is on. */
    basisLabel: "basis",
    basisOwner: (owner) => `owner grant ${owner}/`,
    basisRepo: "repo grant",
    basisClone: "per clone",
    /**
     * Slice 2 (S4), brief §3.3: inside a repo that is NOT on, the account may still grant it. The account never admits a repo on
     * its own (R3-22): naming it here is `connect`'s picker, and the action row already offers `connect`.
     */
    basisAccountOnly: "granted on your account, not on this machine",
    /**
     * Slice 2 (S4), brief §3.3: the machine screen's account rows, after `off` and before `held`. `on account` lists what the
     * user's account grants that THIS machine has not named (an owner as `owner/`); the second line says what to do about it.
     */
    accountLabel: "on account",
    accountNotHere: (connect) => `not on this machine · to capture them here, run: ${connect}`,
    /** Changes queued for the account that no sync has delivered yet. They go out with the next sync; only `connect`, `status`, `off` and a terminal `auth` sync. */
    pendingLabel: "pending",
    pendingValue: (n) => `${n} ${n === 1 ? "change" : "changes"} not yet sent to your account · sent at the next sync`,
    /**
     * VQ's ruling (ii): a queued change the server refused with 400 is kept (a consent statement is never dropped) but a retry
     * fails again, so this row does not say "the next command retries". The URL is the one the web app's error state uses.
     */
    pendingRejectedValue: (n) => `${n} ${n === 1 ? "change" : "changes"} your account didn't accept · report this: github.com/Vibe-Commit/claude-plugin/issues`,
    /**
     * The first sync uploads what this machine already named (per-clone consents made under 0.6.x/0.7.0 reach the account, R3-21).
     * Slugs only, never paths; more than three names shows two and "and N more", and the full list follows, one per line. The names arrive as ONE string, a name per line, because the copy corpus renders every template with string arguments.
     */
    accountSaving: (namesOnePerLine) => {
        const names = namesOnePerLine.split("\n");
        return `Saving this machine's repository choices to your VibeCommit account: ${names.length > 3 ? `${names.slice(0, 2).join(", ")} and ${names.length - 2} more` : names.join(", ")}.`;
    },
    /** The machine-level screen (any folder that is not a work tree). */
    offMachine: "Capture is not on for any repository on this machine.",
    ownersLabel: "owners",
    reposLabel: "repos",
    offLabel: "off",
    /**
     * Machine-level `status`: the repos whose own last upload was refused because their org has not approved capture. §10.2's held
     * vocabulary — the beat word `held`, and the backfill screen's "the org must approve capture" (Alexander, 2026-10-24 17:20).
     */
    heldLabel: "held",
    heldReason: "the org must approve capture",
    ownerTail: "all its repos, including ones you clone later",
    changeLabel: "Change what is captured",
    turnOffInside: "Turn one repo off, run inside it",
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
    /**
     * `CR-234d`, decision 12A: the same fact as the hook's state 5, in `status`'s own register — a sentence
     * after the rows, with the glyph turned `warn`. The date is absolute and in UTC.
     */
    credentialEnding: (date, authCommand) => `This machine's credential ends ${date}. Run \`${authCommand}\` to renew it.`,
    /**
     * 0.7.0. A `grants.json` that is present and unreadable denies capture for every clone that has a remote
     * (`consent.ts`'s `isCaptureAllowed`), and a hook cannot say so, so `status` does. The file name is the user's
     * to fix; `connect` is where the next consent lands once it is readable.
     */
    grantsUnreadable: (connect) => `~/.vibecommit/grants.json can't be read, so capture is stopped on this machine for every repository that has a remote. Fix the file or move it aside, then run \`${connect}\`.`,
    /**
     * 0.7.0, `SessionStart` (T21). `npm i -g` alone never adds the event to an agent's config, so a 0.6.x machine is
     * missing it until `connect` runs. Only said on the npm channel: the plugin ships its own `hooks.json`, and its
     * contract (no `SessionStart`, no git hooks) is unchanged.
     */
    sessionStartMissing: (agents, connect) => `${agents} will not add commit hooks to a new clone: VibeCommit's SessionStart hook is not registered there. Run \`${connect}\` to register it.`,
    /** 0.7.0, D4 · A. A hook the user deleted stays deleted; `connect` is the watched way back. */
    commitHooksOff: (connect) => `Commit hooks are off in this repository: sessions are captured, commits are not linked to them. Run \`${connect}\` here to add them.`,
    commitHooksForeign: (connect) => `This clone has its own commit hook, so VibeCommit's is not installed here. Run \`${connect}\` here to chain it.`,
    credentialShadowed: "VIBECOMMIT_TOKEN is set and takes precedence over the credential saved on this machine. Unset it to use the saved one.",
    /**
     * `CR-228`, `TODOS[142]` — bytes the client ADVANCED PAST without delivering.
     *
     * ⛔ Not an absence state, so not `ABSENCE`'s sixth: this reports something
     * that happened, with a number, rather than something that has not happened
     * yet. Written off means never re-offered — the sentence says so rather than
     * implying a retry. It names no cause because the counter records none.
     */
    writtenOff: (bytes, sessions) => `${BYTE_COUNT.format(bytes)} ${bytes === 1 ? "byte" : "bytes"} of transcript from ` +
        `${sessions === 1 ? "1 session" : `${sessions} sessions`} could not be sent and ` +
        "were skipped. They will not be sent later.",
    /**
     * `CR-228` — bytes a session ENDED still owing, which `SessionEnd` now keeps
     * instead of skipping. ⚠ Claims no recovery: whether this session's hooks
     * will fire again is not something the client can know, so the sentence says
     * what is true now and promises nothing about later.
     */
    heldAtEnd: (bytes, sessions) => `${BYTE_COUNT.format(bytes)} ${bytes === 1 ? "byte" : "bytes"} of transcript from ` +
        `${sessions === 1 ? "1 session that has" : `${sessions} sessions that have`} ended ` +
        "could not be sent and have not been sent since.",
    /**
     * `TODOS[145]`/`[146]` — a session that ENDED while its last turn was still open. The server seals a
     * turn only when a following prompt arrives, so nothing will ever seal this one and the commits made in
     * it cannot be recorded. States the consequence and the command; promises nothing about the commits.
     */
    openTail: (sessions, finalizeLatest) => `${sessions === 1 ? "1 session has" : `${sessions} sessions have`} ended with the last turn still ` +
        `open, so commits made in that turn are not recorded. Run \`${finalizeLatest}\` to close it.`,
    /**
     * `TODOS[145]` — commits the client has seen and is holding because no turn has closed yet. Normal
     * mid-session; shown as a fact, not as a fault.
     */
    commitsWaiting: (commits) => `${commits} ${commits === 1 ? "commit is" : "commits are"} waiting for a turn to close before ` +
        `${commits === 1 ? "it can" : "they can"} be recorded.`,
    /**
     * `TODOS[175]` — waiting commit lines that nobody could claim and that were discarded after 7 days. A COUNT only:
     * never a sha, never a session id. Shown for up to 7 days after the last discard, so a delete is not a non-event.
     */
    discardedStale: (lines) => `${lines} waiting commit ${lines === 1 ? "line" : "lines"} older than 7 days ${lines === 1 ? "was" : "were"} ` +
        `discarded (no session claimed ${lines === 1 ? "it" : "them"}).`,
    /**
     * `TODOS[177]` — squash pairs made with `git reset --soft` that were detected but never ended up recorded by the
     * server. `oversize`/`sha256` are never-spooled SQUASHES: more than 64 commits folded (the server's per-request
     * ceiling; a partial set of links is worse than none) or a sha256 repository (the server reads 40-hex only).
     * `set_aside`/`pruned` (VL, 2026-10-08, VG's silent-loss finding) are PAIRS that WERE spooled, at least once sent,
     * and never fully recorded: given up on after too many short acks, or discarded by the 7-day prune. All four are
     * COUNTS only, shown for up to 7 days after the last one — a skipped link is not a non-event.
     */
    inferredSkipped: (oversize, sha256, setAside, pruned) => {
        const squashes = (n, why) => `${n} ${n === 1 ? "squash" : "squashes"} made with git reset could not be linked (${why}).`;
        const pairs = (n, why) => `${n} ${n === 1 ? "pair" : "pairs"} from a squash made with git reset ${n === 1 ? "was" : "were"} ${why}.`;
        return [
            oversize > 0 ? squashes(oversize, "more than 64 commits") : "",
            sha256 > 0 ? squashes(sha256, "a sha256 repository") : "",
            setAside > 0 ? pairs(setAside, "given up on and discarded (the server kept acknowledging less than was sent)") : "",
            pruned > 0 ? pairs(pruned, "discarded after 7 days with no acknowledgement") : "",
        ].filter((x) => x !== "").join(" ");
    },
    /**
     * `TODOS[177]` follow-up (VG pre-review, 2026-10-08) — inferred pairs spooled right now, waiting on the
     * server's per-request ack (`x-rewrites-inferred-stored`) that has not yet confirmed them: an absent, short,
     * or mismatched ack keeps a group for the next hook rather than dropping it on a 2xx alone. A live count, not
     * a 7-day tally — it falls as soon as a later hook's ack confirms them.
     */
    inferredUnacknowledged: (n) => n === 0 ? "" : `${n} ${n === 1 ? "pair" : "pairs"} from a squash made with git reset ${n === 1 ? "is" : "are"} spooled, waiting for the server to confirm them.`,
    /**
     * `TODOS[182]` — commits/rewrites/inferred pairs held back because the server refused a full request and
     * this client is now sending a reduced (`lean`) one for the rest of the session. ONE sentence for both
     * triggers (a measured 431, or a request this client itself predicted would be too large to send) — they
     * set the same sticky flag, so the cause reads the same either way. Never "the server refused": that is
     * literally true only for the first, and a user cannot tell the two apart from this screen anyway. A live
     * count, not a 7-day tally — there is no prune for these files (`pending_prune.ts`), so nothing here ever
     * needs to survive past the data it describes.
     *
     * ⛔ **NAMES EACH PART, NEVER ONE BARE NUMBER** (VG's B1, VL's V3 ruling). `commits_waiting` and
     * `inferredUnacknowledged` exclude a lean session's data entirely now, so this is the ONE place it is
     * counted — folding three different nouns into one number (an earlier draft's "11 pairs" for 7 commits
     * plus 4 pairs) would misname most of what it is reporting.
     */
    leanHeld: (commits, rewrites, inferred) => {
        const parts = [];
        if (commits > 0)
            parts.push(`${commits} ${commits === 1 ? "commit" : "commits"}`);
        if (rewrites > 0)
            parts.push(`${rewrites} ${rewrites === 1 ? "rewrite pair" : "rewrite pairs"}`);
        if (inferred > 0)
            parts.push(`${inferred} ${inferred === 1 ? "inferred pair" : "inferred pairs"}`);
        if (parts.length === 0)
            return "";
        const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
        const verb = parts.length === 1 && commits + rewrites + inferred === 1 ? "is" : "are";
        return `${list} ${verb} held because the full request was too large to send; not sent.`;
    },
    // ⛔ NO `inferredSetAside` SENTENCE HERE (VL, 2026-10-08, VG's double-count finding, item (b)): it duplicated the
    // `inferredSkipped` sentence's `set_aside` clause above — same pairs, two sentences. Removed, not kept dead:
    // nothing in `status.ts` calls it any more, and a copy function with no caller is the thing this package's own
    // dead-symbols gate exists to catch.
    /**
     * `TODOS[184]` — a LIVE session (a hook fired inside `SESSION_LIVE_WINDOW_MS`) whose oldest unclaimed
     * backlog span has ITSELF survived that same window: it has been retried at least a full turn's worth
     * and still has not gone out. `stuckSpoolLinesForRepo`'s commit count is named here instead of in
     * `commitsWaiting` for exactly these sessions (VG's S8 fix) — one fact, one line.
     *
     * ⛔ **NAMES ONLY THE OLDEST SPAN'S AGE, NEVER EVERY BYTE'S** (VG's N1). An earlier draft said every
     * byte/commit "has not been sent in over 30 minutes," which is false for anything newer than the
     * oldest held span in a session that keeps producing new backlog while stuck. This sentence sums all
     * of it (the whole fact is worth reporting at once) but only claims the ONE thing that is actually true
     * of the whole: the oldest has waited that long.
     *
     * No promised outcome (VG's D2): `enforceCaps`'s existing 24h age cap runs on the next attempt
     * regardless of what this sentence says, so "keeps retrying" states what happens now, not a guarantee
     * about later.
     */
    liveStuck: (bytes, sessions, commits, ids = []) => {
        const who = `${sessions} live ${sessions === 1 ? "session" : "sessions"} (${namedIds(ids)})`;
        const commitsClause = commits > 0 ? `, including ${commits} ${commits === 1 ? "commit" : "commits"}` : "";
        return (`${BYTE_COUNT.format(bytes)} ${bytes === 1 ? "byte is" : "bytes are"} held from ${who}${commitsClause}; ` +
            "the oldest has waited over 30 minutes. Capture keeps retrying; anything held past 24 hours is written off instead.");
    },
    /**
     * `TODOS[184]` — a session no hook has touched in over `SESSION_LIVE_WINDOW_MS`: nothing is coming to
     * retry it on its own. The remainder `heldAtEndForRepo` does not already own (VG's D1) and that is not
     * covered by `liveStuck` because the session itself has gone quiet, not just one span.
     *
     * ⛔ **NEVER PROMISES `finalize` WILL SUCCEED** (VG's N2). An earlier draft said `finalize --session
     * <id>` "sends them and closes it" — but a failed send closes NOTHING (`FINALIZE.notDelivered`:
     * "Could not deliver the session. Nothing was closed."). "Tries to send them and, if that works,
     * closes it" is true on both outcomes. Gated on "if that session is finished": `held_idle` alone
     * cannot tell a crashed session from one idle at lunch, and closing a session still in progress seals
     * a turn that was not actually over.
     */
    heldIdle: (bytes, sessions, commits, finalizeSession, ids = []) => {
        const who = sessions === 1 ? `session ${namedIds(ids)}` : `${sessions} sessions (${namedIds(ids)})`;
        const commitsClause = commits > 0 ? `, including ${commits} ${commits === 1 ? "commit" : "commits"}` : "";
        const action = sessions === 1
            ? `If that session is finished, \`${finalizeSession} ${ids[0]}\` tries to send them and, if that works, closes it`
            : `If a session above is finished, \`${finalizeSession} <id>\` tries to send its bytes and, if that works, closes it`;
        return (`${BYTE_COUNT.format(bytes)} ${bytes === 1 ? "byte" : "bytes"} held from ${who}${commitsClause}, with no hook in over 30 ` +
            `minutes. ${action}; anything held past 24 hours is written off instead.`);
    },
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
    consentHeading: "VibeCommit uploads your coding-agent transcripts for this repo.",
    /**
     * D23 · 17A: the picker path's heading (every `connect` that shows the picker, in a repo or not). `consentHeading`
     * above remains only on the no-remote (`local:`) in-repo path, where there is nothing to pick (D35 · 29A: "Claude
     * Code transcripts" understated what uploads once `connect` also wired Codex and Cursor hooks, 0.2.0).
     */
    consentHeadingPicker: "VibeCommit uploads your coding-agent transcripts for the repositories you choose.",
    /**
     * ONE sentence, not a paragraph, added on the picker path only (design doc step 2, "The disclosure"): what the grant
     * covers beyond the repos named on screen. The four paragraphs under either heading stay byte-identical.
     */
    consentScope: "The choice covers future clones of these repositories too, adds commit hooks to each clone where it can, and is saved to your VibeCommit account so your other machines running VibeCommit 0.8.0 or later can offer it.",
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
    consentCommits: "Not only the transcript. Commits you make while a session is recording are uploaded too: the commit ID, the branch name, the session it was linked to, and how that link was made. If you amend, rebase, or squash with git reset, the ID of the commit you replaced goes with them — that commit may never have left this machine, and git will eventually delete it from here. A squash made with git reset also sends a hash of the combined change.",
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
    /**
     * Non-TTY refusal — DESIGN.md §13.7 exit 2, D65 §DR7. PR 6 item 6: written for an AGENT that hit it, which is who reaches
     * this branch. It says who must answer ("a person"), that an agent cannot, and what to relay, and it carries the code
     * `CONSENT_NEEDS_TTY` for a wrapper to key on — PR 7 registered it and renders it on the block's own code line, so it is not
     * repeated in the sentence. No `--yes`: that would bypass consent (D65 §DR7). The `what` line has no "you" (§13.6).
     */
    nonInteractiveWhat: "Consent needs a person at a terminal.",
    nonInteractiveWhy: "An agent cannot answer it, and standard input is not a terminal. Nothing was read and nothing was uploaded.",
    /** A repo with no remote has a folder to name; the label is the fix and the command follows it. */
    nonInteractiveFix: (folder) => `Ask the user to run this in ${folder}:`,
    /**
     * The picker path's refusal (VQ + VT, PR 6 item 6 fit): it names no folder (the picker is not about one repo), has no
     * "you" in the `what` line, and is reached BEFORE the scan beat, so "Nothing was read and nothing was uploaded" stays
     * literally true.
     */
    pickerNonInteractiveWhat: "Choosing repositories needs a person at a terminal.",
    pickerNonInteractiveWhy: "An agent cannot answer it, and standard input is not a terminal, so no repository can be chosen and consent cannot be asked. Nothing was read and nothing was uploaded.",
    pickerNonInteractiveFix: "Ask the user to run this in a terminal:",
    alreadyConnected: "Capture is already on for this repository.",
    /**
     * 0.7.0. `grants.json` is present and unreadable, which denies this repository whatever consent it has (see
     * `consent.ts`'s `isCaptureAllowed`). Answering the consent prompt could not change that, so `connect` stops
     * BEFORE asking rather than take a yes it cannot honour.
     */
    grantsUnreadableWhat: "Capture can't be turned on: ~/.vibecommit/grants.json can't be read.",
    grantsUnreadableWhy: "Capture is stopped on this machine for every repository that has a remote until the file is readable. Nothing was changed.",
    grantsUnreadableFixLabel: "Fix the file or move it aside, then run:",
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
    perClone: (connect) => `Run \`${connect}\` in each clone you want commits recorded for — git hooks are per-clone, not per-account.`,
    hooksPathWhat: "Commit capture could NOT be installed for this clone.",
    hooksPathWhy: (configured) => `This repository sets \`core.hooksPath\` to ${configured}, so git ignores \`.git/hooks\` entirely and a hook installed there would never run. Transcript capture is unaffected; only commit observation is.`,
    hooksPathFixLabel: "Fix, either one:",
    hooksPathFixUnset: "git config --unset core.hooksPath",
    hooksPathFixManual: (postCommit) => `or add \`${postCommit}\` to your existing post-commit hook`,
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
    refusedFix: (path, connect) => `check ${path} for a syntax error, then run \`${connect}\` again`,
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
/**
 * `vibecommit scan` — design review D17 · 11A, D26, D27, D33 · 27A, and the screen VQ drew for it
 * (style guide §10.13) on 2026-10-24.
 *
 * ⛔ **The nouns are the agent-neutral ones** (D11 · A, D35): "coding agent", never "Claude Code
 * session", because the scan covers three agents and the picker's heading says the same. The agent
 * NAMES appear only on a repo's second line, where they are facts about which store a count came from.
 *
 * ⚠ **Every sentence here is a claims-register row** (the register is `code`'s, VR's PR). None says
 * "every" or "all": the scan counts transcripts still on disk, and what `cleanupPeriodDays` already
 * deleted is not among them.
 */
export const SCAN = {
    /** The beat line, drawn in the existing beat shape and overwritten once with `done` (D17). */
    beat: "Looking for repositories on this machine...",
    beatDone: "done",
    found: (count) => `Found ${count} ${count === 1 ? "repository" : "repositories"} you've used a coding agent in on this machine.`,
    sessions: (count) => `${count} ${count === 1 ? "session" : "sessions"}`,
    since: (date) => `since ${date}`,
    /** What an agent is called on a repo's second line. The ids are wire values, not labels. */
    agent: { "claude-code": "Claude Code", "codex-cli": "Codex", cursor: "Cursor" },
    notListed: "Not listed here:",
    noRemote: (count, connect) => count === 1 ? `1 repo with no remote: run \`${connect}\` inside it` : `${count} repos with no remote: run \`${connect}\` inside each`,
    /**
     * The picker's own line (PR 1 ruling 2): ONE count and ONE line for a folder with two or more
     * candidate paths, a hashed name (cut, so it cannot be inverted) and a deleted sibling. Claude Code's
     * and Cursor's only — a Codex row records its real `cwd` and is never ambiguous.
     */
    ambiguous: (count) => count === 1
        ? "1 session in a folder that can't be matched to one repo"
        : `${count} sessions in folders that can't be matched to one repo`,
    /** Scan-only (ruling 5a): a folder, or a Codex `cwd`, that exists but is not inside a git work tree. */
    nonRepo: (count) => count === 1
        ? "1 session in a folder that isn't a git repository"
        : `${count} sessions in folders that aren't git repositories`,
    missingFolder: (count) => count === 1
        ? "1 session in a folder that no longer exists"
        : `${count} sessions in folders that no longer exist`,
    /**
     * ⛔ CLAIMS ONLY WHAT GIT SHOWS (ruling 7). The test is a session's mtime against the OLDEST reflog entry,
     * and `gc.reflogExpire` prunes a long-lived clone's oldest entries, so "older than the reflog" is the fact
     * and "the folder was reused" is a possibility — the same repo deleted and cloned again reads the same.
     */
    pathReused: (count) => count === 1
        ? "1 session older than its clone's reflog (possibly a reused folder)"
        : `${count} sessions older than their clone's reflog (possibly a reused folder)`,
    /** One clone: the path rides the line. More: this heading, then one indented path per clone. */
    noReflogOne: (path) => `1 clone with no reflog: ${path} (backfill skips it)`,
    noReflogMany: (count) => `${count} clones with no reflog (backfill skips them):`,
    /** Rollouts on disk that no index row names (ruling 5c) — counted, never opened. */
    unindexed: (count) => count === 1
        ? "1 Codex session missing from its thread index"
        : `${count} Codex sessions missing from its thread index`,
    /**
     * `Codex sessions couldn't be read (unrecognised index)`, one line per unreadable agent (R3-15). The
     * bracket names a cause the user can act on; a plain read failure (ruling 6) has none to name, so it
     * gets none. The `--json` `reason` is the same three words either way.
     */
    unreadable: (agent, reason) => reason === null
        ? `${agent} sessions couldn't be read`
        : `${agent} sessions couldn't be read (${reason})`,
    next: "Choose what is captured:",
    /** Exit 4. Both screens end on the same command. */
    none: "No coding-agent sessions were found on this machine.",
    /**
     * Exit 4 with `Not listed here:` lines: sessions exist that could not be listed, so `none` would be
     * untrue. `none` prints only when that block is empty, i.e. the scan saw no session at all (VQ, PR 1
     * ruling 3).
     */
    noneListable: "No repository could be listed from the sessions on this machine.",
    noneNext: "Choose owners or repos anyway:",
};
/**
 * `vibecommit backfill` — style guide §10.14, design review D14 · 8A, D15 · 9A; capture 0.7.0, PR 5.
 *
 * Every sentence here is a claims-register row. ⛔ Three promises it must never make: that a backfilled session is
 * LINKED to a commit (it arrives without links, and the copy says so), that "every" or "all" earlier sessions are
 * uploaded (only the ones still on this machine and not yet sent), and that a held session will upload by itself (no
 * hook fires for an old session, so the held line points at a re-run).
 *
 * The two folder reasons are different facts (VQ ruling): `folder differs` is a RECORDED folder that is not this clone,
 * `folder not recorded` is a transcript that records none.
 */
export const BACKFILL = {
    /**
     * Inside `connect` the repos are the ones it just showed, so "these"; run on its own there is no "these", so it names whose
     * they are (VQ, PR 5 review).
     */
    offerHeading: (repos, standalone) => standalone
        ? `Earlier sessions are still on this machine for ${repos} ${repos === 1 ? "repository" : "repositories"} you chose.`
        : `Earlier sessions are still on this machine for ${repos} of these repos.`,
    /** The count on a repo row. "Not yet uploaded", so it is never mistaken for the picker's total on disk. */
    notYetUploaded: (count) => `${count} not yet uploaded`,
    /**
     * Cursor sessions are not offered (Alexander, 2026-10-24 13:54 EST: Cursor's transcripts record no folder, so the
     * folder check cannot run). One muted line, only when a repo you chose has some.
     */
    cursorNotUploaded: (count) => count === 1
        ? "1 Cursor session isn't uploaded: Cursor doesn't record the folder a session started in."
        : `${count} Cursor sessions aren't uploaded: Cursor doesn't record the folder a session started in.`,
    /** Two lines, as §10.14 draws them. */
    /**
     * A session over the 50 MiB cap is left out of the count and named here, so the offer never promises an upload the run would
     * skip on every re-run. (Sub-agent streams are not capped.)
     */
    overSizeNote: (count) => count === 1 ? "1 session over 50 MiB isn't uploaded." : `${count} sessions over 50 MiB aren't uploaded.`,
    /**
     * A clone with no reflog cannot be tested for a reused path (a transcript older than the clone's first reflog entry), and
     * that test is the only guard against one, so its sessions are left out of the count and named here with the clone.
     */
    noReflogNote: (count, path) => count === 1
        ? `1 session in a clone with no reflog isn't uploaded: ${path}`
        : `${count} sessions in a clone with no reflog aren't uploaded: ${path}`,
    uploadNote: ["They upload one at a time, the same way new sessions do, without", "commit links."],
    question: (sessions) => sessions === 1 ? "Upload this session now? [y/N] " : `Upload these ${sessions} sessions now? [y/N] `,
    /** A no. A completed consent flow (§13.7), not an error. */
    declined: (backfill) => `Nothing was uploaded. Run \`${backfill}\` any time.`,
    nothingToUpload: "Nothing to upload: no earlier session on this machine is waiting for a repository you've chosen.",
    runHeading: (sessions) => sessions === 1 ? "Uploading 1 session..." : `Uploading ${sessions} sessions, one at a time...`,
    /** Outcome fragments on a repo line, joined by " · ". */
    uploaded: (count) => `${count} uploaded`,
    skipped: (count, reason) => `${count} skipped, ${reason}`,
    held: (count) => `${count} held, the org must approve capture`,
    failed: (count, reason) => `${count} failed, ${reason}`,
    stopped: "stopped",
    /** Skip reasons. */
    overSize: "over 50 MiB",
    folderDiffers: "folder differs",
    folderNotRecorded: "folder not recorded",
    /** The transcript could not be opened at all (permissions), which is a different fact from one that records no folder. */
    couldntBeRead: "couldn't be read",
    /** The file vanished between the offer and its upload: a skip, not a refusal by the server. */
    fileGone: "the file is gone",
    /** `vibecommit off` (or a grant removed) while the run was going: the rest of that repo is not sent. */
    turnedOff: "turned off while this ran",
    outsideAgentFolder: "not in the agent's session folder",
    /** Failure reasons: a `never`. The server's own code is never shown (§13.6: no bare status, no raw error). */
    refusedByServer: "the server refused it",
    repositoryForbidden: "another organization owns this repository",
    noRepoIdentity: "no repository identity",
    unrecognisedFileName: "the file name isn't a session id",
    /** The summary. The glyph is `ok` only when nothing was held, stopped or failed. */
    summary: (uploaded, total, skipped, held, failed) => {
        const noun = total === 1 ? "session" : "sessions";
        const tail = [
            skipped > 0 ? `${skipped} skipped` : null,
            held > 0 ? `${held} held` : null,
            failed > 0 ? `${failed} failed` : null,
        ].filter((part) => part !== null);
        return `Uploaded ${uploaded} of ${total} ${noun}.${tail.length > 0 ? ` ${tail.join(", ")}.` : ""}`;
    },
    /** `owners` is the held repos' owners, already phrased ("acme-corp", "acme-corp or other-org"). */
    heldBlock: (owners) => `Held sessions wait for ${owners} to approve capture:`,
    heldThenRun: "Then run:",
    /**
     * The stop block: a server `later` (5xx, 429) stops the run, with the resume fix. ⛔ It states only what landed: `uploaded` is
     * sessions the server took, not sessions looked at, and "not yet uploaded" is what a re-run will OFFER again (skipped and held
     * sessions among them), not a promise of what it will send.
     */
    stopWhat: (uploaded, total) => `Upload stopped: ${uploaded} of ${total} ${total === 1 ? "session" : "sessions"} uploaded.`,
    stopWhy: (notUploaded) => `The server asked the client to try again later. Nothing already sent is lost, and a re-run offers the ${notUploaded} ${notUploaded === 1 ? "session" : "sessions"} not yet uploaded.`,
    /** No response at all (a refused connection, a timeout): not the server asking anything. */
    stopWhyUnreachable: (notUploaded) => `The server could not be reached. Nothing already sent is lost, and a re-run offers the ${notUploaded} ${notUploaded === 1 ? "session" : "sessions"} not yet uploaded.`,
    stopFixLabel: "Resume:",
    /** Ctrl+C at the y/N or during the upload. Exit 0: capture is on. */
    interrupted: (backfill) => `Stopped. A re-run of ${backfill} sends what is left.`,
    /** Exit 3. */
    notConnectedWhat: "This machine isn't connected.",
    notConnectedWhy: "`backfill` uploads with this machine's credential, and there isn't one. Nothing was read.",
    notConnectedFixLabel: "Connect first:",
    /** `grants.json` is present and unreadable: every repo with a remote is denied, so there is nothing honest to offer. */
    grantsUnreadableWhat: "Backfill can't run: ~/.vibecommit/grants.json can't be read.",
    grantsUnreadableWhy: "Capture is stopped on this machine for every repository that has a remote until the file is readable. Nothing was read and nothing was uploaded.",
    grantsUnreadableFixLabel: "Fix the file or move it aside, then run:",
    /** Exit 2. A prompt that proceeds when nobody can answer it is not a prompt. */
    nonInteractiveWhat: "`backfill` needs an interactive terminal.",
    nonInteractiveWhy: "Standard input is not a terminal, so the question before uploading cannot be answered. Nothing was read and nothing was uploaded.",
    nonInteractiveFix: "Run this in a terminal:",
    /** The credential was rejected mid-run (a 401): the same block `finalize` shows, in this verb's words. */
    credentialStoppedWhat: "Upload stopped: this machine's credential is no longer accepted.",
    credentialStoppedWhy: "Nothing already sent is lost, and a re-run offers the sessions not yet uploaded.",
    credentialStoppedFixLabel: "Renew it, then run backfill again:",
    usageWhat: "That is not something `vibecommit backfill` understands.",
    usageWhy: "Nothing was read and nothing was uploaded. `backfill` takes no arguments.",
};
/**
 * `vibecommit connect` from any folder — the picker, the grant block, the hooks step and the endings (0.7.0, PR 3).
 * Style guide §10.12, copied from the merged guide and the design doc; the design doc wins where they differ.
 */
export const PICKER = {
    onNow: "on now",
    turnedOff: "turned off",
    /** Why an `on now` row is on (D5 · 1A), so a 0.6.x upgrader sees what is already captured. */
    reasonOwner: "owner",
    reasonRepo: "repo",
    reasonPerClone: "per clone",
    /** The owner row ALWAYS states how many repos `aN` covers (D9), so a hidden repo is never covered unseen. */
    ownerAll: (count) => `all ${count} ${count === 1 ? "repo" : "repos"} here, including repos you clone later`,
    ownerOnReposHere: (count) => `${count} ${count === 1 ? "repo" : "repos"} here`,
    turnOnHint: "choose it to turn it back on",
    /** Where the working folder is a repo, the row is marked so a pre-tick (or a `$HOME` dotfiles repo) is legible. */
    thisRepo: "this repo",
    thisFolder: "this folder",
    moreTyped: (count, owner) => `${count} more in ${owner}/ · type more to list them`,
    moreChecklist: (count, owner) => `${count} more in ${owner}/`,
    /** The typed prompt (D8). */
    choose: (hasOwners) => hasOwners
        ? "Choose a1, numbers (1 2), owner/ or owner/repo."
        : "Choose numbers (1 2), owner/ or owner/repo.",
    removeHint: "Remove one with -N, -owner/ or -owner/repo.",
    enterNothing: "Press Enter to change nothing.",
    /** D34 in the typed prompt: the working folder's repo is pre-selected, so Enter leads to the (default No) y/N. */
    enterThisRepo: (slug) => `Press Enter to choose ${slug}, this repo.`,
    promptMark: "> ",
    /** `tokens` is the already-joined list (`9 (no row 9), acme, corp`): the corpus renders every template with a string. */
    notUnderstood: (tokens) => `Not understood: ${tokens}. Nothing was chosen.`,
    noRow: (n) => `${n} (no row ${n})`,
    alreadyOn: (token, remove) => `${token} (already on; ${remove} stops it)`,
    notOn: (token) => `${token} (not on)`,
    /** The empty screen (D12 · 6A): a new laptop, no agent session on disk at all. */
    emptyNone: "No coding-agent sessions were found on this machine.",
    emptyExpected: "That's expected on a new machine. Type the owners or repos to capture; every clone of them is captured once Claude Code, Codex or Cursor runs in it.",
    emptyType: "Type owner/ or owner/repo, for example alexvibecommit/.",
    /** Sessions exist but none could be listed (the `Not listed here:` block is not empty): scan's own wording. */
    emptyListable: "Type owner/ or owner/repo, for example alexvibecommit/, to capture a repository that is not listed.",
    /** The checklist (D28). */
    hint: "↑↓ move · space choose · enter done · t typed prompt · ctrl+c cancel",
    hintTyped: (connectTyped) => `For a screen reader, run: ${connectTyped}`,
    /** The enter-with-nothing lines (D5). */
    nothingGranted: (connect) => `Nothing granted. Run \`${connect}\` again any time.`,
    noChanges: (summary) => `No changes. Capture stays on for ${summary}.`,
    cancelled: "Cancelled. Nothing was changed.",
    /** The grant block (D7 · 3A). */
    chose: "You chose:",
    labelOwners: "owners",
    labelRepos: "repos",
    labelTurnOn: "turn on",
    labelStop: "stop",
    ownerHere: (count) => `(${count} here, and later clones)`,
    noCloneHere: "(no clone here yet)",
    questionGrant: "Upload transcripts from these repositories?",
    questionStop: "Stop capturing these repositories?",
    stopped: "Stopped capturing the repositories above.",
    /** "1 owner and 2 repos" — the on-now summary of Enter-with-grants, `auth`'s one line and the status heading. */
    summary: (owners, repos) => {
        const o = `${owners} ${owners === 1 ? "owner" : "owners"}`;
        const r = `${repos} ${repos === 1 ? "repo" : "repos"}`;
        if (owners > 0 && repos > 0)
            return `${o} and ${r}`;
        return owners > 0 ? o : r;
    },
    authStays: (summary) => `Capture stays on for ${summary} on this machine.`,
    /** The hooks step (D13 · 7A). */
    hooksBeat: (clones) => `Adding commit hooks to ${clones} ${clones === 1 ? "clone" : "clones"}...`,
    hooksDone: "done",
    hooksCount: (added, chained, notAdded) => {
        const head = `${added} added${chained > 0 ? `, ${chained} of them after your own hook` : ""}`;
        return notAdded > 0 ? `${head} · ${notAdded} not added` : head;
    },
    hooksNotAdded: (count) => `Commit hooks were not added to ${count} ${count === 1 ? "clone" : "clones"}:`,
    hooksPathReason: "core.hooksPath is set",
    /** A hook write that FAILED is a real exception with its own reason (VQ, item 9): neither dropped nor given `hooksPath`'s fix. */
    hooksFailedReason: "the hook could not be written",
    hooksStillCaptured: "Sessions there are still captured. To record commits too, either:",
    hooksStillCapturedOther: "Sessions there are still captured.",
    hooksFailedFixLabel: "Where the hook could not be written, try again:",
    /** "Capture is on" (D18 · 12A, D19 · 13A). */
    onFor: (summary) => `Capture is on for ${summary} on this machine.`,
    onProof: "The next Claude Code, Codex or Cursor session in any of them is captured. In Claude Code, its first reply then shows \"VibeCommit captured this session.\"",
    stopOne: "To stop one repo, run inside it:",
    /**
     * Alexander's "caveat for other owners" (2026-10-24; amended 17:20), on the "Capture is on" block. It prints for the owners the
     * test capture did NOT check: from `~` that is every granted owner (there is no session to probe), and in a repo it is every
     * granted owner except the one whose delta the server answered with a 2xx. For an owner that is not the signed-in person's own
     * account the client cannot know whether an org is yet to approve capture, so it says one may be. Never printed when every
     * such owner is the user's own account.
     */
    ownerApproval: (status) => `An organization can require an owner's approval before its repos are captured; once a session in one of its repos has tried to upload, ${status} shows any that are waiting.`,
    onNewLaptop: (names) => `Capture is on for ${names} on this machine.`,
    onNewLaptopProof: "No clone of it is here yet. Clone one and open a coding agent in it; that session is captured.",
    // --- Slice 2 (S4 part 3, capture 0.8.0): the account's grants in `connect`. Brief §2-§3, VQ's rulings 2026-10-24. ---
    /** The group of account grants this machine has not named (§2): numbered, unticked until chosen, like any other row. */
    onAccount: "on your account",
    onAccountHint: "choose it to capture it here",
    /** A `turn on` row whose repo was turned off on the ACCOUNT (not only here): the yes re-includes it everywhere. */
    turnedOffOnAccount: "(turned off on your account)",
    /** Screen 1a: the second line of the prompt block, on a machine with no credential, a terminal and a browser to sign in with. */
    gLine: "Or type g for the repositories your account already grants. It signs in first.",
    /** The one token a mixed answer is refused for; `notUnderstood` wraps it in D8's line. */
    gMixedToken: "g can't be combined with other choices",
    /** Screen 1b: the grant block's heading when the list is the account's, not the person's picks. */
    accountGrants: "Your account grants:",
    /** Screen 1b, N: the credential `g` signed in with is revoked. The removed-here variant is a revoke that could not reach the server. */
    gDeclinedRevoked: "Nothing is captured on this machine. The credential made for this was revoked.",
    gDeclinedRemoved: "Nothing is captured on this machine. The credential made for this was removed here; the server will be told on the next vibecommit command that contacts the server.",
    /** Ctrl+C after a mint (VQ's correction): never "Nothing was changed", because a credential was made and then removed. */
    gCancelledRevoked: "Cancelled. Nothing is captured on this machine. The credential made for this was revoked.",
    gCancelledRemoved: "Cancelled. Nothing is captured on this machine. The credential made for this was removed here; the server will be told on the next vibecommit command that contacts the server.",
    /**
     * `g` stopped because this machine could not make the write-ahead record of the credential it had just been given (an unwritable,
     * unreadable or full queue). The credential is revoked at once (`REPLACE.declinedRevoked`), or `REPLACE.declinedOrphan` says where
     * to remove it. An insecure queue file gets the insecure-file block instead of this line.
     */
    gNotRecorded: "g stopped: this machine couldn't keep a record of the credential it was just given.",
    /**
     * The yes found `g`'s own record of the credential UNUSABLE (the queue file became insecure or unreadable while the question was
     * open): nothing was revoked by anyone, this machine just cannot keep the record, so no credential is kept.
     */
    gRecordUnusable: (connect) => `This machine's record of the credential this run had made couldn't be used, so none was kept. The repositories you chose stay named here; run \`${connect}\` again to sign in.`,
    /**
     * The yes found a `credentials.json` already there (another run saved one while the question was open): that one is kept, this run's
     * is not, and the grants the yes wrote are saved — capture IS on, so this never says nothing is captured. The fate of the
     * credential this run made follows on its own line (`REPLACE.declinedRevoked`, `gRemovedWillTell`, or `REPLACE.declinedOrphan`).
     */
    gOccupied: (connect) => `A credential was saved on this machine while this question was open, so that one is kept and the one this run made was not. The repositories you chose are saved; run \`${connect}\` again to finish.`,
    /** The fate line for `gOccupied` when a readable row still holds the credential this run made. */
    gRemovedWillTell: "The credential just created was removed here; the server will be told on the next vibecommit command that contacts the server.",
    /**
     * The yes found `g`'s own record of the credential gone: another vibecommit command (a retry that ran while the question was open)
     * had already revoked it. No credential is kept, and the grants the yes wrote stay. `connect` is THIS install's command.
     */
    gRevokedElsewhere: (connect) => `Another vibecommit command revoked the credential this run had made, so none was kept. The repositories you chose stay named here; run \`${connect}\` again to sign in.`,
    /** Screen 1c: `g` found no grants on the account. The credential is kept and the person chooses here. */
    gEmpty: "Your account doesn't grant any repositories yet. Choose them here instead:",
    /**
     * `g` signed in but the account's grants could not be read (the server did not answer, or answered off-contract). It must not
     * say the account is empty, and it says what to do: run `connect` again. `connect` is THIS install's command (a function of it).
     */
    gUnavailable: (connect) => `The repositories your account grants couldn't be read right now. Run \`${connect}\` again to choose from them.`,
    /** Screen 2: a machine joining an account by picking local repos is asked about the rest of the account's grants. */
    joinAlso: (namesOnePerLine) => {
        const names = namesOnePerLine.split("\n");
        const head = names.length > 3
            ? `${names.slice(0, 2).join(", ")} and ${names.length - 2} more`
            : names.length > 1
                ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`
                : names[0];
        return `Your account also grants ${head}.`;
    },
    joinQuestion: "Capture those here too?",
    /**
     * Under "Capture is on" when the sync after `connect`'s writes did not reach the server (VQ, on VT's question). Capture IS on —
     * local grants admit the repo — so this is not a warning; it only tells the truth about the account. Only `connect`, `status` and
     * `off` sync, so it names `status` (the install channel's command); a 400 and a 401 have their own lines (below and `ERRORS`).
     */
    accountNotTold: (status) => `Your account hasn't been told yet; running \`${status}\` retries.`,
    /**
     * "0.8.0 truth fixes" F2: the same line on a machine that HAS SYNCED before. There a grant the account has not been told about
     * holds the repository's sessions on this machine (`isCaptureAllowed`, step 3), so "Capture is on" needs the truth about it.
     * A machine that has never synced holds nothing and keeps `accountNotTold`.
     */
    accountNotToldHeld: (status) => `Your account hasn't been told yet. Until it is, sessions in the repositories you just chose that it doesn't grant wait on this machine; running \`${status}\` retries.`,
    joinDeclined: (status) => `They stay granted on your account and aren't captured on this machine. ${status} lists them.`,
};
/** `vibecommit off`. */
export const OFF = {
    done: "Capture is off for this repository.",
    /**
     * 0.7.0, a claims-register row. A repo with a remote is turned off BY SLUG, which reaches every clone of it on this
     * machine. Slice 2 extends the sentence to the other machines once they sync; until then it says only what is true.
     */
    doneSlug: (slug) => `Turned off ${slug} for every clone on this machine.`,
    /** D31: bare `off` outside a repository. The picker is where an owner or another repo is unticked. */
    outsideRepoWhat: "`off` turns off the repository you're in.",
    outsideRepoFixLabel: "To stop capturing an owner or another repo, untick it in the picker:",
    /** `grants.json` is unreadable, so the exclusion could not be recorded. The clone's own consent was still withdrawn. */
    grantsUnreadableWhat: "The turn-off could not be recorded: ~/.vibecommit/grants.json can't be read.",
    grantsUnreadableWhy: "Capture is already stopped for this repository while the file can't be read, and this clone's own consent was withdrawn.",
    grantsUnreadableFixLabel: "Fix the file or move it aside, then run:",
    alreadyOff: "Capture was already off for this repository.",
    /**
     * Slice 2 (S4), brief §2 and §5. On a machine with a credential the exclusion is also queued for the account and synced
     * (3 s), so the success line says where else it reaches; `unsyncedOthers` says who keeps capturing until they sync; and
     * `notSentYet` is the design's sentence for a write that could not reach the server (it stays queued).
     */
    doneSlugAccount: (slug) => `Turned off ${slug} for every clone on this machine, and on your other machines running VibeCommit 0.8.0 or later once they sync.`,
    // ⛔ A 0.6.x/0.7.0 machine never syncs, so every sentence about "your other machines" names the version that does (VQ, on #87).
    unsyncedOthers: (n) => n === 1
        ? "1 of your machines hasn't synced and keeps capturing it until it syncs on VibeCommit 0.8.0 or later."
        : `${n} of your machines haven't synced and keep capturing it until they sync on VibeCommit 0.8.0 or later.`,
    notSentYet: "Stopped here. Your other machines running VibeCommit 0.8.0 or later don't know yet; it will retry.",
    /** The write was stopped, not just unsent (a 400, a 401, too large, unreadable): "it will retry" would be false, so it does not say so. */
    notSentStopped: "Stopped here. Your other machines running VibeCommit 0.8.0 or later don't know yet.",
    /** The account already had it turned off (another machine, or the dashboard); this machine now agrees. */
    alreadyOffAccount: "Already off on your account; now off on this machine too.",
    note: "Sessions already recorded are unaffected.",
    // `TODOS[184]`. `off` used to ignore `argv` entirely and always run — a stray
    // argument, including `--help`'s own flag landing here by a bug, must never
    // silently revoke consent. Same shape as `AUTH.argvWhat`/`argvWhy`.
    unrecognizedArgWhat: "That is not something `vibecommit off` understands.",
    unrecognizedArgWhy: "Nothing was changed. `off` takes no arguments.",
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
     * `TODOS[174]`, `D217` (`code` main `46d85c8`) — the THIRD `match_kind`, once mcp starts writing
     * rewrite-link rows from an agent's own tool call rather than only from git's hook. Same shape as
     * `squashProbableBasis` above: states what the pairing rests on and that capture did not witness it
     * directly, claiming no more than that.
     */
    squashAssertedBasis: "This pairing was reported by an agent's tool call rather than recorded by git's own hook, so it is the agent's assertion and not something capture witnessed directly.",
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
    /** The PLUGIN channel's remedy (`COMMANDS.pluginInstall`). */
    skewFix: "Reinstall the VibeCommit plugin to pick up the current client, then run this again:",
    /** The npm channel's remedy (`COMMANDS.npmUpdate`): an npm install has no plugin to reinstall. */
    skewFixNpm: "Update VibeCommit to pick up the current client, then run this again:",
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
/**
 * `vibecommit finalize` (`TODOS[146]`, VD decision 5).
 *
 * ⛔ The turn extractor seals a turn only when a following prompt opens the next one, so a session
 * that is never followed by another prompt (a one-shot `claude -p`, the last turn of any session that
 * is not resumed) seals nothing and binds no commit. This verb is the CALLER saying the session is
 * over. The copy states what happened and what did not, and claims nothing about commits it cannot
 * know were bound: `closed` says the last turn is recorded, not that any commit matched it.
 */
export const FINALIZE = {
    // PR 7 (Q7): where the remedy is a command it sits in the §13.6 fix block, not inside the `what` line. The `what` lines
    // below lost exactly the clause that moved; the fix commands are the ones the old sentence named.
    needTarget: "Say which session to close.",
    needTargetFix: "Name one, or take the latest:",
    badSessionId: "That is not a session id (letters, digits, dot, dash and underscore only).",
    noRecentSession: "No session in this repository has delivered anything in the last 24 hours.",
    noRecentSessionFix: "Name a session:",
    severalRecent: "More than one session in this repository is recent.",
    severalRecentFix: "Name one:",
    /** `finalize --session <id>` for a session that is known, e.g. the one whose delivery just failed. */
    commandSession: (id) => `vibecommit finalize --session ${id}`,
    /** The same with the placeholder, for a fix line written before a session is known. */
    commandSessionAny: "vibecommit finalize --session <id>",
    /** The command without its id, for a sentence that names the id itself (`status`'s held-idle line). */
    commandSessionBase: "vibecommit finalize --session",
    commandSessionForce: (id) => `vibecommit finalize --session ${id} --force`,
    recentRow: (id, minutesAgo) => `${id}  (${minutesAgo} min ago)`,
    unknownSession: (id) => `This repository has no captured session ${id}.`,
    transcriptMissing: (id) => `Could not find the transcript for session ${id}.`,
    stillWriting: "That session's transcript changed a moment ago.",
    stillWritingFix: "Wait for the session to finish, or if it is over, run:",
    closed: (id) => `Closed session ${id}: its last turn is recorded, so commits made in it can now be recorded.`,
    alreadyClosed: (id) => `Session ${id} had nothing left open. Nothing changed.`,
    notAcknowledged: "The server accepted the data but did not confirm that it closed the session; it may predate this command. The last turn may still be open.",
    refused: "The server declined to close the session on this attempt.",
    retryFix: "Run it again:",
    notDelivered: "Could not deliver the session. Nothing was closed.",
    credentialStopped: "VibeCommit stopped sending for this credential.",
    credentialStoppedFix: "Replace it:",
    /**
     * PR 7 (Q2, VQ's wording): the ingest address in the environment (`VIBECOMMIT_INGEST_URL`) is one this client refuses to
     * send to, so retrying cannot help. Shared by `finalize` and `backfill`, so the `why` says only "Nothing was sent": it must
     * not claim a session was or was not closed. The VALUE is never echoed (a URL can carry a secret).
     */
    ingestUrlWhat: "The address VibeCommit sends sessions to can't be used.",
    ingestUrlWhy: "VIBECOMMIT_INGEST_URL must be an https address, or an http address on this machine, and it isn't. Nothing was sent.",
    ingestUrlFix: "Correct it, or remove it to use the default address:",
    ingestUrlCommand: "unset VIBECOMMIT_INGEST_URL",
    /**
     * `TODOS[177]` follow-up (VL, 2026-10-08, VG's silent-loss finding) — ONE stderr line for the whole run when
     * `finalize` sets any inferred-squash pairs aside (the main delivery, the drain loop, or both, summed). Printed
     * alongside the normal `closed(id)`/`alreadyClosed(id)` stdout line, never instead of it: finalize still closed
     * the session successfully, and this is a separate, narrower fact about the inferred-squash spool specifically.
     */
    inferredSetAside: (n) => `${n} inferred-squash ${n === 1 ? "pair" : "pairs"} ${n === 1 ? "was" : "were"} given up on: the server kept acknowledging less than was sent.`,
};
/**
 * The credential-rejected block — `11A`, style guide §13.6 what / why / fix, fix LAST.
 *
 * Shown by `connect` (exit 3) and `status`. The `why` is true on both of its branches, and says
 * so: a 401 holds the offset, so reconnecting uploads what was held. The server cannot say whether
 * the credential was revoked or expired (opaque 401), so the generic `why` names both; a local
 * `expires_at` in the past lets the client say "expired" outright (`whyExpired`).
 */
export const REJECTED = {
    what: "This machine's credential is no longer accepted.",
    why: "It was revoked in Settings, or it expired. Held turns upload once reconnected; nothing is lost.",
    whyExpired: (day) => `It expired on ${day}. Held turns upload once reconnected; nothing is lost.`,
    fixLabel: "Reconnect this machine:",
    /**
     * `R12`. The server did not answer the probe: not a verdict on the credential, so not an error.
     * TWO lines (`unconfirmedWhat`, `unconfirmedFix`) so the 80-column wrap can never split the backticked
     * command across lines; `unconfirmed` is their join, the sentence the plan wrote.
     */
    unconfirmedWhat: "Couldn't confirm this machine's credential with the server.",
    unconfirmedFix: (status) => `Run \`${status}\` later.`,
    unconfirmed: (status) => `Couldn't confirm this machine's credential with the server. Run \`${status}\` later.`,
};
/** `TODOS[184]`-style one-sentence facts the retire step prints; every one is true whatever the server did. */
export const RETIRE = {
    retired: "The credential this one replaces is retired.",
    /** `retired: false` is the server's one uniform answer — it will not say why, so neither do we. */
    notRetired: "The credential this one replaces was left as it was.",
    /** A 404: a server that predates the route. */
    unknown: "Whether the credential this one replaces was retired is unknown: this server cannot retire it.",
    failed: "The credential this one replaces could not be retired. It stays valid until it expires, and it is listed in Settings.",
    /** `VIBECOMMIT_TOKEN` shadows the file `auth` just wrote — D206 §4 — and nothing is retired. */
    envShadows: "VIBECOMMIT_TOKEN is set and takes precedence over the credential just saved. Nothing was retired.",
};
/**
 * The replace confirmation — the `5B` block, in the one case slice 1 shows it: a re-auth that
 * lands in a DIFFERENT workspace than the credential it replaces. One question, default NO.
 */
export const REPLACE = {
    accountLabel: "account",
    workspaceLabel: "workspace",
    replacesLabel: "replaces",
    /** `R8`: the handle was null — shown as an explicit gap, never a blank. */
    accountUnavailable: "(GitHub handle unavailable)",
    /**
     * A4 §3. The probe of the new credential was not answered, so the workspace match cannot be shown.
     * The block says so on the `workspace` row, in the gutter's own shape, rather than hiding the row.
     */
    workspaceUnconfirmed: "(couldn't confirm with the server)",
    /** …and the question then names NO workspace — it has none to name. ≤80 columns with the `[y/N]`. */
    questionUnconfirmed: "Upload this machine's transcripts to the workspace you signed in to?",
    replacesValue: (org) => `credential for ${org}`,
    question: (org) => `Upload this machine's transcripts to ${org}?`,
    /**
     * 0.7.0, D7 · 3A: on the PICKER path the question names the repos, not the machine, and is the second of at most three
     * questions in a run. The workspace is cut to 28 columns (not `question`'s 30) so the line stays within 80 with `[y/N]`.
     */
    questionRepos: (org) => `Upload transcripts from the repos above to ${org}?`,
    questionReposUnconfirmed: "Upload transcripts from the repos above to your signed-in workspace?",
    declined: "Nothing was saved. The approval is discarded.",
    /** Ctrl+C at the question (the prompt was aborted): the same outcome as N, said as what it was. */
    cancelled: "Cancelled. Nothing was saved.",
    /**
     * The new credential was created and then declined, so it was never saved. The client revokes it with
     * the retire route's self form (brief A3); this is what it says when that worked.
     */
    /**
     * A4 §3, fail closed: the device flow's confirmation has nothing to show (no probe, no ticket
     * workspace), and it never saves without asking. §13.6 what / why / fix, fix last.
     */
    unconfirmableWhat: "The workspace for this credential could not be confirmed.",
    unconfirmableWhyRevoked: "Nothing was saved, and the credential just created was revoked.",
    unconfirmableWhyOrphan: "Nothing was saved. The credential just created is unused; revoke it in Settings if you want it gone.",
    unconfirmableFix: "Run the command again:",
    declinedRevoked: "The credential just created was revoked.",
    /**
     * …and when it did not (a server without the self form, or any failure): the credential is live but
     * unused, so say where to remove it.
     */
    declinedOrphan: "The credential just created is unused. Revoke it in Settings if you want it gone.",
    declinedFix: "Settings:",
};
/**
 * The device sign-in (`CR-234d`, D219, style guide §10.2): the waiting block, its terminal states and the
 * copy the 5B confirmation reuses from `REPLACE`.
 *
 * ⚠ The waiting block is STATIC: no spinner and no ticking countdown (DESIGN.md §13.8). The expiry is an
 * absolute local time, so the screen is still true when someone reads it ten minutes later over a
 * scrollback. With `NO_COLOR` or a non-TTY it is identical minus the escapes.
 */
export const DEVICE = {
    /** RFC 8628 §3.3.1: the bare URL and the code are ALWAYS printed, whether or not a browser was opened. */
    heading: "Approve this machine in a browser on any device:",
    codeLabel: "Code",
    expires: (time) => `The code works once and expires at ${time}.`,
    /** The remote-phishing mitigation: whoever enters the code picks the account this machine uploads to. */
    shareWarning: "Don't share it: whoever enters it chooses the account this machine uploads to.",
    waiting: "Waiting for approval…  (Ctrl+C to cancel)",
    /** Ctrl+C. §13.7: exit 1. Not a failure block — nothing went wrong. */
    cancelled: "Cancelled. Nothing was changed on this machine.",
    deniedWhat: "The request was denied in the browser.",
    deniedWhy: "Nothing was changed on this machine.",
    deniedFix: "If this was you, run it again:",
    /** 16C, brief A7: one block for the poll's `access_denied` (gate) and the mint's 403 `code_signin_off`. */
    gateOffWhat: "Code sign-in is off for this account.",
    gateOffWhy: "Nothing was approved, and nothing was changed on this machine.",
    gateOffFix: "Turn on \"Allow approving machines with a code\" in Settings → Machines, then run it again:",
    expiredWhat: "The code expired before it was approved.",
    expiredWhy: "Codes last 5 minutes.",
    expiredFix: "Run it again for a new code:",
    rateLimitedWhat: "Too many sign-in attempts from this network.",
    rateLimitedWhy: "Shared networks can hit this limit.",
    rateLimitedFix: (time) => `Try again after ${time} by running:`,
    /** The server gave no `retry_after`. */
    rateLimitedFixUnknown: "Try again in a few minutes by running:",
    /** No `device_authorization_endpoint` in the discovery document: a server older than this client. */
    unsupportedWhat: "This server does not offer sign-in by code.",
    unsupportedWhy: "The sign-in service does not list a device endpoint, so it may be older than this version.",
    refusedWhat: "The service refused to start a sign-in by code.",
    refusedWhy: "Nothing was changed on this machine.",
    unreachableWhat: "Sign-in by code could not reach the service.",
    unreachableWhy: "The service stopped answering. Nothing was changed on this machine.",
    malformedWhat: "Sign-in by code got an answer this version cannot use.",
    malformedWhy: "The service answered in a form this version does not understand. Nothing was changed on this machine.",
    /** `invalid_grant`: the code is unknown or already spent. */
    invalidWhat: "The service no longer recognises this code.",
    invalidWhy: "It may have been used already. Nothing was changed on this machine.",
    retryFix: "To try again, run:",
    /** `--device` is TTY only: the approval is a person's, and nothing attached can answer for them. */
    needsTerminalWhat: "Sign-in by code needs a terminal.",
    needsTerminalWhy: "It waits for a person to approve, and the question at the end needs an answer.",
    needsTerminalFix: "To save a credential without a terminal, run:",
    /** The CHANNEL's auth command (`authCommandFor`), so a plugin-only machine is not told to run a bare name. */
    needsTerminalCommand: (authCommand) => `${authCommand} --stdin`,
    conflictWhat: "--device and --paste cannot be used together.",
    conflictWhy: "One waits for an approval elsewhere; the other asks for a credential here.",
    conflictFix: "Pick one:",
    /** The ticket could not be redeemed (expired, spent, or the service refused the mint). */
    redeemFailedWhy: "The approval could not be exchanged for a credential. It may have expired or been used already. Nothing was written.",
};
/**
 * `13A` — the update nudge: `muted` sentence, the command on its own line in `accent`.
 *
 * Two lines, not the one the plan sketches: "capture 0.4.6 is available (you have 0.4.5): npm i -g
 * @vibe-commit/capture@latest" is 82 columns before the indent, and §13.4 caps every line at 80. The
 * command stays the LAST line either way, which is the point of 13A.
 */
export const UPDATE = {
    npm: (latest, current) => `capture ${latest} is available (you have ${current}):`,
    npmCommand: "npm i -g @vibe-commit/capture@latest",
    plugin: (latest) => `capture ${latest} is available: update the VibeCommit plugin in Claude Code.`,
};
export const ERRORS = {
    notConnected: "This repository is not connected.",
    /** PR 7 (Q7): the remedy was a sentence inside the `what` line; it is a command now, so it moves to the fix block. */
    notConnectedFix: "Connect it:",
    networkLater: "Could not reach VibeCommit. This session will be recorded on the next turn.",
    // `11A`. The `what` of the §13.6 rejected-credential block (`REJECTED`), not a second sentence: the
    // old line sent users to `connect`, which printed "Connected" over the same dead credential (G1).
    authFatal: "This machine's credential is no longer accepted.",
    payloadNever: "This session was too large to record and has been skipped.",
    notAGitRepo: "Not a git repository.",
    /** PR 7 (VQ): names the folder, tilde-shortened and cut from the LEFT by the caller (`truncatePath`, §13.4). */
    notAGitRepoWhy: (folder) => `${folder} is not inside a git work tree.`,
    /** A fix with no command to give: the remedy is where to run it, so the block has a label and no commands. */
    notAGitRepoFix: "Run it again inside a git repository.",
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
    // The command is this install's own (PR 7): `node <path> <command>` on a plugin-only machine, which has no `vibecommit`.
    unexpectedDebugCommand: (command) => `VIBECOMMIT_DEBUG=1 ${command} <command>`,
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
    /** The FOLDER (`~/.vibecommit`) is open to other accounts, not the file: same code, its own what, why and `chmod`. */
    insecureDirWhat: "The folder that holds the credential file is open to other accounts on this machine.",
    insecureDirWhyLabel: "folder",
    insecureDirWhy: "The credential was not read. This folder must be accessible only to its owner.",
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
    /**
     * PR 6 item 1. Was "Mint one, then run:" over the URL alone, so the label promised a command and printed a link, and the
     * non-interactive path was named nowhere. The URL comes FIRST (inside the label, where it cannot be wrapped away from
     * its sentence) and the commands LAST, so the fix stays last (§13.6). A function because `URLS` is declared below.
     */
    mintFix: (url) => `Mint one at ${url}, then run either:`,
    /**
     * The two ways to hand it over: piped (a script or an agent), or typed at a terminal. `--stdin` never continues into `connect`
     * (D32 guard 1). `auth` is `authCommandFor(env, selfPath)`: a plugin-only machine has no `vibecommit` on PATH, so the line names
     * `node <path> auth` there (README, "Keeping a machine connected"), and handing it `vibecommit auth` would be a new wrong output.
     */
    mintCommands: (auth) => [`printf %s "$TOKEN" | ${auth} --stdin`, auth],
    wrongClassWhat: "That is not a VibeCommit ingest credential.",
    wrongClassWhy: `An ingest credential begins ${INGEST_TOKEN_PREFIX}. Nothing was written and nothing was sent.`,
    argvWhat: "A credential must not be passed as an argument.",
    argvWhy: "Arguments are written to your shell history and are readable by other processes on this machine while the command runs. Treat the one you just typed as exposed and revoke it.",
    argvFix: "Read it from the terminal, or from a pipe:",
    argvFixPrompt: "vibecommit auth",
    /** A pipe, so `channelCommand` cannot rewrite it: it takes the channel's `auth` (`authCommandFor`) instead. */
    argvFixStdin: (auth) => `printf %s "$TOKEN" | ${auth} --stdin`,
    // --- `CR-226`: the browser mint, and the paste it falls back to. ---
    /**
     * Printed before the request, naming the label the credential will carry in
     * `/app/settings` — the list a user revokes from, so the name they will look
     * for there is the name they see here.
     */
    minting: (label) => `Creating this machine's credential, labelled "${label}"…`,
    /** Every mint failure shares the `what`; the `why` names which step refused. */
    mintFailedWhat: "No credential was created through the browser.",
    /** `not-authorized`, or a 401 that survived one refresh. */
    mintSessionWhy: "The sign-in on this machine could not be used to create one. It may have ended or been revoked. Nothing was written.",
    mintNotMemberWhy: "The account that signed in is not a member of the workspace its sign-in names. Nothing was written.",
    mintRateLimitedWhy: "Too many credentials were created for this account in the last hour. Nothing was written.",
    mintRefusedWhy: "The service refused the request. Nothing was written.",
    mintUnreachableWhy: "The service did not answer. Nothing was written.",
    mintMalformedWhy: "The service answered in a form this version cannot use. Nothing was written.",
    /**
     * The documented fallback (FOUNDER_OAUTH_PROPOSAL decision 2): the paste path
     * that worked before this, unchanged. `auth` prints this and then prompts.
     */
    pasteInsteadLabel: "Paste one instead. Create it here, then paste it below:",
    /** `R5`/`8A`: the mint came back unusable (the probe of the NEW credential was refused). */
    mintUnconfirmedWhy: "The service created a credential and then refused it. Nothing was written.",
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
    /**
     * State 1. The command is the channel's (`installChannel`): `vibecommit connect` on npm, `node <path> connect` for the plugin
     * bundle, which has no `vibecommit` on PATH (slice 2, design Next Steps 6, the mechanism state 2 already uses). On npm the line is
     * the same bytes it always was.
     */
    notConnected: (connectCommand) => `VibeCommit is installed but not connected. Run \`${connectCommand}\` to start capturing.`,
    /** State 1 when the channel's command would blow `credentialRejectedBudget` (a long plugin realpath). */
    notConnectedFallback: "VibeCommit is installed but not connected. Connect it: vibecommit.ai/install",
    /**
     * State 2 — `11A`. House prefix kept, ONE line, and the cause is no longer named: the server's 401
     * body is opaque on purpose (it cannot say "revoked" vs "expired"), so "revoked" was a guess that
     * read as an accusation after a normal expiry. The command is the channel's (`installChannel`):
     * `vibecommit auth` on npm, `node <path> auth` for the plugin bundle — `connect` is not on offer
     * because it never replaced a credential that loads.
     */
    credentialRejected: (authCommand) => `VibeCommit capture stopped: this machine's credential is no longer accepted. Run \`${authCommand}\`.`,
    /** State 2 when the channel's command would blow `CREDENTIAL_REJECTED_BUDGET` (a long plugin realpath). */
    credentialRejectedFallback: "VibeCommit capture stopped: this machine's credential is no longer accepted. Reconnect: vibecommit.ai/install",
    /** The ≤120-character budget style guide §10.1 gives a one-line state. */
    credentialRejectedBudget: 120,
    /**
     * State 5 — `CR-234d`, decision 12A. A WARNING, not a failure: capture is still working. House prefix,
     * ONE line, an ABSOLUTE date (a relative one would be wrong by the time it is read), and the channel's
     * own `auth` command — a re-auth retires and replaces with no gap. Same ≤120 budget and fallback as state 2.
     */
    credentialEnding: (date, authCommand) => `VibeCommit: this machine's credential ends ${date}. Run \`${authCommand}\` to renew it.`,
    credentialEndingFallback: (date) => `VibeCommit: this machine's credential ends ${date}. Renew it: vibecommit.ai/install`,
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
    /**
     * States 6-9 — style guide §10.1 (0.7.0, design review D16 · 10A), all emitted by the `SessionStart` hook. One
     * plain-text line each, ≤120 characters, no SGR. The wording is the design doc's and the merged style guide's,
     * byte for byte; `test/session-start.test.ts` pins the length of every one.
     *
     * 6 — hooks added, once per clone. 7 — `core.hooksPath` is set, once per clone. 8 — the clone has its own
     * commit hook, once per clone. 9 — `grants.json` is unreadable, once per (machine, day).
     */
    hooksAdded: "VibeCommit added its post-commit and post-rewrite hooks to this clone, so commits can link to sessions.",
    hooksPathSet: "VibeCommit captures sessions here, not commits: core.hooksPath is set. Run `vibecommit status` here for the fix.",
    ownCommitHook: "VibeCommit didn't add its commit hook here: this clone has its own. Run `vibecommit connect` here to chain it.",
    grantsUnreadable: "VibeCommit capture stopped on this machine: ~/.vibecommit/grants.json can't be read. Run `vibecommit status`.",
    /**
     * State 10 — slice 2 (`CR-259`, brief §3 item 4). Emitted by the `SessionStart` hook, once per (machine, account epoch), when its one
     * bounded `GET` found account grants this machine has not named. SessionStart-only like states 6-9 (the plugin registers no
     * SessionStart), so it names the CLI by its own name, in backticks as 7-9 do; ≤120 characters.
     *
     * The counts are of what `status` lists under "on account", split: `owners` are the account's owner grants this machine has not named
     * (`octocat/`), `repos` its repository grants not named here, not under a named owner, and not turned off. The forms: "2 repositories",
     * "1 owner and 3 repositories", "2 owners"; the singulars are "1 repository" and "1 owner".
     */
    accountGrantsNotHere: (owners, repos) => {
        const o = `${owners} ${owners === 1 ? "owner" : "owners"}`;
        const r = `${repos} ${repos === 1 ? "repository" : "repositories"}`;
        const what = owners > 0 && repos > 0 ? `${o} and ${r}` : owners > 0 ? o : r;
        return `Your account grants ${what} not captured on this machine yet. Run \`vibecommit status\`.`;
    },
    /** State 10 when the counts would blow the ≤120 budget (an absurd number of grants): no counts, the same command. */
    accountGrantsNotHereFallback: "Your account grants repositories not captured on this machine yet. Run `vibecommit status`.",
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
    /** `D33 · 27A`. */
    scan: "vibecommit scan",
    /** `D14`/`D15`. */
    backfill: "vibecommit backfill",
    /**
     * `CR-216/U2`. The only verb a credential FAULT's fix line may name — it can
     * replace the credential from any state. `CR-226` lets `connect` mint one
     * too, but only on a machine with NO credential and a human at the terminal,
     * so `connect` is never the fix for a fault (`credential-fix-copy.test.ts`).
     */
    auth: "vibecommit auth",
    /** `CR-084d`. A FLAG, not a verb — `--help`'s verb list and its golden file do not move. */
    signIn: "vibecommit connect --sign-in",
    status: "vibecommit status",
    /** `TODOS[146]`. */
    finalize: "vibecommit finalize --latest",
    /**
     * `CR-108`. The ARGUMENT SHAPE, shown once so the usage error and the retry
     * fix line cannot drift apart — the same convention `why` uses.
     */
    report: "vibecommit report --since 2026-07-08",
    /** The ref form, for the detached-HEAD refusal. */
    reportRef: "vibecommit report --since 2026-07-08 --ref main",
    off: "vibecommit off",
    /** The picker's screen-reader flag: a FLAG on `connect`, like `signIn`. */
    connectTyped: "vibecommit connect --typed",
    /** The git hook's own verb. `hooksPathFixManual` tells a user to add it to a hook they keep. */
    postCommit: "vibecommit post-commit",
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
    /** The folder's remedy, for `CREDENTIAL_FILE_INSECURE` when the folder is the one with the wrong mode. */
    chmodDirectory: "chmod 700 ~/.vibecommit",
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
    /** The npm channel's way to a newer client: the package's own documented install, at `latest`. */
    npmUpdate: "npm install -g @vibe-commit/capture@latest",
};
/**
 * Every URL the CLI prints. Here rather than inline for the same reason as the
 * rest: a link is user-visible copy, the claims gate can only check what it can
 * find, and `CR-114` is moving `/app`'s information architecture underneath us.
 */
export const URLS = {
    dashboard: "https://vibecommit.ai/app",
    // `7A`/A4 §3b: every use of this constant is about MACHINE credentials (`auth`'s paste fallback,
    // `status`'s revoke line), and every such link goes to the section, not the page.
    settings: "https://vibecommit.ai/app/settings#machines",
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
    /** `/app/conversations`: where an uploaded backfill lands (D19). `/app` (`dashboard`) is the ending after a no. */
    conversations: "https://vibecommit.ai/app/conversations",
    /**
     * One recorded session — the ending's link when the ingest 2xx carried a `conversation_id` (`DX D8`).
     * Verified by file: `vibecommit-web` `app/app/conversations/[id]/page.tsx` exists on `main`, and an
     * unknown or cross-tenant id is a 404 there (RLS), not a leak. Callers pass a UUID-shaped id only
     * (`post.ts` `readConversationId` guarantees it), and fall back to `commits` when there is none.
     */
    conversation: (id) => `https://vibecommit.ai/app/conversations/${id}`,
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
    /** The reconnect page `SYSTEM_MESSAGE.credentialRejectedFallback` points at. */
    install: "https://vibecommit.ai/install",
};
//# sourceMappingURL=strings.js.map