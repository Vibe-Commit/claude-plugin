/**
 * The `~/.vibecommit/` layout.
 *
 * One module so the fifteen tasks that build on this one do not each invent a
 * path. Every function takes `home` explicitly rather than calling `os.homedir()`
 * internally — the contract test runs the real binary against a temp HOME, and a
 * module that reads the real one cannot be tested without touching the
 * developer's own credentials.
 *
 * `CR-017d` added the repo to the binding key and hangs per-repo send state off
 * `stateDir` — see `sessionStatePath` and `SessionKey` below.
 *
 * @provenance vibecommit-schema 20260809150000_cr017a_repo_binding_key.sql — PK shape, mirrored
 * @provenance vibecommit-schema ingest_sessions.file_key — CHECK bound 1..128, retyped
 */
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { join, sep } from "node:path";
/** Root of the client's own state. Never Claude Code's — see the plan's keychain note. */
export function rootDir(home) {
    return join(home, ".vibecommit");
}
/** The ingest credential envelope. Mode 0600, enforced on read (`credential.ts`). */
export function credentialsPath(home) {
    return join(rootDir(home), "credentials.json");
}
/** The per-project consent allow list. Consulted BEFORE any transcript read (D56 §D19). */
export function projectsPath(home) {
    return join(rootDir(home), "projects.json");
}
/**
 * The HUMAN lane's signed-in session — `CR-084d`. Mode 0600, enforced on read by
 * the same `readSecretFile` the ingest credential goes through.
 *
 * A SECOND FILE and not a second field in `credentials.json`, deliberately. The
 * two hold different privilege classes on different lanes: `credentials.json`
 * holds the machine's opaque ingest credential and is read by every hook, and
 * this holds a user-principal refresh token read only by interactive verbs. One
 * file would mean the hook path opens the more powerful secret on every turn for
 * no reason, and `VIBECOMMIT_TOKEN` (which overrides the ingest credential and
 * nothing else) would acquire a meaning it does not have.
 */
export function sessionPath(home) {
    return join(rootDir(home), "session.json");
}
/**
 * Client state. `CR-023`'s capture-confirmed key lives here under `(repo, day)`;
 * the three negative `systemMessage` states use a per-session file.
 */
export function stateDir(home) {
    return join(rootDir(home), "state");
}
/**
 * Once-per-session marker for a `systemMessage` state.
 *
 * Keyed on `(session, state)` and NOT on the transcript file: `ER23` keys client
 * state per file, which would fire the same message once for `main` and once for
 * every `subagents/agent-*.jsonl` in the same session.
 */
export function sessionNoticePath(home, sessionId, state) {
    return join(stateDir(home), "notices", sanitise(sessionId), `${sanitise(state)}.json`);
}
/**
 * Once-per-`(repo, day)` marker for the capture-confirmed notice — `CR-023d`.
 *
 * **The key is neither the session nor "ever", and both alternatives are wrong
 * in a way you can feel.** `PreCompact` mints a fresh `session_id` mid-task, so
 * a per-session key fires the one positive message twice in an afternoon and
 * reads as a bug. A key with no day component fires it exactly once ever, which
 * under-communicates on a tool used daily — and this is the single positive beat
 * in a channel that is otherwise silent by design (style guide §10.1).
 *
 * A per-FILE key would be wrong too, once `CR-124` (W6) starts producing
 * `agent-*` file keys: it would fire once for `main` and once per sub-agent
 * transcript in the same session. The key is deliberately chosen so that landing
 * `CR-124` cannot change how often this message appears.
 *
 * `repo-day/` namespaces this away from `sessionNoticePath`'s
 * `notices/<session>/<state>.json`: the two live at different depths under
 * `notices/`, so no session id can ever resolve onto a repo-day file.
 *
 * The repo is the same SHA-256 digest `sessionStatePath` uses, for the same
 * reason — `sanitise` truncates at 128 characters, so two deep checkouts sharing
 * a prefix would land on one key and the second repo would never see its
 * confirmation. `day` is supplied by the caller as a UTC `YYYY-MM-DD`
 * (`system_message.ts`'s `utcDay`), never read from a local clock here.
 */
