/**
 * The hook client — and the enforcement of the hook half of the exit contract.
 *
 * DESIGN.md §13.7, restated because every line below exists to hold it:
 *
 *   exit        ALWAYS 0. Every path: success, 401, 403, network failure,
 *               uncaught exception, unsupported Node, signal.
 *   stderr      ALWAYS empty.
 *   wall clock  ALWAYS under the hooks.json timeout for that event.
 *   stdout      At most one well-formed JSON object carrying `systemMessage`;
 *               otherwise empty. If JSON construction fails for ANY reason →
 *               empty stdout. The fallback is always silence.
 *
 * ⚠ **That stdout line reads "EMPTY on the happy path" in DESIGN.md §13.7, and
 * as of `CR-023d` it is no longer true.** Style guide §10.1's fourth state
 * (`capture confirmed`) fires on a successful send, once per `(repo, day)` — so
 * a populated stdout no longer implies something went wrong. §13.7 and §10.1
 * disagreed on this before this task; the code now follows §10.1, which D65
 * records as the executed ruling. DESIGN.md is orchestrator-owned (D66 §3), so
 * the amendment there is reported, not made here.
 *
 * **A hook that exits non-zero feeds stderr back into the user's agent and
 * derails the task they were actually doing.** That is the whole reason.
 *
 * ## Read this before trusting a green contract test
 *
 * `silenceStderr()` makes the stderr-empty assertion true STRUCTURALLY. That is
 * the correct engineering choice — it is the only thing that holds when a
 * dependency three levels down decides to warn — but it also means a green
 * "stderr is empty" proves the hook never speaks, and proves **nothing** about
 * whether the credential is handled carefully. The credential's own control is
 * separate and lives in `credential.ts` (opaque wrapper + redaction), with its
 * own red-proof in `test/credential.test.ts`. Do not read one as evidence for
 * the other.
 */
import { closeSync, openSync, readSync, statSync, writeSync } from "node:fs";
import { zstdCompressSync } from "node:zlib";
import { isProjectAllowed } from "../consent.js";
import { loadCredential } from "../credential.js";
import { EXIT } from "../exit.js";
import { resolveRepoSlug } from "../git.js";
import { deliver, ingestUrl } from "../post.js";
import { SESSION_END_EVENT, settleDelayMs, settledSize, } from "./session_end.js";
import { isInside, transcriptRoot } from "../paths.js";
import { resolveProjectKey } from "../project.js";
import { meetsNodeFloor } from "../runtime.js";
import { renderNotice } from "../system_message.js";
/**
 * Default wall-clock budget. `CR-028` sets the real per-event `timeout` in
 * `claude-plugin/hooks/hooks.json`; this is the client-side backstop, which must
 * be the SMALLER of the two or the backstop never fires.
 */
export const DEFAULT_HOOK_BUDGET_MS = 5_000;
/** The subset of the network budget one attempt may take. */
const SEND_BUDGET_FRACTION = 0.6;
/**
 * A floor under the send timeout, for the case the budget arithmetic cannot
 * cover: `consumedMs` is MEASURED, not planned, so a scheduler stall during the
 * settle can overshoot the budget outright and leave nothing to divide.
 * `settleDelayMs`'s cap bounds the plan; this bounds reality.
 *
 * When it binds, the outer watchdog is already the real limit — it fires at
 * `budgetMs` regardless — so a small positive timeout here costs nothing and a
 * zero or negative one would abort the send before it was attempted.
 */
const MIN_SEND_TIMEOUT_MS = 50;
/**
 * What one send attempt may take, after the settle has taken its share.
 *
 * `consumedMs` is 0 on every event but `SessionEnd`, and at 0 this is exactly
 * the expression that was inline here before `CR-020d`
 * (`Math.floor(budgetMs * SEND_BUDGET_FRACTION)`) for any budget above ~84 ms —
 * so `Stop` and `PreCompact` are unchanged in both timing and code path.
 */
export function sendTimeoutMs(budgetMs, consumedMs) {
    const remaining = Math.max(0, budgetMs - consumedMs);
    return Math.max(MIN_SEND_TIMEOUT_MS, Math.floor(remaining * SEND_BUDGET_FRACTION));
}
/** A promise that resolves after `ms`. The one clock the settle path needs. */
function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
/**
 * Parse hook stdin. Claude Code supplies `{ session_id, transcript_path, cwd,
 * hook_event_name }` on stdin — NOT in the environment.
 *
 * Returns null on anything malformed. A hook cannot report a parse error (stderr
 * is empty by contract), so the only honest response is to do nothing.
 */
