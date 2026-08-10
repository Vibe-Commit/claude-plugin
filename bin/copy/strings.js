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
 */
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
/** `vibecommit status` (CR-021). */
export const STATUS = {
    onForRepo: "Capture is on for this repository.",
    offForRepo: "Capture is off for this repository.",
    neverSent: "No session has been recorded yet.",
    lastSuccessLabel: "Last recorded",
    dashboardLabel: "Dashboard",
    fixCommandLabel: "To reconnect, run",
    revokeLabel: "To revoke access",
};
/**
 * `vibecommit connect` (CR-025 owns the live-capture ending).
 *
 * ⚠ The DISCLOSURE PARAGRAPHS ARE NOT HERE and must not be improvised. `CR-111`
 * owns the consent-screen copy, because D64 falsified the trust argument the
 * earlier draft leaned on: this repo is private, so "read the source" is false
 * and BLOCKED by the register. What survives is `Vibe-Commit/claude-plugin`,
 * which vendors the exact binary — but "inspect the build" is WEAKER than "read
 * the source" and may not be dressed up as it. The strings below are the
 * MECHANISM's copy only: the prompt, the two answers, and the refusals.
 *
 * Also locked and enforced by the mechanism, not by these strings: default `N`,
 * non-TTY refuses with exit 2, and no reassurance adjectives (*secure, safe,
 * protected, private, encrypted*) anywhere on the screen (D65 §DR7).
 */
export const CONNECT = {
    consentHeading: "VibeCommit records your Claude Code sessions.",
    consentDetail: "Your conversation turns and the commits they produced are uploaded.",
    consentLinkLabel: "What we upload",
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
 * The empty-window state must distinguish "no commits in this window" from
 * "no capture yet" — those are different facts and collapsing them reads as a
 * coverage claim we cannot make.
 */
export const REPORT = {
    emptyNoCommits: "No commits in this window.",
    emptyNoCapture: "No sessions recorded in this window.",
    coverageLabel: "Commits with a recorded session",
    gradeMixLabel: "Evidence",
};
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
/** Commands the copy points at. One definition, so a rename cannot half-land. */
export const COMMANDS = {
    connect: "vibecommit connect",
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
};
//# sourceMappingURL=strings.js.map