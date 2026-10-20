// test/collector/arch/darwin/socktable-real.test.mjs — the door's owner question against the REAL kernel (RFC 4.9 §5.3; the platform-seam rule: the
// process seam's default path has a real e2e). A child process connects to a real loopback listener of this test; the shipped `socktable` helper,
// run the way the daemon runs it (execTool over runAsync, from node), must name that child's pid for the peer the listener accepted. This is the
// shape that broke on macOS 27 (a macOS machine 2026-10-20): under a node the OS does not trust, `netstat` printed no TCP table and every connection was
// spliced `pid-unresolved`. The helper runs from a COPY inside the temp dir (0.1 §3: the committed binary is a tool no-real-os refuses; a copy on
// the test's own path is what the rule allows). Nothing outside the temp dir is touched and no daemon is asked.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { tmpDir } from '../../../helpers/tmp.mjs'
import { WITH_PARENT, watchEnv } from '../../../helpers/standin.mjs'
import { execTool, runAsync } from '../../../../src/off/exec.mjs'
import { ownerOfSocket } from '../../../../src/collector/arch/darwin/socktable.mjs'
import { NATIVE, nativePath } from '../../../../src/collector/arch/darwin/native.mjs'

test('real kernel: the helper names the process that holds the peer\'s socket — a child that connected, not the test that accepted', { skip: process.platform !== 'darwin' && 'macOS only' }, async () => {
  const helper = path.join(tmpDir('asight-socktable-real-'), NATIVE.socktable)
  fs.copyFileSync(nativePath(NATIVE.socktable), helper)
  fs.chmodSync(helper, 0o755)
  const server = net.createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const accepted = once(server, 'connection')
  const child = spawn(process.execPath, [...WITH_PARENT, '-e', `require('net').connect(${server.address().port}, '127.0.0.1').on('connect', () => console.log('up')); setInterval(() => {}, 1000)`], { stdio: ['ignore', 'pipe', 'inherit'], env: watchEnv() }) // ends with this test process (test/helpers/standin.mjs)
  try {
    const [sock] = await accepted
    const failures = []
    const exec = (file, args, o = {}) => execTool(file, args, { ...o, run: runAsync }) // the daemon's runner (arch/model-backends.mjs doorPartsFor)
    const r = await ownerOfSocket({ exec, peer: { address: sock.remoteAddress, port: sock.remotePort }, socktablePath: helper, onFailure: (e) => failures.push(e) })
    assert.deepEqual(failures, [], 'the table was read')
    assert.deepEqual([r.pid, r.source], [child.pid, 'socket-table'])
    sock.destroy()
  } finally {
    child.kill()
    server.close()
  }
})
