/**
 * The `claude-code` dialect — `CR-183`.
 *
 * ⛔ **NOTHING ABOUT CLAUDE CODE'S BEHAVIOUR CHANGES HERE.** Every value below is
 * the value the client already used, moved to where a second agent can be
 * described beside it. The one function member, `locateCurrentTranscript`, is
 * `commands/connect.ts`'s own `findCurrentTranscript` verbatim except for the
 * confinement call, which now runs against the registry's union.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { claudeConfigPath, claudeSettingsPath, isInside, isTranscriptFile, transcriptRoot, } from "../paths.js";
import { readEntries, sessionFile, subdirectories } from "./session_listing.js";
/**
 * The client-side backstop, per event.
 *
 * ⛔ **This is `hooks/entry.ts`'s `DEFAULT_HOOK_BUDGET_MS`, and the constant does
 * not move.** It is restated as a literal here for one reason: `entry.ts`
 * imports this registry, so importing the constant back would close an import
 * cycle whose failure mode is a temporal-dead-zone `undefined` at module load —
 * a budget of `NaN`, silently. `test/agent-registry.test.ts` asserts the two
 * agree, which is the coupling the import would have provided.
 */
const CLAUDE_CLIENT_BUDGET_MS = 5_000;
/**
 * What `claude-plugin/hooks/hooks.json` registers, in MILLISECONDS.
 *
 * ⚠ **That file is hand-written in another repository and nothing generates it
 * from here**, so these three numbers are a MIRROR, not a source. They are
 * pinned as literals so the `clientBudgetMs < registeredTimeoutMs` relation can
 * be asserted at all — see `test/agent-registry.test.ts`, which also states what
 * the assertion cannot see: a drift in the file itself.
 *
 * Its own timeouts are in SECONDS (8, 8, 10). Every value is above the client
 * budget above, which is the relation that lets the client's watchdog fire
 * first; below that line the agent kills the process and the exit-0 contract
 * goes with it.
 */
const CLAUDE_REGISTERED_STOP_MS = 8_000;
const CLAUDE_REGISTERED_PRECOMPACT_MS = 8_000;
const CLAUDE_REGISTERED_SESSION_END_MS = 10_000;
/**
 * `SessionStart` reuses `Stop`'s two clocks and has no fast path of its own.
 *
 * ⛔ **A logged shortcut** — gstack-shortcut(dec-e650afbf), eng review D7 · B,
 * Alexander's choice over a 1.5 s cap. The ceiling: a hung `SessionStart` can
 * hold a session's start up by as long as the REGISTERED timeout (8 s here).
 * Upgrade when a measurement or a user report shows session-start delay, or
 * before slice 2's grants fetch is built into this handler.
 */
const CLAUDE_REGISTERED_SESSION_START_MS = CLAUDE_REGISTERED_STOP_MS; // gstack-shortcut(dec-e650afbf)
/**
 * The longest folder name Claude Code writes verbatim.
 *
 * ⛔ **MEASURED (Open Question 3, VS, 2026-10-24).** An encoded path that would
 * pass 200 characters is cut to 200, then `-`, then 6 hash characters (a
 * measured name was 207 long, `…-x911fg`). The hash is not invertible from here,
 * so such a folder cannot be matched to a path — and so a name LONGER than this
 * is always a hashed one, since a verbatim name never exceeds it.
 */
export const CLAUDE_NAME_LIMIT = 200;
/**
 * The folder name Claude Code gives a project path — Open Question 3.
 *
 * ⛔ **EVERY UTF-16 CODE UNIT OUTSIDE `[A-Za-z0-9]` BECOMES ONE `-`.** Measured by
 * running throwaway sessions in folders named with `. _`, a space, `@ + ~ ( ) ' =
 * , # % &`, `é` and an emoji: all of them, and the emoji TWICE, because the
 * regular expression below runs over code units (no `u` flag) and an emoji is
 * two. Runs do NOT collapse (`501/-Users` gave `501--Users`), a literal `-` stays
 * itself, case is kept, and a leading `/` gives a leading `-`.
 *
 * ⚠ **This replaces `/[/.]/g`, which was the rule the first version of
 * `locateCurrentTranscript` derived from 17 folders none of which held anything
 * else.** For a repo whose path held an `_` or a space, `connect`'s test capture
 * looked in a folder that does not exist and skipped the beat (a 0.6.x defect;
 * `test/scan-encodings.test.ts` carries its regression cell).
 *
 * ⚠ **It returns the FULL encoding even past the limit**, and the callers decide
 * what that means: `locateCurrentTranscript` cannot find a hashed folder, and the
 * scan's walk compares PREFIXES of a name that is itself at most the limit, so a
 * longer prefix simply never matches. One function, no second spelling of the rule.
 */
