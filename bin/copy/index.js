/**
 * Single entry point for all user-facing copy.
 *
 * Command bodies import from HERE and nowhere else. If you find yourself typing
 * a quoted user-facing string inside a command, it belongs in `strings.ts`; if
 * it describes a commit's evidence, it belongs in `grades.ts` behind the one
 * header renderer.
 */
export { HELP, USAGE, STATUS, FINALIZE, CONNECT, SIGNIN, OFF, SCAN, BACKFILL, PICKER, WHY, REPORT, ABSENCE, ERRORS, INTERNAL, CREDENTIAL, AUTH, RUNTIME, SYSTEM_MESSAGE, REDACTION, COMMANDS, URLS, AGENT_HOOKS, COMMIT_HOOK, PATH_CLASH, REJECTED, RETIRE, REPLACE, DEVICE, UPDATE, } from "./strings.js";
export { relativeAge, shortDate } from "./time.js";
export { renderCommitHeader, renderCommitIdentity, gradeFloor, gradeCopyFor, ALL_GRADES, } from "./grades.js";
export { BLOCKED_PHRASES, findClaimViolations, } from "./claims.js";
//# sourceMappingURL=index.js.map