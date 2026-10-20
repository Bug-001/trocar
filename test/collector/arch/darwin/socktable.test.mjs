// test/collector/arch/darwin/socktable.test.mjs — the owner question of the engine's doors (RFC 4.9 §5.3, socktable.mjs `ownerOfSocket`): which pid owns the
// socket the engine just accepted, read from the native `socktable` helper (this user's processes' TCP sockets) at accept time. The wrong-pid-never rule (4.8 W4): no row,
// several pids on the peer's end, an unreadable table, a peer that is not an IPv4 literal — all null, never a guess. A slow table is waited for, never a
// verdict (a macOS machine 2026-10-17: a 250 ms budget spliced a whole OpenCode session); a hung or failed one is ONE socktable-unavailable record.
// What the redirector does with the answer is redirector.test's.
import test from 'node:test'
import assert from 'node:assert/strict'
import { ownerOfSocket } from '../../../../src/collector/arch/darwin/socktable.mjs'

const PEER = { address: '127.0.0.1', port: 52312 }
const row = (local, foreign, pid, state = 'ESTABLISHED') => { const [la, lp] = local.split(':'), [fa, fp] = foreign.split(':'); return `${pid} ${state} ${la} ${lp} ${fa} ${fp}` }
const table = (...rows) => ({ code: 0, out: rows.join('\n'), err: '' })

test('one read of the helper: the row whose LOCAL end is the peer answers its pid; the engine\'s own accepted socket (the peer as its FOREIGN end) never qualifies', async () => {
  const asks = []
  const exec = async (file, args) => {
    asks.push([file, args])
    return table(row('127.0.0.1:18112', `127.0.0.1:${PEER.port}`, process.pid), row(`127.0.0.1:${PEER.port}`, '127.0.0.1:18112', 42177),
      row('127.0.0.1:18112', '0.0.0.0:0', process.pid, 'LISTEN'))
  }
  const r = await ownerOfSocket({ exec, peer: PEER, socktablePath: '/x/socktable' })
  assert.deepEqual([r.pid, r.source], [42177, 'socket-table'])
  assert.ok(r.ms >= 0)
  assert.deepEqual(asks, [['/x/socktable', []]])
})

test('W4 (the wrong-pid-never rule): two pids on the peer\'s end (a socket a child inherited) is nobody; no row is nobody; a port that only shares a prefix, or another address on the same port, is not the peer', async () => {
  const two = await ownerOfSocket({ exec: async () => table(row(`127.0.0.1:${PEER.port}`, '1.2.3.4:443', 11), row(`127.0.0.1:${PEER.port}`, '1.2.3.4:443', 12)), peer: PEER })
  assert.deepEqual([two.pid, two.source], [null, null], 'two holders: null, not a pick')
  const none = await ownerOfSocket({ exec: async () => table(row('127.0.0.1:52311', '1.2.3.4:443', 11), row(`127.0.0.1:${PEER.port}1`, '1.2.3.4:443', 12), row(`10.0.0.2:${PEER.port}`, '1.2.3.4:443', 13)), peer: PEER })
  assert.deepEqual([none.pid, none.source], [null, null], 'no row of this end: null')
  const garbled = await ownerOfSocket({ exec: async () => table('not a row', `x ESTABLISHED 127.0.0.1 ${PEER.port} 127.0.0.1 18112`, row(`127.0.0.1:${PEER.port}`, '127.0.0.1:18112', 77)), peer: PEER })
  assert.equal(garbled.pid, 77, 'a line not of the helper\'s shape is no holder')
})

test('a slow table is waited for, not judged: an answer at 400 ms is the pid (a macOS machine 2026-10-17: 274 ms under a 250 ms budget spliced a 292 s OpenCode connection)', async () => {
  const exec = () => new Promise((resolve) => setTimeout(() => resolve(table(row(`127.0.0.1:${PEER.port}`, '127.0.0.1:18112', 12813))), 400))
  const r = await ownerOfSocket({ exec, peer: PEER })
  assert.equal(r.pid, 12813)
  assert.ok(r.ms >= 390, `the cost is said (${r.ms} ms)`)
})

test('a peer that is not an IPv4 literal is answered null at once, no ask: the doors bind 127.0.0.1 only (D47) — fail-safe, never a guess', async () => {
  const asks = []
  const exec = async (...a) => { asks.push(a); return table() }
  const r = await ownerOfSocket({ exec, peer: { address: '::1', port: 443 } })
  assert.deepEqual([r.pid, r.source, r.ms], [null, null, 0])
  assert.deepEqual(asks, [], 'nothing ran')
  const bare = await ownerOfSocket({ exec, peer: { address: '', port: 443 } })
  assert.deepEqual([bare.pid, bare.source], [null, null], 'no address at all: the same fail-safe null')
})

test('a table that cannot be read — the helper failed, or hung past its guard and was killed — is ONE socktable-unavailable record and null; an exec-closed rejection is an operator\'s close and records nothing', async () => {
  const cases = [
    [async () => ({ code: null, out: '', err: '' }), /did not answer within 10000 ms/],
    [async () => ({ code: 1, out: '', err: 'socktable: proc_listpids: Operation not permitted' }), /exited with 1: socktable: proc_listpids/],
    [async () => { throw new Error('no runner') }, /no runner/],
  ]
  for (const [exec, why] of cases) {
    const failures = []
    const r = await ownerOfSocket({ exec, peer: PEER, onFailure: (rec) => failures.push(rec) })
    assert.deepEqual([r.pid, r.source], [null, null])
    assert.equal(failures.length, 1)
    assert.equal(failures[0].code, 'socktable-unavailable')
    assert.match(failures[0].reason, why)
    assert.match(failures[0].reason, /spliced untracked/)
  }
  const closed = []
  const r = await ownerOfSocket({ exec: async () => { throw Object.assign(new Error('the runner closed'), { code: 'exec-closed' }) }, peer: PEER, onFailure: (rec) => closed.push(rec) })
  assert.deepEqual([r.pid, closed], [null, []], 'the collector\'s own stop closed the runner: not an unreadable table')
})

test('the ask needs its inputs: no exec runner is a TypeError, and neither is a peer without a port', async () => {
  await assert.rejects(() => ownerOfSocket({ peer: PEER }), /needs the injected exec runner/)
  await assert.rejects(() => ownerOfSocket({ exec: async () => table(), peer: { address: '127.0.0.1' } }), /peer\.port is required/)
})
