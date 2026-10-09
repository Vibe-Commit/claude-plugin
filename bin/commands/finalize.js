/**
 * `vibecommit finalize` — the CALLER asserts a session is over (`TODOS[146]`, VD decision 5).
 *
 * ## ⛔ THE DEFECT, AND WHY THE ANSWER IS A VERB
 *
 * The server holds the last turn of a delta as a tentative tail, because a chunk boundary is not a turn
 * boundary, and seals a turn only when a following prompt opens the next one. A session that is never
 * followed by another prompt — a one-shot `claude -p`, the last turn of any session that is not resumed —
 * therefore seals NOTHING: no capture, no turn, no commit edge, however many commits it made. Nothing
 * inside the process can say honestly that the session is over (`SessionEnd`'s `reason` is `"other"`
 * whether or not a resume follows). The caller can. A script that just ran `claude -p` knows it is done.
 *
 * This verb sends that assertion as `X-Session-Final: 1` on the session's MAIN stream and keeps what the
 * server answers: `sealed` (the last turn is now recorded), `already` (nothing was left open — a repeat is
 * a no-op), or silence (an older server, which ignores the header). ⛔ Silence is NOT success, and has its
 * own exit code: a script must be able to separate a close that was confirmed from a delivery that merely hoped.
 *
 * ## What it reuses, and why it is not a second pipeline
 *
 * The same consent gate, credential, spool, pending-promotion and rewrite-spool as a `Stop` hook, so a
 * commit the hook was holding rides THIS request and binds on the turn it seals. Sub-agent streams go
 * FIRST: the server folds them into the parent turn when it seals it, so sealing before they arrive would
 * seal a poorer turn.
 *
 * ## What it refuses to do
 *
 * - Guess. `--latest` closes the ONE session that delivered in the last 24 hours and lists them when there
 *   are several — the attribution ladder's rule: ambiguity is named, never picked.
 * - Touch a session this repo never captured, or one still being written (`--force` overrides the second:
 *   closing a live session seals a turn that is not complete, and a later resume opens a new turn rather
 *   than extending it).
 * - Read anywhere but the agent's own transcript root (`admitsTranscript`, the same confinement as a hook).
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_AGENT_ID, admitsTranscript, transcriptRoots } from "../agents/registry.js";
import { ERRORS, FINALIZE, HELP } from "../copy/index.js";
import { isProjectAllowed } from "../consent.js";
import { loadCredential } from "../credential.js";
import { EXIT } from "../exit.js";
import { headRef, resolveRepoSlug } from "../git.js";
import { confinementRoots, deliverSubagents, fileSize, readSpan, sendTimeoutMs, wait } from "../hooks/entry.js";
import { repoSessionsDir, sessionStatePath } from "../paths.js";
import { deliver, ingestUrl } from "../post.js";
import { resolveProjectKeys } from "../project.js";
import { capInferred, capSpool, capSuccessors, deleteInferredSpool, inferredFullyResolved, readInferred, readRewrites, readSpool } from "../spool.js";
import { fileState, loadSessionState, saveSessionState } from "../state.js";
import { renderErrorBlock, wrap } from "../term.js";
import { writeLines } from "./context.js";
/** A transcript modified this recently is a session still being written. */
const STILL_WRITING_MS = 5_000;
/** `--latest` considers sessions that delivered inside this window. */
const LATEST_WINDOW_MS = 24 * 60 * 60 * 1000;
/** One wall-clock budget for the whole verb: not a hook, so not the hook's few seconds. */
const SEND_BUDGET_MS = 60_000;
/** Bounded drain of the rewrite/inferred spools after the seal succeeds (TODOS[177] follow-up); never unbounded. */
const FINALIZE_DRAIN_MAX_ITERATIONS = 8;
/**
 * `TODOS[177]` follow-up (VL, 2026-10-08, VG's silent-loss finding B1) — the backoff BETWEEN successive short acks
 * for the SAME inferred group, inside the drain loop only. `INFERRED_SET_ASIDE_AFTER` (K=3) attempts spread across
 * separate HOOK CYCLES (minutes apart) is a real signal of a persistently-refusing server; the same K attempts
 * inside one `finalize` call's drain loop — which otherwise iterates with no delay at all — could burn through all
 * of them in under a second, turning a one-second TRANSIENT server hiccup into a permanent-looking set-aside. Index
 * 0 is the wait before the 2nd attempt on a group, index 1 before the 3rd; total added delay 1s + 3s = 4s, inside
 * VL's ≤6s bound.
 */
