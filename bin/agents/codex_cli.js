/**
 * The `codex-cli` dialect — `CR-183`, D164.
 *
 * ⚠ **DATA, described here; the readers land in later tasks of this wave.** What
 * this entry does today is put Codex's transcript root into the confinement
 * union and give `connect` a truthful answer about having no locator. The
 * scrubber it names is `CR-185`'s, and the delegated-transcript mechanism it
 * declares has no reader at all yet (see `DelegatedTranscripts`).
 *
 * ⛔ **Every number and mechanism below is CARRIED FROM THE TASK BRIEF, not
 * measured by this task.** They are recorded as the brief stated them so a later
 * reader can check them against the product rather than against this file.
 */
import { readdirSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { CODEX_INDEX_FILE, codexHooksPath, codexIndexDir, codexTranscriptRoot, isInside, isTranscriptFile, } from "../paths.js";
import { readEntries, sessionFile } from "./session_listing.js";
/**
 * `SessionEnd` is the tight one — 3 s registered, 2.2 s client.
 *
 * That cap is why `CR-182`'s gap-stamp reserve exists at all: at 2200 ms a slow
 * send routinely consumed the whole budget and the honest hole went unrecorded,
 * which is the one outcome D56 §D8 says this client may not produce.
 */
const CODEX_SESSION_END_REGISTERED_MS = 3_000;
const CODEX_SESSION_END_CLIENT_MS = 2_200;
/** `Stop` and `PreCompact` are registered far wider — 30 s, client 8 s. */
const CODEX_TURN_REGISTERED_MS = 30_000;
const CODEX_TURN_CLIENT_MS = 8_000;
/**
 * `SessionStart` takes the turn clocks, with no fast path of its own.
 *
 * ⛔ **A logged shortcut** — gstack-shortcut(dec-e650afbf), eng review D7 · B.
 * The ceiling: a hung `SessionStart` can hold a session's start up by as long as
 * the REGISTERED timeout (30 s here). Upgrade when a measurement or a user report
 * shows session-start delay, or before slice 2's grants fetch lands in this handler.
 */
const CODEX_SESSION_START_REGISTERED_MS = CODEX_TURN_REGISTERED_MS; // gstack-shortcut(dec-e650afbf)
const CODEX_SESSION_START_CLIENT_MS = CODEX_TURN_CLIENT_MS; // gstack-shortcut(dec-e650afbf)
/**
 * ⛔ **THE FOUR COLUMNS, AND NO OTHER — `D11 · A`, Alexander's approved read.**
 *
 * The thread index also holds `first_user_message`, `title`, `preview` and more,
 * which are CONTENT. Selecting one would turn a metadata read into a transcript
 * read, so the statement names exactly these four and `test/scan-codex-index.test.ts`
 * asserts the SQL carries nothing else. ⚠ **`archived` is not here either, on
 * purpose** (VQ, 2026-10-24): an archived thread's `rollout_path` is decided by
 * the admission below, and a fifth column would change the approved read surface.
 */
export const CODEX_INDEX_COLUMNS = ["cwd", "git_origin_url", "rollout_path", "created_at"];
/** The one statement the adapter runs against a thread row. */
export const CODEX_INDEX_SQL = `SELECT ${CODEX_INDEX_COLUMNS.join(", ")} FROM threads`;
/** How long a locked index is waited for before the adapter gives up (eng review D2). */
const CODEX_BUSY_TIMEOUT_MS = 1_000;
/**
 * `node:sqlite`, loaded here and nowhere else, with ITS warning and only its
 * warning dropped — eng review D2 · A.
 *
 * Node 22 prints `ExperimentalWarning: SQLite is an experimental feature…` to
 * stderr the first time the module loads, which would land mid-screen in the
 * picker and breaks DESIGN.md §13's output rules. `process.emitWarning` is
 * wrapped for the duration of the one `require` and restored in a `finally`;
 * any OTHER warning, in that window or after it, still prints. Measured on
 * node 22.17.0.
 *
 * ⚠ **A `require` and not a dynamic `import()`**, so the whole adapter stays
 * synchronous like every other lister (`scan` is a chain of `execFileSync`
 * anyway) and the wrapped window is exactly the load, not a promise turn that
 * something else could emit a warning inside. Lazy: a machine with no Codex
 * never loads the module at all.
 */
function loadSqlite() {
    const original = process.emitWarning;
    process.emitWarning = ((warning, ...rest) => {
        const type = typeof warning === "string" ? rest[0] : warning.name;
        const message = typeof warning === "string" ? warning : warning.message;
        if (type === "ExperimentalWarning" && message.startsWith("SQLite"))
            return;
        return original.call(process, warning, ...rest);
    });
    try {
        return createRequire(import.meta.url)("node:sqlite");
    }
    finally {
        process.emitWarning = original;
    }
}
/** Does the `threads` table carry all four columns? A bare name test, nothing deeper. */
function hasIndexColumns(db) {
    const present = new Set(db.prepare("PRAGMA table_info(threads)").all().map((c) => String(c.name)));
    return CODEX_INDEX_COLUMNS.every((column) => present.has(column));
}
/** A locked database is a different line from an unrecognised one. */
function readFailure(err) {
    return /locked|busy/i.test(err instanceof Error ? err.message : "")
        ? "index locked"
        : "unreadable";
}
/**
 * Rollout files under `sessions/` that NO index row names — counted, never opened.
 *
 * Open Question 6's text, as VQ ruled (PR 1 ruling 5c): an index which cannot see a
 * session is a thing to REPORT, not to guess about. The walk lists directory entries — names
 * and file types, nothing else — and counts each regular `.jsonl`; a symlink is
 * not a file here (`Dirent.isFile` is false for it).
 *
 * Compared as REALPATHS on both sides, because the index stores the path Codex
 * wrote and the walk builds its own from `home`; a symlinked home would otherwise
 * make every rollout look unindexed. A row whose rollout has gone cannot be
 * resolved and names nothing, which is correct: it is not on disk to be matched.
 */
function countUnindexed(root, rolloutPaths) {
    const named = new Set();
    for (const path of rolloutPaths) {
        try {
            named.add(realpathSync(path));
        }
        catch {
            // Gone from disk: it names no file that the walk could find.
        }
    }
    let base;
    try {
        base = realpathSync(root);
    }
    catch {
        return 0;
    }
    let count = 0;
    const visit = (dir) => {
        let entries;
        try {
            entries = readEntries(dir);
        }
        catch {
            return;
        }
        for (const entry of entries ?? []) {
            const path = join(dir, entry.name);
            if (entry.isDirectory())
                visit(path);
            else if (entry.isFile() && entry.name.endsWith(".jsonl") && !named.has(path))
                count += 1;
        }
    };
    visit(base);
    return count;
}
/**
 * Codex's sessions, from its thread index — `D11 · A`, eng review D2, `scan`.
 *
 * Codex keeps rollouts DATE-keyed (`sessions/YYYY/MM/DD/`), so a folder walk
 * cannot say which repo one belongs to; its `threads` table can, because it
 * records the real `cwd`. That row is the whole reason this adapter exists and
 * the reason a Codex row is never ambiguous.
 *
 * ## ⛔ What is read, and how
 *
 *   - **exactly `state_5.sqlite`**, and any other `state_N` is `unrecognised
 *     index` (Open Question 6; see `codexIndexDir`).
 *   - **`readOnly`, never `immutable`.** Codex keeps everything since its last
 *     checkpoint in the `-wal` file (on the author's machine, every thread since
 *     Sep 30), and an `immutable` open ignores it.
 *   - **the four columns only** (`CODEX_INDEX_SQL`), after a `PRAGMA table_info`
 *     check, and a 1000 ms busy timeout. Any failure is this agent's
 *     `unreadable` answer, so the other two agents' rows are untouched.
 *
 * ## ⛔ The rollout file is `lstat`ed, never opened
 *
 * A row is admitted only if its `rollout_path` lies under the sessions root and
 * is a regular file there. That is also what decides an ARCHIVED thread, whose
 * rollout is not under `sessions/`. The row's `git_origin_url` is carried but is
 * not the slug source: the scan names a repo from the CLONE (`resolveRepoSlug`),
 * so there is one normalisation and not two.
 */
function codexSessionSource(home, env) {
    const dir = codexIndexDir(home, env);
    const file = join(dir, CODEX_INDEX_FILE);
    let present;
    try {
        present = readdirSync(dir);
    }
    catch (err) {
        const code = err.code;
        return code === "ENOENT" || code === "ENOTDIR"
            ? { kind: "rows", rows: [], unindexed: 0 }
            : { kind: "unreadable", reason: "unreadable" };
    }
    if (!present.includes(CODEX_INDEX_FILE)) {
        // A Codex that keeps its index under another generation's name is a store
        // this client was not checked against. One with no index at all has simply
        // never recorded a thread — and its rollouts, if any, are all unindexed.
        return present.some((name) => /^state_\d+\.sqlite$/.test(name))
            ? { kind: "unreadable", reason: "unrecognised index" }
            : { kind: "rows", rows: [], unindexed: countUnindexed(codexTranscriptRoot(home, env), []) };
    }
    let sqlite;
    try {
        sqlite = loadSqlite();
    }
    catch {
        return { kind: "unreadable", reason: "unreadable" };
    }
    let db = null;
    try {
        // ⚠ `readOnly` stops THIS CODE writing the index and does not stop SQLite creating its own
        // `-wal`/`-shm` files beside it, which any reader of a WAL database whose writer has closed does
        // (measured by VQ on node 22.17, PR 1 F1). Nothing is written to `state_5.sqlite` itself.
        db = new sqlite.DatabaseSync(file, { readOnly: true });
        db.exec(`PRAGMA busy_timeout = ${CODEX_BUSY_TIMEOUT_MS}`);
        if (!hasIndexColumns(db))
            return { kind: "unreadable", reason: "unrecognised index" };
        const root = codexTranscriptRoot(home, env);
        const rows = [];
        const named = [];
        for (const row of db.prepare(CODEX_INDEX_SQL).all()) {
            const { cwd, git_origin_url: origin, rollout_path: rollout, created_at: created } = row;
            if (typeof cwd !== "string" || typeof rollout !== "string")
                continue;
            // Every path an index row names counts as INDEXED, admitted or not: an archived thread's rollout
            // is not "missing from the index", it is simply not capturable (`D11 · A`).
            named.push(rollout);
            if (!isInside(root, rollout) || !isTranscriptFile(root, rollout))
                continue;
            const session = sessionFile(rollout);
            if (session === null)
                continue;
            rows.push({
                cwd,
                origin: typeof origin === "string" ? origin : null,
                // `created_at` is whole SECONDS (measured), the rest of this client's
                // times are milliseconds.
                session: typeof created === "number" ? { ...session, startedMs: created * 1000 } : session,
            });
        }
        return { kind: "rows", rows, unindexed: countUnindexed(root, named) };
    }
    catch (err) {
        return { kind: "unreadable", reason: readFailure(err) };
    }
    finally {
        try {
            db?.close();
        }
        catch {
            // Closing a read-only handle that failed to open is not a second finding.
        }
    }
}
export const CODEX_CLI = {
    id: "codex-cli",
    transport: "ndjson",
    transcriptRoot: codexTranscriptRoot,
    // ⛔ `CR-193`, D177 §2 — the lane's `.jsonl` gate. `~/.codex/sessions` is
    // date-nested rollout transcripts and nothing else, so there is no interior
    // shape to require here either. ⚠ CARRIED FROM THE BRIEF like the numbers
    // above: this task did not re-walk a Codex tree to confirm it.
    admitsFile: isTranscriptFile,
    // ⛔ **IDENTITY — MEASURED, and it is the one member on this dialect that is
    // no longer carried from the brief** (`CR-195`, D205). Read out of the native
    // binary's embedded JSON schema, where every `hook_event_name` is a `const`:
    // `PermissionRequest PostCompact PostToolUse PreCompact PreToolUse SessionEnd
    // SessionStart Stop SubagentStart SubagentStop UserPromptSubmit`. All three of
    // ours are present and spelled exactly as Claude Code spells them.
    //
    // ⚠ **The binary ALSO carries a snake_case enum** (`session_end`,
    // `pre_compact`, …) beside a TOML-serialisation error string, and taking it
    // for the config vocabulary was the near-miss of this unit. A differential run
    // against three throwaway `CODEX_HOME`s settled it: `SessionEnd` is recognised
    // and says so by clamping, while `session_end` and a bogus key produce NO
    // diagnostic — a file that parses, registers nothing, and reports success.
    // `SessionStart` is in that schema list too, spelled the same way, and MEASURED
    // live (Open Question 1, Codex 0.148.0): it fires before the first prompt — in
    // the TUI lazily, when the first prompt is submitted — and accepts a
    // `systemMessage`. ⚠ Those runs were under cmux's `--dangerously-bypass-hook-trust`;
    // stock Codex >= 0.131.0 runs a user-level hook only after the user trusts it.
    eventNames: {
        Stop: "Stop",
        PreCompact: "PreCompact",
        SessionEnd: "SessionEnd",
        SessionStart: "SessionStart",
    },
    // ⛔ `~/.codex/hooks.json`, honouring `CODEX_HOME` — MEASURED, since every
    // probe in this unit drove a real `codex` through a throwaway `CODEX_HOME`
    // and it read the `hooks.json` there. The NESTED shape, also measured: a
    // document in this form was parsed, its event recognised and its timeout
    // clamped, which Codex can only do having read the inner entry.
    hookConfig: { path: codexHooksPath, shape: "claude" },
    events: {
        Stop: {
            registeredTimeoutMs: CODEX_TURN_REGISTERED_MS,
            clientBudgetMs: CODEX_TURN_CLIENT_MS,
        },
        PreCompact: {
            registeredTimeoutMs: CODEX_TURN_REGISTERED_MS,
            clientBudgetMs: CODEX_TURN_CLIENT_MS,
        },
        SessionEnd: {
            registeredTimeoutMs: CODEX_SESSION_END_REGISTERED_MS,
            clientBudgetMs: CODEX_SESSION_END_CLIENT_MS,
        },
        SessionStart: {
            registeredTimeoutMs: CODEX_SESSION_START_REGISTERED_MS,
            clientBudgetMs: CODEX_SESSION_START_CLIENT_MS,
        },
    },
    // The delegated path ARRIVES on stdin as `agent_transcript_path` — there is no
    // directory to glob. Nothing parses it yet; the discriminator is here so the
    // Claude glob cannot run against a layout that has no `subagents/`.
    delegatedTranscripts: "announce",
    redaction: "codex-cli",
    // ⛔ **UNMEASURED.** `null` here does NOT mean "Codex CLI has no session id in
    // its environment" — it means nobody has run the measurement `M1` ran for
    // Claude Code (agent commit, human commit, worktree commit) against Codex, so
    // this client has no variable it can honestly name. ⚠ Read it as the absence
    // of a measurement, not as a fact about the agent. Measuring it is a change to
    // this line and nothing else.
    sessionIdFromEnv: () => null,
    sessionSource: codexSessionSource,
    // ⛔ NO `locateCurrentTranscript`, and the omission is the decision. Finding
    // the repository would mean reading a `cwd` out of the transcript's own
    // records — ANALYSIS, which D60 §D6 forbids this client. `connect` therefore
    // skips the test-capture beat rather than guessing.
};
//# sourceMappingURL=codex_cli.js.map