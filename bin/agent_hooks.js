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
 *   2. **IDEMPOTENT via a marker.** JSON has nowhere to put a comment, so ours
 *      carries `_vibecommit`. Without it, `connect` run twice appends twice and
 *      the hook fires twice per event — two processes racing on one session
 *      state file. ⚠ The marker field is TOLERATED by all three readers, and
 *      that is measured rather than assumed: Codex parses and clamps with the
 *      field present on the inner and outer object alike, and Cursor's validator
 *      checks only known members (`HWu`/`jWu`/`$Wu` in its bundle).
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
import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
/**
 * What marks an entry as ours.
 *
 * ⚠ **A FIELD, not a substring of the command.** Matching on the command text
 * would claim a user's own hook that happens to mention this product, and would
 * lose track of ours the moment the binary path changed — which is exactly when
 * idempotence matters, because that is a re-`connect`.
 */
export const AGENT_HOOK_MARKER = "vibecommit-capture-hook v1";
/** The field carrying it. Leading underscore: a hint that it is not the agent's. */
const MARKER_KEY = "_vibecommit";
/** The `version` we mint when CREATING a `cursor` document. */
const CURSOR_CONFIG_VERSION = 1;
/**
 * ⛔ **THE WHOLE MERGE, AS A PURE FUNCTION ON TEXT.**
 *
 * `raw` is the file's current contents, or `null` when it does not exist. No fs,
 * no `home`, no clock — so the semantics that matter can be driven by a test
 * without a temp directory, and the writer below is left with nothing but I/O.
 * That split is deliberate: every rule in the module docblock is a property of
 * this function, and none of them needs a real `~/.claude` to check.
 */
export function mergeHookDocument(raw, shape, registrations) {
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
        const at = entries.findIndex(isOurs);
        if (at >= 0) {
            // ⛔ REFRESH IN PLACE, and the position is kept. The binary path moves on
            // every reinstall, so this arm is the ordinary one on a re-`connect` — and
            // appending instead would grow the array without bound.
            entries[at] = ours;
            updated.push(registration.event);
        }
        else {
            entries.push(ours);
            added.push(registration.event);
        }
        foreign += entries.filter((entry) => !isOurs(entry)).length;
        hooks[registration.event] = entries;
    }
    doc.hooks = hooks;
    return { kind: "merged", text: `${JSON.stringify(doc, null, 2)}\n`, added, updated, foreign };
}
/** Ours? ⛔ By the marker alone — never by the command, which changes. */
function isOurs(entry) {
    return (entry !== null &&
        typeof entry === "object" &&
        !Array.isArray(entry) &&
        entry[MARKER_KEY] === AGENT_HOOK_MARKER);
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
    const merged = mergeHookDocument(raw, shape, registrations);
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