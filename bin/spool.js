/**
 * The commit spool — where `post-commit` leaves what it OBSERVED, for the next
 * Claude Code hook to deliver (`CR-170`, D154).
 *
 * ## Why a spool at all, rather than sending from `post-commit`
 *
 * `post-commit` runs inside `git commit`. A network call there would put our
 * latency on the user's own commit, and a failure would surface as noise in a
 * command that has nothing to do with us. So the commit hook does the one thing
 * only it can do — witness the commit — and writes a line. Delivery stays on the
 * hook path that already has a credential, a budget and a retry story.
 *
 * ## ⛔ APPEND, THEN TRUNCATE ON 2xx — NEVER READ-AND-DELETE
 *
 * A send that fails must leave the commit in the spool so the NEXT hook retries
 * it. Deleting on read would lose a commit to a single 500, permanently, and
 * `capture_commits` rows cannot be retracted (D105/D108). So the truncation is
 * the LAST step and it is conditional on the server's 2xx.
 *
 * ## ⛔ THE SESSION GATE IS ABOUT WHICH SESSION, NOT ABOUT WHO TYPED IT
 *
 * ⚠ **This block used to say the gate is what keeps a HUMAN'S commits out. That
 * has been FALSE since `CR-170` shipped** — `activeSessionFor` has never
 * inspected authorship, and `post_commit.ts` says three lines below its own copy
 * of the claim that the hook *"fires for every commit in this work tree,
 * including ones no agent was involved in."* Corrected as a comment fix; no
 * behaviour moved with it (`D5`).
 *
 * What the gate actually asks is whether a capture session is demonstrably live
 * for this repo, and — since the ladder below — **WHICH ONE**. A line is written
 * only when that question has an answer, and the answer carries the rung that
 * produced it so the server can tell an observation from a guess.
 *
 * ## The line is deliberately small, and the file list stays here
 *
 * `{sha, branch, at, files}`. Only the SHA reaches the wire in wave 1 (`CR-170`
 * §4): commit messages were MEASURED at 9/20, 8/20 and 5/20 commits over 4096
 * bytes across the three repos, largest 12,112, so a quarter of real commits
 * would land permanently truncated in a header. Metadata is backfillable from
 * the sha; the observation is not. `files` is carried for wave 2 and never put
 * in a header.
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { keepsPendingLine } from "./pending_bound.js";
import { repoSessionsDir, sessionStatePath } from "./paths.js";
/**
 * How many SHAs one hook may put on the wire.
 *
 * A header has a practical size bound and the server pins its own; 40 hex plus a
 * separator is 41 bytes, so 32 is ~1.3 KB and comfortably inside any of them.
 * ⛔ **The rest stay spooled** rather than being dropped — a burst of commits is
 * delivered across several hooks, and hooks are frequent.
 */
export const MAX_SPOOLED_SHAS = 32;
/**
 * A session is "live" for this repo if its state file was touched inside this
 * window.
 *
 * ⚠ **A JUDGEMENT CALL, AND IT IS THE ONE KNOB IN THIS MODULE.** The Claude Code
 * hook writes session state on every fire, so during active work this file is
 * touched every turn. Too short and a long turn's commit is missed; too long and
 * a human's commit hours later is attributed to a session that is morally over.
 *
 * The asymmetry decides it, the same way it did in `spawn_budget.ts`: a MISSED
 * commit is recoverable — the sha is still in git and wave 2 can backfill it —
 * while a WRONGLY ATTRIBUTED commit is a permanent row linking work to a session
 * that did not do it. So this is sized to the length of a plausible single turn,
 * not to the length of a working day.
 */
export const SESSION_LIVE_WINDOW_MS = 30 * 60 * 1000;
/**
 * `<repo>/<session>.spool.jsonl`, beside the session's state file.
 *
 * ⚠ **`.jsonl`, NOT `.json`, and that is load-bearing.** `lastSendForRepo`
 * scans this same directory and filters on `entry.endsWith(".json")`; a spool
 * named `.json` would be parsed as session state, fail, and silently degrade
 * every `vibecommit status` for the repo. Checked rather than assumed — there is
 * a test for exactly that.
 *
 * Null on no repo identity, for the reason `sessionStatePath` is: there is no
 * repo-less bucket and a placeholder key is a cross-repo bleed with an extra step.
 */
export function spoolPath(home, key) {
    const state = sessionStatePath(home, key);
    if (state === null)
        return null;
    return state.replace(/\.json$/, ".spool.jsonl");
}
/**
 * Append one observed commit. Returns false on any failure.
 *
 * ⛔ **NEVER THROWS.** This runs inside `git commit`: an exception here would
 * surface as a failed hook on the user's own commit, which is exactly the noise
 * `post-commit` must not create. A dropped line is strictly better.
 *
 * `appendFileSync` with `a` is a single positioned write, so two commits racing
 * in one repo interleave whole lines rather than corrupting each other.
 */
