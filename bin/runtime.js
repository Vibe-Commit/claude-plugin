/**
 * The Node floor — D57 (plan §DX11).
 *
 * `>= 22.15.0`. Two enforcement points, deliberately different in loudness:
 *   - `connect` refuses loudly, because the user is watching and can act.
 *   - the hook self-checks and says it once per session through `systemMessage`,
 *     because a hook that fails silently on an old runtime IS the
 *     silent-unconfigured default that DX3 exists to kill.
 *
 * `engines` in `package.json` does NOT cover this. npm only warns by default, and
 * the plugin lane (`CR-028`) vendors the binary and invokes it by path, so npm is
 * not in the loop at hook time at all.
 */
export const NODE_FLOOR = { major: 22, minor: 15, patch: 0 };
export const NODE_FLOOR_TEXT = `${NODE_FLOOR.major}.${NODE_FLOOR.minor}`;
/**
 * Parse a `process.versions.node` string. Returns null on anything unexpected —
 * an unparseable version is treated as unsupported, because guessing in the
 * permissive direction is how a floor stops being a floor.
 */
export function parseNodeVersion(version) {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
    if (!m)
        return null;
    return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}
export function meetsNodeFloor(version) {
    const v = parseNodeVersion(version);
    if (v === null)
        return false;
    if (v.major !== NODE_FLOOR.major)
        return v.major > NODE_FLOOR.major;
    if (v.minor !== NODE_FLOOR.minor)
        return v.minor > NODE_FLOOR.minor;
    return v.patch >= NODE_FLOOR.patch;
}
//# sourceMappingURL=runtime.js.map