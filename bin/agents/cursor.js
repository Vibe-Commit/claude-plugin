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
import { join } from "node:path";
import { cursorHooksPath, cursorTranscriptRoot, isCursorTranscript } from "../paths.js";
import { readEntries, sessionFile, subdirectories } from "./session_listing.js";
/**
 * ⭐ **MEASURED. `D5`'s SECOND HALF IS ANSWERED (`TODOS[130]`), AND THE ANSWER IS
 * THAT CURSOR IMPOSES NO NUMBER OF ITS OWN.**
 *
 * `D5` asked for the exact `hook_event_name` strings Cursor sends *and* the
 * timeouts its `~/.cursor/hooks.json` registers. D205 discharged the strings
 * from the shipped app bundle. The timeouts are now read the same way, out of
 * `workbench.desktop.main.js` — the validator `Fed` and the executor
 * `_executeCommandHookScript`:
 *
 * | question | measured |
 * |---|---|
 * | is there a per-hook `timeout`? | **yes**, and it is in **SECONDS** |
 * | is it clamped or capped? | **NO** — above `3600` Cursor only `console.warn`s |
 * | rejected when? | non-number, or `<= 0`. Nothing else. |
 * | default when omitted | **60 s** — `(t.timeout ?? ROi) * 1e3`, `ROi = 60` |
 * | enforcement | real: killed, **exit code 124**, logged `timed out after Ns` |
 * | on timeout | `failClosed: true` BLOCKS the tool; otherwise the step proceeds |
 *
 * ⛔ **SO THERE WAS NEVER A CURSOR NUMBER TO DISCOVER. Cursor honours whatever we
 * register.** The old header said `CR-195` "owns the real numbers once `D5` comes
 * back"; `D5` is back, and the real numbers are ours to choose.
 *
 * ## ⚠ THE NUMBERS BELOW DO NOT CHANGE — BUT THEIR JUSTIFICATION DOES
 *
 * They were a defensive floor against a cap that might exist. They are now a
 * DELIBERATE PAIR, and the reasoning is no longer conditional:
 *
 *   - We register **3 s**, so Cursor kills the hook at 3 s and not before.
 *   - Our own watchdog is **2.2 s**, so it always fires **800 ms FIRST**.
 *
 * That ordering is the whole point. `DESIGN.md §13.7` forbids one outcome — the
 * agent killing us before we can exit 0 with silent stdout — and the old header
 * could only *hope* the registered value held. It holds: the client watchdog
 * leads the registered timeout by construction, on a value Cursor does not
 * override.
 *
 * ⚠ And note the direction against Cursor's own default: **60 s**. Registering
 * 3 s TIGHTENS by twenty-fold. An omitted `timeout` would leave a wedged hook
 * stalling an agent step for a full minute, so writing this field is not
 * ceremony — it is the difference between a 2.2 s worst case and a 60 s one.
 *
 * ## ⛔ WHAT THIS MEASUREMENT IS, AND WHAT IT IS NOT
 *
 * It is a reading of **shipped code**, not an observed firing — the same
 * standing as D205's strings, and the same limit. It proves what Cursor's
 * validator accepts and what its executor does with the value. It does **not**
 * prove a hook of ours has been fired by a real Cursor session and killed at
 * 3 s. That confirmation is cheap now that the signal is known — **exit code
 * 124** and `Hook … timed out after 3s` in Cursor's log — and it is owed.
 *
 * ⚠ **Both clauses of the old header were false when it was written, which is
 * why this row existed.** It said *"Nothing installs a Cursor hook today, so no
 * Cursor hook has ever fired and these numbers remain unreachable in
 * production."* `CURSOR` carries a `hookConfig`, so `installAgentHooks` writes
 * `~/.cursor/hooks.json` on any machine with Cursor present — and that shipped
 * in `0.2.0` and is live in `0.2.3`. The numbers were reachable, in users'
 * hands, and documented as unreachable.
 */
const CURSOR_REGISTERED_MS = 3_000;
const CURSOR_CLIENT_MS = 2_200;
/**
 * The longest folder name Cursor writes verbatim.
 *
 * ⛔ **MEASURED (Open Question 3, VS, 2026-10-24), with `cursor-agent`, which
 * creates the project folder even when it is not logged in.** A name up to 61
 * characters is kept; a longer one becomes its first 53 characters, `-`, and 7
 * hex characters (the hash varied with the input, so it is not a constant).
 */
export const CURSOR_NAME_LIMIT = 61;
/**
 * The folder name Cursor gives a workspace path — Open Question 3.
 *
 * ⛔ **THIS IS NOT CLAUDE CODE'S RULE, and the difference is the measurement.**
 * Every RUN of non-alphanumerics, a literal `--` included, collapses to ONE `-`;
 * leading and trailing separators are dropped (so `/tmp/q/trail.` is `…-trail`
 * and there is no leading `-`); case is kept. An emoji and `é'` each gave a single
 * dash where Claude Code gives two.
 *
 * ⚠ **Which makes Cursor's names collide far more:** `a-b`, `a.b`, `a--b` and
 * `a.b.` are all one folder. The scan's walk encodes every directory entry with
 * THIS function and matches on the result, so the collapsing applies to every
 * candidate rather than being assumed away.
 */
