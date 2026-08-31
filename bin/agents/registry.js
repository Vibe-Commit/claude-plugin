/**
 * The registry — `CR-183`, D164.
 *
 * The one place that knows which dialects exist. Two things are derived from it
 * and from nothing else: which adapter a `--agent=` value selects, and the set
 * of roots the confinement check runs over.
 *
 * ## ⛔ Why `--agent=` is the selector, and why two alternatives are SECURITY
 * rejections rather than taste
 *
 *   - **an environment variable** — rejected because Codex exports
 *     `CLAUDE_PLUGIN_ROOT` itself, so the obvious variable is set by the wrong
 *     agent and says the wrong thing.
 *   - **`hook_event_name`** — rejected because both members of this lane fire
 *     the same three events. It discriminates nothing.
 *   - ⛔ **the `transcript_path` prefix, as the PRIMARY selector** — rejected
 *     because that is *the attacker-influenced input `isInside` exists to
 *     constrain.* A path that CLAIMS to sit under a root may not be what
 *     decides which root we will read from.
 *
 * ⚠ **`CR-185` picking the SCRUBBER by the containing root is not a
 * contradiction — read D164 §5 before you think it is.** Choosing a STRICTER
 * scrubber because a path sits outside every known root is fail-closed;
 * choosing a WIDER root because a path claims to be there is not. The
 * confinement boundary is computed from this registry either way, so a wrong
 * SELECTION can pick a suboptimal redaction profile and can never widen the
 * boundary.
 */
import { isInside, isInsideAny } from "../paths.js";
import { CLAUDE_CODE } from "./claude_code.js";
import { CODEX_CLI } from "./codex_cli.js";
import { CURSOR } from "./cursor.js";
import { UNKNOWN_AGENT_ID, } from "./types.js";
/**
 * Every dialect, in registration order.
 *
 * ⛔ **The ids are D164 §1's, spelled exactly.** `test/agent-registry.test.ts`
 * pins them against the literal list, because the four-way cross-repo spelling
 * fails silently in the direction that matters: emit `codex_cli` and the server
 * does not recognise it, the default extractor runs, and the row lands `unknown`
 * permanently with no error anywhere.
 */
export const DIALECTS = [CLAUDE_CODE, CODEX_CLI, CURSOR];
/**
 * What an invocation with no `--agent=` is.
 *
 * Claude Code, because that is what every install shipped before this flag
 * existed — the `.claude-plugin` bundle's command carries no `--agent=` and
 * must keep working unchanged.
 */
export const DEFAULT_AGENT_ID = "claude-code";
/** The flag. ⛔ `--agent=<value>`; there is no space-separated form. */
const AGENT_FLAG = "--agent=";
/**
 * Read the adapter id off argv.
 *
 * ⛔ **CALLED FROM `index.ts`, beside `invocationMode`, and NOWHERE ELSE.** The
 * hook path never sees argv: `runHook` takes a `HookEnvironment`, and the id
 * reaches it as a field on that object — the same seam that already injects
 * `home` and `nodeVersion` so the whole path can be driven by a test. ⛔ And
 * `parseHookInput` must NOT select the adapter: stdin is the input the
 * confinement boundary exists to constrain, and a selector read from there is
 * the rejection above with an extra step.
 *
 * ⚠ **Resolving an id is NOT entering hook mode**, and the difference is the
 * trap this wave is most likely to ship. `invocationMode` returns `"hook"` only
 * when `argv[0] === "hook"` (or a legacy env var is set), and Codex sets
 * neither — so a registered command whose FIRST argument is this flag runs the
 * binary INTERACTIVELY, inside a hook. ⛔ **The registered command must lead
 * with the `hook` verb.** `test/agent-registry.test.ts` holds both arms.
 *
 * Returns the LITERAL it was given. It is deliberately not narrowed to
 * `AgentId`: an id we do not recognise still has to travel, and the honest thing
 * to carry is what the operator wrote.
 */
export function resolveAgentId(argv) {
    for (const arg of argv) {
        if (!arg.startsWith(AGENT_FLAG))
            continue;
        const value = arg.slice(AGENT_FLAG.length).trim();
        if (value !== "")
            return value;
    }
    return DEFAULT_AGENT_ID;
}
/**
 * The dialect an id selects.
 *
 * ⛔ **AN UNKNOWN ID FALLS BACK; IT NEVER STOPS CAPTURE (plan §D7, founder
 * ruling).** The client still reads, still redacts and still sends. Refusing was
 * considered and rejected: a misconfigured hook that captures NOTHING is a worse
 * outcome than one that captures conservatively, and the server has an honest
 * label (`unknown`, D164 §1) for a producer it does not recognise — so nothing
 * downstream has to guess.
 *
 * ⚠ **The fallback is a BEHAVIOUR choice only.** The literal the operator gave
 * is not rewritten by this function; callers that put the agent on the wire read
 * the id, not the dialect.
 */
export function dialectFor(agentId) {
    return DIALECTS.find((dialect) => dialect.id === agentId) ?? CLAUDE_CODE;
}
/**
 * Every transcript root, deduped — ⛔ **the confinement boundary, computed from
 * the REGISTRY and never from input.**
 *
 * A union rather than "the selected dialect's root" on purpose. The selection
 * comes from a flag an install may have got wrong; the boundary must not. With
 * the union, a wrong selection costs a suboptimal redaction profile (D164 §5)
 * and cannot make a file readable that was not readable before.
 *
 * Deduped because two dialects can be pointed at one directory by environment —
 * `CODEX_HOME` and `CLAUDE_CONFIG_DIR` are both operator-set — and a duplicated
 * root would make `isInsideAny` do the same `realpath` pair twice for no reason.
 */
