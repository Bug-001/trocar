// test/rules/helpers/never-writes.mjs — the shapes a path takes on each platform to stop a reader or a writer, for tests that hold on all of them.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { TMP_MARK } from '../../../src/off/fsutil.mjs'
import { tmpDir } from '../../helpers/tmp.mjs'

/** What opens and then blocks a reader for good: a FIFO on POSIX, a link to a named pipe nobody writes to on Windows. */
export async function neverWrites(file, t) {
  if (process.platform !== 'win32') return assert.equal(spawnSync('mkfifo', [file]).status, 0)
  const pipe = `\\\\.\\pipe\\${path.basename(tmpDir('never-writes-'))}`, server = net.createServer(() => {})
  await new Promise((resolve) => server.listen(pipe, resolve))
  t.after(() => server.close())
  fs.symlinkSync(pipe, file, 'file')
}

/** Stops writes to `file` in this process until the returned function runs: a read-only directory on POSIX. Windows has no such mode, so there the temp name it writes first is taken. */
export function readOnly(dir, file) {
  if (process.platform !== 'win32') {
    fs.chmodSync(dir, 0o500)
    return () => fs.chmodSync(dir, 0o700)
  }
  const tmp = `${file}${TMP_MARK}${process.pid}`
  fs.mkdirSync(tmp)
  return () => fs.rmdirSync(tmp)
}
