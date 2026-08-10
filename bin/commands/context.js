/**
 * What an interactive verb is handed.
 *
 * Everything ambient — env, home, cwd, the TTY answer, the clock — arrives as
 * data. No verb calls `os.homedir()`, `process.cwd()` or `Date.now()` itself,
 * which is what lets the tests drive a real binary against a temp HOME without
 * the risk of a test run touching the developer's own credentials.
 */
export function writeLines(stream, lines) {
    if (lines.length === 0)
        return;
    stream.write(`${lines.join("\n")}\n`);
}
//# sourceMappingURL=context.js.map