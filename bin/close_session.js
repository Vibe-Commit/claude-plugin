/**
 * `closeSession` — close ONE session: sub-agent streams first, then the main stream, then (when `seal`) the assertion and the bounded drain.
 *
 * Moved out of `commands/finalize.ts` UNCHANGED (last-turn seal plan, T1 / D7 / OV7). `finalize` and `backfill` call it; the upload worker's seal
 * phase (`replay.ts`) and the drain's seal (`drain.ts`) now call it too. `finalize.ts` imports `replayAllUnderLock` from `replay.ts`, so `replay.ts`
 * importing `finalize.ts` would be a cycle, and the worker's rule (`upload_worker.ts`: "Static imports are the worker's own") keeps it from loading a
 * command module. The spec helpers (`CloseSpec`, `closeSpecOf`, `SpecFacts`) moved with it for the same reason.
 */
import { existsSync } from "node:fs";
import { headRef } from "./git.js";
import { deliverSubagents, readSpan, recordCutter, sendTimeoutMs, wait } from "./hooks/entry.js";
import { isolationOf, pastCursorOf } from "./session_targets.js";
import { sessionStatePath } from "./paths.js";
import { deliver } from "./post.js";
import { deleteInferredSpool, inferredFullyResolved } from "./spool.js";
import { fileState, loadSessionState, pruneDeliveredEndHold } from "./state.js";
import { readSpoolUnion } from "./spool_union.js";
/** One wall-clock budget for the whole verb: not a hook, so not the hook's few seconds. */
export const SEND_BUDGET_MS = 60_000;
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
/** What `closeSession` is told for one resolved target: the repo (or folder) and everything `closeSession` needs about it. */
export function closeSpecOf(target, scan, facts) {
    return specOf(target, scan, facts);
}
function specOf(target, scan, facts) {
    // C43: a copy delivered from the start of a stream whose call checkpoint has been pruned (a repo granted after the others were sent) cannot judge a
    // result by the log, so a repo copy of an isolating dialect observes its own delivered bytes in order (the same observer the hook uses past the cursor).
    const base = isolationOf(target, facts?.record);
    const isolation = facts?.capRepos === true && facts.record !== undefined ? { ...base, past: pastCursorOf(base, scan) } : base;
    return {
        projectKey: target.ledgerKey,
        redactionRoots: target.redactionRoots,
        repoSlug: target.slug,
        worktrees: target.worktrees.length > 0 ? target.worktrees : [target.ledgerKey],
        allowNeverCaptured: true,
        ...(target.kind === "folder" || facts?.capRepos === true ? { sizeCap: scan } : {}),
        isolation,
        target,
    };
}
/** Rounds of `deliverSubagents` a complete close will make: eight files each, so 512 streams. A bound, not a goal. */
const SUBAGENT_ROUNDS_MAX = 64;
/** A delivery the failure policy KEPT the bytes of — the only kind that blocks the main stream (a `never` advanced past its span). */
function blocksMain(delivery) {
    if (delivery.kind === "stopped")
        return true;
    return delivery.kind === "attempted" && (delivery.disposition === "later" || delivery.disposition === "fatal");
}
/**
 * Close ONE session: sub-agent streams first, then the main stream, then (when `seal`) the assertion and the bounded drain.
 *
 * Extracted from `finalize` (design review D5 · A) so that `vibecommit backfill` closes an old session exactly the way the
 * verb that asserts a session is over does. A second copy of this order would be a second place for "sub-agents first" to be
 * forgotten, and the seal it ends in cannot be reopened.
 *
 * It PRINTS nothing and reads no flag: `finalize` and `backfill` each turn the outcome into their own words and exit codes.
 */