export function repoDayNoticePath(home, repoKey, day, state) {
    return join(stateDir(home), "notices", "repo-day", repoDigest(repoKey), sanitise(day), `${sanitise(state)}.json`);
}
/**
 * Per-`(repo, session)` send state — `CR-018`'s offset ledger, backlog and
 * terminal stop, keyed by `CR-017d`.
 *
 * **Returns null when there is no repo identity, and that is the fix.** D58: *"The
 * server key gains repo; the client offset state did not, so a `prefix_sha256`
 * resync would duplicate repo 1's turns into repo 2."* Keyed on the session alone
 * this file was machine-wide, so one Claude Code session whose `cwd` moved between
 * two repos read and wrote the same offsets for both. A caller with no repo must
 * therefore get NO path at all rather than a shared bucket — a placeholder key is
 * the bleed with an extra step (D72's "required from day one", mirrored).
 *
 * The repo is a SHA-256 digest and not the sanitised path: `sanitise` truncates at
 * 128 characters, and two work trees sharing a long prefix would land in one
 * directory — a silent collision at exactly the boundary being defended.
 *
 * Still one file per session rather than one per `(session, file)`, because `seq`
 * is monotonic per SESSION across the main transcript and every sub-agent's, so
 * splitting the store would split the counter that has to stay single.
 */
export function sessionStatePath(home, key) {
    const dir = repoSessionsDir(home, key.repoKey);
    if (dir === null)
        return null;
    return join(dir, `${sanitise(key.sessionId)}.json`);
}
/**
 * Every session file for ONE repo — the directory `sessionStatePath` writes into.
 *
 * `status` needs this and a hook does not: a hook is handed a `session_id` on
 * stdin, but `vibecommit status` is interactive and has none, so the only way it
 * can answer "when did this repo last send?" is to look at every session under
 * the repo (`CR-021`). Exposed rather than duplicated so there is still exactly
 * one place that knows the layout, and the digest stays private.
 *
 * Null on no repo, for the same reason `sessionStatePath` is: there is no
 * repo-less bucket, and a caller with no repo has nothing to scan.
 */
export function repoSessionsDir(home, repoKey) {
    if (repoKey === "")
        return null;
    return join(stateDir(home), "sessions", repoDigest(repoKey));
}
/** A fixed-length, collision-free filename component for a work-tree path. */
function repoDigest(repoKey) {
    return createHash("sha256").update(repoKey).digest("hex").slice(0, 32);
}
/**
 * Where Claude Code writes transcripts.
 *
 * `CLAUDE_CONFIG_DIR` is honoured because Claude Code honours it; hard-coding
 * `~/.claude` would silently capture nothing for anyone who relocated it.
 */
export function transcriptRoot(home, env) {
    const configured = env.CLAUDE_CONFIG_DIR;
    const root = configured !== undefined && configured.trim() !== ""
        ? configured.trim()
        : join(home, ".claude");
    return join(root, "projects");
}
/**
 * Where Codex CLI writes transcripts — `CR-183`, D164.
 *
 * BESIDE `transcriptRoot` rather than inside it, because the two roots are two
 * facts about two products: `CODEX_HOME ?? ~/.codex` plus `sessions`, against
 * `CLAUDE_CONFIG_DIR ?? ~/.claude` plus `projects`. Folding them into one
 * function taking a discriminant would make the union below read as a branch on
 * a flag rather than as an enumeration of the registry, which is the property
 * the confinement check depends on.
 *
 * ⚠ **The env var is honoured on the same evidence the Claude one is: because
 * the product honours it.** Hard-coding `~/.codex` would silently capture
 * nothing for anyone who relocated it.
 */
