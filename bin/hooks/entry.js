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
import { closeSync, openSync, readdirSync, readSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import { isProjectAllowed } from "../consent.js";
import { loadCredential } from "../credential.js";
import { EXIT } from "../exit.js";
import { resolveRepoSlug } from "../git.js";
import { redactSpan } from "../redact.js";
import { deliver, ingestUrl } from "../post.js";
import { markSkipped } from "../policy.js";
import { fileState, loadSessionState, saveSessionState, withFileState } from "../state.js";
import { SESSION_END_EVENT, settleDelayMs, settledSize, } from "./session_end.js";
import { isInside, subagentFileKey, subagentsDir, transcriptRoot } from "../paths.js";
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
 * Below this much REMAINING budget, stop starting sub-agent files — `CR-124`,
 * D95.
 *
 * This, not a file count, is the real bound. `sendTimeoutMs` gives each attempt
 * 0.6 of what is LEFT, so the remainder decays geometrically (5000 → 2000 → 800
 * → …) and the sum can never reach the budget however many files there are. What
 * a floor adds is refusing to START an attempt so small it can only time out:
 * a 200 ms send against a slow server burns the wall clock and delivers nothing,
 * and the file's offset would have been held anyway.
 *
 * The leftovers are not lost. Their offsets simply do not advance, and the next
 * hook picks them up — except on `SessionEnd`, where there is no next hook and
 * they stamp a gap instead (D95).
 */
const MIN_SUBAGENT_BUDGET_MS = 400;
/**
 * A hard backstop on files attempted per invocation.
 *
 * The floor above is the bound that binds when the server is slow; this one
 * bounds the pathological shape the floor cannot see — a directory with
 * hundreds of entries answering instantly, where the loop would spend its time
 * in `stat` rather than in sends. The busiest session measured on this machine
 * has 27 sub-agent files, so eight per invocation clears it in four Stop hooks,
 * and a session that spawned 27 delegated agents will fire far more than four.
 */
const MAX_SUBAGENT_FILES = 8;
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
    }, eof, 
    // `projectKey` is the consented git toplevel — the boundary redaction is
    // measured against, and the same value the consent gate approved.
    (from, to) => readSpan(input.transcriptPath, from, to, projectKey));
    // --- DELEGATED WORK. `CR-124`, D76. ---
    // Claude Code writes sub-agent transcripts to `<session>/subagents/`, which
    // `transcript_path` never names: ~16% of transcript volume, and the work a
    // reviewer most wants attributed. MAIN WENT FIRST, deliberately (D95) — the
    // content most likely to matter is the content most likely to fit.
    await deliverSubagents({
        ctx,
        input,
        url,
        credential: load.credential,
        projectKey,
        startedAt: settleStart,
        budgetMs,
    });
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
/**
 * Send whatever delegated transcripts fit in what is left of the budget.
 *
 * ## Why this is bounded and not a loop over the directory
 *
 * `entry.ts` gets ONE wall clock (DESIGN.md §13.7) and the watchdog cuts the
 * process off at `budgetMs` regardless. A real session on this machine has 27
 * sub-agent files; twenty-seven sends cannot each have a share of five seconds.
 * D95 settles the shape: one MEASURED deadline, the running elapsed handed to
 * `sendTimeoutMs` so file N gets the real remainder, and a floor below which no
 * new file is started.
 *
 * Nothing is lost by stopping early. An unattempted file's offset does not
 * advance, so the next hook picks it up — the same property `CR-018`'s failure
 * classes already rely on.
 *
 * **Except on `SessionEnd`, where there is no next hook.** There, an undelivered
 * file STAMPS A GAP (D95): the offset advances and the hole is recorded, because
 * a record that says what it could not send is honest and one that is quietly
 * short is not. That is D56 §D8's own shape, applied to the one event where
 * advance-regardless would otherwise lose the bytes silently.
 *
 * Serial, never `Promise.all`: each `deliver()` does load-modify-save on one
 * JSON file and claims `session.seq + 1`, so concurrent calls would lose seq
 * updates to each other and the server would read a replay.
 */
