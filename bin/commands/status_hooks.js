/**
 * The hook facts `status` states about the setup, and about the clone it is run in (0.7.0; CR-PRB T9a).
 *
 * Read-only by construction: nothing here writes, spawns a long-lived process or reaches the network. `status`
 * reports and `connect` repairs. Every fact comes from the one predicate (`setup_state.ts`, plan §4.4a), so `status`
 * and `connect` cannot disagree about what is broken:
 *   - branch (a), no credential: the heading changes (the caller's job, see `setupUnfinishedLines`) and `--json` gains
 *     `setup_unfinished` (`setupUnfinishedJson`);
 *   - repair (c): an agent's hooks need an update (`agentHooksNeedUpdate`);
 *   - repair (f): no coding agent holds any of ours (`noAgentHooks`);
 *   - repair (b): a commit hook is `off`, `foreign`, under `core.hooksPath`, or names a removed binary (`commitHooksStale`
 *     and the 0.7.0 lines for the other three);
 *   - a predicate that could not read its inputs (`setupUnknown`).
 * A repair prints its detail line under an UNCHANGED heading; only branch (a) changes the heading (ENG-3).
 */
import { AGENT_HOOKS, COMMANDS, COMMIT_HOOK, STATUS } from "../copy/index.js";
import { channelCommand, installChannel } from "../install.js";
import { agentHookVerdicts } from "../agent_install.js";
import { terminalSafe } from "../printable.js";
import { renderErrorBlock, wrap } from "../term.js";
/** What each agent is called in prose. The ids are wire values, not labels. */
const AGENT_LABELS = {
    "claude-code": "Claude Code",
    "codex-cli": "Codex CLI",
    cursor: "Cursor",
};
/**
 * T8 (D-CODEX): does this machine hold any of our Codex hooks? The Codex trust line in `status` prints only then. Read-only.
 */
export function codexHooksHere(ctx) {
    return agentHookVerdicts(ctx.home, ctx.env, ctx.selfPath).some((v) => v.agentId === "codex-cli" && v.kind === "readable" && v.ours !== "none");
}
/**
 * T8 (4.2, DX-13, ENG-17): one `warn` block per installed agent whose config the installer refuses (its parse check, run on the text), or
 * whose directory cannot be written (`W_OK | X_OK`). Read-only, through `agentHookVerdicts`, and OUTSIDE the 4.4a predicate: a re-run of
 * `connect` cannot repair these, so they do not make setup unfinished. A 0444 file in a writable directory is not a failure.
 */
export function agentConfigWarnLines(ctx) {
    const out = [];
    const connect = channelCommand(ctx.env, ctx.selfPath, COMMANDS.connect);
    for (const verdict of agentHookVerdicts(ctx.home, ctx.env, ctx.selfPath)) {
        const agent = AGENT_LABELS[verdict.agentId];
        if (verdict.kind === "refused") {
            out.push("", ...renderErrorBlock({
                kind: "warn",
                what: AGENT_HOOKS.refusedWhat(agent),
                why: [AGENT_HOOKS.refusedWhy(terminalSafe(verdict.path), terminalSafe(verdict.why))],
                fixLabel: AGENT_HOOKS.refusedFixLabel,
                fixes: [AGENT_HOOKS.refusedFix(terminalSafe(verdict.path), connect)],
            }, ctx.colour));
        }
        else if (verdict.unwritable !== null) {
            out.push("", ...renderErrorBlock({
                kind: "warn",
                what: AGENT_HOOKS.unwritableWhat(agent),
                why: [AGENT_HOOKS.unwritableWhy(terminalSafe(verdict.path))],
                fixLabel: AGENT_HOOKS.refusedFixLabel,
                fixes: [AGENT_HOOKS.failedFix(connect)],
            }, ctx.colour));
        }
    }
    return out;
}
/** Branch (a) holds, so `status` says setup is unfinished. Only ever true where the grants are on. */
export function setupUnfinished(setup) {
    return setup.kind === "checked" && setup.noCredential;
}
/**
 * The heading's `why` and fix lines for branch (a), each under the `warn` heading. The caller prints the heading itself.
 * Only where the heading is "on" (an in-repo `status` for a repo that is off keeps its own heading).
 */