export function codexTranscriptRoot(home, env) {
    const configured = env.CODEX_HOME;
    const root = configured !== undefined && configured.trim() !== ""
        ? configured.trim()
        : join(home, ".codex");
    return join(root, "sessions");
}
/**
 * Where Cursor writes transcripts — `CR-193`, D177 §2.
 *
 * ⛔ **`projects`, and NOT the `agent-transcripts` directory D177 §2 names —
 * because that root IS NOT EXPRESSIBLE HERE, and the reason is measured rather
 * than argued.**
 *
 * One conversation's transcript lives at
 * `~/.cursor/projects/<munged>/agent-transcripts/<cid>/<cid>.jsonl`, where
 * `<munged>` is the WORKSPACE fsPath with every non-alphanumeric run collapsed
 * to `-`. A `transcriptRoot` member is handed `home` and `env` and nothing else,
 * and `<munged>` is derivable from neither: this machine already carries two of
 * them, `Users-acohan-Documents-VibeCommit` and `empty-window`.
 *
 * ⚠ **And the obvious rescue — derive it from the consented project key — is
 * measured WRONG, not merely awkward.** `resolveProjectKey` is
 * `git rev-parse --show-toplevel`, and the workspace that produced the D177 §10
 * corpus, `/Users/acohan/Documents/VibeCommit`, is **not a git repository at
 * all**. The repository that IS one sits a directory below it, so its project
 * key munges to that workspace's name with the child directory appended — a
 * name with no directory under `projects/` — and a project-key-derived root
 * would refuse the one real transcript there is.
 *
 * ⇒ ⛔ **The interior shape is enforced by `isCursorTranscript` instead**, which
 * runs AFTER the registry-computed boundary and can only refuse. Read that
 * function's docblock for what this changes about D177 §2's stated reason: it
 * inverts it.
 *
 * ⚠ **No environment override, and that is an absence rather than an
 * oversight.** `CLAUDE_CONFIG_DIR` and `CODEX_HOME` are honoured because those
 * products honour them. No Cursor equivalent has been measured, and inventing
 * one would be a configuration surface this client reads and nothing writes.
 */
export function cursorTranscriptRoot(home) {
    return join(home, ".cursor", "projects");
}
/**
 * The one child of a Cursor workspace directory that holds transcripts.
 *
 * Its three measured siblings are `agent-tools/` (scraped web content),
 * `canvases/` (a React/TypeScript scratch project, `node_modules` and all) and
 * `mcps/` (per-server tool schemas). D177 §2.
 */
const CURSOR_TRANSCRIPTS_DIR = "agent-transcripts";
/**
 * ⛔ **THE `.jsonl` GATE — `CR-193`, D177 §2**, which supersedes `CR-183`'s
 * exclusion of `transcriptExtension`.
 *
 * The lane's file gate: `transport: "ndjson"` says every member appends NDJSON
 * to a file, and `.jsonl` is what that file is called. Confinement answers
 * *"may this path be read at all"*; this answers *"is this a transcript"*, and
 * the two are different questions — a root can be exactly right and still
 * contain files that are not transcripts.
 *
 * ⚠ **`root` is unused HERE and is a parameter of the member, because Cursor's
 * answer needs it.** Under Claude's and Codex's roots every file is a
 * transcript, so the suffix is the whole test; under Cursor's it is not.
 *
 * ⚠ **No `realpath`, deliberately, and only here.** A symlink whose name ends
 * `.jsonl` and whose target does not is a real shape, and `isCursorTranscript`
 * resolves for exactly that reason — but under these two roots there is nothing
 * to point at: every file under them is a transcript already. Paying two
 * syscalls per hook to defend a set with no members is the cost this note exists
 * to decline.
 */
