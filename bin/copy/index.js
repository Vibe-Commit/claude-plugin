/**
 * Single entry point for all user-facing copy.
 *
 * Command bodies import from HERE and nowhere else. If you find yourself typing
 * a quoted user-facing string inside a command, it belongs in `strings.ts`; if
 * it describes a commit's evidence, it belongs in `grades.ts` behind the one
 * header renderer.
 */
export { HELP, STATUS, CONNECT, OFF, REPORT, ERRORS, INTERNAL, CREDENTIAL, RUNTIME, SYSTEM_MESSAGE, COMMANDS, URLS, } from "./strings.js";
export { renderCommitHeader, gradeFloor, gradeCopyFor, ALL_GRADES, } from "./grades.js";
export { BLOCKED_PHRASES, findClaimViolations, } from "./claims.js";
//# sourceMappingURL=index.js.map