/**
 * The update nudge — `13A`, G7.
 *
 * The CLI had no way to learn that a better one existed: Alexander's machine ran 0.2.3 against an
 * npm `latest` of 0.4.5 and nothing said so. mcp's `GET /client/latest` answers `{ npm?: "x.y.z" }`
 * (it reads npm's `dist-tags.latest`; there is no `plugin` field until TODOS[178]), so user machines
 * still talk to one host.
 *
 * ## When it speaks
 *
 * Interactive `status`, `connect` and `auth` — after the verb has SUCCEEDED, as the last thing on
 * screen, after a blank line. Never after an error (the §13.6 fix line must stay last), never in a
 * hook, never under `--json`, never when stdout is not a terminal, never with
 * `VIBECOMMIT_NO_UPDATE_CHECK=1`.
 *
 * ## ⛔ IT FAILS SILENT, EVERYWHERE
 *
 * Any failure — no channel, a timeout, a bad body, an unwritable cache — returns no lines. The
 * version string is printed only if it matches `^\d+\.\d+\.\d+$` and is newer than this build: it
 * comes from a network response and lands on a user's terminal, so it must be a version and nothing
 * else. The answer (or its absence) is cached for 24 hours, so an offline machine pays the 2 s once
 * a day, not on every command.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { writeFileAtomic } from "./atomic_write.js";
import { UPDATE } from "./copy/index.js";
import { installChannel } from "./install.js";
import { mcpUrl } from "./oauth/discovery.js";
import { stateDir, updateCheckPath } from "./paths.js";
import { paint } from "./term.js";
import { CLIENT_VERSION, CLIENT_VERSION_HEADER } from "./version.js";
export const LATEST_PATH = "/client/latest";
const CACHE_MS = 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 2_000;
const VERSION = /^\d+\.\d+\.\d+$/;
/** True when `a` is a newer x.y.z than `b`. Both must already match `VERSION`. */
export function isNewer(a, b) {
    const x = a.split(".").map(Number);
    const y = b.split(".").map(Number);
    for (let i = 0; i < 3; i += 1) {
        if ((x[i] ?? 0) !== (y[i] ?? 0))
            return (x[i] ?? 0) > (y[i] ?? 0);
    }
    return false;
}
const version = (v) => (typeof v === "string" && VERSION.test(v) ? v : undefined);
function readCache(home, nowMs) {
    try {
        const doc = JSON.parse(readFileSync(updateCheckPath(home), "utf8"));
        if (typeof doc.checked_at_ms !== "number" || nowMs - doc.checked_at_ms > CACHE_MS)
            return null;
        if (doc.checked_at_ms > nowMs)
            return null; // a clock that moved backwards: ask again
        return { npm: version(doc.npm), plugin: version(doc.plugin) };
    }
    catch {
        return null;
    }
}
function writeCache(home, nowMs, latest) {
    try {
        mkdirSync(stateDir(home), { recursive: true, mode: 0o700 });
        writeFileAtomic(updateCheckPath(home), `${JSON.stringify({ checked_at_ms: nowMs, ...latest })}\n`, 0o600);
    }
    catch {
        /* a cache that cannot be written costs one more request tomorrow */
    }
}
async function fetchLatest(endpoint, fetchImpl) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
        const res = await fetchImpl(new URL(LATEST_PATH, endpoint).toString(), {
            headers: { accept: "application/json", [CLIENT_VERSION_HEADER.toLowerCase()]: CLIENT_VERSION },
            signal: controller.signal,
            redirect: "error",
        });
        if (res.status !== 200)
            return {};
        const doc = (await res.json());
        return { npm: version(doc?.npm), plugin: version(doc?.plugin) };
    }
    catch {
        return {};
    }
    finally {
        clearTimeout(timer);
    }
}
/** The lines to print after a successful verb — `[]` for every reason not to. */
export async function updateNudge(ctx, deps = {}) {
    try {
        if (ctx.env.VIBECOMMIT_NO_UPDATE_CHECK === "1")
            return [];
        if (ctx.stdout.isTTY !== true)
            return [];
        const channel = installChannel(ctx.env, ctx.selfPath);
        if (channel.kind === "unknown")
            return [];
        const endpoint = mcpUrl(ctx.env);
        if (endpoint === null)
            return [];
        const nowMs = ctx.now().getTime();
        let latest = readCache(ctx.home, nowMs);
        if (latest === null) {
            latest = await fetchLatest(endpoint, deps.fetch ?? fetch);
            writeCache(ctx.home, nowMs, latest);
        }
        if (channel.kind === "npm") {
            if (latest.npm === undefined || !isNewer(latest.npm, CLIENT_VERSION))
                return [];
            return [
                "",
                `  ${paint(ctx.colour, "muted", UPDATE.npm(latest.npm, CLIENT_VERSION))}`,
                `    ${paint(ctx.colour, "accent", UPDATE.npmCommand)}`,
            ];
        }
        // plugin
        if (latest.plugin === undefined || !isNewer(latest.plugin, CLIENT_VERSION))
            return [];
        return ["", `  ${paint(ctx.colour, "muted", UPDATE.plugin(latest.plugin))}`];
    }
    catch {
        return [];
    }
}
//# sourceMappingURL=update_nudge.js.map