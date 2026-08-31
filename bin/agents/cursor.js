/**
 * The `cursor` dialect — `CR-193`, D177.
 *
 * ⛔ **THE ID IS `cursor`. NEVER `cursor-ide`, never `cursor-mcp`** (D177 §1).
 * The server's client-name alias map already folds both of those spellings onto
 * `cursor`, and a cell over there asserts that every producible id is one of
 * that map's TARGETS — so a different spelling here reds a test in another
 * repository, on day one, for a reason nothing on this side would report.
 * ⚠ Cited from D177 §1 rather than read: this task has no access to that tree.
 *
 * ⛔ **`transport: "ndjson"` DOES NOT CHANGE, and the lock-out doing its job is
 * it NOT FIRING** (D177 §1). D164 §2 installed that literal type precisely so
 * *"an Aider or **Cursor** dialect cannot be registered without editing the
 * interface"* — and Cursor turns out to meet D164 §1's membership rule exactly:
 * it appends NDJSON to a file and hands a hook its path.
 *
 * ⚠ **What is DATA here and what is MEASURED is not the same set**, and the
 * difference is marked on each member below rather than left to a reader.
 */
import { cursorTranscriptRoot, isCursorTranscript } from "../paths.js";
/**
 * ⛔ **UNMEASURED, AND ADOPTED AS A FLOOR RATHER THAN GUESSED.**
 *
 * The plan's `D5` — the exact `hook_event_name` strings Cursor sends, and the
 * timeouts its `~/.cursor/hooks.json` registers — is **founder-blocked and
 * gates `CR-195`**, the unit that writes that file. Nothing installs a Cursor
 * hook today, so no Cursor hook has ever fired and these numbers are currently
 * unreachable in production.
 *
 * ⚠ **The direction of safety is what picks them.** Too WIDE and the agent
 * kills the process before this client's watchdog fires — which loses the
 * exit-0/silent-stdout contract, the one outcome DESIGN.md §13.7 forbids. Too
 * TIGHT and an invocation sends less and the next one picks it up. So the
 * registry's tightest existing pair is taken as a FLOOR: it holds whatever
 * Cursor turns out to register, down to Codex's 3 s cap.
 *
 * ⛔ **This is a refusal to guess, not a measurement of Cursor**, and `CR-195`
 * owns the real numbers once `D5` comes back.
 */
const CURSOR_REGISTERED_MS = 3_000;
const CURSOR_CLIENT_MS = 2_200;
export const CURSOR = {
    id: "cursor",
    transport: "ndjson",
    // ⛔ `projects`, one level ABOVE the root D177 §2 names, because `<munged>` is
    // the workspace fsPath and is derivable from neither `home` nor `env`. The
    // measurement that rules out deriving it from the project key, and what that
    // costs, are in `cursorTranscriptRoot`'s own docblock.
    transcriptRoot: cursorTranscriptRoot,
    // ⛔ THE GATE D177 §2 REQUIRES TO SHIP IN THIS UNIT — `.jsonl`, plus the
    // `<workspace>/agent-transcripts/` shape that puts §2's boundary back.
    admitsFile: isCursorTranscript,
    events: {
        Stop: {
            registeredTimeoutMs: CURSOR_REGISTERED_MS,
            clientBudgetMs: CURSOR_CLIENT_MS,
        },
        PreCompact: {
            registeredTimeoutMs: CURSOR_REGISTERED_MS,
            clientBudgetMs: CURSOR_CLIENT_MS,
        },
        SessionEnd: {
            registeredTimeoutMs: CURSOR_REGISTERED_MS,
            clientBudgetMs: CURSOR_CLIENT_MS,
        },
    },
    // ⛔ DECLARED EXPLICITLY, and it is load-bearing now in a way it was not
    // before (D177 §2, §9). `subagentsDir()` would compute
    // `<root>/<cid>/<cid>/subagents` for a Cursor transcript — ONE LEVEL TOO DEEP,
    // since the real layout is `<root>/<parentId>/subagents/<childId>.jsonl` — and
    // that wrong directory is inert only because `announce` short-circuits before
    // it. ⚠ `CR-204` made the selection ROOT-derived rather than flag-derived, so
    // a wrong declaration here is no longer a line nobody reaches.
    delegatedTranscripts: "announce",
    redaction: "cursor",
    // ⛔ **UNMEASURED.** `null` here does NOT mean "Cursor has no session id in its
    // environment" — it means nobody has run the measurement `M1` ran for Claude
    // Code (agent commit, human commit, worktree commit) against Cursor, so this
    // client has no variable it can honestly name. ⚠ Read it as the absence of a
    // measurement, not as a fact about the agent. Measuring it is a change to this
    // line and nothing else.
    sessionIdFromEnv: () => null,
    // ⛔ NO `locateCurrentTranscript`, and the omission is the decision — the same
    // one Codex made. Finding the conversation for THIS project would mean munging
    // a workspace path this client is never told, or reading a `cwd` out of the
    // transcript's own records, which is ANALYSIS (D60 §D6). `connect` skips the
    // test-capture beat rather than guessing.
};
//# sourceMappingURL=cursor.js.map