export function transcriptRoots(home, env) {
    return [...new Set(DIALECTS.map((dialect) => dialect.transcriptRoot(home, env)))];
}
/**
 * ⛔ **MAY THIS PATH BE READ AS A TRANSCRIPT? — confinement, THEN the file
 * gate (`CR-193`, D177 §2).**
 *
 * Two different questions, asked in an order that cannot be swapped:
 *
 *   1. `isInsideAny(transcriptRoots(...))` — *may this path be read at all.*
 *      Registry-computed, never derived from input, byte-unchanged from
 *      `CR-183`. `/cso` finding 1.
 *   2. the containing dialect's `admitsFile` — *is this file a transcript.* A
 *      root can be exactly right and still hold files that are not transcripts;
 *      there are 112 of them under Cursor's.
 *
 * ⛔ **STEP 2 CAN ONLY REFUSE.** It runs over a path step 1 already admitted, so
 * every outcome is a narrowing — D177 §7's direction test, which is what makes
 * this the accepted shape rather than the rejected `transcript_path`-as-boundary
 * one. The boundary is still the registry's.
 *
 * ⚠ **The `unknown` arm keeps step 1's answer, deliberately.** A path inside two
 * roots is admitted by the boundary and is `unknown` to `agentForTranscript`;
 * `dialectFor` then falls back to Claude, whose gate is the plain `.jsonl` test.
 * Refusing on `unknown` here would be a THIRD boundary rule, and it would refuse
 * captures D177 §7 decided to keep (the header is omitted, the bytes still go).
 *
 * ⚠ Two root resolutions rather than one — `isInsideAny` resolves, then
 * `agentForTranscript` resolves again. Measured against the alternative, which
 * is folding the two into one pass by editing `agentForTranscript`: that
 * function is the wire's producer oracle and `test/wire-agent.test.ts` gates it,
 * so a handful of `realpath` calls inside a multi-second budget is the cheaper
 * side of that trade.
 */
export function admitsTranscript(home, env, transcriptPath) {
    if (!isInsideAny(transcriptRoots(home, env), transcriptPath))
        return false;
    const dialect = dialectFor(agentForTranscript(home, env, transcriptPath));
    return dialect.admitsFile(dialect.transcriptRoot(home, env), transcriptPath);
}
/**
 * ⛔ **WHICH AGENT PRODUCED THIS TRANSCRIPT — the containing registry root's,
 * NEVER the `--agent=` flag's (`CR-204`, D177 §7).**
 *
 * ## Why the flag cannot be the answer
 *
 * `DEFAULT_AGENT_ID` is `claude-code` and **no install passes the flag** — the
 * `.claude-plugin` bundle's command is `node "…/bin/index.js" hook`, no flag, as
 * the docblock above records. So a flag-derived wire value is `claude-code` for
 * every path that did not remember to set it: a FALSE PROVENANCE CLAIM,
 * permanent, in the artifact whose entire worth is faithfulness. The wire is not
 * a place to be wrong in a plausible direction
 * (`project_plausible_answer_hazard_class`).
 *
 * ## ⛔ This is `CR-185`'s shape, not `CR-183`'s rejected one
 *
 * `rulesForTranscript` in `redact.ts` is the same three lines with `RULES` in
 * place of `id`, and its own docblock carries the distinction verbatim:
 *
 *   - choosing a **stricter scrubber** — or a LESS specific producer — because a
 *     path sits outside every known root is **fail-closed**;
 *   - choosing a **wider root** because a path *claims* to be there is not.
 *
 * ⛔ **The confinement boundary is untouched and still runs FIRST.** This is a
 * LOOKUP AGAINST an already-computed boundary: `transcriptRoots` decides what
 * may be read, `isInsideAny` refuses everything else, and only then does this
 * ask which of the roots that already admitted the file names its producer. It
 * can never widen anything, and its arity is 3 — ⛔ **the flag is not a
 * parameter of it at all.**
 *
 * ## Zero or two → `unknown`, ⛔ which the wire step turns into an OMISSION
 *
 * Exactly one match names the agent. Two dialects can be pointed at one
 * directory by environment (`CLAUDE_CONFIG_DIR` and `CODEX_HOME` are both
 * operator-set and both sides resolve through `realpath`), and a path inside two
 * roots is a path whose producer is not known. `unknown` is D164 §3's honest
 * label for exactly that.
 *
 * ⛔ **It is not, however, what goes on the wire.** `buildIngestHeaders` OMITS
 * `x-agent` for this answer, because the server treats an absent header and a
 * present `unknown` as different facts: absent is *"nothing to say"* and leaves
 * a stream's pinned agent alone, while a present `unknown` resolves and
 * DISAGREES with any non-`unknown` pin — which drops the buffered tail and sheds
 * the in-flight turn. Selecting `unknown` here is therefore a decision to say
 * nothing, not a value to assert. `post.ts` carries the full argument.
 *
 * ⚠ **The zero-match arm has NO CLIENT CALLER on the hook path**, said plainly
 * rather than left to be assumed (`feedback_unexercisable_branch_not_verified`):
 * `isInsideAny(transcriptRoots(...))` refuses everything outside the union
 * before a delta is ever built. It is a second independent line, and
 * `test/agent-registry.test.ts` exercises it by calling this function directly.
 */
export function agentForTranscript(home, env, transcriptPath) {
    const matches = DIALECTS.filter((dialect) => isInside(dialect.transcriptRoot(home, env), transcriptPath));
    return matches.length === 1 ? matches[0].id : UNKNOWN_AGENT_ID;
}
//# sourceMappingURL=registry.js.map