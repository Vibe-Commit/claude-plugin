/**
 * The transcript lane, as a type.
 *
 * `CR-183`, D164 §1. The registry key is the transcript FORMAT, not the agent:
 * Codex CLI is the second member of ONE lane, not a special case.
 *
 * ## The scope statement, verbatim — it is the whole membership rule
 *
 * > Agents that append NDJSON to a file and hand a hook its path.
 *
 * Read it as an exclusion, because that is the work it does. An agent whose
 * transcript is Markdown, or a database, or is never handed to a hook at all, is
 * NOT a member — and adding one is a different capture STRATEGY, not another
 * entry in this file. `docs/architecture_refactor.md` lists eleven agents; this
 * lane covers five of them after `CR-193` (D177 §1). "Config not code" is true
 * WITHIN the lane and false across lanes (D164), and the type below is what
 * makes that difference mechanical rather than a promise in a comment.
 *
 * ## Why the lock-out is `transport` and not a runtime check
 *
 * `transport: "ndjson"` is a LITERAL type, so a dialect for a Markdown-transcript
 * agent cannot be registered without EDITING THIS INTERFACE. That is a compile
 * error in a diff a human reads, rather than a config line nobody reviews.
 *
 * It is not decoration. D164's first ruling names the defect it prevents:
 * `redact.ts` parses each line as JSON and returns any NON-JSON line UNCHANGED,
 * which is correct for a partial line at a span boundary and catastrophic for a
 * transcript that is not JSON at all — every line would ship unredacted.
 * Redaction correctness is a property of the FORMAT, so the format is what the
 * type system has to pin.
 *
 * ## The members are limited to what two confirmed differences justify
 *
 * `transcriptRoot`, `admitsFile`, `events`, `delegatedTranscripts`, `redaction`
 * and the optional `locateCurrentTranscript` differ between the three members
 * that exist. `id` names them and `transport` locks the lane. Nothing else is
 * here, and the omissions are deliberate rather than pending: a field whose only
 * member set is a guess about an agent nobody has measured is a decision made
 * early with no evidence, and it will be wrong in the direction that is
 * expensive to undo.
 *
 * ⚠ **`admitsFile` is `CR-193`'s, and it clears that bar rather than bending
 * it** (D177 §2): it was one of `CR-183`'s seven speculative exclusions until a
 * MEASUREMENT un-excluded it — 113 files under Cursor's root, exactly one of
 * them a transcript.
 */
/**
 * D164 §1's third value — a producer nobody can name, never a dialect.
 *
 * ⛔ **AND IT NEVER TRAVELS.** The docblock above stays literally true after
 * `CR-204`: this is the SELECTOR's answer for a transcript no single registry
 * root contains, and `buildIngestHeaders` turns that answer into an **omitted**
 * header rather than a sent one. The server distinguishes the two — an absent
 * header is *"nothing to say"* and cannot disagree with the value a stream is
 * already pinned to, while a present `unknown` resolves and **does** disagree,
 * which drops the buffered tail and sheds the in-flight turn. See `post.ts`.
 */
export const UNKNOWN_AGENT_ID = "unknown";
/**
 * The three hook events DESIGN.md §13.7 names.
 *
 * Both members of this lane fire the same three; that is exactly why
 * `hook_event_name` was REJECTED as an adapter selector (`CR-183`) — the events
 * are shared, so they discriminate nothing.
 */
export const HOOK_EVENTS = ["Stop", "PreCompact", "SessionEnd"];
//# sourceMappingURL=types.js.map