export function appendSpool(home, key, entry) {
    const path = spoolPath(home, key);
    if (path === null)
        return false;
    try {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        appendFileSync(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
        chmodSync(path, 0o600);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Every well-formed entry in the spool, oldest first.
 *
 * A malformed line is SKIPPED rather than fatal: the file is appended to by a
 * different process than reads it, so a torn final line is a real possibility
 * and losing one observation beats losing the whole spool.
 */
export function readSpool(home, key) {
    const path = spoolPath(home, key);
    if (path === null)
        return [];
    let raw;
    try {
        raw = readFileSync(path, "utf8");
    }
    catch {
        return [];
    }
    const out = [];
    for (const line of raw.split("\n")) {
        if (line.trim() === "")
            continue;
        const entry = parseEntry(line);
        if (entry !== null)
            out.push(entry);
    }
    return out;
}
/**
 * Drop the first `count` entries — called ONLY after the server's 2xx.
 *
 * ⚠ **RE-READS BEFORE REWRITING, and that is not defensive tidiness.**
 * `post-commit` may have appended while the send was in flight. Slicing the
 * array we read BEFORE the send would rewrite the file without those lines and
 * lose them silently. Appends only ever go to the END, so the first `count`
 * lines are still the same ones we delivered, and dropping exactly that many is
 * correct against the current file rather than against a stale snapshot.
 *
 * ⚠ **A residual race remains and is accepted:** a commit landing between this
 * re-read and the write is lost. The window is one `readFileSync` plus one
 * `writeFileSync` on a small file, the cost is one un-delivered commit row, and
 * closing it properly means a lock file on a path that must never block
 * (`post-commit` runs inside the user's `git commit`). Recorded rather than
 * hidden.
 */
export function dropSpooled(home, key, count) {
    const path = spoolPath(home, key);
    if (path === null || count <= 0)
        return false;
    try {
        const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim() !== "");
        writeFileSync(path, lines.slice(count).map((l) => `${l}\n`).join(""), { mode: 0o600 });
        chmodSync(path, 0o600);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Settle the first `count` lines against the server's `X-Commits-Retry`
 * (`CR-222`, D209 §4): KEEP a line only if it went on the wire and the server
 * named its sha; drop every other consumed line. Kept lines stay at the head, in
 * order, so they ride the next delta first. Returns false on any failure.
 *
 * ⛔ **NOT `dropSpooled` WITH A SMALLER N.** `dropSpooled` removes a PREFIX, and
 * the lines to keep need not be one: a batch can bind its first sha and not its
 * second. Truncating by any count would either delete the unbound sha or keep a
 * BOUND one — and a bound sha resent into a sealed turn is a second, permanent
 * edge (`cr071:157`). Only the per-line decision is right.
 *
 * ⚠ THE SAME LINE ARITHMETIC AS `dropSpooled`, deliberately: it works on raw
 * non-empty lines, because `count` was computed from them via `capSpool`. A line
 * that does not parse, or carries a rung that never goes on the wire, is dropped
 * exactly as `dropSpooled` would drop it — the server cannot have named it.
 *
 * ⚠ The residual race `dropSpooled` documents applies here unchanged.
 */
export function settleSpooled(home, key, count, keep) {
    const path = spoolPath(home, key);
    if (path === null || count <= 0)
        return false;
    try {
        const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim() !== "");
        const kept = lines.slice(0, count).filter((line) => {
            const entry = parseEntry(line);
            return entry !== null && WIRE_RUNGS.includes(entry.attribution) && keep.has(entry.sha);
        });
        writeFileSync(path, [...kept, ...lines.slice(count)].map((l) => `${l}\n`).join(""), { mode: 0o600 });
        chmodSync(path, 0o600);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Which session, if any, is live for this repo right now — ⛔ **AND HOW WE KNOW.**
 *
 * ## The defect this replaces
 *
 * Until the ladder, this function returned *the most recently mtime'd state file
 * within 30 minutes* and said nothing about its own confidence. Two agents in one
 * clone: session A commits, B's state file is newer, **A's commit enters B's
 * spool** — and `cr071:157` makes the resulting edge PERMANENT, with UPDATE and
 * DELETE both raising for `service_role` too. A wrong edge is forever, so the
 * guess had to stop being indistinguishable from the answer.
 *
 * ## The ladder
 *
 * ```
 *  env id names a live session ─────────> env_session_id         WRITE
 *  no live session at all ──────────────> null                   REFUSE (no row)
 *  env id names NONE of them ───────────> env_session_unmatched  REFUSE (named)
 *  exactly ONE candidate ───────────────> sole_live_session      WRITE  (D5)
 *  TWO OR MORE candidates ──────────────> recency_heuristic      HOLD
 * ```
 *
 * ⛔ **`sole_live_session` ALWAYS WRITES, and that is not a change.** It never
 * inspected authorship and does not start now: a human's `git commit` in a clone
 * with one live session produces a spool line today, at HEAD, and
 * `test/post-commit-spool.test.ts` has a green arm asserting exactly that. What
 * is new is that the server will write a PERMANENT row off this rung, so the rung
 * has to be named on the wire (`D190`).
 *
 * ## ⛔ `env_session_unmatched` — THE THIRD ARM, AND IT IS A REFUSAL WITH A NAME
 *
 * An env id that names **none** of the live candidates is a shape the plan's
 * ladder does not draw, and the code must answer it. It is REAL rather than
 * hypothetical: `agents/registry.ts:11-13` rejects an environment variable as the
 * agent selector precisely because **Codex exports `CLAUDE_PLUGIN_ROOT` itself**,
 * so a Codex agent running under an outer Claude session carries a
 * `CLAUDE_CODE_SESSION_ID` that corroborates nothing here.
 *
 *   - ⛔ `sole_live_session` there would name a session we have POSITIVE evidence
 *     did not commit — the permanent wrong edge, arrived at from the other
 *     direction. Never.
 *   - ⛔ `recency_heuristic` is what this ladder used first, and it is wrong for
 *     the reason `AttributionRung` records: cardinality one, refused **23514**,
 *     and a doubt we do not actually have.
 *   - ⛔ **A silent refusal is worse than either in one respect** — nobody can
 *     afterwards ask *why did that commit vanish*. That is the failure class this
 *     whole wave exists to close, so the refusal is RECORDED and NAMED.
 *
 * ⚠ **The line goes in the recency winner's spool bucket, because that is the
 * only bucket that exists** — an uncorroborated env id deliberately does not open
 * one of its own. The bucket is a FILE LOCATION and the rung is the attribution:
 * the line says, in terms, *this commit is attributed to nobody, and here is
 * why*. It never reaches `x-commits` and never becomes a `commit_attributions`
 * row.
 *
 * ⚠ **So `recency_heuristic` is reachable ONLY with two or more candidates**,
 * which is what `commit_attributions_ambiguity_is_plural` demands. That is a
 * property of the ladder's SHAPE now rather than of a caller's care, and
 * `test/post-commit-spool.test.ts` asserts it directly.
 *
 * ⚠ **A commit made before a session's FIRST hook has fired is still NOT
 * captured**, because the state file it would key on does not exist yet. The env
 * id could key a bucket that has no state file, and deliberately does not: the
 * ladder's first rung requires CORROBORATION, so a stale or inherited variable
 * cannot open a spool of its own.
 *
 * `envSessionId` is a PARAMETER rather than a read of `process.env` here, and it
 * has no default: the compiler is the only thing that will notice a caller which
 * forgot the env path, and this seam has no other check.
 */
export function activeSessionFor(home, repoKey, envSessionId, nowMs = Date.now(), windowMs = SESSION_LIVE_WINDOW_MS) {
    const live = liveSessions(home, repoKey, nowMs, windowMs);
    // Rung 1 — the committing process told us, and a state file agrees.
    if (envSessionId !== null && live.some((s) => s.sessionId === envSessionId)) {
        return { sessionId: envSessionId, attribution: "env_session_id" };
    }
    // ⛔ **THE COLD CASE — `CR-195`/D208, and it used to DROP THE COMMIT SILENTLY.**
    //
    // The environment names a session and NO state file exists for it. Until D208 that
    // returned `null` and the observation was gone: MEASURED in a real session as commit
    // `f1608bc`, spooled nowhere. And it is not an edge case — `Stop` fires at the END of a
    // turn, so **every commit made during a session's first turn lands here**, which is
    // exactly what a tester does before asking `blame_commit`.
    //
    // ⚠ **Rung 1 cannot cover it, structurally.** That rung requires
    // `live.some(s => s.sessionId === envSessionId)` — a state file must
    // corroborate the environment — and on the first turn none can exist.
    //
    // So when the committing process DID name itself, record the observation at a
    // rung that says exactly that and cannot mint an edge. When it did not, there
    // is genuinely nothing to record and the silence stands.
    //
    // ⭐ **`TODOS[172]` — AND IT IS INDEPENDENT OF WHO ELSE IS LIVE.** This rung was guarded by
    // `live.length === 0`, so a second session started within the 30-minute window of a first
    // reached the NAMED REFUSAL below instead, which files the commit under `live[0]` (another
    // session's bucket) as `env_session_unmatched` — a rung that can never mint an edge. Two
    // terminals, or a quick second `claude -p`, lost every first-turn commit of the second one,
    // forever. The refusal's premise — *we were TOLD who committed, and it is none of these* —
    // is false for a session that has merely not written its state file YET.
    //
    // ⭐ **`TODOS[176]` — AND IT IS THE SAME FOR A SESSION WHOSE STATE FILE EXISTS BUT HAS GONE STALE.**
    // A RESUMED session (idle past the 30-minute window) is exactly as "not yet corroborated" as a brand-new one: the
    // resumed turn's first commit is made BEFORE any hook of that turn has fired, and `liveAt` is refreshed only by a
    // hook. Measured on the registry 0.4.0 binary: alone, that commit left no spool line anywhere (null); with another
    // session live it was filed under the OTHER session as `env_session_unmatched` and then discarded. Either way the
    // edge was lost for good. So rung 1 failing (X is not live) with X named by the environment now ALWAYS takes the cold
    // rung, keyed to X's own id.
    //
    // ⛔ WHAT MAKES THAT SAFE (the old comment here forbade it, for a good reason): the hazard was a shell that exported a
    // session id once and kept committing, with the commits then adopted by a long-dead session and PROMOTED to
    // edge-minting rows. Three things close it, and none of them is this function:
    //   1. this rung writes ONE `.pending.jsonl` line (post_commit.ts picks the sidecar for this rung): no state file, no
    //      `liveAt`, no spool line. A non-hook writer cannot make X live (D2; asserted as bytes in
    //      `test/stale-own-pending.test.ts`).
    //   2. only X's OWN running hook promotes X's bucket (`promotePending`'s call site is keyed by the executing hook's
    //      session, never by the environment): a dead session never runs a hook, and another session's hook cannot touch it.
    //   3. the promotion bound (`pending_bound.ts`): a line observed before the START OF THE TURN X is delivering (its first unsent prompt-like record) is
    //      DROPPED, so a lingering-id commit from days ago is not adopted when X is finally resumed.
    // Residual, stated: a stale exported id committing DURING the resumed turn looks exactly like X's own commit.
    // (Worded to avoid `from` followed by a quoted string: `provenance.test.ts` walls RAW TEXT and reads that shape as an
    // escaping import specifier.)
    //
    // ⚠ WHAT THIS COSTS, stated rather than discovered: an environment naming a session this clone has never captured, or
    // captured long ago, opens a `.pending.jsonl` bucket even when others are live (Codex under an outer Claude session is
    // the case `agents/registry.ts:11-13` describes). The line is `pending`, not sendable: it promotes only if THAT
    // session's own hook later corroborates it, and otherwise ages out under `MAX_PENDING_SHAS`.
    if (envSessionId !== null && sessionStatePath(home, { repoKey, sessionId: envSessionId }) !== null) {
        return { sessionId: envSessionId, attribution: "env_session_uncorroborated" };
    }
    if (live.length === 0)
        return null;
    // ⛔ THE NAMED REFUSAL, AND IT COMES BEFORE BOTH WRITE RUNGS. We were TOLD who
    // committed, and it is none of these — and now only when there is POSITIVE
    // evidence against the named session: its state file exists, so it is not on its
    // first turn, and it is not live. Falling through would attribute the commit to a
    // session we have positive evidence did not make it.
    if (envSessionId !== null) {
        return { sessionId: live[0].sessionId, attribution: "env_session_unmatched" };
    }
    // Rung 2 — D5. One session, nothing contradicting it.
    if (live.length === 1) {
        return { sessionId: live[0].sessionId, attribution: "sole_live_session" };
    }
    // ⛔ Rung 3 — the guess, and TWO OR MORE candidates is now structurally
    // guaranteed here: every path with an env id returned above, and one candidate
    // returned on the line before. `commit_attributions_ambiguity_is_plural`
    // requires exactly that, and a cardinality-one row is refused 23514.
    return { sessionId: live[0].sessionId, attribution: "recency_heuristic" };
}
/**
 * `SessionState.liveAt` of one state file, or null when it is absent, unreadable or not a positive number.
 *
 * ⚠ Read straight from the JSON rather than through `state.ts`: that module imports this one's `commitLinesFor`, and the
 * field is one number. `state.ts` owns the schema and its docblock; this is the single reader of it outside that module.
 */
function readLiveAt(path) {
    try {
        const v = JSON.parse(readFileSync(path, "utf8")).liveAt;
        return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
    }
    catch {
        return null;
    }
}
/**
 * `TODOS[176]` — which promotion path a pending line is on, decided by the session's OWN state at the moment its hook runs:
 * `stale-own` = its state file EXISTS and is not live (a RESUMED session: the cold rung put the line here because rung 1 failed),
 * `first-turn` = no state file yet, or one that is live (the original cold case — the first Stop promotes BEFORE it saves state).
 * Reads only; writes nothing (D2).
 */
export function pendingModeFor(home, key, nowMs = Date.now(), windowMs = SESSION_LIVE_WINDOW_MS) {
    const state = sessionStatePath(home, key);
    if (state === null || !existsSync(state))
        return "first-turn";
    const at = readLiveAt(state);
    return at !== null && nowMs - at <= windowMs ? "first-turn" : "stale-own";
}
/** Every session whose hook last ran inside the window, most recent first. */
function liveSessions(home, repoKey, nowMs, windowMs) {
    const dir = repoSessionsDir(home, repoKey);
    if (dir === null)
        return [];
    let entries;
    try {
        entries = readdirSync(dir);
    }
    catch {
        // No directory at all: nothing has ever captured this repo.
        return [];
    }
    const live = [];
    for (const entry of entries) {
        // ⚠ State files only. `.spool.jsonl` and `.rewrites.jsonl` live here too and
        // are not sessions — and neither ends with `.json`, which is the same
        // load-bearing spelling `spoolPath` documents.
        if (!entry.endsWith(".json"))
            continue;
        // ⛔ THE CONTENT CLOCK, NEVER THE FILE'S MTIME (VG review 2, D2). `SessionState.liveAt` is written only by a hook;
        // a `vibecommit finalize` of a long-dead session rewrites the file and moved the mtime, which made that session
        // "live" and let a plain-terminal commit be filed under it at an edge-minting rung. A file with no `liveAt`
        // (written by 0.3.0) is NOT live — see the field's docblock for the stated cost.
        const touchedAt = readLiveAt(join(dir, entry));
        if (touchedAt === null || nowMs - touchedAt > windowMs)
            continue;
        live.push({ sessionId: entry.slice(0, -".json".length), at: touchedAt });
    }
    // ⚠ Ties broken by name so the guess is at least DETERMINISTIC. Two state files
    // written in the same millisecond is ordinary on a coarse-grained filesystem,
    // and a rung that picked differently on each read would be unreproducible as
    // well as wrong.
    live.sort((a, b) => (b.at - a.at) || a.sessionId.localeCompare(b.sessionId));
    return live;
}
/**
 * ⛔ **THE TWO RUNGS THAT MAY GO ON `x-commit-attributions` (`D190`).**
 *
 * The server's vocabulary is exactly these two (`edge_derivation.ts:178`) and a
 * rung outside it is **skipped silently** — no edge, no error, no log. So the
 * refusal lives here, on the producing side, rather than being discovered as a
 * zero where edges should have been.
 *
 * ⚠ **This constant is NOT what the wire cell asserts against.** There is no
 * shared type across that seam and inventing one would couple an MIT client to a
 * closed server, so the cell types the literals itself — round-tripping this
 * constant through our own code would only prove it equals itself (`D190 §5`).
 */
export const WIRE_RUNGS = ["env_session_id", "sole_live_session"];
/**
 * The SHAs this hook will carry, their rungs, and how many lines to drop after a
 * 2xx.
 *
 * ⛔ **FULL WIDTH, ALWAYS.** `capture_commits.commit_sha` is 7..40 because the
 * server's `expandShortSha` can fail, so an abbreviated sha makes the web join
 * SILENTLY EMPTY — a wrong answer with no error, D98's class exactly. Anything
 * that is not a full sha is dropped by `parseEntry` rather than sent.
 *
 * ⛔ **`shas` AND `attributions` ARE THE SAME LENGTH BY CONSTRUCTION** — one
 * `push` each, in one iteration, or neither. That is not style.
 * `parseObservedCommits` returns `[]` when the two lists differ in length: **the
 * ENTIRE BATCH is dropped, not the odd entry**, with no edge, no error and no
 * log (`D190 §1`). A `filter` and a `map` over the same array would be the same
 * thing until someone changed one of them.
 *
 * ⛔ **`count` IS LINES CONSUMED, NOT `shas.length`, AND THEY DIVERGE.** A held
 * entry is consumed and never sent. `dropSpooled` drops **the first N lines**, so
 * a caller truncating by `shas.length` would delete a held line at the head and
 * re-send the commit that was actually delivered — forever.
 *
 * ⚠ **A held entry IS dropped on the 2xx, and the observation is lost.** Stated
 * rather than hidden: this wave gives the client no way to transmit a held
 * commit, and leaving it in the file would make every subsequent hook re-read a
 * line that can never be sent. The asymmetry this module already runs on decides
 * it — a MISSED commit is recoverable, the sha is still in git, while a WRONGLY
 * ATTRIBUTED one is a permanent row (`cr071:157`).
 */
export function capSpool(entries) {
    const taken = entries.slice(0, MAX_SPOOLED_SHAS);
    const shas = [];
    const attributions = [];
    for (const entry of taken) {
        if (!WIRE_RUNGS.includes(entry.attribution))
            continue;
        shas.push(entry.sha);
        attributions.push(entry.attribution);
    }
    return { shas, attributions, count: taken.length };
}
/**
 * How many rewrite pairs one hook may put on the wire.
 *
 * ⛔ **ITS OWN CONSTANT, AND SHARING `MAX_SPOOLED_SHAS` WOULD MAKE ONE OF THE TWO
 * WRONG.** The units differ: a sha plus a separator is 41 bytes, a pair plus a
 * separator is **82** (40 + `:` + 40 + `,`). 16 pairs is 1,312 bytes — the same
 * header budget `MAX_SPOOLED_SHAS = 32` was sized against, arrived at through the
 * arithmetic of this header rather than inherited from the other one.
 *
 * ⛔ **The rest stay spooled**, exactly as the commit spool's remainder does.
 */
export const MAX_SPOOLED_PAIRS = 16;
/** `<repo>/<session>.rewrites.jsonl`, beside the commit spool. */
export function rewriteSpoolPath(home, key) {
    const state = sessionStatePath(home, key);
    if (state === null)
        return null;
    return state.replace(/\.json$/, ".rewrites.jsonl");
}
/**
 * Append rewrite pairs, skipping any already spooled. Returns how many were
 * WRITTEN — ⛔ not how many were offered.
 *
 * ## ⛔ THE DEDUP IS ONE OF T4'S TWO GUARDS, AND IT IS NOT REDUNDANCY
 *
 * `M6` measured the squash hazard and it is **SIZE-DEPENDENT**. A 3→1 squash
 * fires `post-rewrite` twice — `amend A→F`, then `rebase A→F; B→F` — so **the
 * pair `A→F` arrives twice**. A 4→1 squash instead produces rows naming an
 * INTERMEDIATE sha that never existed on any branch; that one is killed by the
 * in-progress-rebase suppression in `hooks/post_rewrite.ts`, which cannot see the
 * duplicate, exactly as this cannot see the intermediate. **One squash size
 * cannot test both.**
 *
 * ⚠ **Dedup is against the FILE, not against the batch**, because the two fires
 * are two processes: a batch-local check would see one pair each time and dedup
 * nothing. ⚠ The read-then-append is not atomic — two rewrites racing in one
 * clone could both miss — but `post-rewrite` runs inside git's own serialised
 * rebase, and the cost of the residual race is one duplicate pair rather than a
 * wrong one.
 *
 * ⛔ **NEVER THROWS.** This runs inside the user's `git rebase`.
 */
export function appendRewrites(home, key, pairs) {
    const path = rewriteSpoolPath(home, key);
    if (path === null)
        return 0;
    const seen = new Set(readRewrites(home, key).map(wirePair));
    let written = 0;
    try {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        for (const pair of pairs) {
            const wire = wirePair(pair);
            if (seen.has(wire))
                continue;
            seen.add(wire);
            appendFileSync(path, `${JSON.stringify(pair)}\n`, { mode: 0o600 });
            written += 1;
        }
        if (written > 0)
            chmodSync(path, 0o600);
        return written;
    }
    catch {
        return written;
    }
}
/** Every well-formed pair in the rewrite spool, oldest first. */
export function readRewrites(home, key) {
    const path = rewriteSpoolPath(home, key);
    if (path === null)
        return [];
    let raw;
    try {
        raw = readFileSync(path, "utf8");
    }
    catch {
        return [];
    }
    const out = [];
    for (const line of raw.split("\n")) {
        if (line.trim() === "")
            continue;
        const pair = parsePair(line);
        if (pair !== null)
            out.push(pair);
    }
    return out;
}
/** Drop the first `count` pairs — called ONLY after the server's 2xx. */
export function dropRewrites(home, key, count) {
    const path = rewriteSpoolPath(home, key);
    if (path === null || count <= 0)
        return false;
    try {
        const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim() !== "");
        writeFileSync(path, lines.slice(count).map((l) => `${l}\n`).join(""), { mode: 0o600 });
        chmodSync(path, 0o600);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * The pairs this hook will carry, and how many to drop after a 2xx.
 *
 * ⛔ **`ancestor:successor`, COLON-SEPARATED.** `parseRewritePairs` drops
 * silently on a wrong separator, on a third colon-field, on a bad sha and on a
 * self-pair — no edge, no error, no log (`D190 §1`).
 */
export function capSuccessors(pairs) {
    const taken = pairs.slice(0, MAX_SPOOLED_PAIRS);
    return { pairs: taken.map(wirePair), count: taken.length };
}
/**
 * How many inferred pairs one request may carry. ⛔ ITS OWN CONSTANT, and a WHOLE-GROUP budget, not a flat per-hook cap: `blame_commit`
 * renders `squashed_from` as a plain list (mcp `blame.ts:454`), so a group split across requests would read as a complete answer when it
 * is not — the same class of defect as [160]. One squash's fold is at most `MAX_INFERRED_COMMITS` (64) pairs (a larger fold is refused
 * before it is ever spooled — "oversize", tallied, nothing sent), so 64 is also the largest a single group can be. `capInferred` packs
 * whole groups, oldest first, up to this budget; a group that would not fit WHOLE waits, with everything after it, for a later request —
 * never split. Measured on the wire (prod, invalid-bearer probe, 2026-10-08): 64 pairs = 7,871 bytes alongside a 10-pair exact-rewrites
 * header (819 B) still returns 401 (passed the proxy and node's header layer); a 40,000 B control header returns 431, so the probe can see
 * a real limit and did not hit it here.
 */
export const MAX_INFERRED_PAIRS = 64;
/** `<repo>/<session>.inferred.jsonl`, beside the rewrite spool. */
export function inferredSpoolPath(home, key) {
    const state = sessionStatePath(home, key);
    if (state === null)
        return null;
    return state.replace(/\.json$/, ".inferred.jsonl");
}
/** A 40-hex patch-id. Not `isFullSha`: the wire contract is `patchid40`, lowercase hex, exactly 40. */
export function isPatchId(value) {
    return typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
}
function identityOf(g) {
    return `${g.successor}:${g.patchId}`;
}
const IDENTITY_RE = /^[0-9a-f]{40}:[0-9a-f]{40}$/;
function parseStoredLine(line) {
    let parsed;
    try {
        parsed = JSON.parse(line);
    }
    catch {
        return null;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
        return null;
    const o = parsed;
    if (typeof o.delivered === "string" && IDENTITY_RE.test(o.delivered))
        return { kind: "delivered", identity: o.delivered };
    if (typeof o.attempt === "string" && IDENTITY_RE.test(o.attempt))
        return { kind: "attempt", identity: o.attempt };
    if (typeof o.set_aside === "string" && IDENTITY_RE.test(o.set_aside))
        return { kind: "set_aside", identity: o.set_aside };
    const successor = o.successor;
    const patchId = o.patch_id;
    const ancestors = o.ancestors;
    if (typeof successor !== "string" || !/^[0-9a-f]{40}$/.test(successor))
        return null;
    if (!isPatchId(patchId))
        return null;
    if (!Array.isArray(ancestors) || ancestors.length === 0)
        return null;
    const clean = ancestors.filter((a) => typeof a === "string" && /^[0-9a-f]{40}$/.test(a) && a !== successor);
    if (clean.length === 0)
        return null;
    return { kind: "group", group: { successor, patchId, ancestors: [...new Set(clean)] } };
}
/** Every group line and every mark (delivered / attempt / set-aside) currently on disk. Malformed lines are skipped, not fatal. */
function readStored(path) {
    let raw;
    try {
        raw = readFileSync(path, "utf8");
    }
    catch {
        return { groups: [], delivered: new Set(), setAside: new Set(), attempts: new Map() };
    }
    const groups = [];
    const delivered = new Set();
    const setAside = new Set();
    const attempts = new Map();
    for (const line of raw.split("\n")) {
        if (line.trim() === "")
            continue;
        const parsed = parseStoredLine(line);
        if (parsed === null)
            continue;
        if (parsed.kind === "delivered")
            delivered.add(parsed.identity);
        else if (parsed.kind === "set_aside")
            setAside.add(parsed.identity);
        else if (parsed.kind === "attempt")
            attempts.set(parsed.identity, (attempts.get(parsed.identity) ?? 0) + 1);
        else
            groups.push(parsed.group);
    }
    return { groups, delivered, setAside, attempts };
}
/**
 * Append inferred pairs as ONE GROUP LINE (they are the fold of one detected squash, so they share one successor and
 * one patch-id by construction; grouped here anyway, defensively, in case a future caller ever passes more than one).
 * A group whose identity is already on disk — spooled OR already delivered — is skipped whole: the same squash
 * detected twice (a hook retried) must not duplicate it. Returns how many ancestor pairs were newly WRITTEN.
 * ⛔ NEVER THROWS — this runs inside the user's `git commit`.
 */
export function appendInferred(home, key, pairs) {
    const path = inferredSpoolPath(home, key);
    if (path === null)
        return 0;
    const valid = pairs.filter(validInferred);
    if (valid.length === 0)
        return 0;
    const order = [];
    const bySuccessor = new Map();
    for (const pair of valid) {
        let g = bySuccessor.get(pair.successor);
        if (g === undefined) {
            g = [];
            bySuccessor.set(pair.successor, g);
            order.push(pair.successor);
        }
        g.push(pair);
    }
    let written = 0;
    try {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        const existing = readStored(path);
        const known = new Set([...existing.delivered, ...existing.setAside, ...existing.groups.map(identityOf)]);
        for (const successor of order) {
            const members = bySuccessor.get(successor);
            const patchId = members[0].patchId;
            if (!members.every((p) => p.patchId === patchId))
                continue; // defensive: a mixed call names no group
            const identity = identityOf({ successor, patchId });
            if (known.has(identity))
                continue;
            known.add(identity);
            const ancestors = [...new Set(members.map((p) => p.ancestor))];
            appendFileSync(path, `${JSON.stringify({ successor, patch_id: patchId, ancestors })}\n`, { mode: 0o600 });
            written += ancestors.length;
        }
        if (written > 0)
            chmodSync(path, 0o600);
        return written;
    }
    catch {
        return written;
    }
}
/**
 * Every well-formed, still-ELIGIBLE inferred pair in the spool, oldest group first, ancestors in stored order
 * within a group. "Eligible" excludes a group already DELIVERED and one already SET ASIDE (VL, 2026-10-08: a
 * group that gave up after `INFERRED_SET_ASIDE_AFTER` short acks is never offered again; `inferred_tally.ts`'s
 * `recordInferredSkipped(..., "set_aside", ...)` tallied it durably at that moment, for `status`). `capInferred`
 * takes `pairs[0]`'s group as the one it sends, so this function's ORDER is load-bearing: the oldest eligible
 * group must come first.
 */
export function readInferred(home, key) {
    const path = inferredSpoolPath(home, key);
    if (path === null)
        return [];
    const { groups, delivered, setAside } = readStored(path);
    const out = [];
    for (const g of groups) {
        if (delivered.has(identityOf(g)) || setAside.has(identityOf(g)))
            continue;
        for (const ancestor of g.ancestors)
            out.push({ ancestor, successor: g.successor, patchId: g.patchId });
    }
    return out;
}
// ⛔ `inferredUnacknowledgedForRepo` MOVED TO `state.ts` (`TODOS[182]`): it now needs `FileState.lean`
// (`SessionState`'s own domain) to exclude a lean session's pairs, and `spool.ts` cannot import `state.ts`
// without a cycle — `state.ts` already imports several read/cap functions from this file.
/**
 * Mark groups DELIVERED, by identity — never by position. Called ONLY after the server's 2xx AND its per-request ack
 * (`x-rewrites-inferred-stored`) confirms every pair of every named group actually landed. An append-only tombstone
 * mark, so a concurrent `appendInferred` for a DIFFERENT group racing this call is never clobbered: there is no file
 * rewrite here to lose it inside. ⛔ NEVER THROWS.
 */
export function dropInferredGroups(home, key, groups) {
    const path = inferredSpoolPath(home, key);
    if (path === null || groups.length === 0)
        return false;
    try {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        const marked = new Set();
        for (const g of groups) {
            const identity = identityOf(g);
            if (marked.has(identity))
                continue;
            marked.add(identity);
            appendFileSync(path, `${JSON.stringify({ delivered: identity })}\n`, { mode: 0o600 });
        }
        chmodSync(path, 0o600);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * The inferred pairs this hook will carry, in WIRE SPELLING — `<ancestor40>:<successor40>:<patchid40>`, lowercase hex, colon-separated —
 * and the identity of the ONE group carried (`groups`, length 0 or 1 — plural for call-site symmetry with `dropInferredGroups`, never
 * more than one member). Only 40-hex shas ride this header; a sha256 repository's pair is not spooled at all.
 *
 * ⛔⛔ ONE GROUP PER REQUEST (VL, 2026-10-08, VG's head-of-line finding over `vg-evidence/177-gate-7dde49e/hol.mjs`). The earlier
 * version packed as many WHOLE groups as fit under `MAX_INFERRED_PAIRS` — correct for the concurrency bug, but it made the ack
 * (`x-rewrites-inferred-stored`, ONE NUMBER per request) ambiguous whenever more than one group rode the same request: a short ack
 * could not say WHICH group was short, so the client had to keep ALL of them, and the head group — if a server persistently
 * refused or shorted it — blocked every group behind it forever (measured: 40+30 under a short ack reads `40,40,40,40,…` on every
 * hook; the 30 is never sent). Sending exactly `readInferred(...)`'s FIRST eligible group makes `n` name exactly that group:
 * `n == size` is unambiguous. A single group is never larger than `MAX_INFERRED_COMMITS` (64) by construction (a bigger fold is
 * refused before it is ever spooled), so it always fits; `MAX_INFERRED_PAIRS` stays as that upper bound's own name.
 */
export function capInferred(pairs) {
    if (pairs.length === 0)
        return { pairs: [], count: 0, groups: [] };
    const { successor, patchId } = pairs[0];
    // ⛔ Defensive, not load-bearing: a single group is never larger than `MAX_INFERRED_PAIRS` by construction
    // (`inferred_squash.ts` refuses a bigger fold before it is ever spooled). The clamp exists so a future upstream
    // change that weakens that guarantee fails SAFE here (an undersized request) rather than oversized on the wire.
    const group = pairs.filter((p) => p.successor === successor && p.patchId === patchId).slice(0, MAX_INFERRED_PAIRS);
    return { pairs: group.map(wireInferred), count: group.length, groups: [{ successor, patchId }] };
}
function wireInferred(pair) {
    return `${pair.ancestor}:${pair.successor}:${pair.patchId}`;
}
function validInferred(pair) {
    return /^[0-9a-f]{40}$/.test(pair.ancestor) && /^[0-9a-f]{40}$/.test(pair.successor) && pair.ancestor !== pair.successor && isPatchId(pair.patchId);
}
/**
 * ⛔ PER-GROUP BOUND (VL, 2026-10-08). A SHORT ack (the header is present but `n < sent`) is a real signal the
 * server has an issue with THIS group — unlike an ABSENT ack (an old server, which says nothing at all and is
 * never counted: "keeping is right there"). Each short ack counts ONE attempt, by identity, append-only like the
 * `delivered` mark. After `INFERRED_SET_ASIDE_AFTER` attempts the group is given up on (`setAsideInferredGroup`),
 * so a persistently-refused group blocks its neighbours for at most that many hook cycles, never forever.
 */
export const INFERRED_SET_ASIDE_AFTER = 3;
/** Record one short-ack attempt against a group, by identity. Returns the attempt count AFTER this one. ⛔ NEVER THROWS. */
export function recordInferredAttempt(home, key, group) {
    const path = inferredSpoolPath(home, key);
    if (path === null)
        return 0;
    try {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        const identity = identityOf(group);
        const before = readStored(path).attempts.get(identity) ?? 0;
        appendFileSync(path, `${JSON.stringify({ attempt: identity })}\n`, { mode: 0o600 });
        chmodSync(path, 0o600);
        return before + 1;
    }
    catch {
        return 0;
    }
}
/**
 * Give up on a group: it is never offered again (`readInferred` excludes it), but it is NOT deleted — it stays on
 * disk, covered by the 7-day orphan prune like everything else here. Not counted by a live gauge here (VL,
 * 2026-10-08, VG's double-count finding, item (b)): `recordInferredSkipped(..., "set_aside", ...)` at the call
 * site is the ONE place this is counted, so a set-aside group is a sentence exactly once, never twice. ⛔ NEVER
 * THROWS.
 */
export function setAsideInferredGroup(home, key, group, reason) {
    const path = inferredSpoolPath(home, key);
    if (path === null)
        return false;
    try {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        appendFileSync(path, `${JSON.stringify({ set_aside: identityOf(group), reason })}\n`, { mode: 0o600 });
        chmodSync(path, 0o600);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Whether EVERY group ever spooled for this session is resolved — delivered or set aside, none still pending —
 * so the file can be deleted outright rather than waiting on the 7-day prune. Called ONLY by `finalize` after its
 * drain loop ends, and ONLY because the session is then over: no concurrent `appendInferred` can still be running
 * for a session finalize just confirmed is finished (the hook that would call it is the one deciding the session
 * is over).
 */
export function inferredFullyResolved(home, key) {
    const path = inferredSpoolPath(home, key);
    if (path === null)
        return false;
    const { groups, delivered, setAside } = readStored(path);
    if (groups.length === 0)
        return false; // nothing to resolve is not the same as everything resolved
    return groups.every((g) => delivered.has(identityOf(g)) || setAside.has(identityOf(g)));
}
/** Delete a fully-resolved inferred spool file outright, rather than leaving dead marks for the 7-day prune to find. ⛔ NEVER THROWS. */
export function deleteInferredSpool(home, key) {
    const path = inferredSpoolPath(home, key);
    if (path === null)
        return false;
    try {
        rmSync(path, { force: true });
        return true;
    }
    catch {
        return false;
    }
}
// ---------------------------------------------------------------------------
// ⭐ VL, 2026-10-08, item 5: `.inferred.jsonl` older than 7 days gets the SAME prune MECHANISM as `.pending.jsonl`
// (`pending_prune.ts`) — tombstone-rename, re-read, put back anything that was not actually expired. A SEPARATE
// function rather than a generalisation of that one: `pending_prune.ts`'s restore-merge dedups by `sha` (a field
// `.inferred.jsonl` lines do not have — every line would read as `sha: null` and collide), so reusing it unmodified
// would silently drop a legitimately-recovered line on every restore. The rule that DOES transfer: a mark line
// (`delivered`/`attempt`/`set_aside`) is safe to keep from BOTH the tombstone and a concurrently-created live file —
// duplicating a mark is harmless (sets) or correct (an attempt really happened twice); only a GROUP line must be
// deduped by identity, or its ancestors would be counted twice.
// ---------------------------------------------------------------------------
export const INFERRED_PRUNE_TTL_MS = 7 * 24 * 3600_000;
const INFERRED_TOMBSTONE = /^(.+\.inferred\.jsonl)\.expired-(\d+)$/;
const INFERRED_TOMBSTONE_GRACE_MS = 3600_000;
const INFERRED_PRUNE_MAX_FILES = 50;
function settleInferredLine(line, liveGroupIdentities) {
    const parsed = parseStoredLine(line);
    if (parsed === null)
        return null; // a torn line in a tombstone is dropped, like everywhere else here
    if (parsed.kind === "group" && liveGroupIdentities.has(identityOf(parsed.group)))
        return null; // already present live
    return line;
}
/** Merge a tombstone's lines back onto its original path, which a concurrent `appendInferred` may have recreated. */
function restoreInferred(tomb, original, raw) {
    let live = null;
    try {
        live = readFileSync(original, "utf8");
    }
    catch {
        /* nothing there */
    }
    if (live === null) {
        renameSync(tomb, original);
        return;
    }
    const liveGroups = new Set();
    for (const l of live.split("\n")) {
        if (l.trim() === "")
            continue;
        const p = parseStoredLine(l);
        if (p?.kind === "group")
            liveGroups.add(identityOf(p.group));
    }
    for (const l of raw.split("\n")) {
        if (l.trim() === "")
            continue;
        const kept = settleInferredLine(l, liveGroups);
        if (kept !== null)
            appendFileSync(original, `${kept}\n`);
    }
    rmSync(tomb, { force: true });
}
/**
 * Examine one tombstone: delete it if still expired by mtime, else restore it. Returns the GROUP lines discarded
 * (`groups`) and the ANCESTOR PAIRS they carried (`pairs` — VL, 2026-10-08, VG's silent-loss finding: the caller
 * tallies `pairs`, not `groups`, so a durable record survives the delete at the same GRANULARITY as the live
 * gauges it replaces). Marks are not counted either way: they are not themselves data loss.
 *
 * ⛔⛔ COUNTS ONLY GROUPS WITH NEITHER A `delivered` NOR A `set_aside` MARK (VL, 2026-10-08, VG's double-count
 * finding, item (a)). A group is removed from `readInferred`'s offer the moment it is delivered or set aside, but
 * its GROUP LINE stays on disk — only `finalize`'s `inferredFullyResolved`/`deleteInferredSpool` deletes the
 * whole file outright, and most sessions are never finalized. So an ordinary, successfully-delivered 40-pair
 * squash sits in a file that ages past 7 days on the COMMON path, and the old code counted its group line as a
 * fresh discard: a real server stored all 40, and a week later `status` announced 40 pairs "discarded after 7
 * days with no acknowledgement" — a false loss report for a delivery that succeeded. A set-aside group has the
 * SAME shape for a different reason: it was already tallied as `set_aside` at the moment `setAsideInferredGroup`
 * ran, so counting it again here as `pruned` would double-announce the same 40 pairs under two reasons. Only a
 * group with NEITHER mark is a genuine, newly-discovered loss — never offered, never resolved, now expired.
 */
function settleInferred(tomb, original, nowMs) {
    let raw;
    let mtimeMs;
    try {
        raw = readFileSync(tomb, "utf8");
        mtimeMs = statSync(tomb).mtimeMs;
    }
    catch {
        return { groups: 0, pairs: 0 };
    }
    if (!(nowMs - mtimeMs > INFERRED_PRUNE_TTL_MS)) {
        restoreInferred(tomb, original, raw);
        return { groups: 0, pairs: 0 };
    }
    rmSync(tomb, { force: true });
    const resolved = new Set();
    const unresolvedGroups = [];
    for (const l of raw.split("\n")) {
        if (l.trim() === "")
            continue;
        const p = parseStoredLine(l);
        if (p === null)
            continue;
        if (p.kind === "delivered" || p.kind === "set_aside")
            resolved.add(p.identity);
        else if (p.kind === "group")
            unresolvedGroups.push(p.group);
    }
    let groups = 0;
    let pairs = 0;
    for (const g of unresolvedGroups) {
        if (resolved.has(identityOf(g)))
            continue; // delivered, or already tallied as set_aside — not a new loss
        groups += 1;
        pairs += g.ancestors.length;
    }
    return { groups, pairs };
}
/**
 * Prune `.inferred.jsonl` files whose mtime is more than 7 days old — the file as a whole, by the SAME rename
 * -then-settle discipline as `pruneOrphanPending` (see that function's header for the race it narrows). Called from
 * the Stop/SessionEnd hooks only, alongside `pruneOrphanPending`, never from `post-commit` or `status`.
 *
 * ⛔⛔ `pairs` is new (VL, 2026-10-08, VG's silent-loss finding): the CALLER must feed it to
 * `recordInferredSkipped(..., "pruned", ..., pairs)` so a discard still shows up in `status` after this function's
 * own rename-then-delete removes the file the live gauges read. `lines` (group count) is kept as `pruneExpiredInferred`
 * already returned it and an existing test pins that shape; `pairs` is the one the tally wants.
 */
export function pruneExpiredInferred(home, repoKey, nowMs) {
    let files = 0;
    let lines = 0;
    let pairs = 0;
    try {
        const dir = repoSessionsDir(home, repoKey);
        if (dir === null)
            return { files, lines, pairs };
        const entries = readdirSync(dir).sort();
        let budget = INFERRED_PRUNE_MAX_FILES;
        for (const entry of entries) {
            if (budget <= 0)
                break;
            try {
                const t = INFERRED_TOMBSTONE.exec(entry);
                if (t !== null) {
                    if (nowMs - Number(t[2]) <= INFERRED_TOMBSTONE_GRACE_MS)
                        continue;
                    budget -= 1;
                    const n = settleInferred(join(dir, entry), join(dir, t[1]), nowMs);
                    if (n.groups > 0) {
                        files += 1;
                        lines += n.groups;
                        pairs += n.pairs;
                    }
                    continue;
                }
                if (!entry.endsWith(".inferred.jsonl"))
                    continue;
                const path = join(dir, entry);
                const mtimeMs = statSync(path).mtimeMs;
                if (!(nowMs - mtimeMs > INFERRED_PRUNE_TTL_MS))
                    continue;
                budget -= 1;
                const tomb = `${path}.expired-${nowMs}`;
                renameSync(path, tomb);
                const n = settleInferred(tomb, path, nowMs);
                if (n.groups > 0) {
                    files += 1;
                    lines += n.groups;
                    pairs += n.pairs;
                }
            }
            catch {
                /* one unreadable entry must not stop the pass */
            }
        }
    }
    catch {
        /* never throw from a hook */
    }
    return { files, lines, pairs };
}
// ---------------------------------------------------------------------------
// ⭐ TODOS[169] — the DANGLING INTERMEDIATE of an interactive-rebase squash.
//
// A 3 → 1 `rebase -i` squash fires `post-commit` for an intermediate `I1` (git builds it as
// "# This is a combination of 2 commits" and then amends it), so `I1` gets a `capture_commits`
// row. It fires `post-rewrite` as `amend` twice — `A→I1`, `I1→F` — which this package
// SUPPRESSED (see `hooks/post_rewrite.ts`), and then as `rebase` once, carrying only
// original→final. So `I1` has a capture row and NO successor row, and `blame_commit` on it
// answers `turns` + `superseded_by: []` — "untouched" — about a commit that was never on any
// branch. MEASURED on a real stack, capture 0.3.0 (`8e64faa9`).
//
// The cure uses git's OWN mapping, so every row stays `exact`: remember the suppressed `amend`
// pairs in a per-repo scratch file, and at the final `rebase` fire collapse each chain to
// `I → F` — for the shas `post-commit` OBSERVED and no others, because an intermediate nobody
// observed has no capture row to explain and naming it would only add noise. The scratch lives
// beside the spools (never ending in `.json`: `liveSessions` and `lastSendForRepo` would read it
// as session state) and is consumed by the final fire.
// ---------------------------------------------------------------------------
/** `<sessions dir>/rebase-amends.jsonl` — per REPO, because a rebase has no session of its own. */
export function rebaseAmendsPath(home, repoKey) {
    const dir = repoSessionsDir(home, repoKey);
    return dir === null ? null : join(dir, "rebase-amends.jsonl");
}
/** A leftover older than this is an aborted rebase's, not this one's. */
const REBASE_AMENDS_MAX_AGE_MS = 6 * 60 * 60 * 1000;
/** Bound on the scratch: a rebase of hundreds of squashes must not grow a file forever. */
const REBASE_AMENDS_MAX_LINES = 256;
/** Remember `amend` pairs seen DURING a rebase. Never throws: this runs inside the user's `git rebase`. */
export function recordRebaseAmends(home, repoKey, pairs, nowMs = Date.now()) {
    const path = rebaseAmendsPath(home, repoKey);
    if (path === null || pairs.length === 0)
        return;
    try {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        let kept = [];
        try {
            kept = readFileSync(path, "utf8").split("\n").filter((l) => l.trim() !== "");
        }
        catch {
            /* no scratch yet */
        }
        for (const pair of pairs)
            kept.push(JSON.stringify({ ancestor: pair.ancestor, successor: pair.successor, at: nowMs }));
        writeFileSync(path, kept.slice(-REBASE_AMENDS_MAX_LINES).map((l) => `${l}\n`).join(""), { mode: 0o600 });
        chmodSync(path, 0o600);
    }
    catch {
        /* the scratch is an optimisation of the record, never a reason to disturb a rebase */
    }
}
/** Read the scratch and DELETE it. Entries older than six hours are an aborted rebase's and are ignored. */
export function takeRebaseAmends(home, repoKey, nowMs = Date.now()) {
    const path = rebaseAmendsPath(home, repoKey);
    if (path === null)
        return [];
    let raw;
    try {
        raw = readFileSync(path, "utf8");
    }
    catch {
        return [];
    }
    try {
        rmSync(path, { force: true });
    }
    catch {
        /* an undeletable scratch is re-read next time; the terminal-in-finals rule still guards it */
    }
    const out = [];
    for (const line of raw.split("\n")) {
        if (line.trim() === "")
            continue;
        try {
            const o = JSON.parse(line);
            if (typeof o.ancestor !== "string" || typeof o.successor !== "string")
                continue;
            if (!isFullSha(o.ancestor) || !isFullSha(o.successor))
                continue;
            if (typeof o.at === "number" && nowMs - o.at > REBASE_AMENDS_MAX_AGE_MS)
                continue;
            out.push({ ancestor: o.ancestor, successor: o.successor });
        }
        catch {
            /* a torn line costs that line only */
        }
    }
    return out;
}
/**
 * Collapse the suppressed `amend` chains into `intermediate → final` pairs.
 *
 * Follow each `amend` pair to its chain's TERMINAL. Emit `x → terminal` only when:
 *   - the terminal is a SUCCESSOR in this rebase's own pairs (so a chain left by an ABORTED rebase
 *     cannot attach to an unrelated one — its terminal is not a final here);
 *   - `x` was OBSERVED by `post-commit` (it has, or is about to have, a capture row to explain);
 *   - `x` is not already an ancestor in the rebase's own pairs and is not the terminal itself.
 * Pure, cycle-safe, and total: it returns `[]` rather than ever throwing.
 */
export function collapseObservedIntermediates(amends, finals, observedShas) {
    const next = new Map();
    for (const a of amends)
        next.set(a.ancestor, a.successor);
    const finalSuccessors = new Set(finals.map((p) => p.successor));
    const finalAncestors = new Set(finals.map((p) => p.ancestor));
    const out = [];
    const emitted = new Set();
    for (const start of next.keys()) {
        let node = start;
        const seen = new Set([node]);
        let cyclic = false;
        for (;;) {
            const to = next.get(node);
            if (to === undefined)
                break;
            if (seen.has(to)) {
                cyclic = true;
                break;
            }
            seen.add(to);
            node = to;
        }
        if (cyclic)
            continue;
        const terminal = node;
        if (!finalSuccessors.has(terminal))
            continue;
        // Every node on the chain except the terminal is a candidate; the chain is walked again from `start` only.
        if (start === terminal || finalAncestors.has(start) || !observedShas.has(start))
            continue;
        const key = `${start}:${terminal}`;
        if (emitted.has(key))
            continue;
        emitted.add(key);
        out.push({ ancestor: start, successor: terminal });
    }
    return out;
}
/** The wire spelling of one pair. Also the dedup key. */
function wirePair(pair) {
    return `${pair.ancestor}:${pair.successor}`;
}
function parsePair(line) {
    let parsed;
    try {
        parsed = JSON.parse(line);
    }
    catch {
        return null;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
        return null;
    const o = parsed;
    const { ancestor, successor } = o;
    // ⛔ Re-validated on the way OUT as well as in. A spool file is on disk and
    // outlives the process that wrote it, so what comes back is input.
    if (!isFullSha(ancestor) || !isFullSha(successor))
        return null;
    // ⚠ A self-pair is dropped by the server anyway; dropping it here keeps a
    // no-op from occupying one of the 16 slots a real pair needs.
    if (ancestor === successor)
        return null;
    return { ancestor, successor };
}
/** Full width, both widths git uses. ⛔ Never abbreviated. */
export function isFullSha(value) {
    return typeof value === "string" && /^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(value);
}
function parseEntry(line) {
    let parsed;
    try {
        parsed = JSON.parse(line);
    }
    catch {
        return null;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
        return null;
    const o = parsed;
    const sha = o.sha;
    // ⛔ The width check lives here as well as at the boundary: a spool file is
    // on disk and outlives the process that wrote it, so what comes back out is
    // input, not something we already validated.
    if (!isFullSha(sha))
        return null;
    const at = typeof o.at === "string" ? o.at : "";
    const branch = typeof o.branch === "string" && o.branch !== "" ? o.branch : null;
    const files = Array.isArray(o.files) ? o.files.filter((f) => typeof f === "string") : [];
    const observedAt = typeof o.observedAt === "number" && Number.isFinite(o.observedAt) && o.observedAt > 0 ? o.observedAt : undefined;
    return { sha, branch, at, files, attribution: parseRung(o.attribution), ...(observedAt === undefined ? {} : { observedAt }) };
}
/**
 * ⛔ **AN UNLABELLED LINE IS `recency_heuristic`, AND THAT IS NOT A DEFAULT — IT
 * IS THE CORRECT NAME FOR HOW IT WAS PRODUCED.**
 *
 * A spool file outlives the process that wrote it and survives an upgrade, so a
 * line written by a PRE-LADDER client is ordinary input here. That client picked
 * its session by mtime recency, with no corroboration and no way to tell one
 * candidate from two. Naming it anything else would upgrade a guess to an
 * observation on the strength of a version number.
 *
 * ⚠ **This is `D190 §2`'s NO RUNG, NO EDGE, on the client side.** The server
 * refuses to write an edge for a commit that arrives without a rung, for exactly
 * this reason; here the same commit is refused a place on `x-commits` before it
 * is ever sent. Both directions of the seam agree, independently.
 */
function parseRung(value) {
    switch (value) {
        case "env_session_id":
        case "sole_live_session":
        case "env_session_unmatched":
            return value;
        default:
            // ⛔ INCLUDING an unlabelled line and a rung outside the vocabulary. A
            // near-miss spelling is NOT admitted: the server skips an unknown rung
            // silently, which is a zero with no error, so it is resolved here to the
            // value that says *we do not know*.
            return "recency_heuristic";
    }
}
// ---------------------------------------------------------------------------
// ⛔ THE PENDING SIDECAR — `CR-195`/D208.
//
// A THIRD file beside `.spool.jsonl` and `.rewrites.jsonl`, for the same reason
// the second one exists: the two are read by different code at different times,
// and a discriminator inside one file would make a torn line of one kind cost
// the other kind too.
//
// ⛔ **WHY NOT JUST LEAVE THE LINE IN `.spool.jsonl`.** `capSpool` returns
// `count: taken.length` — every line taken, wire-eligible or not — and
// `dropSpooled` truncates by that count on the 2xx, so a non-wire line is
// DISCARDED by the next successful post (`spool.ts`'s own note: *"A held entry
// IS dropped on the 2xx, and the observation is lost"*). An uncorroborated line
// left there would be destroyed by the very post that could not carry it, and
// "binds when a state file appears" could never happen.
//
// ⚠ And the truncation rule it would have to change is load-bearing: `count`
// rather than `shas.length` exists precisely so a retained line at the head
// cannot shift every subsequent index and re-send a delivered commit forever.
// A separate file gives this rung different retention while leaving that
// invariant byte-untouched.
//
// ⚠ `.pending.jsonl` — like its two siblings it must NOT end in `.json`, or
// `lastSendForRepo` parses it as session state and `liveSessions` counts it as a
// live session, which would make an uncorroborated commit corroborate itself.
// ---------------------------------------------------------------------------
/**
 * How many uncorroborated commits one session may hold.
 *
 * ⛔ **ITS OWN CONSTANT** — the house rule `MAX_SPOOLED_PAIRS` states: sharing a
 * bound across two files with different units makes one of them wrong. This one
 * is not a header budget at all, because nothing here reaches a header; it is a
 * bound on how much unpromotable observation may accumulate before the oldest is
 * dropped. Sized under `MAX_SPOOLED_SHAS` deliberately: a session that made 32
 * commits before its first `Stop` is not a session, and the failure direction of
 * being too small is a MISSED commit, which the module's own asymmetry prefers
 * to a wrong one.
 */
export const MAX_PENDING_SHAS = 16;
/** `<repo>/<session>.pending.jsonl`, beside the commit spool. */
export function pendingSpoolPath(home, key) {
    const state = sessionStatePath(home, key);
    if (state === null)
        return null;
    return state.replace(/\.json$/, ".pending.jsonl");
}
/**
 * Record an uncorroborated observation. Returns whether it was written.
 *
 * ⚠ Deduped on sha, like `appendRewrites`: `post-commit` can fire twice for one
 * commit (a manual invocation beside the real hook), and two lines for one sha
 * would promote into two spool entries and two permanent rows —
 * `capture_commits`' PK is `(org_id, capture_id, commit_sha)`, so two capture
 * ids are two legal rows for one commit.
 */
export function appendPending(home, key, entry) {
    const path = pendingSpoolPath(home, key);
    if (path === null)
        return false;
    try {
        const existing = readPending(home, key);
        if (existing.some((e) => e.sha === entry.sha))
            return false;
        const kept = [...existing, entry].slice(-MAX_PENDING_SHAS);
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        writeFileSync(path, kept.map((e) => `${JSON.stringify(e)}\n`).join(""), { mode: 0o600 });
        chmodSync(path, 0o600);
        return true;
    }
    catch {
        return false;
    }
}
/** Every uncorroborated entry for this session, oldest first. */
export function readPending(home, key) {
    const path = pendingSpoolPath(home, key);
    if (path === null)
        return [];
    let raw;
    try {
        raw = readFileSync(path, "utf8");
    }
    catch {
        return [];
    }
    const out = [];
    for (const line of raw.split("\n")) {
        const entry = parseEntry(line);
        if (entry !== null)
            out.push(entry);
    }
    return out;
}
/** Remove the pending file entirely. Used once its lines have been promoted. */
export function clearPending(home, key) {
    const path = pendingSpoolPath(home, key);
    if (path === null)
        return false;
    try {
        rmSync(path, { force: true });
        return true;
    }
    catch {
        return false;
    }
}
/**
 * ⛔ **PROMOTION — the half that makes the cold rung worth recording.**
 *
 * A pending line names the session the committing process reported. Once THAT
 * session has a state file, the environment's claim is corroborated by exactly
 * the evidence rung 1 requires, so the line is rewritten into the real spool as
 * `env_session_id` and the pending file is cleared.
 *
 * ⚠ **The corroboration is the session's OWN state file, not any state file.**
 * Promoting on "some session is live" would be `sole_live_session` wearing a
 * stronger rung's name — the environment said WHO, and the whole value of rung 1
 * over rung 2 is that it is a fact about the committing process rather than
 * about there being nobody else it could have been (D5).
 *
 * Returns how many were promoted. Safe to call when there is nothing to do.
 */
export function promotePending(home, key, 
/**
 * ⛔ **THE CORROBORATION, AND IT IS A LITERAL TYPE ON PURPOSE** — the same
 * device `TranscriptDialect.transport` uses. It cannot be satisfied by
 * accident: a caller must type the claim, and the claim is that `key.sessionId`
 * is the session whose hook is executing right now.
 *
 * ⚠ **A STATE FILE IS THE WRONG TEST AND I TRIED IT FIRST.** State files are
 * never deleted, so `existsSync` promotes months later against a session that
 * ended long ago; and gating on the 30-minute window instead FAILS THE ONLY
 * CASE THIS RUNG EXISTS FOR — on a session's first `Stop` the state file has
 * not been written yet (`deliver` saves it, after this runs), so nothing would
 * ever promote on the turn that matters. MEASURED: the cold-start commit sat
 * unpromoted with the delta carrying no commits.
 *
 * ⛔ Running the hook is STRONGER evidence than either: a state file proves a
 * session ran once, an executing hook proves it is running NOW. And it closes
 * the resurrect hazard by construction — a dead session never runs a hook, so
 * a lingering exported `CLAUDE_CODE_SESSION_ID` accumulates pending lines that
 * are never promoted and age out under `MAX_PENDING_SHAS`.
 */
corroboration, 
/**
 * ⛔ `TODOS[176]` — THE PROMOTION BOUND AND ITS PATH, BOTH REQUIRED SO A CALLER CANNOT FORGET THEM. `bound` is the start
 * of the turn this hook is delivering (`turnStart`: the first unsent PROMPT-LIKE record's timestamp); `mode` says whether the
 * session's state file already existed (`stale-own`) or not (`first-turn`). A line observed before the turn start is DROPPED;
 * when no turn start is found a stale-own line is dropped and a first-turn line kept. See `pending_bound.ts`.
 */
bound, mode) {
    void corroboration;
    const pending = readPending(home, key);
    if (pending.length === 0)
        return 0;
    let promoted = 0;
    for (const entry of pending) {
        if (!keepsPendingLine(entry, bound, mode))
            continue;
        // The pending-only observation clock stays behind: a promoted line is an ordinary spool line.
        const { observedAt: _observedAt, ...rest } = entry;
        void _observedAt;
        if (appendSpool(home, key, { ...rest, attribution: "env_session_id" }))
            promoted += 1;
    }
    clearPending(home, key);
    return promoted;
}
//# sourceMappingURL=spool.js.map