/**
 * The public verbs, in the order `--help` lists them.
 *
 * Its own module so `index.ts` can answer `isVerb` without importing a single verb: `index.ts` is the process a hook is, and
 * it must stay free of the interactive half (`cli.ts`; `test/load-path.test.ts`). `renderHelp` iterates this list, so adding
 * a verb here moves `test/help.golden.txt` on purpose. The hidden verbs (`hook`, `post-commit`, `post-rewrite`) are NOT here
 * for exactly that reason.
 */
export const VERBS = ["auth", "connect", "scan", "backfill", "status", "off", "why", "report", "finalize"];
/**
 * The groups the top-level help lists the verbs under (plan 4.3). Each verb is in exactly one group
 * (`test/help-grouped.test.ts`), so a new verb cannot drop out of help. The labels are shown uppercase.
 */
export const VERB_GROUPS = {
    "SET UP": ["connect", "backfill", "auth"],
    CHECK: ["status", "scan", "why", "report"],
    CHANGE: ["off", "finalize"],
};
export function isVerb(value) {
    return VERBS.includes(value);
}
//# sourceMappingURL=verbs.js.map