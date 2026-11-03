/**
 * Codex record isolation (any-folder capture, part (b)): the EFFECTIVE FOLDER of a Codex rollout record.
 *
 * A Codex record names a folder on very few types (`session_meta` and `turn_context` carry `payload.cwd`, a finished command item carries `item.cwd` as a
 * `file://` URL, `thread_settings_applied` carries `thread_settings.cwd`). Everything else (the user's prompt, the agent's prose, a command's output) runs
 * "somewhere" without saying where, so a copy for repo A of a session that also worked in repo B would carry B's turns. Every record therefore gets an
 * effective folder, told by these rules:
 *
 *   1. a record that carries its OWN folder (`payload.cwd`, `payload.item.cwd`, `payload.thread_settings.cwd`) takes it; an unreadable one is UNKNOWN. Only
 *      `session_meta` and `turn_context` CHANGE the turn folder.
 *   2. a CALL takes the folders its tool ran in. The rule is per tool name and DEFAULT DENY: `exec_command` / `shell` / `local_shell_call` (workdir, else the
 *      turn folder, plus the files of a patch they carry), `apply_patch` (the files it changes), `exec` (the whole-literal workdirs of the program, the turn
 *      folder, and the folders of the sessions it polls), `write_stdin` (the folders of the session it polls), `wait` (the folders of the cell it waits on),
 *      `view_image` (its path), `update_plan` (the turn folder). ANY OTHER tool name, in either call form, is UNKNOWN.
 *   3. an OUTPUT takes the folders of its call, matched by `call_id`; an output whose call is not known is UNKNOWN. A process an `exec_command` started and a
 *      cell an `exec` program started are named in the output (`Process running with session ID <n>`, `Script running with cell ID <id>`, a `"session_id"`
 *      field): the SESSION and CELL maps learned from those lines are how a later `write_stdin` or `wait` is placed.
 *   4. otherwise the TURN FOLDER in force, the latest `session_meta` / `turn_context` cwd at or before the record in the SAME stream.
 *
 * The common failure the rules are built against: a record whose folder cannot actually be read must come out UNKNOWN, never as a KNOWN but wrong folder
 * (usually the turn folder), because UNKNOWN is withheld from a multi-repo copy and a wrong known folder is kept.
 *
 * Pure: no filesystem, no clock. The caller supplies the turn folder, the call table and the two maps, so the resolver's scan (which writes the checkpoint)
 * and the redactor (which reads it) share ONE definition of "where a record ran".
 */
import { isAbsolute } from "node:path";
import { CALL_LOG_BUDGET_BYTES, DIR_OVERHEAD_BYTES, boundedId, boundedName, bytesOf, storedBytes } from "./bounded_id.js";
import { MAX_PATH_BYTES, joinRaw, pathTooLong } from "./physical_path.js";
import { fileURLToPath } from "node:url";
/** The longest `file://` URL that can decode to a path of `MAX_PATH_BYTES`: every byte percent-encoded (3 characters), plus the scheme and a little slack. */
const FILE_URL_MAX_CHARS = 3 * MAX_PATH_BYTES + 16;
/** A folder given as a `file://` URL (a finished command item's `cwd`) or as a path, as a plain absolute path; null when it is neither. */
export function folderFromValue(value) {
    if (typeof value !== "string" || value === "")
        return null;
    // C74 (3): a path longer than any the kernel could have opened is unreadable AT PLACEMENT (the existing unreadable-folder rule): it is never stored.
    // C75 (5): a `file://` URL is bounded BEFORE it is decoded (a percent-encoded byte takes three characters, so a path of 4,096 bytes is at most 3 x 4,096 + 16 characters
    // of URL), and the path bound applies to the DECODED path only: a URL that decodes to a readable path is not made unreadable by its encoding.
    if (value.startsWith("file://")) {
        if (value.length > FILE_URL_MAX_CHARS)
            return null;
        try {
            const path = fileURLToPath(value);
            return pathTooLong(path) ? null : path;
        }
        catch {
            return null;
        }
    }
    return pathTooLong(value) || !isAbsolute(value) ? null : value;
}
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
/**
 * The turn folder this record sets: a `session_meta` or `turn_context` `payload.cwd`. `undefined`: the record sets none (another type, or no `cwd`).
 * `null`: it names one that cannot be read (C49 (6)): the turn folder is UNKNOWN from here until the next readable header.
 */
function turnFolderOf(record) {
    if (record.type !== "session_meta" && record.type !== "turn_context")
        return undefined;
    if (!isObject(record.payload) || record.payload.cwd === undefined)
        return undefined;
    return folderFromValue(record.payload.cwd);
}
/** The three places a Codex record can carry its own folder: `payload.cwd`, `payload.item.cwd`, `payload.thread_settings.cwd`. */
function carriersOf(record) {
    if (!isObject(record.payload))
        return [];
    const p = record.payload;
    return [p.cwd, isObject(p.item) ? p.item.cwd : undefined, isObject(p.thread_settings) ? p.thread_settings.cwd : undefined];
}
/**
 * The folder a record carries on its own: `payload.cwd`, `payload.item.cwd` or `payload.thread_settings.cwd`, whatever the record's type. `undefined`: it
 * carries none. `null`: it carries one that cannot be read. (C48 (5): `item_started` and `thread_settings_applied` name a folder too.)
 */
function ownFolderOf(record) {
    let found;
    for (const carrier of carriersOf(record)) {
        if (carrier === undefined)
            continue;
        const folder = folderFromValue(carrier);
        if (folder === null)
            return null;
        found = found === undefined ? folder : found;
    }
    return found;
}
/** EVERY readable folder a record carries on its own (C49 (7): discovery reads folders by this one definition, `file://` decoded). */
export function ownFoldersOf(record) {
    const out = [];
    for (const carrier of carriersOf(record)) {
        if (carrier === undefined)
            continue;
        const folder = folderFromValue(carrier);
        if (folder !== null && !out.includes(folder))
            out.push(folder);
    }
    return out;
}
const CALL_TYPES = new Set(["function_call", "custom_tool_call", "local_shell_call"]);
const OUTPUT_TYPES = new Set(["function_call_output", "custom_tool_call_output", "local_shell_call_output"]);
/** The `call_id` of a call record, or null. */
function callIdOf(record) {
    if (record.type !== "response_item" || !isObject(record.payload))
        return null;
    const p = record.payload;
    return typeof p.type === "string" && CALL_TYPES.has(p.type) && typeof p.call_id === "string" ? boundedId(p.call_id) : null;
}
/** The `call_id` of an output record, or null. */
function outputIdOf(record) {
    if (record.type !== "response_item" || !isObject(record.payload))
        return null;
    const p = record.payload;
    return typeof p.type === "string" && OUTPUT_TYPES.has(p.type) && typeof p.call_id === "string" ? boundedId(p.call_id) : null;
}
/** The tool a call record names (`exec_command`, `exec`, ...); `local_shell_call` has none and is reported as itself. */
function toolOf(record) {
    if (record.type !== "response_item" || !isObject(record.payload))
        return null;
    const p = record.payload;
    if (p.type === "local_shell_call")
        return "local_shell_call";
    return typeof p.name === "string" ? boundedName(p.name) : "";
}
const PATCH_BEGIN = "*** Begin Patch";
// C65 (3): a header is matched after its leading blanks are trimmed (fail closed: a line the parser may or may not honour is read as a header).
// C66 (2): every Unicode White_Space character counts as a blank, as Rust's trim() does: [^\S\n\r] covers the rest of the \s class (NBSP, U+2000-200A, U+3000, \v, \f, ...) and U+0085.
// C67 (1): the path is captured to the end of the line (`(.+)$`) and right-trimmed IN CODE: a lazy `(.+?)\s*$` backtracks quadratically on a header followed by a long run of
// blanks and one more character (8,000 blanks took 1.6 s, 16,000 took 5.3 s), synchronously, in the scan on every firing and again in delivery.
// C69 (1): the path runs to the end of the LINE, and Codex splits patch lines on \n only: `.` also stops at \r, U+2028 and U+2029, so `Add File: /r/A/z<U+2028>/../../B/x` named
// /r/A/z while Codex writes /r/B/x. `([^\n]+)$` takes the whole line (trimEndBlanks drops a CRLF's \r; resolveFrom normalises the `..`), and stays linear.
// C68 (1): the lead-in must not contain a line terminator: under the `m` flag `^` also matches after U+2028 and U+2029, so a run of them in the lead-in made every position a
// line start and the loop quadratic. They are not in the class (a header right after one is still read, `^` re-anchors there).
const PATCH_FILE = /^(?:[^\S\n\r\u2028\u2029]|\u0085)*\*\*\* (?:Add|Update|Delete) File: ([^\n]+)$/gm;
const PATCH_MOVE = /^(?:[^\S\n\r\u2028\u2029]|\u0085)*\*\*\* Move to: ([^\n]+)$/gm;
/** Rust's White_Space (what Codex's `trim()` removes): `\s` without U+FEFF, plus U+0085. */
function isBlank(char) {
    return char !== "\ufeff" && (char === "\u0085" || /\s/.test(char));
}
/** `text` without its trailing blanks; one linear pass from the end. */
function trimEndBlanks(text) {
    let end = text.length;
    while (end > 0 && isBlank(text[end - 1]))
        end -= 1;
    return end === text.length ? text : text.slice(0, end);
}
/** The paths an `apply_patch` document's `*** Add/Update/Delete File:` and `*** Move to:` headers name, in header-kind order; `""` for a header whose path is empty once trimmed. */
function patchHeaderPaths(text) {
    const out = [];
    // (`matchAll` reads a copy of the pattern, so the shared regexes keep `lastIndex` 0.)
    for (const match of text.matchAll(PATCH_FILE))
        out.push(trimEndBlanks(match[1]));
    for (const match of text.matchAll(PATCH_MOVE))
        out.push(trimEndBlanks(match[1]));
    return out;
}
function resolveFrom(path, base) {
    // C74 (3): ONE guard for every path a record hands to placement (patch headers, `Move to`, every workdir form, `view_image`, a review's files, a program's literals): one
    // longer than any the kernel could have opened (or whose joined form is) is unresolvable here, so it is UNJUDGED_FILE / UNKNOWN and nothing over 4 KB enters the
    // placement, the checkpoint, the tracker, the id maps or the evidence.
    if (pathTooLong(path))
        return null;
    if (isAbsolute(path))
        return path;
    // C70: joined, not normalised: a `..` after a link is only meaningful once the links before it are resolved (`physicalPath`).
    if (base === null)
        return null;
    const joined = joinRaw(base, path);
    return pathTooLong(joined) ? null : joined;
}
/** The files an `apply_patch` document names (its `*** Add/Update/Delete File:` and `*** Move to:` headers), resolved against `base`; null when one cannot be. */
function patchFiles(text, base) {
    const out = [];
    for (const path of patchHeaderPaths(text)) {
        // An empty path (a header with nothing after it) names no file we can resolve: UNKNOWN, never the folder itself.
        const file = path === "" ? null : resolveFrom(path, base);
        if (file === null)
            return null;
        out.push(file);
    }
    return out;
}
/**
 * Every string a shell-form call carries that holds a patch: a top-level string argument, OR a string element of a top-level array argument (the older
 * `command: ["apply_patch", "<patch>"]` form). Nothing deeper is read.
 */
