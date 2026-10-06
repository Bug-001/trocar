// test/helpers/no-real-os.cjs — `--require` preload for `npm test`: marks every test process as a sandbox (ASIGHT_TEST_SANDBOX=1).
//
// 0.1 §3 「不碰真实机器」: the author's Mac runs the old capture while the tests run, and the user's real launchctl, systemctl,
// security and certutil are one forgotten injected runner away. src/off/exec.mjs (the one way new code runs an OS tool) reads
// the flag and refuses to spawn a real tool when it is set: a stub inside the temp dir, or an injected runner, is all it runs.
// Load it with `--require` like the other preloads; the test files' children inherit the variable. Guard: test/off/exec.test.mjs.
'use strict'
process.env.ASIGHT_TEST_SANDBOX = '1'
