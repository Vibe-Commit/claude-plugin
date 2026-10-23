/**
 * Should this machine sign in by CODE rather than by browser? — `CR-234d`, plan item 7.
 *
 * The loopback sign-in opens a browser on THIS machine and waits for it to call back to `127.0.0.1`. That
 * cannot work where the person is not sitting at the machine's own screen:
 *
 *   - over SSH (`SSH_CONNECTION` or `SSH_TTY` is set), and
 *   - on Linux with no display server (neither `DISPLAY` nor `WAYLAND_DISPLAY`) — a container, a bare VM.
 *
 * macOS and Windows have no such signal: a Mac reached over SSH is caught by the first rule, and a desktop
 * one always has a window server. Anything not matched here still falls back to device mode when the
 * browser fails to open (`signIn`'s `fallbackOnNoBrowser`), so a wrong guess costs one extra step, not a hang.
 *
 * A pure function of the environment, so the whole table is a test.
 */
function set(env, name) {
    const value = env[name];
    return value !== undefined && value.trim() !== "";
}
/** Why this machine has no usable browser, or null when it plausibly has one. */
export function headlessReason(env, platform) {
    if (set(env, "SSH_CONNECTION") || set(env, "SSH_TTY"))
        return "ssh";
    if (platform === "linux" && !set(env, "DISPLAY") && !set(env, "WAYLAND_DISPLAY"))
        return "no-display";
    return null;
}
//# sourceMappingURL=device_mode.js.map