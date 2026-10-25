/**
 * The stable error codes — one per CONDITION, not per call site (0.7.0, PR 7).
 *
 * An agent that drives `vibecommit` keys on the code, not on the sentence: the sentence is copy and
 * may be reworded, the code is a contract. So the rules are the rules of a contract:
 *
 *   - **A shipped code is never renamed or reused for another condition.** A retired code stays in
 *     this table, marked `retired`, so the docs page still explains it.
 *   - **Adding a code is additive; changing one is a contract change** and goes in the release
 *     paragraph (L12).
 *   - **Names the state, not the verb**, and never "you": `^[A-Z][A-Z0-9_]{2,31}$`. A verb prefix is
 *     used only where the condition exists in one verb (`FINALIZE_SEVERAL_RECENT`).
 *   - **Two conditions with different fixes get two codes**, even when they print the same sentence;
 *     one condition reached from several verbs is one code (`NOT_A_REPO`).
 *   - **No exit code lives here.** A code names the condition; the exit stays the verb's own and the
 *     README's per-verb exit lists stay the contract (VQ, Q8).
 *
 * `test/error-codes.golden.txt` lists every code and its summary; the docs page copies it. This file
 * imports nothing, so `term.ts` (the renderer) and `json.ts` can both use it.
 */
/**
 * Declared as a literal so `ErrorCode` is a union of the keys and the compiler finds every
 * `kind: "bad"` block that has no (or a misspelt) code.
 */