function patchTexts(args) {
    const out = [];
    for (const value of Object.values(args)) {
        if (typeof value === "string" && value.includes(PATCH_BEGIN))
            out.push(value);
        else if (Array.isArray(value))
            for (const item of value)
                if (typeof item === "string" && item.includes(PATCH_BEGIN))
                    out.push(item);
    }
    return out;
}
/** C57 (a): a `local_shell_call` patch is read from `action.command` ONLY (a string, or a string element of an array); a patch in any other field of the action is unread. */
function shellPatchTexts(action) {
    return patchTexts({ command: action.command });
}
/** A quoted literal that starts at `source[at]` and is the WHOLE value (followed by optional whitespace and then `,` `}` or `)`); null otherwise. */
function wholeLiteral(source, at) {
    const quote = source[at];
    if (quote !== '"' && quote !== "'")
        return null;
    let i = at + 1;
    while (i < source.length) {
        const c = source[i];
        if (c === "\\") {
            // A single-quoted literal that holds any backslash is not read (its escapes are JavaScript's, not JSON's): UNKNOWN.
            if (quote === "'")
                return null;
            i += 2;
            continue;
        }
        if (c === quote)
            break;
        if (c === "\n")
            return null;
        i += 1;
    }
    if (i >= source.length)
        return null;
    const raw = source.slice(at, i + 1);
    let value;
    if (quote === '"') {
        try {
            value = JSON.parse(raw);
        }
        catch {
            return null;
        }
    }
    else {
        value = raw.slice(1, -1);
    }
    let j = i + 1;
    while (j < source.length && (source[j] === " " || source[j] === "\t" || source[j] === "\n" || source[j] === "\r"))
        j += 1;
    if (source[j] !== "," && source[j] !== "}" && source[j] !== ")")
        return null;
    return { value, end: j };
}
/** Every `workdir` of a JavaScript program that drives `tools.exec_command`: each must be a WHOLE string literal, else the program's folders are unknown. */
function programWorkdirs(source) {
    const mentions = (source.match(/workdir/g) ?? []).length;
    const dirs = [];
    let found = 0;
    for (const match of source.matchAll(/["']?workdir["']?\s*:\s*/g)) {
        const literal = wholeLiteral(source, (match.index ?? 0) + match[0].length);
        if (literal === null)
            return null;
        dirs.push(literal.value);
        found += 1;
    }
    // A `workdir` that is not followed by a whole string literal (a variable, a template, a concatenation) cannot be read.
    return found === mentions ? dirs : null;
}
/**
 * The numeric session ids a program polls (`session_id: 7`, `"session_id": 7`); null when any mention is not a WHOLE numeric literal (C49 (3): optional
 * whitespace, then `,` `}` or `)` after the digits, so `session_id: 7 + 1` is unknown).
 */
function programSessions(source) {
    const mentions = (source.match(/session_id/g) ?? []).length;
    const ids = [];
    for (const match of source.matchAll(/["']?session_id["']?\s*:\s*(\d+)/g)) {
        let j = (match.index ?? 0) + match[0].length;
        while (j < source.length && (source[j] === " " || source[j] === "\t" || source[j] === "\n" || source[j] === "\r"))
            j += 1;
        if (source[j] !== "," && source[j] !== "}" && source[j] !== ")")
            return null;
        ids.push(boundedId(match[1]));
    }
    return ids.length === mentions ? ids : null;
}
/** Every whole-literal `workdir` of a program, skipping the ones that are not (C53: what CAN be read is still kept). */
function programWorkdirsLoose(source) {
    const dirs = [];
    for (const match of source.matchAll(/["']?workdir["']?\s*:\s*/g)) {
        const literal = wholeLiteral(source, (match.index ?? 0) + match[0].length);
        if (literal !== null)
            dirs.push(literal.value);
    }
    return dirs;
}
/** Every polled `session_id` that is a whole numeric literal, skipping the rest. */
function programSessionsLoose(source) {
    const ids = [];
    for (const match of source.matchAll(/["']?session_id["']?\s*:\s*(\d+)/g)) {
        let j = (match.index ?? 0) + match[0].length;
        while (j < source.length && (source[j] === " " || source[j] === "\t" || source[j] === "\n" || source[j] === "\r"))
            j += 1;
        if (source[j] === "," || source[j] === "}" || source[j] === ")")
            ids.push(boundedId(match[1]));
    }
    return ids;
}
/** The files a patch names that CAN be resolved; `skipped` is true when a header could not be (a relative one with no base): the patch is then not fully judged. */
function patchFilesLoose(text, base) {
    const files = [];
    let skipped = false;
    for (const path of patchHeaderPaths(text)) {
        const file = path === "" ? null : resolveFrom(path, base);
        if (file !== null)
            files.push(file);
        else
            skipped = true;
    }
    return { files, skipped };
}
/** Folders as a set where an EMPTY list means "cannot be told" and absorbs the rest. */
export function unionDirs(a, b) {
    if (a.length === 0 || b.length === 0)
        return [];
    return [...new Set([...a, ...b])];
}
/** The item kinds of an `item_completed` event that carry no folder of their own and are MEASURED to run in the turn folder. */
const TURN_ITEM_KINDS = new Set(["Reasoning", "UserMessage", "AgentMessage", "EnteredReviewMode", "ExitedReviewMode", "Extension"]);
const TURN_EVENT_KINDS = new Set([
    "agent_message",
    "user_message",
    "token_count",
    "task_started",
    "task_complete",
    "thread_settings_applied",
    "exited_review_mode",
]);
/**
 * C48 (10): only a MEASURED record kind takes the turn folder. Everything else is UNKNOWN (kept in a single-repo copy, withheld in a multi-repo one), so a
 * kind Codex adds later, a `compacted` summary of earlier turns (which can describe another repo's work), or an old-format item with no `payload` is never
 * placed by a guess. The kinds C40 (2) withholds from every copy (`world_state`, `additional_tools`, `entered_review_mode`, a user or developer message)
 * need no placing: nothing of theirs is sent.
 */
export function takesTurnFolder(record) {
    const type = record.type;
    if (type === undefined)
        return typeof record.id === "string" && typeof record.thread_name === "string" && typeof record.updated_at === "string";
    if (type === "token_usage_record" || type === "world_state")
        return true;
    if (!isObject(record.payload))
        return false;
    const p = record.payload;
    if (type === "response_item")
        return p.type === "message" || p.type === "reasoning" || p.type === "additional_tools" || p.type === "configuration_update";
    if (type !== "event_msg")
        return false;
    if (typeof p.type !== "string")
        return false;
    if (TURN_EVENT_KINDS.has(p.type) || p.type === "entered_review_mode")
        return true;
    return p.type === "item_completed" && isObject(p.item) && typeof p.item.type === "string" && TURN_ITEM_KINDS.has(p.item.type);
}
/**
 * C49 (12): an `exited_review_mode` event and an `item_completed` `ExitedReviewMode` item take the turn folder, and every `absolute_file_path` they hold is
 * a named FILE (judged per copy like a patch's headers). A relative one is resolved against the turn folder.
 */
function reviewFiles(record, turn) {
    if (!isObject(record.payload))
        return [];
    const p = record.payload;
    const exited = p.type === "exited_review_mode" || (p.type === "item_completed" && isObject(p.item) && p.item.type === "ExitedReviewMode");
    if (!exited)
        return [];
    const out = new Set();
    // C50 (2): a walk that stopped early (nested past 24 levels, or more than 4,096 paths) cannot vouch for the files it did not reach: the record is UNKNOWN.
    let truncated = false;
    const walk = (node, depth) => {
        if (truncated || node === null || typeof node !== "object")
            return;
        if (depth > 24) {
            truncated = true;
            return;
        }
        if (Array.isArray(node)) {
            for (const item of node)
                walk(item, depth + 1);
            return;
        }
        for (const [key, value] of Object.entries(node)) {
            if (key === "absolute_file_path" && typeof value === "string" && value !== "") {
                const file = resolveFrom(value, turn);
                // A relative path with no folder to resolve it against cannot be judged: the walk is unjudged, like a truncated one (C52 (1)).
                if (file === null) {
                    truncated = true;
                    return;
                }
                // The cap bounds the work: the 4,097th distinct path is not added, the walk stops, and the record is withheld whole.
                if (!out.has(file) && out.size >= 4096) {
                    truncated = true;
                    return;
                }
                out.add(file);
            }
            else {
                walk(value, depth + 1);
            }
        }
    };
    walk(p, 0);
    return truncated ? null : [...out];
}
/** A "file" that lies inside no copy's tree: a record whose named files could not all be judged names it, so it is withheld from every copy. */
export const UNJUDGED_FILE = "\u0000unjudged";
// C75 (8): a call whose stored places (`paths` and `files`) alone pass the log budget is UNKNOWN (null), like one that names more than MAX_PLACED_FILES: it is never stored.
const placed = (paths, files = [], inputFiles = []) => (bytesOf(paths) + bytesOf(files) > CALL_LOG_BUDGET_BYTES ? null : { paths, files, inputFiles });
/**
 * C62: the most files a PLACED call may name. A call that names more is UNKNOWN (like the readable cap, `readableOf` keeps 64 and marks it unjudged and multi): the
 * checkpoint entry, the tracker, the id maps and the scrub never hold or loop over more than this per call (one 8 MiB patch line can name ~400,000 files).
 */
const MAX_PLACED_FILES = 4096;
/**
 * The places a CALL ran in and the files it names, or null when they cannot be told (DEFAULT DENY: a tool this module has no rule for, a malformed argument
 * document, a `workdir` that is not a string, a relative path with no turn folder, an id that names no known session or cell).
 */
export function placeCall(record, ctx) {
    if (record.type !== "response_item" || !isObject(record.payload))
        return null;
    const p = record.payload;
    const turn = ctx.turn;
    if (p.type === "local_shell_call") {
        const action = isObject(p.action) ? p.action : null;
        const dir = action === null ? undefined : action.working_directory;
        let base = turn;
        // C60: ONLY an absent working directory takes the turn folder; `null` is not a string, so it is unreadable (UNKNOWN, and the session is multi in readableOf).
        if (dir !== undefined)
            base = typeof dir === "string" ? resolveFrom(dir, turn) : null;
        if (base === null)
            return null;
        // C49 (5): `action.command` is read like a shell function call's arguments (a string, or a string element of an array, that holds a patch).
        const files = [];
        for (const text of action === null ? [] : shellPatchTexts(action)) {
            const named = patchFiles(text, base);
            if (named === null)
                return null;
            for (const file of named)
                files.push(file);
        }
        const unique = [...new Set(files)];
        if (unique.length > MAX_PLACED_FILES)
            return null;
        // C59 (2): an explicit working directory is an INPUT file (the scrub knows neither `working_directory` nor `command`): the command is withheld when the
        // folder is outside the copy's tree (C48 (11) parity); its output stays the residual.
        return placed([...new Set([base, ...unique])], unique, dir !== undefined ? [base] : []);
    }
    const name = typeof p.name === "string" ? p.name : "";
    if (p.type === "custom_tool_call") {
        if (typeof p.input !== "string")
            return null;
        if (name === "apply_patch") {
            const files = patchFiles(p.input, turn);
            if (files === null)
                return null;
            const unique = [...new Set(files)];
            if (unique.length > MAX_PLACED_FILES)
                return null;
            return unique.length > 0 ? placed([...unique], unique) : turn === null ? null : placed([turn]);
        }
        if (name === "exec")
            return programFolders(p.input, ctx);
        return null;
    }
    if (p.type !== "function_call" || typeof p.arguments !== "string")
        return null;
    let args;
    try {
        args = JSON.parse(p.arguments);
    }
    catch {
        return null;
    }
    if (!isObject(args))
        return null;
    switch (name) {
        case "exec_command":
        case "shell":
        case "apply_patch": {
            let base = turn;
            if (args.workdir !== undefined) {
                if (typeof args.workdir !== "string")
                    return null;
                base = resolveFrom(args.workdir, turn);
            }
            if (base === null)
                return null;
            const files = [];
            for (const text of patchTexts(args)) {
                const named = patchFiles(text, base);
                if (named === null)
                    return null;
                for (const file of named)
                    files.push(file);
            }
            const unique = [...new Set(files)];
            if (unique.length > MAX_PLACED_FILES)
                return null;
            // C61 (1): an EXPLICIT working folder is an input file here too (`shell`'s `command` array is a key the scrub does not know): the call's text is withheld
            // when the folder is outside the copy's tree. An absent `workdir` is the turn folder: no input file.
            return placed([...new Set([base, ...unique])], unique, args.workdir !== undefined ? [base] : []);
        }
        case "write_stdin": {
            const id = args.session_id;
            if (typeof id !== "number" && typeof id !== "string")
                return null;
            const place = ctx.session(boundedId(String(id)));
            return place === undefined || place.unknown === true ? null : placed([...place.paths], [...place.files]);
        }
        case "wait": {
            const id = args.cell_id;
            if (typeof id !== "number" && typeof id !== "string")
                return null;
            const place = ctx.cell(boundedId(String(id)));
            return place === undefined || place.unknown === true ? null : placed([...place.paths], [...place.files]);
        }
        case "view_image": {
            if (typeof args.path !== "string")
                return null;
            const file = resolveFrom(args.path, turn);
            return file === null ? null : placed([file], [file]);
        }
        case "update_plan":
            return turn === null ? null : placed([turn]);
        default:
            return null;
    }
}
const MAX_READABLE = 64;
export function readableOf(record, ctx) {
    const evidence = new Set();
    const files = new Set();
    const inputFiles = new Set();
    // C54: wherever partial information would be lost (a cap, a path that cannot be resolved), the record carries UNJUDGED_FILE and is withheld from every copy.
    let unjudged = false;
    // C56 (10): a folder the call names that cannot be read is an UNRESOLVED candidate (a folder, not a file): the session is multi, the record is NOT unjudged.
    let incomplete = false;
    const addFile = (file) => {
        files.add(file);
        evidence.add(file);
    };
    const done = () => {
        const over = evidence.size > MAX_READABLE || files.size > MAX_READABLE || inputFiles.size > MAX_READABLE;
        const outFiles = [...files].slice(0, MAX_READABLE);
        if (over || unjudged)
            outFiles.push(UNJUDGED_FILE);
        return { evidence: [...evidence].slice(0, MAX_READABLE), files: outFiles, inputFiles: [...inputFiles].slice(0, MAX_READABLE), ...(over || incomplete ? { overflow: true } : {}) };
    };
    if (record.type !== "response_item" || !isObject(record.payload))
        return done();
    const p = record.payload;
    const turn = ctx.turn;
    const name = typeof p.name === "string" ? p.name : "";
    const baseOf = (value) => {
        if (value === undefined)
            return turn;
        if (typeof value !== "string") {
            incomplete = true;
            return null;
        }
        const resolved = resolveFrom(value, turn);
        if (resolved === null)
            unjudged = true;
        return resolved;
    };
    const patches = (texts, base) => {
        for (const text of texts) {
            const loose = patchFilesLoose(text, base);
            for (const file of loose.files)
                addFile(file);
            if (loose.skipped)
                unjudged = true;
        }
    };
    const fromPlace = (place) => {
        if (place === undefined)
            return;
        for (const path of place.paths)
            evidence.add(path);
        for (const path of place.evidence ?? [])
            evidence.add(path);
        for (const file of place.files)
            files.add(file);
    };
    if (p.type === "local_shell_call") {
        const action = isObject(p.action) ? p.action : null;
        const base = baseOf(action === null ? undefined : action.working_directory);
        if (base !== null)
            evidence.add(base);
        if (base !== null && action !== null && action.working_directory !== undefined)
            inputFiles.add(base);
        patches(action === null ? [] : shellPatchTexts(action), base);
    }
    else if (p.type === "custom_tool_call" && typeof p.input === "string") {
        if (name === "apply_patch") {
            patches([p.input], turn);
        }
        else if (name === "exec") {
            if (turn !== null)
                evidence.add(turn);
            // C56 (2): a program that holds a patch marker (a template literal naming files) is source text, not a patch the client can parse. What can be read is
            // evidence here; the program (with its outputs) is unjudged by `callGuard`.
            if (p.input.includes(PATCH_BEGIN))
                patches([p.input], turn);
            // C56 (10): a `workdir` that is not a whole string literal names a folder this module cannot read.
            if (programWorkdirs(p.input) === null)
                incomplete = true;
            for (const literal of programWorkdirsLoose(p.input)) {
                const dir = resolveFrom(literal, turn);
                if (dir !== null) {
                    evidence.add(dir);
                    inputFiles.add(dir);
                }
                else {
                    unjudged = true;
                }
            }
            for (const id of programSessionsLoose(p.input))
                fromPlace(ctx.session(id));
            // C56 (13): a `session_id` that is not a numeric literal may reach ANY process the session knows at this point: the program carries the files of every
            // session entry known here, and is unjudged when one of them is unknown with files (or already unjudged). A session that names no file adds nothing.
            if (programSessions(p.input) === null) {
                for (const place of ctx.allSessions?.() ?? []) {
                    for (const file of place.files)
                        files.add(file);
                    if (place.files.length > 0 && (place.unknown === true || place.files.includes(UNJUDGED_FILE)))
                        unjudged = true;
                }
            }
        }
    }
    else if (p.type === "function_call" && typeof p.arguments === "string") {
        let args;
        try {
            args = JSON.parse(p.arguments);
        }
        catch {
            return done();
        }
        if (!isObject(args))
            return done();
        if (name === "exec_command" || name === "shell" || name === "apply_patch") {
            const base = baseOf(args.workdir);
            if (base !== null)
                evidence.add(base);
            if (base !== null && args.workdir !== undefined)
                inputFiles.add(base);
            patches(patchTexts(args), base);
        }
        else if (name === "view_image" && typeof args.path === "string") {
            const file = resolveFrom(args.path, turn);
            if (file !== null)
                addFile(file);
            else
                unjudged = true;
        }
        else if (name === "write_stdin" && (typeof args.session_id === "number" || typeof args.session_id === "string")) {
            // C54 (2): a poll inherits what its process named, even when its own placement is unreadable.
            fromPlace(ctx.session(boundedId(String(args.session_id))));
        }
        else if (name === "wait" && (typeof args.cell_id === "number" || typeof args.cell_id === "string")) {
            fromPlace(ctx.cell(boundedId(String(args.cell_id))));
        }
    }
    return done();
}
/** The places a call ran in (see `placeCall`), or null when they cannot be told. */
export function callFolders(record, ctx) {
    return placeCall(record, ctx)?.paths ?? null;
}
/**
 * An `exec` program's folders: its whole-literal workdirs, the TURN folder always (a command with no `workdir` runs there), and the folders of every session
 * it polls. A program that holds a patch, a workdir that is not a whole literal, or a session id that is not a numeric literal naming a known session is
 * UNKNOWN. Its workdirs are also `inputFiles`: the program text is withheld when one lies outside the copy's tree.
 */
function programFolders(source, ctx) {
    if (source.includes(PATCH_BEGIN))
        return null;
    if (ctx.turn === null)
        return null;
    const workdirs = programWorkdirs(source);
    if (workdirs === null)
        return null;
    const dirs = new Set([ctx.turn]);
    const files = new Set();
    const literal = new Set();
    for (const text of workdirs) {
        const dir = resolveFrom(text, ctx.turn);
        if (dir === null)
            return null;
        dirs.add(dir);
        literal.add(dir);
    }
    const sessions = programSessions(source);
    if (sessions === null)
        return null;
    for (const id of sessions) {
        const place = ctx.session(id);
        if (place === undefined || place.unknown === true)
            return null;
        for (const dir of place.paths)
            dirs.add(dir);
        for (const file of place.files)
            files.add(file);
    }
    // C65 (4): like `placeCall`, a program that names more than MAX_PLACED_FILES places in total (its workdirs plus the folders and files of the sessions it
    // polls, the turn folder counted) is UNKNOWN: nothing downstream (the checkpoint entry, the id maps, the scrub) holds or loops over more.
    if (new Set([...dirs, ...files]).size > MAX_PLACED_FILES)
        return null;
    return placed([...dirs], [...files], [...literal]);
}
export function outputTextOf(record) {
    if (!isObject(record.payload))
        return undefined;
    const output = record.payload.output;
    if (typeof output === "string")
        return { header: headerOf(output), all: output };
    if (!Array.isArray(output) || output.length === 0)
        return undefined;
    // C56 (6): a block that is not text (an image) is skipped, not a reason to read nothing: learn from the TEXT blocks, the header from the FIRST of them.
    const texts = [];
    for (const block of output)
        if (isObject(block) && typeof block.text === "string")
            texts.push(block.text);
    if (texts.length === 0)
        return undefined;
    return { header: headerOf(texts[0]), all: texts.join("\n") };
}
const OUTPUT_DELIMITER = "\nOutput:\n";
/** The part of an output that is HEADER: before the first `\nOutput:\n` (all of it when there is none, and then there is no body to be fooled by). */
function headerOf(text) {
    const at = text.indexOf(OUTPUT_DELIMITER);
    return at === -1 ? text : text.slice(0, at);
}
/**
 * What an output teaches about the processes and scripts its call started (C48 (1)): from an `exec_command` / `write_stdin` output, the session id in the
 * header line `Process running with session ID <n>` (never from the body, where a printed log could remap an id); from an `exec` program's output, a
 * `"session_id": <n>` field (either JSON escaping, anywhere in the text) and the header line `Script running with cell ID <id>`.
 */
export function learnFromOutput(tool, text) {
    const sessions = [];
    const cells = [];
    if (tool === "exec_command" || tool === "write_stdin") {
        for (const match of text.header.matchAll(/^Process running with session ID (\d+)$/gm))
            sessions.push(boundedId(match[1]));
    }
    else if (tool === "exec" || tool === "wait") {
        // C56 (7): a `wait` output prints the `session_id` of a process the script started, like the `exec` output that started it.
        for (const match of text.all.matchAll(/\\?"session_id\\?"\s*:\s*(\d+)/g))
            sessions.push(boundedId(match[1]));
        if (tool === "exec")
            for (const match of text.header.matchAll(/^Script running with cell ID (\S+)$/gm))
                cells.push(boundedId(match[1]));
    }
    return { sessions, cells };
}
/** The most entries a session or cell map keeps; the oldest is evicted, and an evicted id is UNKNOWN. */
export const MAX_ID_MAP = 4096;
/** C75 (9) / C76: the bytes of freeable path text ONE id map (the session map, or the cell map) may store per stream (`dirs`, `files` and `evidence` of live entries and tombstones). */
export const ID_MAP_BUDGET_BYTES = CALL_LOG_BUDGET_BYTES;
/** The most distinct folders one id keeps (C49 (10)); past it the id is UNKNOWN for good. */
export const MAX_ID_FOLDERS = 64;
/** The path text an id-map entry stores (what a collapse frees): its folders, files and evidence, with their quoting. */
function idEntryText(entry) {
    let total = 0;
    for (const learned of entry.dirs)
        total += Buffer.byteLength(learned.dir, "utf8") + DIR_OVERHEAD_BYTES;
    return total + storedBytes(entry.files ?? []) + storedBytes(entry.evidence ?? []);
}
/** The tombstone a collapse leaves: it withholds its polls and outputs, and stores one short mark. */
const isCollapsed = (entry) => entry.tomb === true && entry.dirs.length === 0 && entry.evidence === undefined && entry.files?.length === 1 && entry.files[0] === UNJUDGED_FILE;
/** The most tombstones (evicted ids) a map keeps; past that the whole map is UNKNOWN from that offset (sticky). */
export const MAX_ID_TOMBS = 4096;
/** The map key that holds the "whole map is unknown from `unknownAt`" mark. */
export const ALL_UNKNOWN = "\u0000all-unknown";
/**
 * A session or cell map with the checkpoint's bounds: at most `MAX_ID_MAP` live entries; the oldest live entry that is evicted becomes a TOMBSTONE (UNKNOWN
 * for good), at most `MAX_ID_TOMBS` of those; past that the whole map is UNKNOWN from that offset. It is a `Map`, so it persists as an array of entries.
 */
export class IdMap extends Map {
    live = 0;
    tombs = 0;
    /**
     * C75 (9) / C76: the FREEABLE text the entries store (the path text of `dirs`, `files` and `evidence` with their quoting), live entries and tombstones alike. The byte budget compares only
     * this: the fixed cost of an entry (its key and field names) is bounded by the count caps (`MAX_ID_MAP` + `MAX_ID_TOMBS`) and is its own term of the record's worst case.
     */
    text = 0;
    /** C75 (9): the byte budget collapsed an entry since the flag was last taken: evidence was LOST (the session counts as multi from that offset). */
    collapsed = false;
    // C76: the oldest live entry, the oldest tombstone, and the oldest of each that holds freeable text, each found in amortized O(1) (never by walking the map).
    liveOrder = new OrderedKeys();
    tombOrder = new OrderedKeys();
    liveTextOrder = new OrderedKeys();
    tombTextOrder = new OrderedKeys();
    constructor(entries = []) {
        super();
        for (const [id, entry] of entries)
            this.put(id, entry);
    }
    /** Remove an entry, keeping the text count and the order indexes (the live and tombstone counts are kept by the callers). */
    delete(id) {
        const had = this.get(id);
        if (had !== undefined)
            this.text -= idEntryText(had);
        this.liveOrder.delete(id);
        this.tombOrder.delete(id);
        this.liveTextOrder.delete(id);
        this.tombTextOrder.delete(id);
        return super.delete(id);
    }
    /** Set an entry, keeping the live, tombstone and text counts and the order indexes. */
    put(id, entry) {
        const had = this.get(id);
        if (had !== undefined)
            this.text -= idEntryText(had);
        if (id !== ALL_UNKNOWN) {
            if (had !== undefined) {
                if (had.tomb === true)
                    this.tombs -= 1;
                else
                    this.live -= 1;
            }
            const tomb = entry.tomb === true;
            // An entry keeps its place in the order while it stays the same kind (the Map's own order for a key that is set again).
            (tomb ? this.liveOrder : this.tombOrder).delete(id);
            (tomb ? this.tombOrder : this.liveOrder).add(id);
            (tomb ? this.liveTextOrder : this.tombTextOrder).delete(id);
            const holds = idEntryText(entry) > 0 && !isCollapsed(entry);
            if (holds)
                (tomb ? this.tombTextOrder : this.liveTextOrder).add(id);
            else
                (tomb ? this.tombTextOrder : this.liveTextOrder).delete(id);
            if (tomb)
                this.tombs += 1;
            else
                this.live += 1;
        }
        super.set(id, entry);
        this.text += idEntryText(entry);
    }
    /** Read and clear the "the byte budget collapsed an entry" flag. */
    takeCollapsed() {
        const was = this.collapsed;
        this.collapsed = false;
        return was;
    }
    /**
     * C75 (9): the map's byte budget. Past `ID_MAP_BUDGET_BYTES` of freeable text the OLDEST entry that stores any is collapsed to a tombstone whose only file is `UNJUDGED_FILE` (its
     * polls and outputs are withheld from every copy), live entries first, then tombstones that kept files. A collapse loses evidence: the caller counts the session as multi (C54 (1)).
     * C76: each step takes the oldest text-bearing entry from an index, so learning one id costs O(1) amortized whatever the map holds.
     */
    fit(at) {
        let collapsedAny = false;
        while (this.text > ID_MAP_BUDGET_BYTES) {
            const key = this.liveTextOrder.oldest() ?? this.tombTextOrder.oldest();
            // Only the one-line marks of earlier collapses are left (at most one per entry, far under the budget): nothing more to free.
            if (key === undefined)
                break;
            this.collapse(key, at);
            collapsedAny = true;
        }
        // A collapse turns a live entry into a tombstone: the count caps are enforced again.
        if (collapsedAny)
            this.bound(at);
    }
    /** The oldest entry that holds freeable text (a live one first), or undefined. */
    oldestText() {
        return this.liveTextOrder.oldest() ?? this.tombTextOrder.oldest();
    }
    /** Store `id` as a tombstone that withholds its polls and outputs, whatever it held. */
    collapse(id, at) {
        this.put(id, { dirs: [], unknownAt: at, tomb: true, files: [UNJUDGED_FILE] });
        this.collapsed = true;
    }
    /** Enforce the bounds after a learning at offset `at`. */
    bound(at) {
        while (this.live > MAX_ID_MAP) {
            const oldest = this.liveOrder.oldest();
            if (oldest === undefined)
                break;
            const evicted = this.get(oldest);
            this.delete(oldest);
            this.live -= 1;
            // The tombstone keeps the files the evicted entry named (the folders go; the id is unknown): nothing silently dropped.
            const kept = unionCapped(evicted?.files, evicted?.dirs.filter((learned) => learned.file === true).map((learned) => learned.dir));
            this.put(oldest, { dirs: [], unknownAt: at, tomb: true, ...(kept === undefined ? {} : { files: kept }) });
        }
        while (this.tombs > MAX_ID_TOMBS)
            if (this.evictOldestTomb(at) === undefined)
                break;
    }
    /**
     * Forget the OLDEST tombstone: the id is no longer remembered as evicted, so the whole map is marked UNKNOWN from `at` (`ALL_UNKNOWN`) and every lookup past it fails closed.
     * Returns the forgotten [id, entry], or undefined when there is none.
     */
    evictOldestTomb(at) {
        const oldest = this.tombOrder.oldest();
        if (oldest === undefined)
            return undefined;
        const entry = this.get(oldest);
        this.delete(oldest);
        this.tombs -= 1;
        if (this.get(ALL_UNKNOWN) === undefined)
            super.set(ALL_UNKNOWN, { dirs: [], unknownAt: at });
        return [oldest, entry];
    }
}
/**
 * C76: keys in the order they were added, with O(1) amortized add, delete and "the oldest". A key that is added again after a delete takes a new place at the end; one that is added
 * while present keeps its place. (A queue with lazy deletion: a stale item is skipped when it reaches the head, and the queue is rebuilt when stale items outnumber live ones.)
 */
class OrderedKeys {
    seq = 0;
    at = new Map();
    queue = [];
    head = 0;
    add(key) {
        if (this.at.has(key))
            return;
        this.seq += 1;
        this.at.set(key, this.seq);
        this.queue.push([key, this.seq]);
        if (this.queue.length - this.head > 4 * this.at.size + 1024)
            this.rebuild();
    }
    delete(key) {
        this.at.delete(key);
    }
    /** The oldest key still present, or undefined. */
    oldest() {
        while (this.head < this.queue.length) {
            const [key, seq] = this.queue[this.head];
            if (this.at.get(key) === seq)
                return key;
            this.head += 1;
        }
        if (this.queue.length > 0) {
            this.queue = [];
            this.head = 0;
        }
        return undefined;
    }
    rebuild() {
        this.queue = [...this.at].map(([key, seq]) => [key, seq]);
        this.head = 0;
    }
}
/**
 * C56 (12): the entries of an id map as they are persisted. The tracker bounds the map (live entries, tombstones and the whole-map mark), so the limit below
 * is never reached; if it ever were, the oldest entries would be CUT, and a cut loses their files: the whole map is marked UNKNOWN from the start instead.
 */
export function boundedIdEntries(entries) {
    const limit = MAX_ID_MAP + MAX_ID_TOMBS + 1;
    if (entries.length <= limit)
        return entries.map(([id, entry]) => [id, entry]);
    const kept = entries.filter(([id]) => id !== ALL_UNKNOWN).slice(-(limit - 1));
    return [...kept.map(([id, entry]) => [id, entry]), [ALL_UNKNOWN, { dirs: [], unknownAt: 0 }]];
}
/** The placement of `id` in `map` at `position` (see `lookupId`), UNKNOWN when the whole map has been marked unknown from before `position`. */
export function lookupIn(map, id, position) {
    if (map === undefined)
        return undefined;
    const all = map.get(ALL_UNKNOWN);
    // C54: a whole-map mark lost every entry's files: whatever is polled from here on is unjudged (withheld from every copy).
    if (all?.unknownAt !== undefined && (position === undefined || all.unknownAt < position))
        return { paths: [], files: [UNJUDGED_FILE], unknown: true };
    return lookupId(map.get(id), position);
}
/**
 * C56 (13): the placement of EVERY entry of `map` at `position` that carries something (folders or files), for a program that polls an id it cannot name:
 * it may reach any of them. A whole-map mark that is in force returns the one unknown-and-unjudged place (every entry's files are lost).
 */
export function placesIn(map, position) {
    if (map === undefined)
        return [];
    const all = map.get(ALL_UNKNOWN);
    if (all?.unknownAt !== undefined && (position === undefined || all.unknownAt < position))
        return [{ paths: [], files: [UNJUDGED_FILE], unknown: true }];
    const out = [];
    for (const [key, entry] of map) {
        if (key === ALL_UNKNOWN)
            continue;
        const place = lookupId(entry, position);
        if (place !== undefined)
            out.push(place);
    }
    return out;
}
/** The placement of an id at `position` (`undefined`: the whole entry), or `undefined` when it is unknown there. */
export function lookupId(entry, position) {
    if (entry === undefined)
        return undefined;
    const unknown = entry.tomb === true || (entry.unknownAt !== undefined && (position === undefined || entry.unknownAt < position));
    if (unknown) {
        // C54 (3): an UNKNOWN id still carries what it named: its polls and their outputs inherit the files.
        const files = [...new Set([...(entry.files ?? []), ...entry.dirs.filter((learned) => learned.file === true).map((learned) => learned.dir)])];
        const evidence = entry.evidence ?? [];
        return files.length > 0 || evidence.length > 0 ? { paths: [], files, evidence, unknown: true } : undefined;
    }
    const live = position === undefined ? entry.dirs : entry.dirs.filter((learned) => learned.at < position);
    if (live.length === 0)
        return undefined;
    // The guard's UNJUDGED mark (learned as a file, C59 (1)) is never a folder.
    return { paths: live.map((learned) => learned.dir).filter((dir) => dir !== UNJUDGED_FILE), files: live.filter((learned) => learned.file === true).map((learned) => learned.dir) };
}
/** A set union that never silently slices: past the bound the list gains UNJUDGED_FILE (the record is withheld from every copy). */
function unionCapped(a, b) {
    const all = [...new Set([...(a ?? []), ...(b ?? [])])];
    if (all.length === 0)
        return undefined;
    if (all.length <= MAX_ID_FOLDERS)
        return all;
    return [...all.filter((value) => value !== UNJUDGED_FILE).slice(0, MAX_ID_FOLDERS), UNJUDGED_FILE];
}
function learnInto(map, id, call, at) {
    const previous = map.get(id);
    // An evicted id stays UNKNOWN for good: a re-announcement does not bring it back, but what it names is still kept.
    if (previous?.tomb === true) {
        const files = unionCapped(previous.files, call.files);
        map.put(id, { ...previous, ...(files === undefined ? {} : { files }) });
        return;
    }
    if (previous !== undefined) {
        map.delete(id);
        map.live -= 1;
    }
    const dirs = previous === undefined ? [] : [...previous.dirs];
    let unknownAt = previous?.unknownAt;
    let files = previous?.files;
    let evidence = previous?.evidence;
    if (call.paths.length === 0) {
        unknownAt = unknownAt ?? at;
        // C54 (3): an id learned from an UNKNOWN call keeps that call's readable files and evidence beside `unknownAt`.
        files = unionCapped(files, call.files);
        evidence = unionCapped(evidence, call.evidence);
    }
    else {
        // C62: linear in the call's paths. Membership is a Map / Set (never `includes` / `findIndex` per path), and insertion STOPS at MAX_ID_FOLDERS + 1: the list
        // is never built past the bound it is then cut to.
        const where = new Map(dirs.map((learned, index) => [learned.dir, index]));
        const fileSet = new Set(call.files ?? []);
        const learn = (dir, isFile) => {
            const at_ = where.get(dir);
            if (at_ !== undefined) {
                if (isFile && dirs[at_].file !== true)
                    dirs[at_] = { ...dirs[at_], file: true };
                return true;
            }
            if (dirs.length > MAX_ID_FOLDERS)
                return false;
            where.set(dir, dirs.length);
            dirs.push(isFile ? { dir, at, file: true } : { dir, at });
            return true;
        };
        const pathSet = new Set(call.paths);
        for (const path of call.paths)
            if (!learn(path, fileSet.has(path)))
                break;
        // C59 (1): a guard result travels everywhere the placement travels. A file of the call that is not one of its paths (the guard's UNJUDGED mark) is learned
        // too, so a later poll of the id and its output are unjudged.
        for (const file of fileSet)
            if (!pathSet.has(file) && !learn(file, true))
                break;
    }
    if (dirs.length > MAX_ID_FOLDERS) {
        // The folders past the bound are dropped: any file among them goes with them, so the id is unjudged from here on.
        dirs.length = MAX_ID_FOLDERS;
        unknownAt = unknownAt ?? at;
        files = unionCapped(files, [UNJUDGED_FILE]);
    }
    const learned = { dirs, ...(unknownAt === undefined ? {} : { unknownAt }), ...(files === undefined ? {} : { files }), ...(evidence === undefined ? {} : { evidence }) };
    // C75 (9): an entry that alone passes the map's budget is stored as the tombstone the budget would make of it.
    if (idEntryText(learned) > ID_MAP_BUDGET_BYTES)
        map.collapse(id, at);
    else
        map.put(id, learned);
    map.bound(at);
    map.fit(at);
}
const UNKNOWN = { unknown: true };
/** UNKNOWN, carrying whatever named files could still be read (they are judged whether or not the folder is known). */
function unknownWith(files, inputFiles = [], evidence = [], overflow = false) {
    if (files.length === 0 && inputFiles.length === 0 && evidence.length === 0 && !overflow)
        return UNKNOWN;
    return {
        unknown: true,
        ...(files.length > 0 ? { files } : {}),
        ...(inputFiles.length > 0 ? { inputFiles } : {}),
        ...(evidence.length > 0 ? { evidence } : {}),
        ...(overflow ? { overflow: true } : {}),
    };
}
/**
 * C57: the GUARD stage. It runs FIRST for every record, before any placement, own-folder branch or early return, and placement only ADDS to what it returns
 * (`addFiles`): a guard cannot be skipped by the shape of the record. Each guard is one function:
 *  - `callGuard` (G1 an unread patch marker, G2 unreadable arguments) for a call;
 *  - `outputGuard` (G3 the call's files, a call that was dropped or may have been lost) for an output;
 *  - `unmeasuredGuard` (G1 for a record kind nobody measured).
 * The same `callGuard` runs in `CodexTracker.step`, so the checkpoint entry (and with it the call's output) carries the mark too.
 */
function guardFiles(record, env) {
    const call = callIdOf(record);
    if (call !== null)
        return callGuard(record);
    const output = outputIdOf(record);
    if (output !== null)
        return outputGuard(output, env);
    return unmeasuredGuard(record);
}
function addFiles(result, extra) {
    if (extra.length === 0)
        return result;
    return { ...result, files: [...new Set([...(result.files ?? []), ...extra])] };
}
/** The effective folder(s) of `record` (see the module note). The guard stage first, then the placement. */
export function recordFolders(record, env) {
    return addFiles(placeRecord(record, env), guardFiles(record, env));
}
function placeRecord(record, env) {
    // C52: an own folder, readable or not, changes ONLY the placement's turn folder. Named-file judgment and review truncation always run.
    const own = ownFolderOf(record);
    const call = callIdOf(record);
    if (call !== null) {
        // C49 (11): a call that carries its own folder is placed with it as the turn folder, plus the folder itself.
        // C54 (4): only an ABSENT own folder inherits the turn folder; an unreadable one (`null`) means the turn is unknown for this call.
        const callCtx = { turn: own === undefined ? env.turnFolder() : own, session: env.session, cell: env.cell, ...(env.sessionPlaces === undefined ? {} : { allSessions: env.sessionPlaces }) };
        // C53: a placement that cannot be fully told keeps what could still be read (as evidence and as named files); the verdict stays UNKNOWN.
        const now = own === null ? null : placeCall(record, callCtx);
        const partial = now === null ? readableOf(record, callCtx) : null;
        const entry = env.ownCall?.(call);
        if (entry !== undefined) {
            const inputFiles = (now ?? partial)?.inputFiles ?? [];
            if (entry.paths.length === 0)
                return unknownWith([...new Set([...(entry.files ?? []), ...(partial?.files ?? [])])], inputFiles, partial?.evidence ?? [], partial?.overflow === true);
            const files = entry.files ?? [];
            return { dirs: entry.paths, ...(files.length > 0 ? { files } : {}), ...(inputFiles.length > 0 ? { inputFiles } : {}) };
        }
        if (now === null)
            return unknownWith(partial?.files ?? [], partial?.inputFiles ?? [], partial?.evidence ?? [], partial?.overflow === true);
        const dirs = own === undefined || own === null ? now.paths : [...new Set([...now.paths, own])];
        return { dirs, ...(now.files.length > 0 ? { files: now.files } : {}), ...(now.inputFiles.length > 0 ? { inputFiles: now.inputFiles } : {}) };
    }
    if (record.type === "session_meta" || record.type === "turn_context")
        return own !== undefined && own !== null ? { dirs: [own] } : UNKNOWN;
    // C50 (1): the files a record names (its call's files for an output, a review's) are judged whether or not it carries an own folder.
    const output = outputIdOf(record);
    if (output !== null) {
        // The unjudged mark is the guard's (`outputGuard`); the placement only needs the real files for the folders it reports.
        const files = env.callFiles(output).filter((file) => file !== UNJUDGED_FILE);
        if (own === null)
            return unknownWith(files);
        if (own !== undefined) {
            // C57 (c): an output's own folder never REPLACES the folders of its known call: placement only adds. A known call's folders and the output's own are both its places.
            const dirs = [...new Set([own, ...(env.callFolders(output) ?? []), ...files])];
            return files.length > 0 ? { dirs, files } : { dirs };
        }
        const dirs = env.callFolders(output);
        // C53: a call whose folders are unknown still carries the files it could read.
        if (dirs === undefined || dirs.length === 0)
            return unknownWith(files);
        return files.length > 0 ? { dirs, files } : { dirs };
    }
    if (own === null) {
        // An unreadable own folder leaves the placement UNKNOWN, but a review's files (or its truncation) are still judged. C55 (2): the turn is unknown for
        // this record too (C54 (4)), so a relative path in the review has nothing to resolve against and the review is unjudged.
        const named = reviewFiles(record, null);
        return unknownWith(named === null ? [UNJUDGED_FILE] : named);
    }
    if (own === undefined && !takesTurnFolder(record))
        return UNKNOWN;
    const turn = own ?? env.turnFolder();
    const files = reviewFiles(record, turn);
    // C50 (2), amended: a truncated walk cannot vouch for the files it did not reach, and a file outside the tree is withheld in EVERY copy: so is the record,
    // whether or not its folder is known (C52 (1)).
    if (files === null)
        return turn === null ? unknownWith([UNJUDGED_FILE]) : { dirs: [turn], files: [UNJUDGED_FILE] };
    if (turn === null)
        return unknownWith(files);
    return files.length > 0 ? { dirs: [turn, ...files], files } : { dirs: [turn] };
}
function markerCount(text) {
    let count = 0;
    for (let at = text.indexOf(PATCH_BEGIN); at !== -1; at = text.indexOf(PATCH_BEGIN, at + PATCH_BEGIN.length))
        count += 1;
    return count;
}
/** The strings the call's own placement READS for patch headers (`patchTexts` of a shell-form call, a custom `apply_patch` input). */
function readPatchTexts(p) {
    if (p.type === "local_shell_call")
        return isObject(p.action) ? shellPatchTexts(p.action) : [];
    if (p.type === "custom_tool_call")
        return p.name === "apply_patch" && typeof p.input === "string" ? [p.input] : [];
    if (p.type === "function_call" && typeof p.arguments === "string" && (p.name === "exec_command" || p.name === "shell" || p.name === "apply_patch")) {
        try {
            const args = JSON.parse(p.arguments);
            return isObject(args) ? patchTexts(args) : [];
        }
        catch {
            return [];
        }
    }
    return [];
}
/** G2: arguments no rule can read: a `function_call` whose `arguments` is not a string holding a JSON object, a custom call whose input is not a string, a shell call with no action. */
function unreadableArguments(p) {
    if (p.type === "function_call") {
        if (typeof p.arguments !== "string")
            return true;
        try {
            return !isObject(JSON.parse(p.arguments));
        }
        catch {
            return true;
        }
    }
    if (p.type === "custom_tool_call")
        return typeof p.input !== "string";
    if (p.type === "local_shell_call")
        return !isObject(p.action);
    return false;
}
/**
 * C57 G1 + G2, for ANY call, placed or not: unreadable arguments, or a patch marker anywhere in the raw payload (arguments of any type serialized, input,
 * action) that the call's own patch rule did not read, name files nobody judged: the call, and with it its output, is unjudged.
 */
function callGuard(record) {
    if (record.type !== "response_item" || !isObject(record.payload))
        return [];
    const p = record.payload;
    if (unreadableArguments(p))
        return [UNJUDGED_FILE];
    // C58 (2): an `exec` program that names `apply_patch` ANYWHERE (a call, a comment) may build a patch the marker count cannot see (a JS-escaped or concatenated
    // marker): it is source text, so it is unjudged. (A fully computed name, `tools["apply" + "_patch"]`, is the stated residual.)
    if (p.type === "custom_tool_call" && p.name === "exec" && typeof p.input === "string" && p.input.includes("apply_patch"))
        return [UNJUDGED_FILE];
    // The total is counted over the payload as the TOOL receives it (the arguments decoded once, like the texts the rule reads): a marker spelled with JSON
    // escapes in the arguments text (`\u002a** Begin Patch`) is the same marker, and an escaped read one must not offset an unescaped unread one.
    let received = p;
    if (p.type === "function_call" && typeof p.arguments === "string")
        received = { ...p, arguments: JSON.parse(p.arguments) };
    return markerCount(JSON.stringify(received) ?? "") > markerCount(readPatchTexts(p).join("\n")) ? [UNJUDGED_FILE] : [];
}
/**
 * C57 G3, for an OUTPUT: the files its call named (a dropped call is `DROPPED_CALL`, which names the unjudged mark), and the mark itself when its call is not
 * known and may have been lost. Checked before any own-folder branch of the placement.
 */
function outputGuard(output, env) {
    const out = [...env.callFiles(output)];
    if (env.callFolders(output) === undefined && env.callsLost?.() === true)
        out.push(UNJUDGED_FILE);
    return out;
}
/** C57 G1 for a record kind nobody measured (UNKNOWN): a patch it carries names files nobody judged. */
function unmeasuredGuard(record) {
    if (record.type === "session_meta" || record.type === "turn_context" || takesTurnFolder(record))
        return [];
    return (JSON.stringify(record) ?? "").includes(PATCH_BEGIN) ? [UNJUDGED_FILE] : [];
}
/** C65 (2): the call of an output whose call is not known: placed nowhere, naming nothing. */
const UNKNOWN_CALL = { tool: "", paths: [] };
/** C56 (1): a call whose files were lost (it was evicted from a bounded table, or its entry is gone): its output and the ids it started are unjudged. */
export const DROPPED_CALL = { tool: "", paths: [], files: [UNJUDGED_FILE] };
/**
 * C62 (3): a call that opens an id ALREADY KNOWN in its stream (still open, closed, dropped, or in the checkpoint) POISONS it: from that call on the id's entry
 * carries the unjudged mark and `named`, so the repeated call, every later output with the id and every id learned from such an output are withheld from
 * every copy. ONE function, shared by the checkpoint fold and `CodexTracker`, so the two views agree.
 */
export function poisonRepeated(info) {
    return { ...info, files: [...new Set([...(info.files ?? []), UNJUDGED_FILE])], named: true };
}
/** The call carried files or evidence (so evicting it loses something). */
export function carriesNames(info) {
    return (info.files?.length ?? 0) > 0 || (info.evidence?.length ?? 0) > 0 || info.named === true;
}
function mergeLearned(a, b) {
    return { sessions: [...new Set([...a.sessions, ...b.sessions])], cells: [...new Set([...a.cells, ...b.cells])] };
}
/**
 * The in-order state of one Codex stream: the turn folder, the session map, the cell map and the call table. The resolver's scan and the delivery's observer
 * both walk records through it, so the checkpoint and the in-span view are built by the same code. The call table has the CHECKPOINT's bounds: at most
 * `bounds.open` open calls (the oldest is dropped, and its output is UNKNOWN), calls closed on their output, `bounds.closed` of those kept.
 */
export class CodexTracker {
    known;
    bounds;
    seen;
    turn;
    sessions;
    cells;
    open = new Map();
    closed = new Map();
    dropped = new Set();
    /** C56 (1): the evicted calls that carried files or evidence (bounded by `bounds.dropped`): their outputs are UNJUDGED. */
    droppedNamed = new Set();
    /** C56 (1): `droppedNamed` overflowed: every output whose call cannot be found is unjudged from here on. */
    droppedNamedAll = false;
    constructor(init, 
    /** The calls known from before this tracker started (the persisted table). */
    known, bounds, 
    /** C62 (3): has the checkpoint seen a call with this id (an entry, or one it dropped)? Exact membership: the sticky all-mark does not count. */
    seen = () => false) {
        this.known = known;
        this.bounds = bounds;
        this.seen = seen;
        this.turn = init.turn;
        this.sessions = new IdMap(init.sessions);
        this.cells = new IdMap(init.cells);
        for (const [id, info] of init.openCalls ?? [])
            this.open.set(id, info);
    }
    /**
     * C65 (1): an independent copy of this tracker's state (the delivery observer snapshots it before a read and restores it when the same bytes are read again).
     * The persisted lookups are shared; every map and set is copied. Id entries and call infos are never mutated in place (`learnInto` and `register` replace
     * them), so they are shared too.
     */
    clone() {
        const copy = new CodexTracker({ turn: this.turn, sessions: this.sessions, cells: this.cells, openCalls: this.open }, this.known, this.bounds, this.seen);
        for (const [id, info] of this.closed)
            copy.closed.set(id, info);
        for (const id of this.dropped)
            copy.dropped.add(id);
        for (const id of this.droppedNamed)
            copy.droppedNamed.add(id);
        copy.droppedNamedAll = this.droppedNamedAll;
        return copy;
    }
    /** A call this tracker has seen, else one the persisted table knows; a dropped one is not known. */
    callInfo(id) {
        // C56 (1): an evicted call that carried files or evidence (or any evicted call once that set overflowed) is a call whose files are LOST: unjudged.
        if (this.droppedNamed.has(id) || (this.droppedNamedAll && this.dropped.has(id)))
            return DROPPED_CALL;
        if (this.dropped.has(id))
            return undefined;
        const found = this.open.get(id) ?? this.closed.get(id) ?? this.known(id);
        return found === undefined && this.droppedNamedAll ? DROPPED_CALL : found;
    }
    /** An evicted call: remembered as unknown, and (C56 (1)) as unjudged when it carried files or evidence. */
    evict(id, info) {
        if (info !== undefined && carriesNames(info)) {
            this.droppedNamed.add(id);
            // Bounded like `dropped`; every named id is also in `dropped`, so when this set outgrows its bound `dropped` has too, and that sets the sticky mark below.
            if (this.droppedNamed.size > this.bounds.dropped)
                this.droppedNamed.delete(this.droppedNamed.values().next().value);
        }
        this.dropped.add(id);
        if (this.dropped.size > this.bounds.dropped) {
            this.dropped.delete(this.dropped.values().next().value);
            // C56 (11): an evicted id was forgotten: from here an output whose call cannot be found may be one of them, so it is unjudged.
            this.droppedNamedAll = true;
        }
    }
    /** C62 (3): is `id` already known in this stream? */
    repeated(id) {
        return this.open.has(id) || this.closed.has(id) || this.dropped.has(id) || this.droppedNamed.has(id) || this.seen(id);
    }
    register(id, info) {
        // The id is live again: it must not stay shadowed by the dropped sets.
        this.dropped.delete(id);
        this.droppedNamed.delete(id);
        this.closed.delete(id);
        this.open.delete(id);
        this.open.set(id, info);
        if (this.open.size > this.bounds.open) {
            const oldest = this.open.keys().next().value;
            const evicted = this.open.get(oldest);
            this.open.delete(oldest);
            this.evict(oldest, evicted);
        }
    }
    close(id) {
        const info = this.callInfo(id);
        if (info === undefined)
            return undefined;
        if (this.open.delete(id)) {
            this.closed.set(id, info);
            if (this.closed.size > this.bounds.closed) {
                // C56 (1): a closed call that falls off the table keeps its names too (a second output with its id is unjudged, not placed by nothing).
                const oldest = this.closed.keys().next().value;
                const evicted = this.closed.get(oldest);
                this.closed.delete(oldest);
                this.evict(oldest, evicted);
            }
        }
        return info;
    }
    step(record, at = 0) {
        const turn = turnFolderOf(record);
        if (turn !== undefined) {
            this.turn = turn;
            return { turnChange: turn, unknown: turn === null };
        }
        const own = ownFolderOf(record);
        const id = callIdOf(record);
        if (id !== null) {
            // C49 (11): a call that carries its own folder is registered like any call, placed with it as the turn folder, plus the folder itself.
            const callCtx = { turn: own === undefined ? this.turn : own, session: (key) => lookupIn(this.sessions, key), cell: (key) => lookupIn(this.cells, key), allSessions: () => placesIn(this.sessions) };
            const placed_ = own === null ? null : placeCall(record, callCtx);
            // C53: an unknown placement keeps the files and folders that could still be read (evidence for discovery, named files for judgment).
            const partial = placed_ === null ? readableOf(record, callCtx) : null;
            const tool = toolOf(record) ?? "";
            const paths = placed_ === null ? [] : own === undefined || own === null ? placed_.paths : [...new Set([...placed_.paths, own])];
            // C57: the guard stage (`callGuard`) runs for every call, placed or not; placement only adds to it.
            const knownFiles = [...new Set([...(placed_ !== null ? placed_.files : (partial?.files ?? [])), ...callGuard(record)])];
            const files = knownFiles.length > 0 ? knownFiles : undefined;
            const evidence = partial !== null && partial.evidence.length > 0 ? partial.evidence : undefined;
            const base = { tool, paths, ...(files === undefined ? {} : { files }), ...(evidence === undefined ? {} : { evidence }) };
            // C62 (3): a repeated id is poisoned, before it is registered (the same function the checkpoint fold uses).
            const info = this.repeated(id) ? poisonRepeated(base) : base;
            this.register(id, info);
            return {
                open: { id, tool, paths, ...(info.files === undefined ? {} : { files: [...info.files] }), ...(evidence === undefined ? {} : { evidence }), ...(partial?.overflow === true ? { overflow: true } : {}) },
                unknown: placed_ === null,
            };
        }
        // C52 (2): an output closes its call and teaches the maps WHATEVER folder it carries; the own folder affects only its placement.
        const closedId = outputIdOf(record);
        if (closedId !== null) {
            const found = this.close(closedId);
            // C65 (2): an output whose call is UNKNOWN is still read by EVERY announcement rule (it has no tool to say which applies), and each id it announces becomes
            // UNKNOWN from here, with no folders and no files: an earlier, known mapping of that id is not kept.
            const call = found ?? UNKNOWN_CALL;
            const text = outputTextOf(record);
            if (text !== undefined) {
                // C56 (1) / C63 (1): the tool of a dropped call is lost, and the tool of a POISONED id (a repeated call id) is whichever call the table happened to keep: an
                // output whose call carries the unjudged mark is read by EVERY announcement rule (the exec_command / write_stdin header, an exec program's session_id
                // field, the cell header), so a process it started is learned as UNJUDGED whatever tool announced it.
                const unjudged = call === UNKNOWN_CALL || call === DROPPED_CALL || (call.files ?? []).includes(UNJUDGED_FILE);
                const learned = unjudged ? mergeLearned(learnFromOutput("exec_command", text), learnFromOutput("exec", text)) : learnFromOutput(call.tool, text);
                for (const session of learned.sessions)
                    learnInto(this.sessions, session, call, at);
                for (const cell of learned.cells)
                    learnInto(this.cells, cell, call, at);
            }
            // (Both flags are read, then combined: `||` would leave the cell map's flag set for a later offset.)
            const sessionsCollapsed = this.sessions.takeCollapsed();
            const cellsCollapsed = this.cells.takeCollapsed();
            const collapsed = sessionsCollapsed || cellsCollapsed;
            const mark = collapsed ? { collapsed: true } : {};
            if (found === undefined)
                return { close: closedId, unknown: true, ...mark };
            return { close: closedId, unknown: own === null ? true : own !== undefined ? false : call.paths.length === 0, ...mark };
        }
        if (own === null || record.type === "session_meta" || record.type === "turn_context")
            return { unknown: true };
        if (own !== undefined)
            return { unknown: false };
        return { unknown: this.turn === null || !takesTurnFolder(record) };
    }
}
//# sourceMappingURL=codex_folders.js.map