export async function closeSession(input) {
    const { home, env, url, credential, projectKey, redactionRoots, repoSlug, sessionId, transcriptPath, eof } = input;
    const spoolKey = { repoKey: projectKey, sessionId };
    if (!input.allowNeverCaptured) {
        const state = sessionStatePath(home, spoolKey);
        if (state === null || !existsSync(state))
            return { kind: "never-captured" };
    }
    // ⛔ THE SPOOL UNION (any-folder capture, O7): the commit, rewrite and inferred spools of every work tree of this repo for the
    // session, acknowledged per source. With one work tree this is exactly the three reads it always was.
    const worktrees = input.worktrees ?? [projectKey];
    const isolation = input.isolation ?? { kind: "repo", ownRoots: redactionRoots };
    const union = readSpoolUnion(home, sessionId, projectKey, worktrees, input.asOfAt);
    const spooled = union.commits;
    const rewritten = union.rewrites;
    const inferred = union.inferred; // `TODOS[177]`
    const hookEnv = {
        env,
        home,
        nodeVersion: input.nodeVersion,
        agentId: input.agentId,
        readStdin: async () => "",
    };
    const hookInput = { sessionId, transcriptPath, cwd: input.cwd, eventName: "Stop" };
    const budget = input.sendBudgetMs ?? SEND_BUDGET_MS;
    const beat = input.heartbeat;
    const holding = () => beat === undefined || beat();
    let startedAt = Date.now();
    if (!holding())
        return { kind: "lock-lost" };
    if (!input.completeSubagents) {
        await deliverSubagents({
            ctx: hookEnv,
            input: hookInput,
            url,
            credential,
            projectKey,
            redactionRoots,
            repoSlug,
            startedAt,
            sendBudget: budget,
            byHook: false,
            ...(input.sizeCap === undefined ? {} : { sizeCap: input.sizeCap }),
            isolation,
            ...(beat === undefined ? {} : { heartbeat: beat }),
        });
        if (!holding())
            return { kind: "lock-lost" };
    }
    else {
        for (let round = 0; round < SUBAGENT_ROUNDS_MAX; round += 1) {
            if (!holding())
                return { kind: "lock-lost" };
            const sent = await deliverSubagents({
                ctx: hookEnv,
                input: hookInput,
                url,
                credential,
                projectKey,
                redactionRoots,
                repoSlug,
                // A fresh budget each round: one round stops at the hook-sized budget with files left, and that is not a failure here.
                startedAt: Date.now(),
                sendBudget: budget,
                byHook: false,
                ...(input.sizeCap === undefined ? {} : { sizeCap: input.sizeCap }),
                isolation,
                ...(beat === undefined ? {} : { heartbeat: beat }),
            });
            if (!holding())
                return { kind: "lock-lost" };
            const blocked = sent.deliveries.find(blocksMain);
            if (blocked !== undefined)
                return { kind: "subagents-held", delivery: blocked };
            // No delivery in a round with a fresh budget means no stream had bytes pending.
            if (sent.deliveries.length === 0)
                break;
        }
        // The main stream's clock starts HERE. Rounds of sub-agent sends can take longer than one budget, and a clock that began before
        // them would hand the main deltas the minimum timeout and end them `later` (PR 5 review). `finalize`'s single pass keeps
        // the clock it always had.
        startedAt = Date.now();
    }
    if (!holding())
        return { kind: "lock-lost" };
    const delivery = await deliver({
        home,
        env,
        url,
        credential,
        repoKey: projectKey,
        repoSlug,
        sessionId,
        fileKey: "main",
        transcriptPath,
        timeoutMs: input.requestTimeoutMs ?? sendTimeoutMs(budget, Date.now() - startedAt),
        // ⛔ NO `deadlineAtMs` HERE (C21 #2, retracting C18 #8's deadline): `finalize` and `backfill` are interactive and "set no deadline
        // and run on" (post.ts). A deadline would stop a main stream that needs longer part-way, never send the final request, and
        // report a session 0.8.0 completed as failed.
        nowMs: Date.now(),
        head: headRef(projectKey),
        commits: spooled,
        // E8: only a REPO target (the same resolver as the hook returns granted targets only); a folder has no commits to describe.
        commitFiles: isolation.kind === "repo",
        rewrites: rewritten.pairs,
        inferredRewrites: inferred.pairs,
        inferredGroups: inferred.groups,
        spoolSources: union.sources,
        ...(input.seal ? { final: true } : {}),
        byHook: false,
        ...(beat === undefined ? {} : { beforeRequest: beat }),
    }, eof, (from, to) => readSpan(transcriptPath, from, to, redactionRoots, home, env, isolation), recordCutter(transcriptPath));
    if (delivery.kind === "stopped")
        return { kind: "stopped" };
    // C25: `deliver` makes no request once the lock is gone. It answers `nothing-to-send` (which a close that does not seal reads as
    // "already delivered") or, after some deltas went, the last good one. Ask again: a lock that is not ours, with bytes still unsent,
    // is not a delivery. (Everything sent and acknowledged is reported as it happened, whoever holds the session now.)
    if (!holding() && (delivery.kind === "nothing-to-send" || fileState(loadSessionState(home, spoolKey), "main").sentOffset < eof)) {
        return { kind: "lock-lost" };
    }
    if (!input.seal) {
        return delivery.kind === "nothing-to-send" || (delivery.kind === "attempted" && delivery.disposition === "ok")
            ? { kind: "delivered", delivery }
            : { kind: "not-delivered", delivery };
    }
    if (delivery.kind !== "attempted" || delivery.disposition !== "ok")
        return { kind: "not-delivered", delivery };
    if (delivery.finalAck === "sealed" || delivery.finalAck === "already") {
        // C25: a write, so only while the session is still ours. The close itself DID happen (the server said so), and is reported.
        if (holding())
            clearDeliveredHold(home, spoolKey);
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
        const lean = fileState(loadSessionState(home, spoolKey), "main").lean;
        for (let i = 0; !lean && i < FINALIZE_DRAIN_MAX_ITERATIONS; i += 1) {
            if (!holding())
                break;
            const more = readSpoolUnion(home, sessionId, projectKey, worktrees, input.asOfAt);
            const moreRewritten = more.rewrites;
            const moreInferred = more.inferred;
            if (moreRewritten.pairs.length === 0 && moreInferred.pairs.length === 0 && (input.byWorker !== true || more.commits.count === 0))
                break;
            const groupId = moreInferred.groups.length > 0 ? `${moreInferred.groups[0].successor}:${moreInferred.groups[0].patchId}` : null;
            if (groupId !== null && groupId === backoffGroupId && backoffStreak >= 1 && backoffStreak <= FINALIZE_DRAIN_BACKOFF_MS.length) {
                await wait(FINALIZE_DRAIN_BACKOFF_MS[backoffStreak - 1]);
            }
            const drain = await deliver({
                home: home,
                env: env,
                url,
                credential: credential,
                repoKey: projectKey,
                repoSlug,
                sessionId,
                fileKey: "main",
                transcriptPath,
                timeoutMs: input.requestTimeoutMs ?? sendTimeoutMs(budget, Date.now() - startedAt),
                nowMs: Date.now(),
                head: headRef(projectKey),
                ...(input.byWorker === true ? { commits: more.commits, commitFiles: isolation.kind === "repo" } : {}),
                rewrites: moreRewritten.pairs,
                inferredRewrites: moreInferred.pairs,
                inferredGroups: moreInferred.groups,
                spoolSources: more.sources,
                final: true,
                byHook: false,
                ...(beat === undefined ? {} : { beforeRequest: beat }),
            }, eof, (from, to) => readSpan(transcriptPath, from, to, redactionRoots, home, env, isolation), recordCutter(transcriptPath));
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
        for (const source of holding() && input.byWorker !== true ? [projectKey, ...worktrees.filter((worktree) => worktree !== projectKey)] : []) {
            const sourceKey = { repoKey: source, sessionId };
            if (inferredFullyResolved(home, sourceKey))
                deleteInferredSpool(home, sourceKey);
        }
        return { kind: delivery.finalAck, delivery, setAsidePairs };
    }
    if (delivery.finalAck === "refused")
        return { kind: "refused", delivery };
    return { kind: "unacknowledged", delivery };
}
/** After a successful close, forget end-of-session holds whose bytes have now been delivered. */
function clearDeliveredHold(home, key) {
    pruneDeliveredEndHold(home, key);
}
//# sourceMappingURL=close_session.js.map