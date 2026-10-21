// test/collector/arch/darwin/pac-left-real.test.mjs — the PAC door's refusal against the REAL kernel (RFC 4.11 P10, 4.8 §5.1, 4.9 §5.3; the platform seam rule:
// the process seam's default path has a real e2e). A macOS machine's daemon wrote 26 `pac-peer-refused … (owner no-row)` on 2026-10-21 with no other user's
// process anywhere near the door: a client that sent its CONNECT and closed before the socket table was read has no holder left (its fd is gone; the
// kernel keeps the socket without one), so the owner question is `no-row` and the door's answer is a refusal of a connection that no longer exists. A
// connection that left while it was judged is refused nothing: no record, counted `left`. A live client of this user is still named, over IPv4 and over
// a dual-stack (v4-mapped IPv6) socket alike. Real sockets, the shipped `socktable` helper from a copy in the temp dir (0.1 §3), the real ingress; no daemon.
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
import { createIngress } from '../../../../src/collector/core/engine/ingress.mjs'
import { peerAllowed } from '../../../../src/collector/core/proxymode/pac.mjs'

const SKIP = { skip: process.platform !== 'darwin' && 'macOS only', timeout: 20_000 }
const exec = (file, args, o = {}) => execTool(file, args, { ...o, run: runAsync }) // the daemon's runner (arch/model-backends.mjs doorPartsFor)
const me = { uid: process.getuid() }

/** A PAC door (auth:false) whose lookup asks the real socket table once `ready` settles, and answers as the PAC door does (peerAllowed, P10). */
async function pacDoor(t, ready) {
  const helper = path.join(tmpDir('trocar-pac-left-'), NATIVE.socktable)
  fs.copyFileSync(nativePath(NATIVE.socktable), helper)
  fs.chmodSync(helper, 0o755)
  const failures = [], owners = []
  const lookupIngress = async ({ peer }) => {
    await ready()
    const o = await ownerOfSocket({ exec, peer, socktablePath: helper })
    owners.push(o)
    const a = peerAllowed({ pid: o.pid, ...(o.pid != null ? me : {}), ...(o.sameUser ? { sameUser: true } : {}) }, me)
    return a.ok ? null : { refuse: { code: a.code, unread: a.unread, reason: `${a.detail} (owner ${o.why})` } }
  }
  const ing = createIngress({ token: 'f'.repeat(32), failure: (f) => failures.push(f), handleFlow: () => {}, connectUpstream: () => { throw new Error('no upstream here') }, lookupIngress })
  const srv = net.createServer((s) => ing.connection(s, { user: 'h:pac', token: null, open: true }))
  srv.listen(0, '127.0.0.1')
  await once(srv, 'listening')
  t.after(() => new Promise((r) => srv.close(r)))
  return { port: srv.address().port, failures, owners, stats: ing.stats }
}
const client = (port, host, then) => spawn(process.execPath, [...WITH_PARENT, '-e',
  `const s = require('net').connect(${port}, ${JSON.stringify(host)}, () => s.write('CONNECT api.example:443 HTTP/1.1\\r\\nHost: api.example:443\\r\\n\\r\\n', () => { ${then} })); s.on('error', () => {}); setInterval(() => {}, 1000)`],
{ stdio: 'ignore', env: watchEnv() })
const until = async (f) => { while (!f()) await new Promise((r) => setTimeout(r, 10)) }

test('real kernel: a client that sent its CONNECT and exited before its owner was read is `no-row` — and the door records no refusal for it, it counts `left`', SKIP, async (t) => {
  let child = null
  const d = await pacDoor(t, () => (child.exitCode !== null || child.signalCode !== null ? null : once(child, 'exit')))
  child = client(d.port, '127.0.0.1', 'process.exit(0)')
  await until(() => (d.stats().left || 0) + d.failures.length > 0)
  assert.deepEqual(d.owners.map((o) => [o.pid, o.why]), [[null, 'no-row']], 'the gone client has no holder: a macOS machine\'s `owner no-row`')
  assert.deepEqual(d.failures, [], 'nothing was refused: no pac-peer-refused')
  assert.equal(d.stats().left, 1)
})

test('real kernel: a live client of this user on the PAC door is named and not refused, over IPv4 and over a dual-stack socket (v4-mapped IPv6)', SKIP, async (t) => {
  const d = await pacDoor(t, () => null)
  for (const host of ['127.0.0.1', '::ffff:127.0.0.1']) {
    const n = d.owners.length
    const child = client(d.port, host, '')
    try {
      await until(() => d.owners.length > n)
      assert.deepEqual([d.owners[n].pid, d.owners[n].source], [child.pid, 'socket-table'], host)
    } finally { child.kill() }
  }
  assert.deepEqual(d.failures.filter((f) => f.code === 'pac-peer-refused'), [], 'this user\'s: never refused')
})