export function isTranscriptFile(_root, path) {
    return path.endsWith(TRANSCRIPT_SUFFIX);
}
/**
 * The lane's gate PLUS the interior shape Cursor's root cannot declare —
 * `CR-193`, D177 §2.
 *
 * ⛔ **AND THIS IS WHERE D177 §2's STATED REASON INVERTS. Say it in these
 * words, because the polarity is the whole point.** §2 records that the ROOT is
 * what excludes the 32 KB scraped-web-content `.txt`, and that the gate
 * therefore ships as fail-closed defence with **no corpus witness** —
 * `agent-tools/` being a SIBLING of `agent-transcripts/`. That is true of the
 * root §2 names. It is **false of the root that is expressible** (see
 * `cursorTranscriptRoot`): rooted at `projects`, `find -type f` returns **113
 * files, exactly 1 of them the transcript** — 66 `.json`, 34 `.ts`, 8 `.md`,
 * 3 extensionless, 1 `.txt`. ⇒ ⛔ **the gate has 112 corpus witnesses and IS
 * what excludes the `.txt`.** It is not defence in depth here; it is the
 * mechanism.
 *
 * ⚠ **THOSE FIGURES ARE A CORRECTION.** This docblock first said 112/111. The
 * total was summed from a per-extension HISTOGRAM rather than read from
 * `find … | wc -l`, and the histogram's own `.jsonl` row was dropped in the
 * addition — `feedback_bounded_output_is_not_a_count`, on the very measurement
 * that motivates this function. Re-measured three ways that must agree:
 * `-type f` = 113, `-name '*.jsonl'` = 1, `-not -name '*.jsonl'` = 112.
 *
 * ⛔ **The segment test is what puts D177 §2's boundary back.** A `.jsonl`
 * anywhere under `projects` would otherwise be admitted for upload, and
 * `agent-tools/` is precisely where Cursor spills whatever the agent
 * downloaded. Requiring `<root>/<workspace>/agent-transcripts/…` reconstructs
 * the root §2 asked for, as a narrowing applied AFTER the registry-computed
 * boundary — so it can only refuse, never widen (D177 §7's direction test).
 *
 * ⚠ **`M0.3` measured ZERO non-`.jsonl` files INSIDE `agent-transcripts/`** (the
 * whole directory holds one file). So the suffix half of this test still has no
 * witness under the segment half, and absence from a corpus is not absence from
 * the product — `D172 §2`'s `notebook_path` reasoning, unchanged.
 *
 * ⛔ **Resolved, because the segment names are the thing being trusted.**
 * `isInside` already resolves both sides, so a path claiming to be under this
 * root cannot be outside it; what a string test would still miss is a symlink
 * INSIDE the root — `…/agent-transcripts/x.jsonl` pointing at
 * `…/agent-tools/scrape.txt`, which passes confinement on the real path and
 * passes a naive segment test on the claimed one. `isInside` is reused rather
 * than re-implemented (`CR-183`); the resolution below exists only to locate the
 * segments within it.
 */
export function isCursorTranscript(root, path) {
    if (!isInside(root, path))
        return false;
    let realRoot;
    let realPath;
    try {
        realRoot = realpathSync(root);
        realPath = realpathSync(path);
    }
    catch {
        return false;
    }
    if (!realPath.endsWith(TRANSCRIPT_SUFFIX))
        return false;
    const segments = realPath.slice(realRoot.length + 1).split(sep);
    // `<workspace>` / `agent-transcripts` / at least one thing under it.
    return segments.length >= 3 && segments[1] === CURSOR_TRANSCRIPTS_DIR;
}
/**
 * Where Claude Code writes DELEGATED work — `CR-124`, D76.
 *
 * `<dir>/<session-id>/subagents/`, beside `<dir>/<session-id>.jsonl`. Derived
 * from `transcript_path` because there is no environment variable for it and
 * the hook is never handed one: the session id is the transcript's own basename.
 *
 * Measured on this machine rather than read from documentation — and the
 * measurement carries a trap. The directory holds an `agent-<id>.meta.json`
 * sidecar beside every `agent-<id>.jsonl`, **636 of each**, exactly 1:1. A
 * `agent-*` glob would therefore double every upload and send metadata as if it
 * were transcript content. The caller globs `agent-*.jsonl`.
 *
 * Returns null for a path that is not a `.jsonl`, rather than inventing a
 * directory next to something that was never a transcript.
 */
export function subagentsDir(transcriptPath) {
    if (!transcriptPath.endsWith(TRANSCRIPT_SUFFIX))
        return null;
    return join(transcriptPath.slice(0, -TRANSCRIPT_SUFFIX.length), "subagents");
}
const TRANSCRIPT_SUFFIX = ".jsonl";
/**
 * The `file_key` a sub-agent transcript travels under: its basename, minus
 * `.jsonl`.
 *
 * From the FILENAME, deliberately. Every record inside also carries `agentId`,
 * but reading a value out of a file to name that file is analysis this client is
 * not licensed to do (D60 §D6 / §D1a) and does not need.
 *
 * Null when the key would breach the server's 1..128 bound
 * (`ingest_sessions.file_key`'s CHECK, `CR-008`): a delta the server 400s is
 * classed `never` and would advance the offset past bytes it never stored.
 * Longest key measured on this machine is 49 characters, so this is a bound
 * being respected rather than one being hit.
 */
