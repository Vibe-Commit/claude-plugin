/**
 * The CLI's own decision whether the verb-start revoke retry runs (`retryPendingRevokes`, cli.ts).
 *
 * 0.17.4 (P6's binding condition on P7's items 10 and 11): ONE predicate, used by cli.ts to run the retry and by `auth` to choose its
 * paste whys, so the words cannot drift from whether the retry ran. `auth` says "no credential was saved" exactly where the retry may
 * have rewritten or deleted pending-revoke.json, and keeps "nothing was written" exactly where it did not run.
 *
 * Pure, and imports nothing: `vibecommit hook` loads cli.ts, and the hook path must never import the module that holds a token.
 */
/** `argv` may start with the verb (cli.ts) or not (a verb's own arguments): only flags are looked at. */
export function verbStartRetryRuns(verb, argv, ctx) {
    // Not for `--help`, not for `scan` (network-free by contract, README).
    if (verb === "scan" || argv.includes("--help") || argv.includes("-h"))
        return false;
    // F8 (L10): nor for `auth` run with `--stdin`, piped or with no terminal ("it only saves the credential" stays exactly true of it).
    return !(verb === "auth" && (argv.includes("--stdin") || !ctx.stdinIsTty));
}
//# sourceMappingURL=verb_start.js.map