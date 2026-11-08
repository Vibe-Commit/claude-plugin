/**
 * Two tiny readers every dialect's "who is committing" evidence shares (multi-session attribution, T1). Pure: no file, no clock, and the environment is a
 * PARAMETER (a module that read `process.env` here could not be tested without the developer's own session ids).
 */
/** An environment variable's value, trimmed, or `null` when unset or blank. An exported-but-empty variable is the shell's idea of unset: a `""` id would key a bucket every unset process shares. */
export function envValue(env, name) {
    const raw = env[name];
    if (raw === undefined)
        return null;
    const value = raw.trim();
    return value === "" ? null : value;
}
/**
 * The executable's own name from what `ps` prints as `comm` (macOS prints the full path, Linux the 15-character name or the `/proc/<pid>/exe` target): the text after the last `/`.
 * Only the NAME ever leaves the process listing; no argv and no other process's environment is read.
 */
export function executableName(comm) {
    const trimmed = comm.trim();
    return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}
//# sourceMappingURL=evidence.js.map