export function encodeProjectPath(path) {
    return path.replace(/[^A-Za-z0-9]/g, "-");
}
/** Is this folder name one Claude Code cut and hashed? See `CLAUDE_NAME_LIMIT`. */
export function isHashedProjectName(name) {
    return name.length > CLAUDE_NAME_LIMIT;
}
/**
 * The transcript for the session running right now.
 *
 * A hook is HANDED `transcript_path` on stdin. `connect` is typed by a human and
 * gets nothing, so it has to find one: Claude Code stores transcripts at
 * `<transcriptRoot>/<encoded-project-path>/<session-id>.jsonl`, where the
 * encoding is `encodeProjectPath` above. The first version of that was derived
 * by comparing every directory on this machine against the `cwd` its transcripts
 * record — 15 of 17 matched exactly, and both misses were sessions whose `cwd`
 * MOVED mid-session, not a different encoding. ⚠ Seventeen folders cannot
 * contain a character none of them had: see `encodeProjectPath` for what that
 * assumption cost.
 *
 * Which is also why this looks up the directory for THIS project rather than
 * taking the newest transcript anywhere: a session that started in another
 * project and `cd`'d here lives under that project's directory, and uploading it
 * would attach one project's session to another's repo — the same confusion
 * `CR-017d`'s key exists to prevent.
 *
 * **Confined.** The result is gated, because this is a reader of transcript
 * bytes and `/cso` finding 1 is about exactly this class of read. A candidate
 * that resolves outside the root is not returned.
 *
 * ⛔ **Against THIS DIALECT'S OWN ROOT, and not against the registry union —
 * which is a deliberate difference from the two hook call sites.** The union
 * exists for a path that ARRIVES from outside, where which agent produced it is
 * not known. This function BUILDS its candidates by joining its own root, so
 * every other root in the registry is unreachable here by construction and
 * admitting them would be a widening that buys nothing. (It is also what keeps
 * this module out of an import cycle with the registry, whose failure mode is a
 * temporal-dead-zone `undefined` at module load rather than an error.)
 */
function locateCurrentTranscript(home, env, projectKey) {
    const root = transcriptRoot(home, env);
    const name = encodeProjectPath(projectKey);
    // A hashed folder name cannot be derived from the path, so there is nothing to
    // look in. `connect` then skips the test-capture beat, as it does for an agent
    // with no locator, rather than guessing a sibling.
    if (isHashedProjectName(name))
        return null;
    const dir = join(root, name);
    let entries;
    try {
        entries = readdirSync(dir);
    }
    catch {
        return null;
    }
    let best = null;
    for (const entry of entries) {
        if (!entry.endsWith(".jsonl"))
            continue;
        const path = join(dir, entry);
        if (!isInside(root, path))
            continue;
        let stat;
        try {
            stat = statSync(path);
        }
        catch {
            continue;
        }
        if (!stat.isFile() || stat.size === 0)
            continue;
        if (best === null || stat.mtimeMs > best.mtime) {
            best = {
                path,
                sessionId: basename(entry, ".jsonl"),
                size: stat.size,
                mtime: stat.mtimeMs,
            };
        }
    }
    return best === null ? null : { path: best.path, sessionId: best.sessionId, size: best.size };
}
/**
 * ⛔ **MEASURED (`M1`), 2026-08-21, BOTH ARMS.**
 *
 * Claude Code exports `CLAUDE_CODE_SESSION_ID` into the Bash tool's environment
 * and git passes it through to `post-commit`:
 *
 *   - agent commit → the uuid, **byte-identical to the transcript filename**;
 *   - human commit, the variable stripped → `<UNSET>`, so `null` here;
 *   - commit from a linked worktree → **the same uuid**.
 *
 * That third row is why this is worth a member: the value survives the worktree
 * boundary that the mtime heuristic in `spool.ts` cannot see across.
 *
 * ⚠ **`null` on empty or whitespace, not `""`.** An exported-but-empty variable
 * is the shell's idea of unset, and a `""` session id would key a spool bucket
 * every unset process shares.
 */
function claudeSessionIdFromEnv(env) {
    const raw = env.CLAUDE_CODE_SESSION_ID;
    if (raw === undefined)
        return null;
    const value = raw.trim();
    return value === "" ? null : value;
}
/**
 * The folders Claude Code has recorded running in: the KEYS of `~/.claude.json`'s
 * `projects` map, and nothing else.
 *
 * ⛔ **Keys only.** The file also holds account and onboarding state, none of
 * which this client has any use for. Nothing but the key strings leaves this
 * function, and a failure of any kind is an empty list: the signal then simply
 * does not fire, which skips less. ⚠ **No error is ever surfaced or logged** — Node
 * 22's `JSON.parse` message quotes the text it failed on, and this file is not
 * one whose text belongs on a screen.
 */