const FINALIZE_DRAIN_BACKOFF_MS = [1_000, 3_000];
/** The id becomes a filename component; keep it to what a session id is. */
const SESSION_ID = /^[A-Za-z0-9._-]{1,128}$/;
function parseArgs(argv) {
    let session = null;
    let latest = false;
    let force = false;
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === "--latest")
            latest = true;
        else if (a === "--force")
            force = true;
        else if (a === "--session") {
            const v = argv[i + 1];
            if (v === undefined)
                return null;
            session = v;
            i += 1;
        }
        else if (a.startsWith("--session="))
            session = a.slice("--session=".length);
        else
            return null;
    }
    if ((session === null) === !latest)
        return null; // exactly one of the two
    return { session, latest, force };
}
export async function finalize(ctx, argv) {
    // `TODOS[184]`. Check-first, before `parseArgs`/anything else — the ONE change this ticket makes to
    // `finalize`. Reads and writes nothing; every other line below (`parseArgs`, session resolution, the
    // seal call, the drain loop, every exit code and receipt string) is byte-identical to 0.4.4 for any
    // `argv` that does not literally contain `--help`/`-h` (pinned by T10's differential).
    if (argv.includes("--help") || argv.includes("-h")) {
        writeLines(ctx.stdout, [HELP.commands.finalize]);
        return EXIT.ok;
    }
    const args = parseArgs(argv);
    if (args === null) {
        writeLines(ctx.stderr, renderErrorBlock({ kind: "bad", what: FINALIZE.needTarget, why: [] }, ctx.colour));
        return EXIT.usage;
    }
    const keys = resolveProjectKeys(ctx.cwd);
    if (keys === null) {
        writeLines(ctx.stderr, renderErrorBlock({ kind: "bad", what: ERRORS.notAGitRepo, why: [] }, ctx.colour));
        return EXIT.failure;
    }
    const projectKey = keys.worktree;
    if (!isProjectAllowed(ctx.home, keys.consent)) {
        writeLines(ctx.stderr, renderErrorBlock({ kind: "bad", what: ERRORS.notConnected, why: [] }, ctx.colour));
        return EXIT.notConnected;
    }
    const load = loadCredential({ env: ctx.env, home: ctx.home });
    if (load.kind !== "ok") {
        writeLines(ctx.stderr, renderErrorBlock({ kind: "bad", what: ERRORS.notConnected, why: [] }, ctx.colour));
        return EXIT.notConnected;
    }
    const url = ingestUrl(ctx.env);
    if (url === null) {
        writeLines(ctx.stderr, renderErrorBlock({ kind: "bad", what: FINALIZE.notDelivered, why: [] }, ctx.colour));
        return EXIT.failure;
    }
    // ── Which session. ──
    const nowMs = ctx.now().getTime();
    let sessionId;
    if (args.session !== null) {
        if (!SESSION_ID.test(args.session)) {
            writeLines(ctx.stderr, renderErrorBlock({ kind: "bad", what: FINALIZE.badSessionId, why: [] }, ctx.colour));
            return EXIT.usage;
        }
        sessionId = args.session;
    }
    else {
        const recent = recentSessions(ctx.home, projectKey, nowMs);
        if (recent.length === 0) {
            writeLines(ctx.stderr, renderErrorBlock({ kind: "bad", what: FINALIZE.noRecentSession, why: [] }, ctx.colour));
            return EXIT.usage;
        }
        if (recent.length > 1) {
            writeLines(ctx.stderr, renderErrorBlock({ kind: "bad", what: FINALIZE.severalRecent, why: recent.map((r) => FINALIZE.recentRow(r.id, Math.round((nowMs - r.at) / 60000))) }, ctx.colour));
            return EXIT.usage;
        }
        sessionId = recent[0].id;
    }
    // ── The session must be one THIS repo captured (it has a state file here) and its transcript must be findable inside the agent's own root. ──
    const state = sessionStatePath(ctx.home, { repoKey: projectKey, sessionId });
    if (state === null || !existsSync(state)) {
        writeLines(ctx.stderr, renderErrorBlock({ kind: "bad", what: FINALIZE.unknownSession(sessionId), why: [] }, ctx.colour));
        return EXIT.usage;
    }
    const transcriptPath = findTranscript(ctx.home, ctx.env, sessionId);
    if (transcriptPath === null) {
        writeLines(ctx.stderr, renderErrorBlock({ kind: "bad", what: FINALIZE.transcriptMissing(sessionId), why: [] }, ctx.colour));
        return EXIT.failure;
    }
    try {
        if (!args.force && nowMs - statSync(transcriptPath).mtimeMs < STILL_WRITING_MS) {
            writeLines(ctx.stderr, renderErrorBlock({ kind: "bad", what: FINALIZE.stillWriting, why: [] }, ctx.colour));
            return EXIT.usage;
        }
    }
    catch {
        return EXIT.failure;
    }
    const eof = fileSize(transcriptPath);
    if (eof === null)
        return EXIT.failure;
    // ── Deliver: promote what was pending, then sub-agents FIRST, then the main stream with the assertion. ──
    // ⛔ NO PENDING-LINE PROMOTION HERE, deliberately. Every hook fire of this session already ran it (`hooks/entry.ts`), and
    // the session necessarily has a state file (required above), so a first-turn commit was promoted by the first
    // `Stop` that wrote one. Promoting from this verb would add a second call site to a function whose only call site
    // is a pinned property (`post-commit-spool.test.ts`, D208): a dead session must never reach it.
    const spoolKey = { repoKey: projectKey, sessionId };
    const spooled = capSpool(readSpool(ctx.home, spoolKey));
    const rewritten = capSuccessors(readRewrites(ctx.home, spoolKey));
    const inferred = capInferred(readInferred(ctx.home, spoolKey)); // `TODOS[177]`
    const redactionRoots = confinementRoots(keys);
    const repoSlug = resolveRepoSlug(projectKey);
    const hookEnv = {
        env: ctx.env,
        home: ctx.home,
        nodeVersion: ctx.nodeVersion,
        agentId: ctx.agentId ?? DEFAULT_AGENT_ID,
        readStdin: async () => "",
    };
    const input = { sessionId, transcriptPath, cwd: ctx.cwd, eventName: "Stop" };
    const startedAt = Date.now();
    await deliverSubagents({
        ctx: hookEnv,
        input,
        url,
        credential: load.credential,
        projectKey,
        redactionRoots,
        repoSlug,
        startedAt,
        sendBudget: SEND_BUDGET_MS,
        byHook: false,
    });
    const delivery = await deliver({
        home: ctx.home,
        env: ctx.env,
        url,
        credential: load.credential,
        repoKey: projectKey,
        repoSlug,
        sessionId,
        fileKey: "main",
        transcriptPath,
        timeoutMs: sendTimeoutMs(SEND_BUDGET_MS, Date.now() - startedAt),
        nowMs: Date.now(),
        head: headRef(projectKey),
        commits: spooled,
        rewrites: rewritten.pairs,
        inferredRewrites: inferred.pairs,
        inferredGroups: inferred.groups,
        final: true,
        byHook: false,
    }, eof, (from, to) => readSpan(transcriptPath, from, to, redactionRoots, ctx.home, ctx.env));
    // ── What the server said. ──
    if (delivery.kind === "stopped") {
        writeLines(ctx.stderr, renderErrorBlock({ kind: "bad", what: FINALIZE.credentialStopped, why: [] }, ctx.colour));
        return EXIT.failure;
    }
    if (delivery.kind !== "attempted" || delivery.disposition !== "ok") {
        writeLines(ctx.stderr, renderErrorBlock({ kind: "bad", what: FINALIZE.notDelivered, why: [] }, ctx.colour));
        return EXIT.failure;
    }
    if (delivery.finalAck === "sealed" || delivery.finalAck === "already") {
        clearDeliveredHold(ctx.home, spoolKey);
        // ⭐ `TODOS[177]` follow-up (VL, 2026-10-08) — DRAIN what the first delivery's caps left spooled. A session
        // over 16 exact pairs or 64 inferred pairs (one squash of 64 is already the server's own cap; several
        // squashes in one session is what overflows this) would otherwise leave the rest spooled FOREVER: nobody
        // fires another hook for a session finalize just declared over. Bounded, empty-body deltas (the main
        // stream is already at EOF; `final: true` again is idempotent — `already`) carrying only what remains.
        // Stops the moment an ack goes missing: a server that cannot confirm one drain request will not confirm
        // the next either, and hammering it buys nothing.
        let setAsidePairs = delivery.inferredSetAsidePairs;
        // `TODOS[177]` follow-up (VL, 2026-10-08, VG's silent-loss finding B1) — the backoff state, local to THIS
        // drain loop only (never across hook cycles, which already space attempts by minutes on their own). Tracks
        // the identity of the group that was short-acked on the PREVIOUS iteration and how many times in a row.
        let backoffGroupId = null;
        let backoffStreak = 0;
        // ⛔⛔ `TODOS[182]` — SKIP THE DRAIN LOOP ENTIRELY WHILE `lean`. Read fresh: the main `deliver()` call above
        // may have just SET it (a 431 mid-seal, retried in-process per `post.ts`'s own `deliver()` docblock). The
        // drain loop exists only to flush `x-rewrites`/`x-rewrites-inferred` — exactly two of the five headers a
        // lean request drops — so while lean it has structurally nothing to send; running it anyway would make up
        // to `FINALIZE_DRAIN_MAX_ITERATIONS` pointless empty-list requests, with the backoff delays above making
        // each one slower rather than faster to give up on (the ack is an explicit `0`, never `null`, so the
        // existing "absent ack, stop asking" guard below never fires either).
        const lean = fileState(loadSessionState(ctx.home, spoolKey), "main").lean;
        for (let i = 0; !lean && i < FINALIZE_DRAIN_MAX_ITERATIONS; i += 1) {
            const moreRewritten = capSuccessors(readRewrites(ctx.home, spoolKey));
            const moreInferred = capInferred(readInferred(ctx.home, spoolKey));
            if (moreRewritten.pairs.length === 0 && moreInferred.pairs.length === 0)
                break;
            const groupId = moreInferred.groups.length > 0 ? `${moreInferred.groups[0].successor}:${moreInferred.groups[0].patchId}` : null;
            if (groupId !== null && groupId === backoffGroupId && backoffStreak >= 1 && backoffStreak <= FINALIZE_DRAIN_BACKOFF_MS.length) {
                await wait(FINALIZE_DRAIN_BACKOFF_MS[backoffStreak - 1]);
            }
            const drain = await deliver({
                home: ctx.home,
                env: ctx.env,
                url,
                credential: load.credential,
                repoKey: projectKey,
                repoSlug,
                sessionId,
                fileKey: "main",
                transcriptPath,
                timeoutMs: sendTimeoutMs(SEND_BUDGET_MS, Date.now() - startedAt),
                nowMs: Date.now(),
                head: headRef(projectKey),
                rewrites: moreRewritten.pairs,
                inferredRewrites: moreInferred.pairs,
                inferredGroups: moreInferred.groups,
                final: true,
                byHook: false,
            }, eof, (from, to) => readSpan(transcriptPath, from, to, redactionRoots, ctx.home, ctx.env));
            if (drain.kind !== "attempted" || drain.disposition !== "ok")
                break;
            setAsidePairs += drain.inferredSetAsidePairs;
            if (drain.finalAck !== "sealed" && drain.finalAck !== "already")
                break;
            // ⛔⛔ VL, 2026-10-08, VG's head-of-line finding: an ABSENT inferred ack (an old server — 86b9460 measured: 9
            // requests, every one absent, the second group never sent) for a request that DID carry an inferred group
            // means this server will never confirm ANY group, so stop asking rather than spend the whole bound on it.
            // A SHORT ack is different (`deliver()` already counted the attempt / set it aside above) — fall through and
            // let the next iteration pick up whatever group is next.
            if (moreInferred.pairs.length > 0 && drain.inferredStored === null)
                break;
            // Update the backoff state for the NEXT iteration: a short ack (present, non-null, not the full count) on
            // the SAME group as last time extends the streak; anything else (delivered, a different group, or this
            // group just got set aside) resets it.
            const sent = moreInferred.pairs.length;
            if (groupId !== null && sent > 0 && drain.inferredStored !== null && drain.inferredStored !== sent) {
                backoffStreak = groupId === backoffGroupId ? backoffStreak + 1 : 1;
                backoffGroupId = groupId;
            }
            else {
                backoffGroupId = null;
                backoffStreak = 0;
            }
        }
        // The session is over (that is what `finalize` just confirmed), so no concurrent `appendInferred` can still be
        // running for it — the hook that would call one is the one deciding the session is over. Safe to delete outright
        // rather than leave a fully-resolved file for the 7-day prune to find.
        //
        // ⛔⛔ Fine to delete AFTER `setAsidePairs` is computed above, NEVER before (VL, 2026-10-08, VG's silent-loss
        // finding B1): `setAsidePairs` is read from `deliver()`'s own return values — which were captured before this
        // point — not re-derived from the spool afterward, which is the file this line is about to delete.
        if (inferredFullyResolved(ctx.home, spoolKey))
            deleteInferredSpool(ctx.home, spoolKey);
        writeLines(ctx.stdout, wrap(delivery.finalAck === "sealed" ? FINALIZE.closed(sessionId) : FINALIZE.alreadyClosed(sessionId), 2));
        if (setAsidePairs > 0)
            writeLines(ctx.stderr, wrap(FINALIZE.inferredSetAside(setAsidePairs), 2));
        return EXIT.ok;
    }
    if (delivery.finalAck === "refused") {
        writeLines(ctx.stderr, renderErrorBlock({ kind: "bad", what: FINALIZE.refused, why: [] }, ctx.colour));
        return EXIT.failure;
    }
    // 2xx and no acknowledgement: an older server. Delivered, NOT closed — and the exit code says so.
    writeLines(ctx.stderr, renderErrorBlock({ kind: "warn", what: FINALIZE.notAcknowledged, why: [] }, ctx.colour));
    return EXIT.unacknowledged;
}
/** Sessions of this repo whose state file was touched in the last 24 h, newest first. */
function recentSessions(home, repoKey, nowMs) {
    const dir = repoSessionsDir(home, repoKey);
    if (dir === null)
        return [];
    let entries;
    try {
        entries = readdirSync(dir);
    }
    catch {
        return [];
    }
    const out = [];
    for (const entry of entries) {
        if (!entry.endsWith(".json"))
            continue;
        try {
            const at = statSync(join(dir, entry)).mtimeMs;
            if (nowMs - at <= LATEST_WINDOW_MS)
                out.push({ id: entry.slice(0, -".json".length), at });
        }
        catch {
            /* a vanished file is not recent */
        }
    }
    return out.sort((a, b) => b.at - a.at);
}
/** `<root>/<project dir>/<session>.jsonl` under any of the agents' transcript roots, confined as a hook's is. */
function findTranscript(home, env, sessionId) {
    for (const root of transcriptRoots(home, env)) {
        let dirs;
        try {
            dirs = readdirSync(root);
        }
        catch {
            continue;
        }
        for (const d of dirs) {
            const candidate = join(root, d, `${sessionId}.jsonl`);
            if (existsSync(candidate) && admitsTranscript(home, env, candidate))
                return candidate;
        }
    }
    return null;
}
/** After a successful close, forget end-of-session holds whose bytes have now been delivered. */
function clearDeliveredHold(home, key) {
    const session = loadSessionState(home, key);
    if (session.endHold === null)
        return;
    const eof = {};
    for (const [fileKey, size] of Object.entries(session.endHold.eof)) {
        if (fileState(session, fileKey).sentOffset < size)
            eof[fileKey] = size;
    }
    saveSessionState(home, key, { ...session, endHold: Object.keys(eof).length > 0 ? { at: session.endHold.at, eof } : null });
}
//# sourceMappingURL=finalize.js.map