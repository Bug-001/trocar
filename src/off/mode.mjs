// mode.mjs — proxy mode or driver mode (RFC 0.0 D47), the one place in src/off/ that knows which OS is which; nobody else here writes
// `platform === 'darwin' || platform === 'win32'` to mean "the engine is the local proxy". Why `off` cares (D62 ⑥): in driver mode the
// kernel steers, so the daemon's exit is WHAT takes the watch table and the links off — `off` with no names asks it to exit. In proxy
// mode the engine's own doors steer, so closing them is the whole of it: the daemon idles on, every door shut, and the next `on` just
// asks it (no `launchctl kickstart`, no ThrottleInterval, no respawn that KeepAlive could turn into a crash loop).
// Imports nothing (src/off/ runs without the repo, 0.1 §2). The collector's own copy of this fact is `isModelOs`
// (src/collector/model-install.mjs MODEL_OS); test/off/mode.test.mjs holds the two to each other.

/** Does `platform` (a `process.platform` value) steer through the engine's doors — proxy mode, D47 — rather than through the kernel? */
export const isProxyMode = (platform) => platform === 'darwin' || platform === 'win32'
