/**
 * The command a `CONSENT_NEEDS_TTY` refusal prints for a retry: the same `connect` run without redirecting its output (ENG-31), with the
 * names and every accepted argument given (DX-23, and CLI UX PR-B round prb1 #10). One helper for every refusal site, so a retry never
 * drops an argument that could upload, such as `--no-backfill`, or `--agent`.
 */
import { COMMANDS } from "../copy/index.js";
import { channelCommand } from "../install.js";
export function connectRetryCommand(env, selfPath, tokens, options) {
    const flags = [
        ...(options.signIn === true ? ["--sign-in"] : []),
        ...(options.device === true ? ["--device"] : []),
        ...(options.noBackfill === true ? ["--no-backfill"] : []),
        // `--typed` goes only with no names: names plus `--typed` is CONNECT_ARGS_CONFLICT, whose fix line never repeats it.
        ...(options.typed === true && tokens.length === 0 ? ["--typed"] : []),
        ...(options.agentFlag != null ? [options.agentFlag] : []),
        ...(options.noColor === true ? ["--no-color"] : []),
    ];
    return channelCommand(env, selfPath, [COMMANDS.connect, ...tokens, ...flags].join(" "));
}
//# sourceMappingURL=connect_retry.js.map