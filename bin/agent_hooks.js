/**
 * Registering our hook in an AGENT's own config — `CR-195`, D205.
 *
 * ⛔ **THIS IS NOT `install.ts`'s CHAINING, AND THE DIFFERENCE IS THE CONTAINER,
 * NOT THE RULE.** The rule is the same one D154 settled for git hooks — *never
 * clobber; whatever was there keeps working*. The MECHANISM cannot be the same:
 *
 *   - `.git/hooks/post-commit` is a **single-slot executable file**. One path,
 *     one script, no way for two owners to coexist — so `writeHook` renames the
 *     incumbent aside and invokes it explicitly. That is the only move available.
 *   - `~/.claude/settings.json` is a **multi-slot document**, and `hooks.Stop`
 *     is an ARRAY that already expresses coexistence natively.
 *
 * ⛔ **So renaming here would be catastrophic rather than conservative.** That
 * file holds the user's model, permissions, enabled plugins, marketplaces and
 * theme; moving it aside to write our own would delete all of it, and on a
 * machine with an existing `Stop` hook it would fire on the very first
 * `connect`. The faithful translation of *never clobber* into this container is
 * **append into the array and leave every other byte alone**.
 *
 * ## The three rules, and what each one is defending against
 *
 *   1. **APPEND, never replace.** A foreign entry is never removed, rewritten or
 *      reordered. Ours goes last.
 *   2. **IDEMPOTENT — by the marker when it survives, and by OUR EXACT COMMAND
 *      when it does not.** JSON has nowhere to put a comment, so ours carries
 *      `_vibecommit`. Without an identity, `connect` run twice appends twice and
 *      the hook fires twice per event — two processes racing on one session
 *      state file. ⚠ The marker field is TOLERATED by all three readers, and
 *      that is measured rather than assumed: Codex parses and clamps with the
 *      field present on the inner and outer object alike, and Cursor's validator
 *      checks only known members (`HWu`/`jWu`/`$Wu` in its bundle).
 *
 *      ⛔ **BUT TOLERATED ON READ IS NOT KEPT ON WRITE — `CR-224`, `TODOS[138]`.**
 *      Claude Code's own settings writer STRIPS unknown keys from hook entries
 *      the next time it saves `settings.json` for any reason. MEASURED against
 *      Claude Code 2.1.285 with a throwaway `CLAUDE_CONFIG_DIR`: an entry
 *      carrying `_vibecommit`, a second foreign key on the entry and a third on
 *      the inner hook went through `claude plugin marketplace add` (which writes
 *      `extraKnownMarketplaces`) and came back with ALL THREE gone — while an
 *      unknown TOP-LEVEL key survived, so it is the hooks schema that strips,
 *      not the file writer wholesale. So on the one machine that matters most the
 *      marker is gone by the second `connect`, and a marker-only identity
 *      appended a duplicate every run. See `isOurs` for what replaced it.
 *   3. ⛔ **REFUSE on unparseable, never overwrite.** A file we could not read is
 *      a file whose contents we cannot preserve. Overwriting it would be the
 *      destructive outcome wearing a success message — the exact defect class
 *      this whole unit exists to delete. Fail-closed, the same direction as
 *      `install.ts`'s `core.hooksPath` refusal.
 *
 * ## ⛔ TWO DOCUMENT SHAPES, MEASURED — they are NOT interchangeable
 *
 * The brief recorded all three agents as "identical to Claude Code". That is
 * true of the STDIN payload and false of the CONFIG document:
 *
 * | | `claude` shape | `cursor` shape |
 * |---|---|---|
 * | used by | Claude Code, Codex CLI | Cursor |
 * | top-level `version` | absent | ⛔ REQUIRED positive integer |
 * | entry | `[{ hooks: [{ type, command, timeout }] }]` | ⛔ flat `[{ command, timeout }]` |
 * | unknown event key | ignored | ⛔ validation ERROR |
 *
 * Cursor's is read out of its shipped bundle (`parseAndValidateHooksConfig` →
 * `M6s` → `zWu` → `HWu`), which rejects a document with no numeric `version`
 * outright. Codex's is MEASURED: a probe wrote the `claude` shape to a throwaway
 * `CODEX_HOME` and Codex parsed it, recognised the event and clamped the
 * timeout — which it could only do having read the inner entry.
 *
 * ⚠ **Writing the wrong shape does not error.** It produces a file that parses,
 * registers nothing, and reports success — the same matches-nothing failure as
 * an unrecognised event name, relocated to the document level.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
/**
 * What marks an entry as ours — the FAST PATH, not the whole identity.
 *
 * ⚠ **A FIELD, never a substring of the command.** A substring match would claim
 * a user's own hook that happens to mention this product. ⛔ But a field is only
 * as durable as the host lets it be, and Claude Code's writer drops it (rule 2
 * above, measured). So an entry WITHOUT the marker is still ours when its
 * command is one we could have written — see `isOurs`, which anchors on the
 * WHOLE command string and never on part of it.
 */