function recordedProjectPaths(home, env) {
    try {
        const parsed = JSON.parse(readFileSync(claudeConfigPath(home, env), "utf8"));
        const projects = typeof parsed === "object" && parsed !== null
            ? parsed.projects
            : undefined;
        return typeof projects === "object" && projects !== null ? Object.keys(projects) : [];
    }
    catch {
        return [];
    }
}
/**
 * Claude Code's sessions, by folder — `D11 · A`, `scan`.
 *
 * `<root>/<encoded path>/<session-id>.jsonl`. Only the files DIRECTLY in a
 * project folder are sessions: `<session-id>/subagents/…` holds delegated work
 * that belongs to a parent session (`CR-124`), and counting it would turn one
 * session into several. A legacy `agent-*.jsonl` sidechain at this level is
 * excluded for the same reason.
 *
 * ⛔ **Names and times only.** The folder name is returned still ENCODED; whether
 * it resolves to a path is the scan engine's walk, against the filesystem, never
 * against a transcript's own `cwd` record (D60 §D6).
 */
function claudeSessionSource(home, env) {
    const root = transcriptRoot(home, env);
    const folders = [];
    try {
        for (const folder of subdirectories(root)) {
            const sessions = [];
            for (const entry of readEntries(folder.path) ?? []) {
                if (!entry.name.endsWith(".jsonl") || entry.name.startsWith("agent-"))
                    continue;
                const session = sessionFile(join(folder.path, entry.name));
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
    return {
        kind: "folders",
        folders,
        encode: encodeProjectPath,
        isHashed: isHashedProjectName,
        recorded: recordedProjectPaths(home, env),
    };
}
export const CLAUDE_CODE = {
    id: "claude-code",
    transport: "ndjson",
    transcriptRoot,
    // ⛔ `CR-193`, D177 §2 — the lane's `.jsonl` gate, and NOTHING MORE under this
    // root. `<projects>/<encoded-project-path>/` holds `<session-id>.jsonl` and a
    // `subagents/` directory, so every file here is already a transcript; there is
    // no interior shape to require, unlike Cursor's.
    admitsFile: isTranscriptFile,
    // ⛔ IDENTITY, and it is the reference the other two are measured AGAINST —
    // `HOOK_EVENTS` is spelled the way Claude Code spells it, because this is the
    // agent the client was built for. Declared explicitly rather than defaulted so
    // that a dialect added later must ANSWER the question; a default would let a
    // camelCase agent inherit Claude's spellings and match nothing (`CR-195`).
    eventNames: {
        Stop: "Stop",
        PreCompact: "PreCompact",
        SessionEnd: "SessionEnd",
        SessionStart: "SessionStart",
    },
    // ⛔ `~/.claude/settings.json`, honouring `CLAUDE_CONFIG_DIR`. ⚠ This is the
    // file the PLUGIN path does not need — the plugin ships its own `hooks.json`
    // — and the npm path had no writer at all, which is the defect `/install`
    // has been advertising past since it first claimed `connect` wires hooks.
    hookConfig: { path: claudeSettingsPath, shape: "claude" },
    events: {
        Stop: {
            registeredTimeoutMs: CLAUDE_REGISTERED_STOP_MS,
            clientBudgetMs: CLAUDE_CLIENT_BUDGET_MS,
        },
        PreCompact: {
            registeredTimeoutMs: CLAUDE_REGISTERED_PRECOMPACT_MS,
            clientBudgetMs: CLAUDE_CLIENT_BUDGET_MS,
        },
        SessionEnd: {
            registeredTimeoutMs: CLAUDE_REGISTERED_SESSION_END_MS,
            clientBudgetMs: CLAUDE_CLIENT_BUDGET_MS,
        },
        // MEASURED (Open Question 1, 2.1.309): fires before the first prompt in `-p`
        // and the TUI, and accepts `systemMessage`. gstack-shortcut(dec-e650afbf).
        SessionStart: {
            registeredTimeoutMs: CLAUDE_REGISTERED_SESSION_START_MS,
            clientBudgetMs: CLAUDE_CLIENT_BUDGET_MS,
        },
    },
    // `<session>/subagents/agent-*.jsonl`, globbed — the paths are never handed
    // over. `CR-124`, D76.
    delegatedTranscripts: "discover",
    redaction: "claude-code",
    sessionIdFromEnv: claudeSessionIdFromEnv,
    sessionSource: claudeSessionSource,
    locateCurrentTranscript,
};
//# sourceMappingURL=claude_code.js.map