export function parseHookInput(raw) {
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return null;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
        return null;
    const o = parsed;
    const sessionId = o.session_id;
    const transcriptPath = o.transcript_path;
    const cwd = o.cwd;
    const eventName = o.hook_event_name;
    if (typeof sessionId !== "string" || sessionId === "")
        return null;
    if (typeof transcriptPath !== "string" || transcriptPath === "")
        return null;
    return {
        sessionId,
        transcriptPath,
        cwd: typeof cwd === "string" && cwd !== "" ? cwd : process.cwd(),
        eventName: typeof eventName === "string" ? eventName : "",
    };
}
/**
 * Replace stderr with a sink for the rest of the process.
 *
 * Node writes uncaught exceptions, unhandled rejections and process warnings to
 * `process.stderr`, so overriding `write` is what makes the contract hold on the
 * paths we do not control. The handlers below stop the non-zero exit; this stops
 * the bytes.
 */
export function silenceStderr() {
    const sink = (_chunk, encodingOrCallback, callback) => {
        const done = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
        if (typeof done === "function")
            done();
        return true;
    };
    // The cast is unavoidable: `Writable.write` is overloaded and the sink
    // satisfies every overload's contract without matching any one signature.
    process.stderr.write = sink;
}
/**
 * Write the single stdout payload and exit 0.
 *
 * `writeSync(1, …)` rather than `process.stdout.write`: stdout to a pipe is
 * asynchronous, and `process.exit` does not flush it. A `systemMessage` lost to a
 * truncated write is the silent-unconfigured failure DX3 exists to kill.
 */
function finish(payload) {
    if (payload !== null) {
        try {
            writeSync(1, `${payload}\n`);
        }
        catch {
            // Silence is the fallback, always.
        }
    }
    process.exit(EXIT.ok);
}
/**
 * Install every contract guard, then run the body.
 *
 * Guards go in FIRST, before any work, because the paths they cover include
 * "the body threw on its first line".
 */
export async function runHook(ctx) {
    silenceStderr();
    const budgetMs = hookBudgetMs(ctx.env);
    // The watchdog covers the wall-clock clause on paths no `await` can reach: a
    // synchronous spin, a socket that never settles, a promise that never
    // resolves. `unref` so it never itself keeps the process alive.
    const watchdog = setTimeout(() => finish(null), budgetMs);
    watchdog.unref();
    process.on("uncaughtException", () => finish(null));
    process.on("unhandledRejection", () => finish(null));
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
        process.on(signal, () => finish(null));
    }
    let payload = null;
    try {
        payload = await hookBody(ctx, budgetMs);
    }
    catch {
        payload = null;
    }
    finish(payload);
}
export function hookBudgetMs(env) {
    const raw = env.VIBECOMMIT_HOOK_TIMEOUT_MS;
    if (raw === undefined)
        return DEFAULT_HOOK_BUDGET_MS;
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_HOOK_BUDGET_MS;
}
/**
 * The hook body. Returns the stdout payload, or null for silence.
 *
 * Ordering is load-bearing in two places:
 *   1. the Node floor is checked FIRST, because everything below it may use
 *      syntax or APIs the old runtime lacks;
 *   2. the CONSENT GATE runs BEFORE `transcript_path` is opened (D56 §D19). A
 *      gate that runs after the read has already read the thing it was gating.
 */