async function deliverSubagents(opts) {
    const { ctx, input, url, credential, projectKey, startedAt, budgetMs } = opts;
    const files = findSubagentFiles(ctx, input.transcriptPath);
    if (files.length === 0)
        return;
    // ⚠ SKIP WHAT HAS NOTHING PENDING, BEFORE THE CAP APPLIES — and this is not an
    // optimisation, it is what stops the tail starving.
    //
    // The order is by mtime, which is STABLE: delivering a file does not touch it.
    // So a cap counting ATTEMPTS re-attempts the same eight oldest files on every
    // invocation, each returning `nothing-to-send`, and files nine and up are
    // never reached at all. Caught by the test that runs two invocations and
    // expects the second to make progress; it did not.
    //
    // Filtering on pending bytes makes the cap count WORK rather than calls, so
    // each invocation starts where the last one stopped.
    const key = { repoKey: projectKey, sessionId: input.sessionId };
    const before = loadSessionState(ctx.home, key);
    const pending = files.filter((f) => fileState(before, f.fileKey).sentOffset < f.size);
    if (pending.length === 0)
        return;
    for (const file of pending.slice(0, MAX_SUBAGENT_FILES)) {
        const consumedMs = Date.now() - startedAt;
        if (budgetMs - consumedMs < MIN_SUBAGENT_BUDGET_MS)
            break;
        await deliver({
            home: ctx.home,
            env: ctx.env,
            url,
            credential,
            repoKey: projectKey,
            repoSlug: resolveRepoSlug(projectKey),
            sessionId: input.sessionId,
            fileKey: file.fileKey,
            // The remainder, MEASURED. This is what keeps N files inside one budget.
            timeoutMs: sendTimeoutMs(budgetMs, consumedMs),
            nowMs: Date.now(),
        }, file.size, 
        // The SAME reader as the main transcript, so `CR-024d`'s redaction and
        // `/cso` finding 1's confinement both apply. A delegated agent reading a
        // third party's file is exactly as out-of-tree as the main thread doing it.
        (from, to) => readSpan(file.path, from, to, projectKey));
    }
    if (input.eventName === SESSION_END_EVENT)
        stampGaps(ctx, input, projectKey, files);
}
/**
 * On `SessionEnd`, record what could not be sent rather than losing it quietly.
 *
 * Covers both the files never started and the ones whose send was held: after
 * this event there is no invocation to retry either, so both are permanently
 * undelivered and both deserve the same honest hole.
 *
 * ⚠ Scoped to sub-agent files, per D95. The MAIN transcript's own failed send on
 * `SessionEnd` is equally permanent and does NOT stamp a gap today — that is
 * `CR-020d`'s territory and outside this task; reported rather than changed.
 */
function stampGaps(ctx, input, projectKey, files) {
    const key = { repoKey: projectKey, sessionId: input.sessionId };
    // Re-read per file rather than once: each `deliver()` above saved, so a
    // snapshot taken before the loop would stamp gaps over work that succeeded.
    for (const file of files) {
        const session = loadSessionState(ctx.home, key);
        const current = fileState(session, file.fileKey);
        // The offset is the only thing that decides this, which is why no record of
        // what was attempted is needed: a file the loop never reached and one whose
        // send was held are both simply behind, and both are equally permanent now.
        if (current.sentOffset >= file.size)
            continue;
        saveSessionState(ctx.home, key, withFileState(session, file.fileKey, markSkipped(current, current.sentOffset, file.size)));
    }
}
/**
 * Every `agent-*.jsonl` under this session's `subagents/`, oldest first.
 *
 * **`agent-*.jsonl`, never `agent-*`.** The directory carries an
 * `agent-<id>.meta.json` beside every transcript — 636 of each on this machine,
 * exactly 1:1 — so the looser glob would double every upload and send metadata
 * as transcript content.
 *
 * **Every path is confined.** `isInside(transcriptRoot(...))` gates each entry
 * before it is opened, exactly as the main transcript is gated: this adds a new
 * SET of readers to the surface `/cso` finding 1 rated HIGH, and a symlinked
 * entry in `subagents/` must not walk out of the transcript root.
 *
 * Oldest first, because it cannot starve. Ordering by pending bytes would let a
 * small file lose every round forever; by mtime, every file reaches the front.
 *
 * A missing or unreadable directory is simply "no sub-agents" — silent, per the
 * hook contract.
 */
function findSubagentFiles(ctx, transcriptPath) {
    const dir = subagentsDir(transcriptPath);
    if (dir === null)
        return [];
    const root = transcriptRoot(ctx.home, ctx.env);
    let entries;
    try {
        entries = readdirSync(dir);
    }
    catch {
        return [];
    }
    const found = [];
    for (const entry of entries) {
        const fileKey = subagentFileKey(entry);
        if (fileKey === null)
            continue;
        const path = join(dir, entry);
        if (!isInside(root, path))
            continue;
        try {
            const stat = statSync(path);
            if (!stat.isFile() || stat.size === 0)
                continue;
            found.push({ path, fileKey: fileKey, size: stat.size, mtimeMs: stat.mtimeMs });
        }
        catch {
            // Vanished between readdir and stat. Not ours to report.
        }
    }
    return found.sort((a, b) => a.mtimeMs - b.mtimeMs);
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
 * Read `[from, to)` of the transcript, REDACT it, and compress it.
 *
 * The path is already confined to the Claude Code transcript root by the caller
 * (`/cso` finding 1) — this function must never be handed one that is not.
 * Returns null on any failure, because a hook cannot report a read error.
 *
 * ## The one chokepoint
 *
 * This is the single place transcript bytes become a request body, which is why
 * `CR-024d`'s redaction goes HERE and nowhere else — the same discipline
 * `post.ts` applies to `expose()`: one call site, greppable, reviewable. Any
 * future path that reads transcript bytes for upload must come through here or
 * it silently bypasses the confidentiality boundary.
 *
 * `redactSpan` is length-preserving BY CONTRACT (see `redact.ts`), which the
 * server's offset accounting depends on — so the compressed body still covers
 * exactly `[from, to)`.
 *
 * EXPORTED for `connect`'s test capture (`CR-025`), which reads a transcript on
 * a path the hook never takes. It reuses this rather than opening one itself,
 * because a second reader would bypass both the confinement and the redaction —
 * exactly what the chokepoint note above warns about.
 */
export function readSpan(path, from, to, projectRoot) {
    let fd;
    try {
        fd = openSync(path, "r");
        const buf = Buffer.alloc(to - from);
        const read = readSync(fd, buf, 0, buf.length, from);
        const raw = read === buf.length ? buf : buf.subarray(0, read);
        return zstdCompressSync(redactSpan(raw, projectRoot).bytes);
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