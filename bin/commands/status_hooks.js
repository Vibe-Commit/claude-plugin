/**
 * The hook facts `status` states about the clone it is run in, and the agents it is run for (0.7.0).
 *
 * Read-only by construction: nothing here writes, spawns a long-lived process or reaches the network. `status`
 * reports and `connect` repairs — a settings file or a git hook is never changed from a read verb.
 *
 * Three facts, each said once and only when it is true:
 *   - an agent whose config holds our hooks but not `SessionStart` (npm channel only; T21);
 *   - a captured clone whose commit hooks are off, with `connect` named as the fix (D4 · A);
 *   - a captured clone under `core.hooksPath`, with the shipped runnable fix block (state 7 sends users here).
 */
import { readFileSync } from "node:fs";
import { agentPresent, registrationsFor } from "../agent_install.js";
import { hasRegistration } from "../agent_hooks.js";
import { DIALECTS } from "../agents/registry.js";
import { COMMANDS, COMMIT_HOOK, STATUS } from "../copy/index.js";
import { channelCommand, installChannel, inspectCaptureHooks } from "../install.js";
import { renderErrorBlock, wrap } from "../term.js";
/** What each agent is called in prose. The ids are wire values, not labels. */
const AGENT_LABELS = {
    "claude-code": "Claude Code",
    "codex-cli": "Codex CLI",
    cursor: "Cursor",
};
/** Agents on this machine that hold our hooks but no `SessionStart`. Empty on the plugin channel. */
function agentsMissingSessionStart(ctx) {
    if (installChannel(ctx.env, ctx.selfPath).kind === "plugin")
        return [];
    const missing = [];
    for (const dialect of DIALECTS) {
        if (!agentPresent(dialect, ctx.home, ctx.env))
            continue;
        let raw = null;
        try {
            raw = readFileSync(dialect.hookConfig.path(ctx.home, ctx.env), "utf8");
        }
        catch {
            raw = null;
        }
        const registrations = registrationsFor(dialect, ctx.selfPath);
        const ours = (event) => {
            const registration = registrations.find((r) => r.event === event);
            return registration !== undefined && hasRegistration(raw, dialect.hookConfig.shape, registration);
        };
        // An agent we were never connected to has none of ours and is not "missing" anything.
        const connected = registrations.some((r) => ours(r.event));
        if (connected && !ours(dialect.eventNames.SessionStart))
            missing.push(dialect.id);
    }
    return missing;
}
/** The lines to add to `status`, already wrapped, each block preceded by a blank line. */
export function hookStateLines(ctx, toplevel, captured) {
    const lines = [];
    // ⛔ ONLY WHERE `connect` WOULD FIX IT. In a repo that is not captured, `connect`'s No exits before it registers
    // any agent, so naming it as the fix would send the user to a command that changes nothing. (Machine-level
    // `status` has no such restriction; it arrives with the picker.)
    const missing = captured ? agentsMissingSessionStart(ctx) : [];
    if (missing.length > 0) {
        lines.push("", ...wrap(STATUS.sessionStartMissing(missing.map((id) => AGENT_LABELS[id]).join(", "), channelCommand(ctx.env, ctx.selfPath, COMMANDS.connect)), 2));
    }
    // The plugin ships no git hooks, so "commit hooks are off" would be a false alarm there.
    if (captured && installChannel(ctx.env, ctx.selfPath).kind !== "plugin") {
        const hooks = inspectCaptureHooks(toplevel);
        if (hooks.kind === "off")
            lines.push("", ...wrap(STATUS.commitHooksOff(channelCommand(ctx.env, ctx.selfPath, COMMANDS.connect)), 2));
        else if (hooks.kind === "foreign")
            lines.push("", ...wrap(STATUS.commitHooksForeign(channelCommand(ctx.env, ctx.selfPath, COMMANDS.connect)), 2));
        else if (hooks.kind === "hooks-path") {
            lines.push("", ...renderErrorBlock({
                kind: "warn",
                what: COMMIT_HOOK.hooksPathWhat,
                why: [COMMIT_HOOK.hooksPathWhy(hooks.configured)],
                fixLabel: COMMIT_HOOK.hooksPathFixLabel,
                fixes: [COMMIT_HOOK.hooksPathFixUnset, COMMIT_HOOK.hooksPathFixManual(channelCommand(ctx.env, ctx.selfPath, COMMANDS.postCommit))],
            }, ctx.colour));
        }
    }
    return lines;
}
//# sourceMappingURL=status_hooks.js.map