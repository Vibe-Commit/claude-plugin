/**
 * Is this machine's setup unfinished? One predicate, the plan's §4.4a (CEO-4, ENG-3; CR-PRB T9a).
 *
 * Nothing else decides it. `status`'s heading and `--json` field, and `connect`'s "finish setup" answers, all read this.
 *
 * ⛔ NOT IMPORTED BY THE HOOK PROCESS. The hooks import `machine_state.ts` (through `hooks/session_grants.ts`), so this
 * module imports neither that file, nor `term.ts`, nor `status_hooks.ts`. The caller computes "grants name something here"
 * and passes it in as `grantsOn` (`machineCapture(home).kind === "on"`), so the grants reader is not needed here.
 *
 * ⛔ NEVER THROWS. Every exclusion in §4.4a ("Excluded from the repairs") returns neither branch (a) nor a repair. The
 * only `unknown` is a read this module cannot complete (`lstat`/`stat` of the credential path, for a reason other than
 * `ENOENT`), or an error from a probe it calls, and that comes back as data.
 *
 * Read-only. It writes no file and spawns no process beyond the git probes `inspectCaptureHooks` already runs.
 */
import { accessSync, constants, existsSync, lstatSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { agentHookVerdicts } from "./agent_install.js";
import { inspectCaptureHooks, installChannel, resolveHooksDir, staleCommitHookBinary } from "./install.js";
import { credentialsPath, rootDir } from "./paths.js";
const DEFAULT_DEPS = { inspectCommitHooks: inspectCaptureHooks, agentVerdicts: agentHookVerdicts };
/** The predicate. Never throws: anything it cannot read comes back as `unknown`. */
export function setupState(input, deps = {}) {
    if (!input.grantsOn)
        return { kind: "not-on" };
    const all = { ...DEFAULT_DEPS, ...deps };
    try {
        return check(input, all);
    }
    catch (error) {
        return { kind: "unknown", error: error instanceof Error ? error.message : String(error) };
    }
}
function check(input, deps) {
    const plugin = installChannel(input.env, input.selfPath).kind === "plugin";
    const noCredential = noCredentialHere(input.home, input.env);
    const commitHooks = input.commitHooks ?? input.toplevels.map((toplevel) => commitFinding(toplevel, input.selfPath, deps));
    const verdicts = deps.agentVerdicts(input.home, input.env, input.selfPath);
    const agents = agentRepairs(verdicts, plugin);
    const noAgentHooks = !plugin && noAgentHooksHold(verdicts);
    const commitRepair = commitHooks.some((f) => f.writable && (f.stale || (!plugin && (f.state.kind === "off" || f.state.kind === "foreign"))));
    return {
        kind: "checked",
        noCredential,
        commitHooks,
        agents,
        noAgentHooks,
        syncUnauthorized: input.syncUnauthorized,
        repair: commitRepair || agents.length > 0 || noAgentHooks || input.syncUnauthorized,
    };
}
/**
 * Branch (a). True only for the plain case: `VIBECOMMIT_TOKEN` is blank or unset, and there is no `credentials.json`, and
 * `~/.vibecommit` is not insecure (an insecure folder is a block of its own, §4.4a). Any file, a faulty one included, makes
 * this false, and so does any value of `VIBECOMMIT_TOKEN`, whatever its class.
 */
function noCredentialHere(home, env) {
    if ((env.VIBECOMMIT_TOKEN ?? "").trim() !== "")
        return false;
    const root = rootDir(home);
    if (existsSync(root) && (statSync(root).mode & 0o077) !== 0)
        return false;
    try {
        lstatSync(credentialsPath(home));
        return false;
    }
    catch (error) {
        if (code(error) === "ENOENT")
            return true;
        throw error;
    }
}
/**
 * The commit-hook findings for these toplevels, probed now (the caller's scan beat). `deps` is the same injection `setupState` takes.
 */
export function commitFindingsFor(toplevels, selfPath, deps = {}) {
    const all = { ...DEFAULT_DEPS, ...deps };
    return toplevels.map((toplevel) => commitFinding(toplevel, selfPath, all));
}
function commitFinding(toplevel, selfPath, deps) {
    const state = deps.inspectCommitHooks(toplevel);
    const relevant = state.kind === "on" || state.kind === "off" || state.kind === "foreign";
    // One git probe for the hooks directory, shared by the stale check and the writable check (ENG-38: the beat is timed).
    const dir = relevant ? resolveHooksDir(toplevel) : null;
    return {
        toplevel,
        state,
        stale: relevant && staleCommitHookBinary(toplevel, selfPath, dir) !== null,
        writable: hooksWritable(dir),
    };
}
/** Writable where `connect` would write: the hooks directory, or its nearest existing ancestor when git has not made it yet. */
function hooksWritable(dir) {
    let at = dir;
    if (at === null)
        return false;
    while (!existsSync(at)) {
        const up = dirname(at);
        if (up === at)
            return false;
        at = up;
    }
    try {
        accessSync(at, constants.W_OK | constants.X_OK);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Repair (c). A refused agent is not repaired (its file is the user's to fix), and neither is an unwritable one. An agent
 * with none of ours is not missing anything. The plugin channel reports only the stale arm (ENG-28).
 */
function agentRepairs(verdicts, plugin) {
    const out = [];
    for (const verdict of verdicts) {
        if (verdict.kind !== "readable" || verdict.unwritable !== null)
            continue;
        if (verdict.stale)
            out.push({ agentId: verdict.agentId, kind: "stale" });
        else if (verdict.ours === "some" && !plugin)
            out.push({ agentId: verdict.agentId, kind: "missing" });
    }
    return out;
}
/**
 * Repair (f). At least one agent is installed, no installed agent holds any of ours (or is stale), and none is refused (a refused
 * file might hold ours, so the answer would be a guess). It needs at least one installed agent that is writable: an agent that
 * is unwritable and holds none cannot be fixed by a re-run, so it does not make (f) hold on its own.
 */
function noAgentHooksHold(verdicts) {
    if (verdicts.length === 0)
        return false;
    if (verdicts.some((v) => v.kind === "refused"))
        return false;
    if (verdicts.some((v) => v.kind === "readable" && (v.ours !== "none" || v.stale)))
        return false;
    return verdicts.some((v) => v.kind === "readable" && v.unwritable === null);
}
function code(error) {
    return error?.code;
}
//# sourceMappingURL=setup_state.js.map