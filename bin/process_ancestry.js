/**
 * The committing process's PARENTS, by executable name only (multi-session attribution, T1, D4/D9).
 *
 * `post-commit` runs inside the user's `git commit`. When its environment shows two agents (an id or a marker from each), the environment alone cannot say which
 * is the inner one: Codex launched from a Claude Code shell carries BOTH ids (T0 X2), and so does Claude Code launched from Codex. The process tree can: the
 * nearest ancestor whose executable some dialect claims is the agent that ran `git`. This module lists them, nearest first, and nothing else.
 *
 * ⛔ **IT RUNS INSIDE `git commit`, SO IT IS BOUNDED ON EVERY AXIS, AND ANY BOUND HIT IS `null`, NEVER A GUESS** (`post_commit.ts` never throws, prints nothing, uses no network):
 *   - at most `ANCESTRY_MAX_DEPTH` ancestors (an agent further away than that is not "the agent that ran this commit");
 *   - at most `ANCESTRY_MAX_MS` of wall clock for the WHOLE walk (the one `ps` spawn carries what is left as its own timeout; `/proc` reads check the deadline per hop);
 *   - at most `ANCESTRY_MAX_BYTES` of listing (`ps` on macOS prints every process; its `maxBuffer` is this bound).
 * macOS: ONE `ps -A -o pid=,ppid=,comm=` spawn, parsed in memory. Linux: `/proc/<pid>/stat` for the parent and `/proc/<pid>/exe` for the name (the `stat` name when the
 * link is unreadable). Any other platform: `null`.
 *
 * ⛔ **ONLY NAMES AND PIDS ARE READ.** No argv, no other process's environment, nothing stored: the result is a list of strings that lives for one hook run.
 *
 * `null` means "could not tell" (a spawn failure, a timeout, an oversize listing, an unreadable tree, an unsupported platform). An empty list is not returned: a
 * walk that found no parent at all is `null` too, because the caller treats both the same (no claimed ancestor: `walk_failed`).
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readlinkSync } from "node:fs";
export const ANCESTRY_MAX_DEPTH = 16;
export const ANCESTRY_MAX_MS = 1_000;
export const ANCESTRY_MAX_BYTES = 1024 * 1024;
/** The ancestors' executable names (as `ps` prints them: a path on macOS), nearest first, or null. */
export function readAncestry(seams = {}) {
    try {
        const platform = seams.platform ?? process.platform;
        const now = seams.now ?? Date.now;
        const deadline = now() + ANCESTRY_MAX_MS;
        const start = seams.ppid ?? process.ppid;
        if (!Number.isSafeInteger(start) || start <= 0)
            return null;
        if (platform === "darwin")
            return walkListing(parsePs((seams.ps ?? realPs)(Math.max(1, deadline - now()), ANCESTRY_MAX_BYTES)), start, seams.pid ?? process.pid, now, deadline);
        if (platform === "linux")
            return walkProc(seams.procStat ?? realProcStat, seams.procExe ?? realProcExe, start, now, deadline);
        return null;
    }
    catch {
        return null;
    }
}
/**
 * `ps -A -o pid=,ppid=,comm=`: `<pid> <ppid> <comm>` per line, the comm being the rest of the line (it may hold spaces). A line that does not parse is skipped. Null in, null out.
 * ⛔ Parsed BY HAND, one pass over the characters: this runs inside `git commit` and a regex over a listing is a linear-time promise nobody reads (C68).
 */
export function parsePs(text) {
    if (text === null)
        return null;
    const rows = new Map();
    for (const line of text.split("\n")) {
        const row = parsePsLine(line);
        if (row !== null)
            rows.set(row.pid, { ppid: row.ppid, comm: row.comm });
    }
    return rows;
}
const isBlank = (code) => code === 0x20 || code === 0x09;
const isDigit = (code) => code >= 0x30 && code <= 0x39;
function parsePsLine(line) {
    let i = 0;
    const number = () => {
        while (i < line.length && isBlank(line.charCodeAt(i)))
            i += 1;
        const start = i;
        while (i < line.length && isDigit(line.charCodeAt(i)))
            i += 1;
        if (i === start || i - start > 12)
            return null;
        return Number(line.slice(start, i));
    };
    const pid = number();
    if (pid === null || i >= line.length || !isBlank(line.charCodeAt(i)))
        return null;
    const ppid = number();
    if (ppid === null || i >= line.length || !isBlank(line.charCodeAt(i)))
        return null;
    const comm = line.slice(i).trim();
    return comm === "" ? null : { pid, ppid, comm };
}
function walkListing(rows, start, self, now, deadline) {
    if (rows === null)
        return null;
    const out = [];
    const seen = new Set([self]);
    let pid = start;
    while (out.length < ANCESTRY_MAX_DEPTH && pid > 0 && !seen.has(pid)) {
        if (now() > deadline)
            return null;
        const row = rows.get(pid);
        if (row === undefined)
            break;
        seen.add(pid);
        out.push(row.comm);
        pid = row.ppid;
    }
    return out.length === 0 ? null : out;
}
function realPs(timeoutMs, maxBytes) {
    try {
        // `maxBuffer` is the size bound: a longer listing makes the call throw, which is null (not a truncated listing that could hide the nearest agent).
        return execFileSync("ps", ["-A", "-o", "pid=,ppid=,comm="], { encoding: "utf8", timeout: timeoutMs, maxBuffer: maxBytes, stdio: ["ignore", "pipe", "ignore"] });
    }
    catch {
        return null;
    }
}
// --- Linux ------------------------------------------------------------------------------------------------------------------------
/** `/proc/<pid>/stat`: `pid (comm) state ppid …`. The comm may hold spaces and parentheses, so the LAST `)` ends it. Null when it does not parse. */
export function parseProcStat(text) {
    const open = text.indexOf("(");
    const close = text.lastIndexOf(")");
    if (open < 0 || close < open)
        return null;
    const rest = text.slice(close + 1).split(" ").filter((field) => field !== "");
    const ppid = Number(rest[1]);
    return rest[1] !== undefined && Number.isSafeInteger(ppid) && ppid >= 0 ? { comm: text.slice(open + 1, close), ppid } : null;
}
function walkProc(stat, exe, start, now, deadline) {
    const out = [];
    const seen = new Set();
    let pid = start;
    let bytes = 0;
    while (out.length < ANCESTRY_MAX_DEPTH && pid > 0 && !seen.has(pid)) {
        if (now() > deadline)
            return null;
        const text = stat(pid);
        if (text === null)
            break;
        bytes += text.length;
        if (bytes > ANCESTRY_MAX_BYTES)
            return null;
        const parsed = parseProcStat(text);
        if (parsed === null)
            return null;
        seen.add(pid);
        out.push(exe(pid) ?? parsed.comm);
        pid = parsed.ppid;
    }
    return out.length === 0 ? null : out;
}
function realProcStat(pid) {
    try {
        return readFileSync(`/proc/${pid}/stat`, "utf8");
    }
    catch {
        return null;
    }
}
function realProcExe(pid) {
    try {
        return readlinkSync(`/proc/${pid}/exe`);
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=process_ancestry.js.map