export function setupUnfinishedLines(ctx) {
    return ["", ...wrap(STATUS.setupUnfinishedWhy, 2), ...wrap(STATUS.setupUnfinishedFix(channelCommand(ctx.env, ctx.selfPath, COMMANDS.connect)), 2)];
}
/**
 * The `setup_unfinished` key of both `status --json` documents (DX-1, TASTE-8). Present only when branch (a) holds, so every
 * other document keeps its exact key set. `reasons` is an array so a later reason can be added without a new key.
 */
export function setupUnfinishedJson(ctx, setup) {
    if (!setupUnfinished(setup))
        return {};
    return {
        setup_unfinished: {
            reasons: ["no_credential"],
            fix: channelCommand(ctx.env, ctx.selfPath, COMMANDS.connect),
            needs_terminal: true,
        },
    };
}
/**
 * The detail lines for repairs (b), (c) and (f), and the predicate's `unknown`, already wrapped, each block preceded by a
 * blank line. `captured` says whether the clone (or, for machine-level `status`, the machine) is on: the repairs are said
 * only where `connect` would act on them.
 */
export function hookStateLines(ctx, setup, captured) {
    const lines = [];
    if (setup.kind === "unknown") {
        lines.push("", ...wrap(STATUS.setupUnknown(setup.error), 2));
        return lines;
    }
    if (setup.kind !== "checked" || !captured)
        return lines;
    const connect = channelCommand(ctx.env, ctx.selfPath, COMMANDS.connect);
    for (const agent of setup.agents) {
        lines.push("", ...wrap(STATUS.agentHooksNeedUpdate(AGENT_LABELS[agent.agentId], connect), 2));
    }
    if (setup.noAgentHooks)
        lines.push("", ...wrap(STATUS.noAgentHooks(connect), 2));
    // The plugin ships no git hooks, so "commit hooks are off" would be a false alarm there. A removed binary is reported there too.
    const staleClones = setup.commitHooks.filter((finding) => finding.stale && finding.writable).length;
    if (staleClones > 0)
        lines.push("", ...wrap(STATUS.commitHooksStale(staleClones, connect), 2));
    if (installChannel(ctx.env, ctx.selfPath).kind !== "plugin") {
        for (const finding of setup.commitHooks) {
            const hooks = finding.state;
            // #14 (CR-PRB1): a hooks folder that cannot be written is never repaired by a re-run (`connect` skips the clone), so "run connect to
            // add them" would send the user round a loop. It gets the failed-write block and its fix instead (4.4a, DX-13).
            if ((hooks.kind === "off" || hooks.kind === "foreign") && !finding.writable) {
                lines.push("", ...renderErrorBlock({
                    kind: "warn",
                    what: COMMIT_HOOK.failedWhat,
                    why: [COMMIT_HOOK.failedWhy(COMMIT_HOOK.hooksDirUnwritable)],
                    fixLabel: AGENT_HOOKS.refusedFixLabel,
                    fixes: [AGENT_HOOKS.failedFix(connect)],
                }, ctx.colour));
            }
            else if (hooks.kind === "off")
                lines.push("", ...wrap(STATUS.commitHooksOff(connect), 2));
            else if (hooks.kind === "foreign")
                lines.push("", ...wrap(STATUS.commitHooksForeign(connect), 2));
            else if (hooks.kind === "hooks-path") {
                lines.push("", ...renderErrorBlock({
                    kind: "warn",
                    what: COMMIT_HOOK.hooksPathWhat,
                    why: [COMMIT_HOOK.hooksPathWhy(terminalSafe(hooks.configured))],
                    fixLabel: COMMIT_HOOK.hooksPathFixLabel,
                    fixes: [COMMIT_HOOK.hooksPathFixUnset, COMMIT_HOOK.hooksPathFixManual(channelCommand(ctx.env, ctx.selfPath, COMMANDS.postCommit))],
                }, ctx.colour));
            }
        }
    }
    return lines;
}
//# sourceMappingURL=status_hooks.js.map