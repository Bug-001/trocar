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
import { createWin32Redirector } from '../../../../src/collector/arch/win32/redirector.mjs'
import { groupsOf } from '../../../../src/collector/arch/win32/route-plan.mjs'
import claudeCode from '../../../../src/collector/harness/win32/claude-code.mjs'
import { loadHarnesses } from '../../../../src/collector/harness/index.mjs'
import { createRegistry } from '../../../../src/collector/core/registry.mjs'

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

// The backlog's repro runs the REAL createWin32Redirector over the in-order helper (cases A and B): the reason a connection is
// spliced with is the door's (4.8 §5.3, the closed set in src/health/codes.mjs).
const CC_IMG = 'C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe'
const CC_GROUPS = groupsOf([{ name: 'claude-code', win32: claudeCode }])
const ID = createRegistry(await loadHarnesses()).match
async function doorOver(t, fixture, { psTimeoutMs } = {}) {
  const h = started(t, fixture)
  await h.ready
  const r = createWin32Redirector({
    helper: h, groups: CC_GROUPS, identify: ID, isOn: () => true, verdictWaitMs: 40,
    ownerOf: (q) => ownerOfSocket({ helper: h, peer: q.peer }),
    factsOf: (pid) => factsOfPid(pid, { helper: h, ...(psTimeoutMs ? { psTimeoutMs } : {}) }),
    routes: () => ({ 'claude-code.settings': { g: 'claude-code.settings', entry: 'auto', on: true, upstream: { kind: 'direct', source: 'direct' }, bypass: [] } }),
    ingress: () => ({ enginePort: 17990, groupPorts: { 'claude-code.settings': 17991 }, ingressToken: 'i'.repeat(32), listenerToken: 't' }),
  })
  return r
}
const ask = (r, port) => r.lookupIngress({ peer: { address: '127.0.0.1', port }, user: 'claude-code.settings', target: { address: 'api.anthropic.com', port: 443 } })

test('A through the door: four staggered connections of one agent while a cold ps (300 ms) is out — every one is the agent\'s pid, none spliced', async (t) => {
  const pid = 4121, ports = [5010, 5011, 5012, 5013]
  const r = await doorOver(t, { verbs: { ps: { delayMs: 300, data: { sessionId: 1, procs: [proc(pid, { exe: CC_IMG, name: 'claude.exe', cmdline: 'claude' })] } }, 'tcp-table': { data: { rows: ports.map((p) => trow(pid, p)) } } } })
  const metas = []
  for (const p of ports) { metas.push(ask(r, p)); await later(10) }
  const got = await Promise.all(metas)
  assert.deepEqual(got.map((m) => [m.pid, m.agent, m.skip?.reason ?? null]), ports.map(() => [pid, 'claude-code', null]))
})

test('B through the door: a ps that never answers splices with facts-unavailable (facts not asked), never as not an agent', async (t) => {
  const r = await doorOver(t, { verbs: { ps: { hang: true }, 'tcp-table': { data: { rows: [trow(4121, 5010)] } } } }, { psTimeoutMs: 80 })
  const m = await ask(r, 5010)
  assert.equal(m.pid, 4121)
  assert.deepEqual(m.skip, { not_captured: 'untracked', reason: 'facts-unavailable' })
})
