/**
 * The `codex-cli` dialect — `CR-183`, D164.
 *
 * ⚠ **DATA, described here; the readers land in later tasks of this wave.** What
 * this entry does today is put Codex's transcript root into the confinement
 * union and give `connect` a truthful answer about having no locator. The
 * scrubber it names is `CR-185`'s, and the delegated-transcript mechanism it
 * declares has no reader at all yet (see `DelegatedTranscripts`).
 *
 * ⛔ **Every number and mechanism below is CARRIED FROM THE TASK BRIEF, not
 * measured by this task.** They are recorded as the brief stated them so a later
 * reader can check them against the product rather than against this file.
 */
import { codexTranscriptRoot, isTranscriptFile } from "../paths.js";
/**
 * `SessionEnd` is the tight one — 3 s registered, 2.2 s client.
 *
 * That cap is why `CR-182`'s gap-stamp reserve exists at all: at 2200 ms a slow
 * send routinely consumed the whole budget and the honest hole went unrecorded,
 * which is the one outcome D56 §D8 says this client may not produce.
 */
const CODEX_SESSION_END_REGISTERED_MS = 3_000;
const CODEX_SESSION_END_CLIENT_MS = 2_200;
/** `Stop` and `PreCompact` are registered far wider — 30 s, client 8 s. */
const CODEX_TURN_REGISTERED_MS = 30_000;
const CODEX_TURN_CLIENT_MS = 8_000;
export const CODEX_CLI = {
    id: "codex-cli",
    transport: "ndjson",
    transcriptRoot: codexTranscriptRoot,
    // ⛔ `CR-193`, D177 §2 — the lane's `.jsonl` gate. `~/.codex/sessions` is
    // date-nested rollout transcripts and nothing else, so there is no interior
    // shape to require here either. ⚠ CARRIED FROM THE BRIEF like the numbers
    // above: this task did not re-walk a Codex tree to confirm it.
    admitsFile: isTranscriptFile,
    events: {
        Stop: {
            registeredTimeoutMs: CODEX_TURN_REGISTERED_MS,
            clientBudgetMs: CODEX_TURN_CLIENT_MS,
        },
        PreCompact: {
            registeredTimeoutMs: CODEX_TURN_REGISTERED_MS,
            clientBudgetMs: CODEX_TURN_CLIENT_MS,
        },
        SessionEnd: {
            registeredTimeoutMs: CODEX_SESSION_END_REGISTERED_MS,
            clientBudgetMs: CODEX_SESSION_END_CLIENT_MS,
        },
    },
    // The delegated path ARRIVES on stdin as `agent_transcript_path` — there is no
    // directory to glob. Nothing parses it yet; the discriminator is here so the
    // Claude glob cannot run against a layout that has no `subagents/`.
    delegatedTranscripts: "announce",
    redaction: "codex-cli",
    // ⛔ **UNMEASURED.** `null` here does NOT mean "Codex CLI has no session id in
    // its environment" — it means nobody has run the measurement `M1` ran for
    // Claude Code (agent commit, human commit, worktree commit) against Codex, so
    // this client has no variable it can honestly name. ⚠ Read it as the absence
    // of a measurement, not as a fact about the agent. Measuring it is a change to
    // this line and nothing else.
    sessionIdFromEnv: () => null,
    // ⛔ NO `locateCurrentTranscript`, and the omission is the decision. Finding
    // the repository would mean reading a `cwd` out of the transcript's own
    // records — ANALYSIS, which D60 §D6 forbids this client. `connect` therefore
    // skips the test-capture beat rather than guessing.
};
//# sourceMappingURL=codex_cli.js.map