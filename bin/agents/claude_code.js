/**
 * The `claude-code` dialect — `CR-183`.
 *
 * ⛔ **NOTHING ABOUT CLAUDE CODE'S BEHAVIOUR CHANGES HERE.** Every value below is
 * the value the client already used, moved to where a second agent can be
 * described beside it. The one function member, `locateCurrentTranscript`, is
 * `commands/connect.ts`'s own `findCurrentTranscript` verbatim except for the
 * confinement call, which now runs against the registry's union.
 */
import { readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { claudeSettingsPath, isInside, isTranscriptFile, transcriptRoot } from "../paths.js";
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
 * The transcript for the session running right now.
 *
 * A hook is HANDED `transcript_path` on stdin. `connect` is typed by a human and
 * gets nothing, so it has to find one: Claude Code stores transcripts at
 * `<transcriptRoot>/<encoded-project-path>/<session-id>.jsonl`, where the
 * encoding replaces `/` and `.` with `-`. That was derived by comparing every
 * directory on this machine against the `cwd` its transcripts record — 15 of 17
 * matched exactly, and both misses were sessions whose `cwd` MOVED mid-session,
 * not a different encoding.
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
    const dir = join(root, projectKey.replace(/[/.]/g, "-"));
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
    eventNames: { Stop: "Stop", PreCompact: "PreCompact", SessionEnd: "SessionEnd" },
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
    },
    // `<session>/subagents/agent-*.jsonl`, globbed — the paths are never handed
    // over. `CR-124`, D76.
    delegatedTranscripts: "discover",
    redaction: "claude-code",
    sessionIdFromEnv: claudeSessionIdFromEnv,
    locateCurrentTranscript,
};
//# sourceMappingURL=claude_code.js.map