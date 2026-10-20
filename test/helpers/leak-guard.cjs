// test/helpers/leak-guard.cjs — `--require` preload for `npm test`: the run fails if its tests leave temp entries behind.
//
// The test runner's own process loads `--require` preloads and not `--import` ones, which is why this is CommonJS. It makes a
// temp directory that belongs to this run alone and points TMPDIR (and TMP / TEMP) at it, so every test file's `os.tmpdir()` — the
// children inherit the environment — is inside it. When the run ends, whatever is still there is something a test made and did
// not remove: it is named on stderr, removed, and the exit code becomes 1. Because the directory is private, another `npm test`
// running at the same time, or old leftovers from before, are never counted against this run — which a before / after listing
// of the shared OS temp dir cannot promise.
//
// A leak is a directory, or an entry named like ours (`trocar-…`, `as-…`, `atrace-…`); a stray file some library drops in TMPDIR is
// removed with the rest and not blamed on a test. The fix for a leak is `tmpDir()` from test/helpers/tmp.mjs, which removes the
// directory when the test process ends, pass or fail. Guard: test/helpers/leak-guard.test.mjs.
'use strict'
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { removeTree } = require('./rm-tree.cjs')

const OURS = /^(trocar|as|atrace)-/

/** True for a directory; false for anything else, and for an entry that has gone since it was listed (it must not end the check). */
function isDir(p) {
  try { return fs.lstatSync(p).isDirectory() } catch { return false }
}

/** What of `entries` (names inside the run's directory) counts as a leak. */
function leaked(dir, entries) {
  return entries.filter((name) => OURS.test(name) || isDir(path.join(dir, name)))
}

// the runner is the process that was started with --test; a test file's process has NODE_TEST_CONTEXT, and a plain `node file` has neither
if (process.execArgv.includes('--test') && !process.env.NODE_TEST_CONTEXT) {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trocar-run-'))
  for (const key of ['TMPDIR', 'TMP', 'TEMP']) process.env[key] = runDir
  process.on('exit', () => {
    let left = []
    try { left = leaked(runDir, fs.readdirSync(runDir)) } catch { /* the run's directory was taken away: nothing to blame */ }
    if (left.length) {
      const shown = left.map((name) => `  ${name}${isDir(path.join(runDir, name)) ? '/' : ''}`)
      const many = left.length === 1
      fs.writeSync(2, `\nleak-guard: ${left.length} temp ${many ? 'entry' : 'entries'} made by this test run ${many ? 'was' : 'were'} not removed (removed now):\n${shown.join('\n')}\n` +
        `  find the test that made one with: grep -rn "'${left[0].replace(/[A-Za-z0-9]{6}$/, '')}" test\n` +
        '  make test directories with tmpDir() from test/helpers/tmp.mjs; it removes them when the test process ends, pass or fail\n')
      process.exitCode = 1
    }
    removeTree(runDir)
  })
}

module.exports = { leaked }