export function subagentFileKey(fileName) {
    if (!fileName.startsWith("agent-") || !fileName.endsWith(TRANSCRIPT_SUFFIX))
        return null;
    const key = fileName.slice(0, -TRANSCRIPT_SUFFIX.length);
    return key.length >= 1 && key.length <= 128 ? key : null;
}
/**
 * The `file_key` an ANNOUNCED sub-agent transcript travels under — `CR-196`,
 * D177 §9. ⛔ **`agent-<childId>`, SYNTHESIZED HERE, CLIENT-SIDE.**
 *
 * ## ⛔ Why this sits BESIDE `subagentFileKey` and not inside it
 *
 * They are opposite jobs on opposite layouts, and one function doing both would
 * be strictly worse at each:
 *
 *   `subagentFileKey`  a FILTER. Claude's `subagents/` directory is globbed, so
 *                      the caller sees `agent-<id>.jsonl`, `agent-<id>.meta.json`
 *                      and anything else that is in there — and the prefix test
 *                      is what REFUSES the sidecar and `main.jsonl`. Relaxing it
 *                      to "mint a prefix if one is missing" would make the
 *                      discover path accept every one of those.
 *   this               a CONSTRUCTOR. Cursor's children are `<childId>.jsonl`
 *                      with **no prefix at all**, and the path was HANDED over
 *                      rather than found, so there is nothing to filter — the
 *                      only question is what to call the stream.
 *
 * ## ⛔ The key stays FILENAME-derived, which is what keeps D60 §D6 intact
 *
 * `<childId>` is the announced path's BASENAME. It is not read out of any
 * record inside the file, so *"do not read a value out of a file to name that
 * file"* still holds — the same rule `subagentFileKey`'s own docblock states
 * about `agentId`. What arrives on stdin is a PATH; this reads its name.
 *
 * ## ⛔ WIDENING `ingest_sessions.file_key` WAS CONSIDERED AND DECLINED (D177 §9)
 *
 * Five independent layers refuse a bare `<childId>`, and a DB-only widening
 * would not have worked at all: `subagentFileKey`'s own prefix test, `post.ts`'s
 * `FileKey` type, `cr008`'s CHECK (whose C5/C6/C7 cells pin more than the CHECK
 * line shows), the server's family check — where a 400 classes `never`, advances
 * the offset and stamps a PERMANENT gap — and the health classifier, which
 * would silently reclassify every sub-agent stream as a MAIN stream. Synthesis
 * touches none of them: no migration, no production deploy.
 *
 * ## The prefix is added UNCONDITIONALLY, and that is what makes it injective
 *
 * A child literally named `agent-x.jsonl` becomes `agent-agent-x`, which is
 * ugly and is the only answer that cannot collide: `x` → `agent-x` and
 * `agent-x` → `agent-agent-x` stay distinct, where "prefix only if missing"
 * maps both onto `agent-x` — two streams sharing one offset ledger.
 *
 * Null when the key would breach the server's 1..128 bound, exactly as
 * `subagentFileKey` is, and null for an empty `<childId>`: a bare `agent-` is
 * REJECTED by `cr008`'s CHECK (`like 'agent-_%'`), and its C5 cell pins that.
 */