export const AGENT_HOOK_MARKER = "vibecommit-capture-hook v1";
/** The field carrying it. Leading underscore: a hint that it is not the agent's. */
const MARKER_KEY = "_vibecommit";
/** The `version` we mint when CREATING a `cursor` document. */
const CURSOR_CONFIG_VERSION = 1;
/**
 * The command an agent's config invokes.
 *
 * ⛔ **`hook` LEADS, AND THE FLAG NEVER DOES.** `invocationMode` returns `"hook"`
 * only when `argv[0] === "hook"`, so a registered command whose first argument
 * is `--agent=` runs the binary INTERACTIVELY — inside a hook, printing to a
 * stream the agent reads back into the user's turn. `registry.ts` names this as
 * the trap the wave was most likely to ship, and `test/agent-registry.test.ts`
 * holds both arms.
 *
 * ⚠ **The flag is passed explicitly for every agent, Claude Code included**,
 * even though `DEFAULT_AGENT_ID` makes it redundant there. A config that names
 * its own agent is self-describing, and — since Cursor reads Claude Code's
 * settings and maps them onto its own events — it is the only thing that tells
 * the two invocations apart when both fire.
 *
 * ⚠ **It lives HERE, beside its own inverse (`HOOK_COMMAND`), since `CR-224`.**
 * The merge below recognises our entry by this exact shape once the host has
 * stripped the marker, so the builder and the recogniser are one grammar and
 * must not be able to drift apart across two files.
 */