export const ERROR_CODES = {
    // — the process —
    INTERNAL_ERROR: { summary: "VibeCommit stopped on an unexpected error." },
    NODE_TOO_OLD: { summary: "The Node runtime is older than this version supports." },
    UNKNOWN_COMMAND: { summary: "The first argument is not a vibecommit command." },
    UNRECOGNIZED_ARGUMENT: { summary: "An argument the command does not take." },
    // — the repository and the machine —
    NOT_A_REPO: { summary: "The command was run outside a git work tree." },
    NOT_CONNECTED: { summary: "This repository is not allowed to be captured." },
    NO_CREDENTIAL: { summary: "This machine has no ingest credential." },
    GRANTS_UNREADABLE: { summary: "The grants file exists but cannot be read, so capture is stopped." },
    CONSENT_NEEDS_TTY: { summary: "Consent needs a person at a terminal." },
    BACKFILL_NEEDS_TTY: { summary: "Backfill asks a question that needs a person at a terminal." },
    OFF_NEEDS_REPO: { summary: "`off` was run outside a repository." },
    // — credentials —
    CREDENTIAL_IN_ARGV: { summary: "A credential was passed as a command-line argument." },
    CREDENTIAL_EMPTY: { summary: "No credential was given to `auth`." },
    CREDENTIAL_NOT_INGEST: { summary: "The credential given to `auth` is not an ingest credential." },
    STORED_CREDENTIAL_NOT_INGEST: { summary: "The credential stored for this machine is not an ingest credential." },
    CREDENTIAL_FILE_INSECURE: { summary: "The credential file is readable by other accounts." },
    CREDENTIAL_FILE_UNREADABLE: { summary: "The credential file could not be read." },
    CREDENTIAL_REJECTED: { summary: "The server no longer accepts this machine's credential." },
    WORKSPACE_UNCONFIRMED: { summary: "The workspace for a new credential could not be confirmed." },
    // — signing in —
    NOT_SIGNED_IN: { summary: "This machine has never signed in." },
    SIGNIN_ENDED: { summary: "This machine's sign-in has ended." },
    SIGNIN_BUSY: { summary: "Another command is renewing this machine's sign-in." },
    SIGNIN_SERVICE_NOT_FOUND: { summary: "The sign-in service could not be found." },
    SIGNIN_DENIED: { summary: "Sign-in was declined." },
    SIGNIN_TIMED_OUT: { summary: "Sign-in did not finish in time." },
    SIGNIN_CLIENT_REFUSED: { summary: "The sign-in service refused this client." },
    SIGNIN_UNREACHABLE: { summary: "The sign-in service could not be reached." },
    SIGNIN_ANSWER_UNUSABLE: { summary: "The sign-in service answered in a way this version cannot use." },
    SIGNIN_CODE_NEEDS_TTY: { summary: "Sign-in by code needs a terminal." },
    SIGNIN_CODE_UNSUPPORTED: { summary: "The server does not offer sign-in by code." },
    SIGNIN_CODE_REFUSED: { summary: "The service refused to start a sign-in by code." },
    SIGNIN_CODE_INVALID: { summary: "The service no longer recognises the sign-in code." },
    SIGNIN_CODE_DISABLED: { summary: "Sign-in by code is turned off for the account." },
    SIGNIN_RATE_LIMITED: { summary: "Too many sign-in attempts from this network." },
    AUTH_FLAGS_CONFLICT: { summary: "Two `auth` flags that cannot be combined were given." },
    MINT_FAILED: { summary: "No credential was created through the browser." },
    MINT_NOT_A_MEMBER: { summary: "The signed-in account is not a member of the workspace." },
    MINT_RATE_LIMITED: { summary: "Too many credential requests; the service asked to wait." },
    // — the command on PATH —
    PATH_COMMAND_FOREIGN: { summary: "Another program owns the `vibecommit` command." },
    PATH_COMMAND_ABSENT: { summary: "The `vibecommit` command is not on PATH." },
    // — finalize and delivery —
    FINALIZE_NEEDS_TARGET: { summary: "`finalize` was given no session to close." },
    FINALIZE_BAD_SESSION_ID: { summary: "The value given is not a session id." },
    FINALIZE_NO_RECENT_SESSION: { summary: "No session in this repository delivered anything recently." },
    FINALIZE_SEVERAL_RECENT: { summary: "More than one recent session; one must be named." },
    FINALIZE_UNKNOWN_SESSION: { summary: "This repository has no captured session with that id." },
    FINALIZE_TRANSCRIPT_MISSING: { summary: "The transcript for the session could not be found." },
    FINALIZE_STILL_WRITING: { summary: "The session's transcript changed a moment ago." },
    FINALIZE_REFUSED: { summary: "The server declined to close the session on this attempt." },
    DELIVERY_FAILED: { summary: "The session could not be delivered; nothing was closed." },
    INGEST_URL_UNAVAILABLE: { summary: "The ingest address from the environment is unusable." },
    // — why and report —
    RECORD_SERVICE_UNREACHABLE: { summary: "The record service could not be reached." },
    RECORD_SERVICE_ERROR: { summary: "The record service could not answer." },
    RECORD_ANSWER_UNREADABLE: { summary: "The record service answered in a way this version cannot read." },
    WHY_NEEDS_FILE_AND_LINE: { summary: "`why` needs a file and a line number." },
    BLAME_FAILED: { summary: "`git blame` could not attribute the line." },
    REPORT_NEEDS_SINCE: { summary: "`report` needs a start date." },
    REPORT_SINCE_UNREADABLE: { summary: "The start date could not be read." },
    REPORT_REF_UNNAMEABLE: { summary: "`report` needs a ref it can name." },
    REPORT_REACHABILITY_UNKNOWN: { summary: "Whether a captured commit is reachable could not be determined." },
    SHALLOW_CLONE: { summary: "The clone is shallow, so the answer cannot be trusted." },
    CLIENT_TOO_OLD: { summary: "The server sent an answer this version is too old to show." },
};
/** What is printed after the code, without the scheme (Alexander, "Code line before the fix"). */
export const ERROR_DOCS_PATH = "vibecommit.ai/docs/errors";
/** The anchor on the docs page: `#` plus the code, lowercased, underscores as hyphens. */
export function errorAnchor(code) {
    return `#${code.toLowerCase().replaceAll("_", "-")}`;
}
/** The one muted line under a block's why paragraphs: `NOT_A_REPO · vibecommit.ai/docs/errors#not-a-repo`. */
export function errorCodeLine(code) {
    return `${code} · ${ERROR_DOCS_PATH}${errorAnchor(code)}`;
}
//# sourceMappingURL=error_codes.js.map