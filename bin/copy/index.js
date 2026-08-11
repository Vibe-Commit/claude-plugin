/**
 * Single entry point for all user-facing copy.
 *
 * Command bodies import from HERE and nowhere else. If you find yourself typing
 * a quoted user-facing string inside a command, it belongs in `strings.ts`; if
 * it describes a commit's evidence, it belongs in `grades.ts` behind the one
 * header renderer.
 */
export { HELP, USAGE, STATUS, CONNECT, SIGNIN, OFF, REPORT, ABSENCE, ERRORS, INTERNAL, CREDENTIAL, RUNTIME, SYSTEM_MESSAGE, REDACTION, COMMANDS, URLS, PATH_CLASH, } from "./strings.js";
export { relativeAge } from "./time.js";
export { renderCommitHeader, gradeFloor, gradeCopyFor, ALL_GRADES, } from "./grades.js";
export { BLOCKED_PHRASES, findClaimViolations, } from "./claims.js";
//# sourceMappingURL=index.js.map