export function announcedSubagentFileKey(fileName) {
    if (!fileName.endsWith(TRANSCRIPT_SUFFIX))
        return null;
    const childId = fileName.slice(0, -TRANSCRIPT_SUFFIX.length);
    if (childId === "")
        return null;
    const key = `agent-${childId}`;
    return key.length <= 128 ? key : null;
}
/**
 * Is `candidate` really inside `root`?
 *
 * `/cso` finding 1 (2026-08-09), HIGH. `transcript_path` arrives on hook stdin
 * and was read and uploaded verbatim under the user's ingest credential, with no
 * check that it was a transcript at all. Anything that could put a hook
 * definition in front of Claude Code could therefore point the client at
 * `~/.ssh/id_rsa` and have it shipped off the machine — and the hook contract's
 * exit-0 silence meant nothing would show on any stream. The silence that makes
 * the hook safe for the developer's turn is what made that quiet.
 *
 * `realpathSync` on BOTH sides, so a symlink cannot walk out of the root: a
 * string prefix test on the unresolved path is exactly the check that misses
 * `~/.claude/projects/x -> /etc`. A missing path resolves to "outside", because
 * a transcript we cannot resolve is not one we should read.
 */
export function isInside(root, candidate) {
    let realRoot;
    let realCandidate;
    try {
        realRoot = realpathSync(root);
        realCandidate = realpathSync(candidate);
    }
    catch {
        return false;
    }
    return realCandidate === realRoot || realCandidate.startsWith(realRoot + sep);
}
/**
 * Is `candidate` inside ANY of `roots`? — `CR-183`, D164 §5.
 *
 * ⛔ **A WRAPPER, and `isInside` above is byte-unchanged.** The union is a
 * second agent's root being added to the SET the check runs over; it is not a
 * loosening of what "inside" means, and rewriting the resolved-path comparison
 * to take a list would have put the `/cso` finding-1 remediation back on the
 * table for a change that is about membership.
 *
 * ⛔ **`roots` comes from the REGISTRY. It must never be derived from input.**
 * A caller that built this list out of anything on hook stdin would have handed
 * the confinement boundary to the value the boundary exists to constrain.
 *
 * Empty `roots` refuses everything, which is the right direction: no known root
 * means nothing is known to be inside one.
 */
export function isInsideAny(roots, candidate) {
    return roots.some((root) => isInside(root, candidate));
}
/**
 * Reduce an untrusted id to a filename component.
 *
 * `session_id` arrives on hook stdin and is attacker-influenced in the sense that
 * matters here: it reaches `path.join`. Whitelisting is the only safe direction —
 * a blacklist of `..` and `/` misses NUL, backslash on Windows, and the empty
 * string, each of which resolves somewhere other than intended.
 */
function sanitise(value) {
    const cleaned = value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128);
    return cleaned === "" || /^\.+$/.test(cleaned) ? "_" : cleaned;
}
/**
 * ⛔ **WHERE EACH AGENT'S HOOK CONFIG LIVES — `CR-195`/U4b, D205.**
 *
 * A sibling set to the `*TranscriptRoot` functions above, and separate from them
 * on purpose: those name where an agent WRITES transcripts, and these name the
 * one file `connect` WRITES INTO. Same home, same env, different question — and
 * conflating them would put an install-time write behind the confinement
 * boundary's reasoning, where it does not belong.
 *
 * ⚠ **The env vars are honoured on exactly the evidence the transcript roots
 * cite: because the product honours them.** `CLAUDE_CONFIG_DIR` relocates the
 * whole `~/.claude` tree, settings included, and `CODEX_HOME` relocates
 * `~/.codex` — MEASURED for Codex rather than assumed, since every probe in this
 * unit drove a real `codex` through a throwaway `CODEX_HOME` and it read the
 * `hooks.json` there. Hard-coding either would write a file the agent never
 * reads, which is the silent no-op this whole unit exists to delete.
 *
 * ⛔ **No Cursor equivalent, for the reason `cursorTranscriptRoot` gives:** none
 * has been measured, and inventing one is a configuration surface this client
 * would read and nothing would write.
 */
export function claudeSettingsPath(home, env) {
    const configured = env.CLAUDE_CONFIG_DIR;
    const root = configured !== undefined && configured.trim() !== ""
        ? configured.trim()
        : join(home, ".claude");
    return join(root, "settings.json");
}
export function codexHooksPath(home, env) {
    const configured = env.CODEX_HOME;
    const root = configured !== undefined && configured.trim() !== ""
        ? configured.trim()
        : join(home, ".codex");
    return join(root, "hooks.json");
}
export function cursorHooksPath(home) {
    return join(home, ".cursor", "hooks.json");
}
//# sourceMappingURL=paths.js.map