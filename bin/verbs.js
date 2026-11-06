/**
 * The public verbs, in the order `--help` lists them.
 *
 * Its own module so `index.ts` can answer `isVerb` without importing a single verb: `index.ts` is the process a hook is, and
 * it must stay free of the interactive half (`cli.ts`; `test/load-path.test.ts`). `renderHelp` iterates this list, so adding
 * a verb here moves `test/help.golden.txt` on purpose. The hidden verbs (`hook`, `post-commit`, `post-rewrite`) are NOT here
 * for exactly that reason.
 */
export const VERBS = ["auth", "connect", "scan", "backfill", "status", "off", "why", "report", "finalize"];
export function isVerb(value) {
    return VERBS.includes(value);
}
//# sourceMappingURL=verbs.js.map