async function hookBody(ctx, budgetMs) {
    const raw = await ctx.readStdin();
    const input = parseHookInput(raw);
    if (input === null)
        return null;
    // `repoKey` is passed per call rather than captured, because the three
    // session-keyed states can fire BEFORE a project has been resolved at all —
    // `unsupported_runtime` fires before anything else runs. Only
    // `capture_confirmed` needs one, and only it supplies one.
    const notice = (state, repoKey = null) => renderNotice({
        home: ctx.home,
        sessionId: input.sessionId,
        nodeVersion: ctx.nodeVersion,
        repoKey,
        now: () => new Date(),
    }, state);
    if (!meetsNodeFloor(ctx.nodeVersion))
        return notice("unsupported_runtime");
    // --- CONSENT GATE. Nothing above this line has opened the transcript. ---
    // The null arm is not new behaviour — `isProjectAllowed(home, null)` is already
    // false, so a `cwd` outside a work tree already stopped here. It is stated
    // separately because `CR-017d` makes this value half the delivery key as well
    // as the consent key, and a key the compiler cannot prove is present is one
    // some later edit supplies a placeholder for.
    const projectKey = resolveProjectKey(input.cwd);
    if (projectKey === null || !isProjectAllowed(ctx.home, projectKey)) {
        // Unconsented is not "not connected": say nothing at all. A machine with no
        // credential says state 1 below; a repo the user declined stays silent,
        // because nagging about a decision the user already made is the tool noise
        // DX3's one-line rule exists to avoid.
        return null;
    }
    const load = loadCredential({ env: ctx.env, home: ctx.home });
    switch (load.kind) {
        case "absent":
            return notice("not_connected");
        case "wrong-class":
        case "insecure-file":
        case "unreadable":
            // Interactive verbs print four different fixes for these (§13.6). A hook
            // has one channel and a one-line budget, so they collapse to the state
            // whose fix — `vibecommit connect` — is the same for all four.
            return notice("not_connected");
        case "ok":
            break;
    }
    // --- PATH CONFINEMENT. `/cso` finding 1, HIGH. ---
    // `transcript_path` is attacker-influenced in the one way that matters: it
    // reaches a read whose result is uploaded. Confining it to the directory
    // Claude Code actually writes transcripts to is what stops this verb being a
    // silent arbitrary-file exfiltrator. Silent refusal, per the contract.
    if (!isInside(transcriptRoot(ctx.home, ctx.env), input.transcriptPath))
        return null;
    const url = ingestUrl(ctx.env);
    // `/cso` finding 2: a rejected override is a silent no-send, not a fallback to
    // the default. Falling back would send the credential somewhere the operator
    // did not ask for, which is the opposite of what the check is for.
    if (url === null)
        return null;
    // CR-016's bootstrap re-sent the whole file from byte 0 every time. CR-018
    // replaces it, because `later` (hold the offset) and `never` (advance past the
    // failing bytes) are both defined in terms of an offset and mean nothing
    // without one. `CR-017d` widened the key that offset is kept under to
    // `(repo, session)`; `CR-124` (W6) owns globbing
    // `<session-dir>/subagents/agent-*.jsonl` — this sends the `main` file only.
    //
    // ⚠ The attribution above said `CR-020` until `CR-020d`. It was wrong, and D76
    // says so by name: `CR-020`'s finding (D57 §DX7) is SessionEnd timing only and
    // says nothing about sub-agent files. Corrected in passing rather than left to
    // send the next reader after work that lives in another task.
    //
    // `SessionEnd` SETTLES FIRST (D57 §DX7). Every other event has a next
    // invocation to pick up a lagging write; this one does not, so bytes missed
    // here are the final turn, lost permanently.
    const settleFor = input.eventName === SESSION_END_EVENT ? settleDelayMs(ctx.env, budgetMs) : 0;
    const settleStart = Date.now();
    const eof = settleFor > 0
        ? await settledSize(() => fileSize(input.transcriptPath), wait, settleFor)
        : fileSize(input.transcriptPath);
    if (eof === null)
        return null;
    // MEASURED, not assumed to be `settleFor`: the wait can overshoot under load,
    // and the budget cares about the time actually spent.
    const consumedMs = settleFor > 0 ? Date.now() - settleStart : 0;
    const delivery = await deliver({
        home: ctx.home,
        env: ctx.env,
        url,
        credential: load.credential,
        // The consent gate's key, reused rather than re-resolved: a second
        // `git rev-parse` could disagree with the one consent was checked against.
        repoKey: projectKey,
        // The WIRE identity, resolved once per invocation and off the same
        // toplevel — `owner/repo` when `origin` is GitHub, else `local:<hash>`.
        // Required by the merged server (`CR-019b`), which 400s a delta without
        // it rather than writing a row nobody can read (D57 §OV1).
        repoSlug: resolveRepoSlug(projectKey),
        sessionId: input.sessionId,
        fileKey: "main",
        timeoutMs: sendTimeoutMs(budgetMs, consumedMs),
        nowMs: Date.now(),
    }, eof, (from, to) => readSpan(input.transcriptPath, from, to));
    // The three classes are decided in `policy.ts` and applied in `post.ts`. Two
    // of the four outcomes reach a human.
    //
    // `fatal`: a hook that stays silent about a revoked credential captures
    // nothing forever. `later` and `never` say nothing — a hook has one line per
    // session and spending it on a condition that resolves itself next turn is the
    // tool noise D57 §DX3 exists to avoid.
    //
    // `ok`: the fourth state (`CR-023d`), and the FIRST time this hook has ever
    // spoken on success. Its `(repo, day)` claim is what keeps it to once — no
    // "have I already said this today" check belongs here, because the atomic `wx`
    // claim already is that check, and a second one could disagree with it.
    if (delivery.kind === "attempted") {
        if (delivery.disposition === "fatal")
            return notice("credential_revoked");
        if (delivery.disposition === "ok")
            return notice("capture_confirmed", projectKey);
    }
    return null;
}
/** Size in bytes, or null if it cannot be read. */
function fileSize(path) {
    try {
        return statSync(path).size;
    }
    catch {
        return null;
    }
}
/**
 * Read `[from, to)` of the transcript and compress it.
 *
 * The path is already confined to the Claude Code transcript root by the caller
 * (`/cso` finding 1) — this function must never be handed one that is not.
 * Returns null on any failure, because a hook cannot report a read error.
 */
function readSpan(path, from, to) {
    let fd;
    try {
        fd = openSync(path, "r");
        const buf = Buffer.alloc(to - from);
        const read = readSync(fd, buf, 0, buf.length, from);
        return zstdCompressSync(read === buf.length ? buf : buf.subarray(0, read));
    }
    catch {
        return null;
    }
    finally {
        if (fd !== undefined) {
            try {
                closeSync(fd);
            }
            catch {
                // Nothing useful to do, and nothing may be said.
            }
        }
    }
}
//# sourceMappingURL=entry.js.map