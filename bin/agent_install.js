/**
 * Registering capture with every agent on this machine — `CR-195`/U4b, D205.
 *
 * ⛔ **THIS IS THE FILE `/install` HAS BEEN DESCRIBING SINCE BEFORE IT EXISTED.**
 * `app/install/page.tsx` told users that `vibecommit connect` *"wires Claude Code
 * hooks on Stop, PreCompact and SessionEnd"*. It did not: `connect` wrote GIT
 * hooks only, and nothing in `src/` ever wrote `settings.json`. The three events
 * were registered in exactly one place — `claude-plugin/hooks/hooks.json` — so
 * the npm path gave a user no session capture at all, silently, while the page
 * said otherwise.
 *
 * ## What is written, and what decides it
 *
 * Everything below is DERIVED from the registry rather than restated here:
 *
 *   - **which file** — `dialect.hookConfig.path(home, env)`, honouring
 *     `CLAUDE_CONFIG_DIR` and `CODEX_HOME` because those products honour them;
 *   - **which document shape** — `dialect.hookConfig.shape`, two shapes across
 *     three agents (Cursor's is its own);
 *   - **which event names** — `dialect.eventNames`, camelCase for Cursor;
 *   - **which timeouts** — `dialect.events[event].registeredTimeoutMs`, so the
 *     number written into an agent's config and the number this client checks
 *     its own watchdog against cannot drift apart.
 *
 * ⚠ That last one matters more than it looks. `EventBudget` requires
 * `clientBudgetMs < registeredTimeoutMs`, and until this file existed the
 * "registered" half was a MIRROR of a JSON file hand-maintained in another
 * repository — `test/agent-registry.test.ts` says so, and says a drift in it is
 * invisible from here. For the three files this writes, the mirror becomes the
 * source.
 *
 * ## ⛔ Only agents that are actually here
 *
 * A config is written only when the directory that would contain it already
 * exists. Creating `~/.cursor/hooks.json` on a machine with no Cursor is not
 * harmless: it is a file the user never asked for, in a tool they do not run,
 * that a future Cursor install would silently inherit. ⚠ The directory — never
 * the config file — is the evidence, because the file's absence is the ordinary
 * first-install case and is exactly what this function is for.
 */
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { writeAgentHooks } from "./agent_hooks.js";
import { DIALECTS } from "./agents/registry.js";
import { HOOK_EVENTS } from "./agents/types.js";
/**
 * The command an agent's config invokes.
 *
 * ⛔ **`hook` LEADS, AND THE FLAG NEVER DOES.** `invocationMode` returns `"hook"`
 * only when `argv[0] === "hook"`, so a registered command whose first argument
 * is `--agent=` runs the binary INTERACTIVELY — inside a hook, printing to a
 * stream the agent reads back into the user's turn. `registry.ts` names this as
 * the trap the wave was most likely to ship, and `test/agent-registry.test.ts`
 * holds both arms.
 *
 * ⚠ **The flag is passed explicitly for every agent, Claude Code included**,
 * even though `DEFAULT_AGENT_ID` makes it redundant there. A config that names
 * its own agent is self-describing, and — since Cursor reads Claude Code's
 * settings and maps them onto its own events — it is the only thing that tells
 * the two invocations apart when both fire.
 */
export function hookCommand(binPath, agentId) {
    return `${quote(binPath)} hook --agent=${agentId}`;
}
/** Double-quote for the shells these configs are read by. */
function quote(value) {
    return `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}
/** Every event this client registers, in one agent's own vocabulary. */
export function registrationsFor(dialect, binPath) {
    return HOOK_EVENTS.map((event) => ({
        event: dialect.eventNames[event],
        command: hookCommand(binPath, dialect.id),
        // ⛔ SECONDS, from the registry's milliseconds. Every one of the three
        // configs takes seconds; `EventBudget` is in milliseconds because the
        // client's own watchdog is. For Codex this lands `SessionEnd` on 3 s, which
        // is exactly the cap Codex clamps to whatever we ask for — measured, so the
        // number we write is the number that takes effect.
        timeoutSec: Math.max(1, Math.round(dialect.events[event].registeredTimeoutMs / 1000)),
    }));
}
/** Is this agent on the machine at all? The DIRECTORY, never the config file. */
export function agentPresent(dialect, home, env) {
    return existsSync(dirname(dialect.hookConfig.path(home, env)));
}
/**
 * Register capture with every agent present on this machine.
 *
 * ⚠ **Never throws and never partially aborts.** Each agent is independent: a
 * refusal to overwrite one unparseable `settings.json` must not stop the other
 * two being wired, and the caller reports all three. That is the same shape
 * `installCaptureHooks` uses for its two git hooks and the same reason —
 * a per-target verdict is the only honest answer when the targets are unrelated.
 */
export function installAgentHooks(home, env, binPath) {
    return DIALECTS.map((dialect) => {
        const path = dialect.hookConfig.path(home, env);
        if (!agentPresent(dialect, home, env)) {
            return { agentId: dialect.id, path, install: null };
        }
        return {
            agentId: dialect.id,
            path,
            install: writeAgentHooks(path, dialect.hookConfig.shape, registrationsFor(dialect, binPath)),
        };
    });
}
//# sourceMappingURL=agent_install.js.map