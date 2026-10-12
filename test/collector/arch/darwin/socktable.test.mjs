// test/collector/arch/darwin/socktable.test.mjs — the targeted owner question of the engine's doors (RFC 4.9 §5.3 as D47 wrote it, socktable.mjs `ownerOfSocket`): which pid owns
// the socket the engine just accepted, read from the peer 4-tuple at accept time. The wrong-pid-never rule (4.8 W4) in its new shape: no row, several rows, a slow table, an
// unreadable one, a peer that is not an IPv4 literal — all null, never a guess. The budget race is kept as a regression of the [本机] experiment ② write-back: a table that is not
// back inside its budget is SLOW, not unavailable — null with the cost said, never a failure record. The contrast case (a table that cannot be asked at all → one
// socktable-unavailable) is covered here too. What the redirector does with the answer is redirector.test's.
import test from 'node:test'
import assert from 'node:assert/strict'
import { ownerOfSocket } from '../../../../src/collector/arch/darwin/socktable.mjs'

const PEER = { address: '127.0.0.1', port: 52312 }

// the budget's timer is unref'd by design (a budget race must not keep a draining daemon alive); the real daemon's loop always has ref'd handles (its listeners),
// so the timer still fires there. A bare test process has none — the loop drains before the 20 ms budget ends and the runner cancels the test — so each budget
// test holds the loop alive for the race it is measuring. Every assertion stays: null, ms ≥ budget, no failure record.
const withAliveLoop = async (fn) => {
  const keepAlive = setInterval(() => {}, 1 << 30)
  try { return await fn() } finally { clearInterval(keepAlive) }
}

test('the targeted ask: one row whose LOCAL end is the peer answers its pid — the ask is -iTCP@addr:port, and the engine\'s own accepted socket (the peer as its FOREIGN end) never qualifies', async () => {
  const asks = []
  const exec = async (file, args) => {
    asks.push([file, args])
    return { code: 0, out: `p42177\nncmd\nn127.0.0.1:${PEER.port}->203.0.113.7:443\np${process.pid}\nncmd\nn127.0.0.1:${PEER.port}->198.51.100.2:443\n`, err: '' }
  }
  const r = await ownerOfSocket({ exec, peer: PEER, budgetMs: 250 })
  assert.equal(r.pid, 42177, 'the one process whose socket has the peer as its LOCAL end')
  assert.equal(r.source, 'socket-table')
  assert.ok(r.ms >= 0)
  assert.deepEqual(asks, [['lsof', ['-nP', '-Fpcn', `-iTCP@${PEER.address}:${PEER.port}`]]], 'the ask is targeted at the peer 4-tuple, not a whole-table read')
})

test('W4 (the wrong-pid-never rule, D47\'s shape): two rows answering the same local end is nobody — a pid reused mid-query or an IPv6 twin is never guessed; no row is nobody; a NaN pid row holds nothing', async () => {
  const two = await ownerOfSocket({ exec: async () => ({ code: 0, out: `p11\nn127.0.0.1:${PEER.port}->1.2.3.4:443\np12\nn127.0.0.1:${PEER.port}->1.2.3.4:443\n`, err: '' }), peer: PEER })
  assert.deepEqual([two.pid, two.source], [null, null], 'two holders: null, not a pick')
  const none = await ownerOfSocket({ exec: async () => ({ code: 0, out: `p11\nn127.0.0.1:52311->1.2.3.4:443\n`, err: '' }), peer: PEER })
  assert.deepEqual([none.pid, none.source], [null, null], 'no holder of this end: null')
  const nan = await ownerOfSocket({ exec: async () => ({ code: 0, out: `px\nn127.0.0.1:${PEER.port}->1.2.3.4:443\n`, err: '' }), peer: PEER })
  assert.deepEqual([nan.pid, nan.source], [null, null], 'a pid that does not read as an integer holds nothing')
})

test('a peer that is not an IPv4 literal is answered null at once, no ask: the doors bind 127.0.0.1 only (D47), and lsof\'s @-syntax for a bracketed literal is its own dialect — fail-safe, never a guess', async () => {
  const asks = []
  const exec = async (...a) => { asks.push(a); return { code: 0, out: '', err: '' } }
  const r = await ownerOfSocket({ exec, peer: { address: '::1', port: 443 }, budgetMs: 250 })
  assert.deepEqual([r.pid, r.source], [null, null])
  assert.equal(r.ms, 0, 'nothing was asked')
  assert.deepEqual(asks, [], 'no lsof ran')
  const bare = await ownerOfSocket({ exec, peer: { address: '', port: 443 } })
  assert.deepEqual([bare.pid, bare.source], [null, null], 'no address at all: the same fail-safe null')
})

test('budget ②: a table that never answers inside its budget gives null with ms ≥ budget and writes no failure — the next connection asks again', async () => {
  const failures = []
  const r = await withAliveLoop(() => ownerOfSocket({ exec: () => new Promise(() => {}), peer: PEER, budgetMs: 20, onFailure: (rec) => failures.push(rec) }))
  assert.deepEqual([r.pid, r.source], [null, null])
  assert.ok(r.ms >= 20, `the cost says the budget was spent (${r.ms} ms)`)
  assert.deepEqual(failures, [], 'slow is not socktable-unavailable (D38 distinguishes them): no record')
})

test('budget ②: a runner that kills lsof at the budget (code:null, the answer arriving late) is the same answer — null, ms ≥ budget, no failure', async () => {
  const failures = []
  const r = await withAliveLoop(() => ownerOfSocket({ exec: async () => ({ code: null, out: '', err: 'killed at the budget' }), peer: PEER, budgetMs: 20, onFailure: (rec) => failures.push(rec) }))
  assert.deepEqual([r.pid, r.source], [null, null])
  assert.ok(r.ms >= 20, `the cost says the budget was spent (${r.ms} ms)`)
  assert.deepEqual(failures, [], 'the runner did its job: slow, not broken — no record')
})

test('a table that cannot be asked at all: ONE socktable-unavailable record (4.8 §12) and null — an exec-closed rejection is an operator\'s close and records nothing', async () => {
  const failures = []
  const r = await ownerOfSocket({ exec: async () => { throw Object.assign(new Error('the runner closed'), { code: 'exec-closed' }) }, peer: PEER, onFailure: (rec) => failures.push(rec) })
  assert.deepEqual([r.pid, r.source], [null, null])
  assert.deepEqual(failures, [], 'the collector\'s own stop closed the runner: not an unreadable table')
  const failures2 = []
  const r2 = await ownerOfSocket({ exec: async () => { throw new Error('no runner') }, peer: PEER, onFailure: (rec) => failures2.push(rec) })
  assert.deepEqual([r2.pid, r2.source], [null, null])
  assert.equal(failures2.length, 1)
  assert.equal(failures2[0].code, 'socktable-unavailable')
  assert.match(failures2[0].reason, /spliced untracked/)
})

test('the ask needs its inputs: no exec runner is a TypeError, and neither is a peer without a port', async () => {
  await assert.rejects(() => ownerOfSocket({ peer: PEER }), /needs the injected exec runner/)
  await assert.rejects(() => ownerOfSocket({ exec: async () => ({ code: 0, out: '', err: '' }), peer: { address: '127.0.0.1' } }), /peer\.port is required/)
})
