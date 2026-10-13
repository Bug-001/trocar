// old-capture.mjs — the pinned list of files that belong to the OLD capture (D22: the Clash steer, the MITM, and its undo), shared by the source scans that
// watch all of src/ (4.7 N15's no-vpn-writes.test.mjs and the D43 scan of no-sysproxy-no-elevation.test.mjs). The old capture's writes into Verge's Script.js and its login-env plist are what it
// is. D39⑥ executed 2026-10-11 retired the old capture's reachable code; what is left on disk under src/capture/ (the orphaned steer / agents library and the readers of
// what the old capture wrote) keeps the exemption until it is swept. The src/off/legacy*.mjs leg went with the files — an exemption must not outlive what it exempts, or a FUTURE src/off/legacy*.mjs
// would be exempt sight unseen. The exemption is a pinned list, not a switch: one more entry is a decision, taken with 4.7 N15.

/** Files of the old capture, by path under the repo root: everything under src/capture/. */
export const OLD_CAPTURE = Object.freeze([/^src\/capture\//])
export const isOldCapture = (file) => OLD_CAPTURE.some((re) => re.test(file))