export function encodeProjectPath(path) {
    return path.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
/**
 * Is this folder name one Cursor cut and hashed? See `CURSOR_NAME_LIMIT`.
 *
 * ⚠ **A hashed name is always exactly 61 long, and so is a verbatim name that
 * happens to be 61 long** — length alone cannot tell them apart. The test is the
 * hash's shape too (`-` and 7 hex). A verbatim 61-character name that ends the
 * same way is read as hashed, which is the safe error: it is skipped and
 * counted, never matched to a path it might not be.
 */
export function isHashedProjectName(name) {
    return name.length === CURSOR_NAME_LIMIT && /-[0-9a-f]{7}$/.test(name);
}
/**
 * The folder Cursor uses for a window with no workspace open. It is not a path,
 * so it can never resolve to one and is not worth a "folder no longer exists"
 * count. Seen by NAME on the author's machine; nothing in it was read.
 */
const CURSOR_NO_WORKSPACE = "empty-window";
/**
 * Cursor's sessions, by folder — `D11 · A`, `scan`.
 *
 * `<root>/<encoded workspace>/agent-transcripts/<cid>/<cid>.jsonl`. Only the
 * conversation's own file counts: `<cid>/subagents/…` is delegated work that
 * belongs to the parent (`delegatedTranscripts: "announce"`). A flat
 * `agent-transcripts/<cid>.jsonl` is accepted too, because `isCursorTranscript`
 * admits any `.jsonl` at that depth and a count that disagreed with the gate
 * would be a count of nothing.
 *
 * ⛔ Names and times only; see `claudeSessionSource` for the rule and its reason.
 */
function cursorSessionSource(home) {
    const root = cursorTranscriptRoot(home);
    const folders = [];
    try {
        for (const folder of subdirectories(root)) {
            if (folder.name === CURSOR_NO_WORKSPACE)
                continue;
            const transcripts = join(folder.path, "agent-transcripts");
            const sessions = [];
            for (const entry of readEntries(transcripts) ?? []) {
                const file = entry.isDirectory()
                    ? join(transcripts, entry.name, `${entry.name}.jsonl`)
                    : entry.name.endsWith(".jsonl")
                        ? join(transcripts, entry.name)
                        : null;
                const session = file === null ? null : sessionFile(file);
                if (session !== null)
                    sessions.push(session);
            }
            if (sessions.length > 0)
                folders.push({ name: folder.name, sessions });
        }
    }
    catch {
        return { kind: "unreadable", reason: "unreadable" };
    }
    // Cursor keeps no record of the folders it has run in, so there is no second signal.
    return {
        kind: "folders",
        folders,
        encode: encodeProjectPath,
        isHashed: isHashedProjectName,
        recorded: [],
    };
}
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
    // ⛔ **THE MEASUREMENT THAT DISCHARGED `D5`'s FIRST HALF — camelCase, and this
    // is the defect `CR-195` exists to fix** (D205). Read out of the SHIPPED app
    // bundle at `/Applications/Cursor.app/Contents/Resources/app`, whose `*.js`
    // carry the event object as literals: seventeen events, of which
    // `stop`/`preCompact`/`sessionEnd` are ours and `subagentStart`/`subagentStop`
    // are the pair `delegatedTranscripts: "announce"` would want next.
    //
    // ⚠ **No live Cursor session was needed**, which is what `D5` had assumed and
    // what kept this unit blocked. The bundle is the same artifact a user runs.
    //
    // ⛔ Against the client's `SessionEnd`, `sessionEnd` matched NOTHING — not an
    // error, a `false` — so a Cursor session took no settle on its final turn and
    // lost it permanently. That is the whole of the bug.
    //
    // ⛔ **`sessionStart` is STATIC, NOT OBSERVED** (Open Question 1, 2026-10-24).
    // `cursor-agent` was not logged in, so no session ran; the spelling and the
    // payload (`conversation_id`, `generation_id`, `model`, `is_background_agent`,
    // `composer_mode`) come from the CLI bundle 2026.08.11-e8db854, which runs it
    // for a NEW chat before the first turn. It reads `env` and `additional_context`
    // from the output — and `additional_context` goes into the agent's context and
    // is NOT shown to the user. There is no user-visible field, so this client
    // never uses it to carry a notice: Cursor users learn the state from `status`,
    // and the first-`Stop` install is kept as the fallback for exactly this reason.
    eventNames: {
        Stop: "stop",
        PreCompact: "preCompact",
        SessionEnd: "sessionEnd",
        SessionStart: "sessionStart",
    },
    // ⛔ `~/.cursor/hooks.json`, and the `cursor` SHAPE — the two are a pair.
    // Read out of the shipped bundle's validator: a top-level numeric `version`
    // is REQUIRED, entries are a FLAT array of hook scripts each needing a
    // `command`, and an unrecognised event key is a validation ERROR rather than
    // something ignored. The `claude` shape written here would be rejected for
    // having no `command` — silently, registering nothing.
    // ⚠ No env override: none has been measured, per `cursorTranscriptRoot`.
    hookConfig: { path: (home) => cursorHooksPath(home), shape: "cursor" },
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
        // gstack-shortcut(dec-e650afbf): `Stop`'s clocks, no fast path (eng review D7 · B).
        SessionStart: {
            registeredTimeoutMs: CURSOR_REGISTERED_MS, // gstack-shortcut(dec-e650afbf)
            clientBudgetMs: CURSOR_CLIENT_MS, // gstack-shortcut(dec-e650afbf)
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
    sessionSource: (home) => cursorSessionSource(home),
    // ⛔ NO `locateCurrentTranscript`, and the omission is the decision — the same
    // one Codex made. Finding the conversation for THIS project would mean munging
    // a workspace path this client is never told, or reading a `cwd` out of the
    // transcript's own records, which is ANALYSIS (D60 §D6). `connect` skips the
    // test-capture beat rather than guessing.
};
//# sourceMappingURL=cursor.js.map