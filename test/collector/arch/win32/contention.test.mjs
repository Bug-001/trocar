// contention.test.mjs — the win32 identity path: the resident helper is ONE single-threaded channel that answers in
// order (helper.ps1's ReadLine loop), so a socket-table read asked while a slow `ps` is out must not be timed (or spliced) for the ps's
// slowness. The fake helper runs in order (fixtures/fake-helper.mjs `inOrder`), and the real client, ownerOfSocket and factsOfPid talk to it.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { startHelper } from '../../../../src/collector/arch/win32/helper.mjs'
import { factsOfPid } from '../../../../src/collector/arch/win32/procinfo.mjs'
import { ownerOfSocket } from '../../../../src/collector/arch/win32/socktable.mjs'

const FAKE = fileURLToPath(new URL('./fixtures/fake-helper.mjs', import.meta.url))
const fakeSpawn = (fixture) => () => spawn(process.execPath, [FAKE, JSON.stringify(fixture)], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ASIGHT_FAKE_HELPER: '1' } })
const trow = (pid, localPort) => ({ pid, state: 'established', family: 4, localAddr: '127.0.0.1', localPort, remoteAddr: '127.0.0.1', remotePort: 17991 })
const proc = (pid, extra = {}) => ({ pid, ppid: 1, name: 'claude.exe', exe: 'C:\\a\\claude.exe', cmdline: 'claude', cmdlineState: 'ok', startedAt: 1000 + pid, sessionId: 1, sameUser: true, integrity: 'medium', tokenDenied: false, ...extra })
function started(t, fixture) {
  const failures = []
  const h = startHelper({ spawn: fakeSpawn({ inOrder: true, ...fixture }), onFailure: (r) => failures.push(r) })
  t.after(() => h.close())
  return Object.assign(h, { failures })
}
const later = (ms) => new Promise((r) => setTimeout(r, ms))

test('a burst of connections while a cold ps (longer than the table budget) is out: every socket-table read answers its pid', async (t) => {
  const rows = [10, 11, 12, 13].map((p, i) => trow(p, 5010 + i))
  const h = started(t, { verbs: { ps: { delayMs: 400, data: { sessionId: 1, procs: [proc(10)] } }, 'tcp-table': { data: { rows } } } })
  await h.ready
  const facts = factsOfPid(10, { helper: h }) // the first connection's identity: the cold ps
  await later(20)
  const owners = []
  for (const i of [1, 2, 3]) { owners.push(ownerOfSocket({ helper: h, peer: { address: '127.0.0.1', port: 5010 + i } })); await later(10) }
  const got = await Promise.all(owners)
  assert.deepEqual(got.map((r) => r.pid), [11, 12, 13], 'none is spliced as pid-unresolved for the ps\'s slowness')
  assert.ok(got.every((r) => r.ms >= 300), 'the cost said is the real wait, the ps included')
  assert.equal((await facts).pid, 10)
  assert.deepEqual(h.failures, [])
})

test('queued calls go fast verbs first — a table read asked after a second ps is written before it', async (t) => {
  const order = []
  const h = started(t, { verbs: { ps: { delayMs: 150, data: { sessionId: 1, procs: [proc(10), proc(11)] } }, 'tcp-table': { data: { rows: [trow(11, 5011)] } } } })
  await h.ready
  const a = h.call('ps', {}, { timeoutMs: 2000, onStart: () => order.push('ps-1') })
  const b = h.call('ps', {}, { timeoutMs: 2000, onStart: () => order.push('ps-2') })
  const c = h.call('tcp-table', { localPort: 5011 }, { timeoutMs: 250, onStart: () => order.push('tcp-table') })
  await Promise.all([a, b, c])
  assert.deepEqual(order, ['ps-1', 'tcp-table', 'ps-2'])
})

test('a helper stuck on a ps answers a waiting table read with helper-busy (naming the ps), and the table lookup is null, not a failure', async (t) => {
  const h = started(t, { verbs: { ps: { hang: true }, 'tcp-table': { data: { rows: [trow(11, 5011)] } } } })
  await h.ready
  const stuck = h.call('ps', {}, { timeoutMs: 50 })
  await assert.rejects(stuck, (e) => e.code === 'helper-timeout')
  assert.equal(h.abandoned('ps'), 1)
  await assert.rejects(h.call('tcp-table', { localPort: 5011 }, { waitMs: 60 }), (e) => e.code === 'helper-busy' && e.behind === 'ps' && e.verb === 'tcp-table')
  const failures = []
  const r = await ownerOfSocket({ helper: h, peer: { address: '127.0.0.1', port: 5011 }, waitMs: 60, onFailure: (f) => failures.push(f) })
  assert.equal(r.pid, null)
  assert.deepEqual(failures, [], 'a busy helper is slow, not an unreadable table')
})

test('a process of the same user in another session is listed by ps and answers its facts', async (t) => {
  const h = started(t, { verbs: { ps: { data: { sessionId: 1, procs: [proc(10), proc(20, { sessionId: 2, sameUser: true })] } } } })
  await h.ready
  const f = await factsOfPid(20, { helper: h })
  assert.deepEqual([f.pid, f.sessionId, f.sameUser], [20, 2, true])
})
