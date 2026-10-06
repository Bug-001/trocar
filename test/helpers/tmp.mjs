// test/helpers/tmp.mjs — a temp directory that is gone when the test process ends, however it ends.
//
// Each test file runs in its own process, so "when the process ends" is "when the file is done": after every test passed, after
// a failed assertion cut a test short (a `fs.rmSync(dir)` written at the END of a test body never ran then), after an uncaught
// throw, after `--test-force-exit`'s process.exit(). Before this, a full `npm test` left 116 `asight-*` directories in the OS
// temp dir (161 with every assertion failing), and an unattended machine collects them for ever.
//
//   import { tmpDir } from '../helpers/tmp.mjs'
//   const dir = tmpDir('asight-foo-')          // was: fs.mkdtempSync(path.join(os.tmpdir(), 'asight-foo-'))
//
// Ctrl-C (SIGINT), SIGTERM and SIGHUP clean up too, then die of the signal as they would have. A kill -9 cannot run any
// cleanup: `npm test`'s leak check (test/helpers/leak-guard.cjs) is what says so.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import rm from './rm-tree.cjs'

const made = new Set()
let armed = false

/** A fresh directory under os.tmpdir(), removed with everything in it (read-only entries too) when this process exits. */
export function tmpDir(prefix = 'asight-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  made.add(dir)
  if (!armed) {
    armed = true
    process.on('exit', removeAll)
    // our handler goes away after one call, so the signal's own default (die of it) is what runs after the cleanup
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(sig, () => { removeAll(); process.kill(process.pid, sig) })
  }
  return dir
}

/** Removes a directory tmpDir made now, rather than at exit (a test that wants the path gone to prove something). It only ever
 *  removes what tmpDir returned in this process: any other path is left alone, so a wrong argument cannot delete anything real. */
export function removeTmp(dir) {
  if (!made.has(dir)) return
  rm.removeTree(dir)
  made.delete(dir)
}

function removeAll() {
  for (const dir of made) rm.removeTree(dir)
  made.clear()
}