export function hookCommand(binPath, agentId) {
    return `${quote(binPath)} hook --agent=${agentId}`;
}
/** Double-quote for the shells these configs are read by. */
function quote(value) {
    return `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}
/**
 * ⛔ `hookCommand`'s output, recognised — ANCHORED AT BOTH ENDS.
 *
 * The quoted path is `quote`'s grammar exactly: any character except the four it
 * escapes, or one of those four behind a backslash. `^…$` is the whole point:
 * `time "<ours>" hook --agent=x`, `"<ours>" hook --agent=x && echo done` and
 * `echo "<ours>" hook --agent=x` are all the USER's commands, and a pattern
 * without both anchors would claim them.
 */
const HOOK_COMMAND = /^"((?:[^"\\$`]|\\["\\$`])*)" hook --agent=([a-z][a-z0-9-]*)$/;
/** `hookCommand`, inverted. `null` for anything it could not have produced. */
function parseHookCommand(command) {
    const match = HOOK_COMMAND.exec(command);
    if (match === null)
        return null;
    return { binPath: match[1].replace(/\\(["\\$`])/g, "$1"), agentId: match[2] };
}
/**
 * ⛔ **THE WHOLE MERGE, AS A PURE FUNCTION ON TEXT.**
 *
 * `raw` is the file's current contents, or `null` when it does not exist. No fs,
 * no `home`, no clock — so the semantics that matter can be driven by a test
 * without a temp directory, and the writer below is left with nothing but I/O.
 * That split is deliberate: every rule in the module docblock is a property of
 * this function, and none of them needs a real `~/.claude` to check.
 */
export function mergeHookDocument(raw, shape, registrations, 
/**
 * Does the binary an existing entry points at still exist? Consulted ONLY by
 * the moved-directory arm of `commandIsOurs` (`TODOS[144]`). ⚠ The default
 * answers "yes" — the direction in which a doubt leaves a WORKING hook alone
 * and costs at most a duplicate. `writeAgentHooks` passes `existsSync`.
 */
binaryExists = () => true) {
    let doc;
    if (raw === null || raw.trim() === "") {
        doc = {};
    }
    else {
        let parsed;
        try {
            parsed = JSON.parse(raw);
        }
        catch (error) {
            // ⛔ RULE 3. We hold the user's settings in our hands here; a parse we do
            // not understand is not permission to replace them.
            return {
                kind: "refused",
                why: error instanceof Error ? error.message : "not valid JSON",
            };
        }
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
            return { kind: "refused", why: "the document is not a JSON object" };
        }
        doc = { ...parsed };
    }
    // ⛔ MINTED ONLY ON CREATE. An existing `version` is the user's (or another
    // tool's) and is left exactly as found — bumping someone else's schema version
    // is the same class of act as renaming their settings file, in a smaller hat.
    if (shape === "cursor" && doc.version === undefined) {
        doc.version = CURSOR_CONFIG_VERSION;
    }
    const existingHooks = doc.hooks;
    if (existingHooks !== undefined) {
        if (existingHooks === null || typeof existingHooks !== "object" || Array.isArray(existingHooks)) {
            // Present and not an object: we cannot merge into it without destroying it.
            return { kind: "refused", why: "`hooks` is present but is not an object" };
        }
    }
    const hooks = {
        ...(existingHooks ?? {}),
    };
    const added = [];
    const updated = [];
    let foreign = 0;
    for (const registration of registrations) {
        const current = hooks[registration.event];
        if (current !== undefined && !Array.isArray(current)) {
            return {
                kind: "refused",
                why: `\`hooks.${registration.event}\` is present but is not an array`,
            };
        }
        const entries = [...(current ?? [])];
        const ours = entryFor(shape, registration);
        const mine = (entry) => isOurs(entry, shape, registration, binaryExists);
        const at = entries.findIndex(mine);
        if (at >= 0) {
            // ⛔ REFRESH IN PLACE, and the position is kept. The binary path moves on
            // every reinstall, so this arm is the ordinary one on a re-`connect` — and
            // appending instead would grow the array without bound.
            entries[at] = ours;
            // ⛔ AND EVERY OTHER COPY OF OURS GOES (`CR-224`). A machine that ran a
            // marker-only `connect` N times after its host stripped the marker holds N
            // copies, each spawning a process on every event. Refreshing only the first
            // would leave N-1 of them firing forever; a re-run has to CONVERGE to one.
            // Only entries `isOurs` claims are removed — rule 1 is about foreign ones,
            // and the claim is anchored on the whole command, so this cannot reach one.
            for (let i = entries.length - 1; i > at; i -= 1) {
                if (mine(entries[i]))
                    entries.splice(i, 1);
            }
            updated.push(registration.event);
        }
        else {
            entries.push(ours);
            added.push(registration.event);
        }
        foreign += entries.filter((entry) => !mine(entry)).length;
        hooks[registration.event] = entries;
    }
    doc.hooks = hooks;
    return { kind: "merged", text: `${JSON.stringify(doc, null, 2)}\n`, added, updated, foreign };
}
/**
 * Ours? ⛔ **By the marker, or by being EXACTLY an entry we could have written.**
 *
 * The marker is the fast path and is enough on its own — it is the only field
 * nothing but this module writes. Without it (`CR-224`: Claude Code's writer
 * strips it), an entry is ours only when ALL of these hold:
 *
 *   1. **Its keys are ours and nobody else's.** `{ hooks: [one hook] }` for the
 *      `claude` shape, `{ command, timeout }` for `cursor`, and the one inner
 *      hook carries only `type`/`command`/`timeout`. A `matcher`, a second
 *      inner hook or any other key means someone EDITED it, and refreshing it
 *      would silently delete their edit.
 *   2. **Its command is ours** — see `commandIsOurs`.
 *
 * ⚠ **THE FAILURE DIRECTION IS DELIBERATE.** A false "not ours" costs one
 * duplicate entry, which `claimFiring` (`CR-195`/U4a) already turns into a
 * single capture. A false "ours" overwrites a user's hook — the one outcome this
 * module exists to make impossible. Every doubt resolves to "not ours".
 */
function isOurs(entry, shape, registration, binaryExists) {
    if (!isRecord(entry))
        return false;
    if (entry[MARKER_KEY] === AGENT_HOOK_MARKER)
        return true;
    if (shape === "cursor") {
        return (hasOnlyKeys(entry, ["command", "timeout"]) &&
            typeof entry.command === "string" &&
            commandIsOurs(entry.command, registration.command, binaryExists));
    }
    if (!hasOnlyKeys(entry, ["hooks"]) || !Array.isArray(entry.hooks) || entry.hooks.length !== 1) {
        return false;
    }
    const inner = entry.hooks[0];
    return (isRecord(inner) &&
        hasOnlyKeys(inner, ["type", "command", "timeout"]) &&
        inner.type === "command" &&
        typeof inner.command === "string" &&
        commandIsOurs(inner.command, registration.command, binaryExists));
}
/**
 * ⛔ **THE WHOLE STRING, NEVER A SUBSTRING — the trap `TODOS[138]` names.**
 *
 * Two arms, and only two:
 *
 *   - **Identical** to the command we are about to write. The ordinary re-run.
 *   - **`hookCommand`'s exact shape with only the binary's DIRECTORY changed.**
 *     This is the reinstall — an nvm switch or a new npm prefix moves
 *     `<prefix>/bin/vibecommit`, the command text moves with it, and an
 *     identical-only rule would append a second entry beside one that now
 *     points at a binary that may not exist (so fails on every event). Both
 *     sides must parse as the whole `"<path>" hook --agent=<id>` grammar, name
 *     the SAME agent (Cursor reads Claude Code's config, so the `--agent=` tail
 *     is what tells the two apart), and end in the SAME binary name. What a
 *     foreign tool would need to be claimed is our exact argv AND a binary with
 *     our name — which is our binary.
 *
 * ⚠ Invoking the same install by a different NAME (`…/bin/vibecommit` vs
 * `…/dist/index.js`) is not matched and leaves one duplicate. That is the safe
 * direction (see `isOurs`), and `index.js` is too generic a name to claim on.
 *
 * ⛔ **AND THE MOVED-DIRECTORY ARM CLAIMS ONLY A DEAD PATH (`TODOS[144]`).** A
 * claimed entry is REPLACED, so this arm decides which binary the user's hooks
 * run. Claiming a LIVE one hands the hook to whatever binary ran `connect` —
 * and a throwaway install (`npx`, a temp prefix, a test harness's artifacts
 * dir) is exactly that: Gate A repointed a machine's working capture at a
 * directory about to be deleted, after which every hook fails quietly and
 * capture stops. Without this arm the same run appends a second entry and the
 * working one keeps firing (`claimFiring` makes it one capture). So: a moved
 * path is claimed only when the binary it names is GONE — the reinstall this
 * arm exists for (an uninstalled prefix, a removed nvm version) — and a live
 * one is left alone. ⚠ Cost, accepted: two live installs leave two entries
 * until one is removed; a duplicate is the safe failure, a hijack is not.
 */
function commandIsOurs(candidate, ours, binaryExists) {
    if (candidate === ours)
        return true;
    const theirs = parseHookCommand(candidate);
    const mine = parseHookCommand(ours);
    if (theirs === null || mine === null)
        return false;
    return (theirs.agentId === mine.agentId &&
        basename(theirs.binPath) === basename(mine.binPath) &&
        !binaryExists(theirs.binPath));
}
function isRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function hasOnlyKeys(value, allowed) {
    return Object.keys(value).every((key) => allowed.includes(key));
}
/** Our entry, in the shape that agent's reader actually validates. */
function entryFor(shape, registration) {
    if (shape === "cursor") {
        // ⛔ FLAT. `zWu` validates `hooks[event]` as an array of hook SCRIPTS, and
        // `HWu` requires a `command` on each — so a nested `{ hooks: [...] }` object
        // is rejected outright for having none.
        return {
            [MARKER_KEY]: AGENT_HOOK_MARKER,
            command: registration.command,
            timeout: registration.timeoutSec,
        };
    }
    // ⛔ NESTED, and `matcher` is deliberately omitted rather than set to `"*"` —
    // these three events carry no tool name to match on, and the plugin's own
    // `hooks.json` omits it too.
    return {
        [MARKER_KEY]: AGENT_HOOK_MARKER,
        hooks: [
            { type: "command", command: registration.command, timeout: registration.timeoutSec },
        ],
    };
}
/**
 * Merge our registrations into `path` and write it back.
 *
 * ⚠ **Written through a temp file in the same directory, then renamed.** A
 * partial write here is the user's settings truncated, and `rename(2)` within a
 * directory is atomic — so a crash mid-write leaves the original intact rather
 * than a half-document that the next run would then REFUSE to touch, locking
 * the user out of their own config.
 *
 * ⚠ The file's existing mode is preserved when there is one. A settings file
 * the user tightened to `0600` must not be widened by us having rewritten it.
 */
export function writeAgentHooks(path, shape, registrations) {
    let raw = null;
    let mode;
    try {
        raw = readFileSync(path, "utf8");
        mode = statSync(path).mode & 0o777;
    }
    catch {
        // Absent is the ordinary case on a first install; anything else surfaces on
        // the write below rather than being guessed at here.
        raw = null;
    }
    const merged = mergeHookDocument(raw, shape, registrations, existsSync);
    if (merged.kind === "refused")
        return { kind: "refused", path, why: merged.why };
    const temp = join(dirname(path), `.${AGENT_HOOK_MARKER.replace(/\W+/g, "-")}.tmp`);
    try {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(temp, merged.text, { mode: mode ?? 0o600 });
        if (mode !== undefined)
            chmodSync(temp, mode);
        renameSync(temp, path);
    }
    catch (error) {
        return { kind: "failed", path, why: error instanceof Error ? error.message : "write failed" };
    }
    const events = registrations.map((registration) => registration.event);
    // "already" is not "nothing happened" — the command was still refreshed. It is
    // the answer to *did this connect ADD anything*, which is what a user reads.
    return merged.added.length === 0
        ? { kind: "already", path, events }
        : { kind: "installed", path, events };
}
//# sourceMappingURL=agent_hooks.js.map