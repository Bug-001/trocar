// old-capture.mjs — the pinned list of files that belong to the OLD capture (D22 / D28 / D29: the Clash steer, the MITM, and `asight off`'s undo of them), shared by the source scans that
// watch all of src/ (4.7 N15's no-vpn-writes.test.mjs and the D43 scan of no-sysproxy-no-elevation.test.mjs). The old capture's writes into Verge's Script.js and its login-env plist are what it
// is; 1.6 §4 and §6 book them, and the whole thing goes when the old capture retires. The exemption is a pinned list of two, not a switch: one more entry is a decision, taken with 4.7 N15.

/** Files of the old capture, by path under the repo root: everything under src/capture/, and the src/off/legacy*.mjs files. */
export const OLD_CAPTURE = Object.freeze([/^src\/capture\//, /^src\/off\/legacy[^/]*\.mjs$/])
export const isOldCapture = (file) => OLD_CAPTURE.some((re) => re.test(file))
