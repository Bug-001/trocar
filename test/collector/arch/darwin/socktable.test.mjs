// test/collector/arch/darwin/socktable.test.mjs — the owner question of the engine's doors (RFC 4.9 §5.3, socktable.mjs `ownerOfSocket`): which pid owns the
// socket the engine just accepted, read from the kernel's TCP table (`netstat -anv -p tcp`) at accept time. The wrong-pid-never rule (4.8 W4): no row,
// several pids on the peer's end, an unreadable table, a peer that is not an IPv4 literal — all null, never a guess. A slow table is waited for, never a
// verdict (a macOS machine 2026-10-17: a 250 ms budget spliced a whole OpenCode session); a hung or failed one is ONE socktable-unavailable record.
// What the redirector does with the answer is redirector.test's.
import test from 'node:test'
import assert from 'node:assert/strict'
import { ownerOfSocket } from '../../../../src/collector/arch/darwin/socktable.mjs'

const PEER = { address: '127.0.0.1', port: 52312 }
const HEAD = 'Active Internet connections (including servers)\nProto Recv-Q Send-Q  Local Address          Foreign Address        (state)          rxbytes      txbytes  rhiwat  shiwat          process:pid    state  options           gencnt    flags   flags1 usecnt rtncnt fltrs'
const row = (local, foreign, owner, state = 'ESTABLISHED') => `tcp4       0      0  ${local}        ${foreign}        ${state}         4806         3654  406080  146988   ${owner}  00102 00000104 00000000007d0898 00000081 01000800      2      0 000000`
const table = (...rows) => ({ code: 0, out: [HEAD, ...rows].join('\n'), err: '' })

test('one read of the kernel TCP table: the row whose LOCAL end is the peer answers its pid; the engine\'s own accepted socket (the peer as its FOREIGN end) never qualifies', async () => {
  const asks = []
  const exec = async (file, args) => {
    asks.push([file, args])
    return table(row('127.0.0.1.18112', `127.0.0.1.${PEER.port}`, `node:${process.pid}`), row(`127.0.0.1.${PEER.port}`, '127.0.0.1.18112', 'opencode-cli:42177'),
      row('127.0.0.1.18112', '*.*', `node:${process.pid}`, 'LISTEN'))
  }
  const r = await ownerOfSocket({ exec, peer: PEER })
  assert.deepEqual([r.pid, r.source], [42177, 'socket-table'])
  assert.ok(r.ms >= 0)
  assert.deepEqual(asks, [['netstat', ['-anv', '-p', 'tcp']]])
})

test('a process name with spaces still answers its pid; an older release\'s plain `pid` column is read too', async () => {
  const spaced = await ownerOfSocket({ exec: async () => table(row(`127.0.0.1.${PEER.port}`, '127.0.0.1.18112', 'OpenCode Helper:14221')), peer: PEER })
  assert.equal(spaced.pid, 14221)
  const old = 'Proto Recv-Q Send-Q  Local Address          Foreign Address        (state)     rhiwat shiwat    pid   epid  state    options\n'
    + `tcp4       0      0  127.0.0.1.${PEER.port}        127.0.0.1.18112        ESTABLISHED 408300 146988   9001      0 00102 00000008`
  assert.equal((await ownerOfSocket({ exec: async () => ({ code: 0, out: old, err: '' }), peer: PEER })).pid, 9001)
})

test('W4 (the wrong-pid-never rule): two pids on the peer\'s end is nobody; no row is nobody; a row no process holds (pid 0, TIME_WAIT) holds nothing; a port that only shares a prefix is not the peer', async () => {
  const two = await ownerOfSocket({ exec: async () => table(row(`127.0.0.1.${PEER.port}`, '1.2.3.4.443', 'a:11'), row(`127.0.0.1.${PEER.port}`, '1.2.3.4.443', 'b:12')), peer: PEER })
  assert.deepEqual([two.pid, two.source], [null, null], 'two holders: null, not a pick')
  const none = await ownerOfSocket({ exec: async () => table(row('127.0.0.1.52311', '1.2.3.4.443', 'a:11'), row(`127.0.0.1.${PEER.port}1`, '1.2.3.4.443', 'b:12')), peer: PEER })
  assert.deepEqual([none.pid, none.source], [null, null], 'no row of this end: null')
  const tw = await ownerOfSocket({ exec: async () => table(row(`127.0.0.1.${PEER.port}`, '127.0.0.1.18112', ':0', 'TIME_WAIT'), row(`127.0.0.1.${PEER.port}`, '127.0.0.1.18112', 'opencode:77')), peer: PEER })
  assert.equal(tw.pid, 77, 'the TIME_WAIT leftover of an earlier connection on the same port is not a second holder')
})

test('a slow table is waited for, not judged: an answer at 400 ms is the pid (a macOS machine 2026-10-17: 274 ms under a 250 ms budget spliced a 292 s OpenCode connection)', async () => {
  const exec = () => new Promise((resolve) => setTimeout(() => resolve(table(row(`127.0.0.1.${PEER.port}`, '127.0.0.1.18112', 'opencode:12813'))), 400))
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

test('a table that cannot be read — the tool failed, hung past its guard and was killed, or printed no owner column — is ONE socktable-unavailable record and null; an exec-closed rejection is an operator\'s close and records nothing', async () => {
  const cases = [
    [async () => ({ code: null, out: '', err: '' }), /did not answer within 10000 ms/],
    [async () => ({ code: 1, out: '', err: 'netstat: sysctl: Operation not permitted' }), /exited with 1: netstat: sysctl/],
    [async () => ({ code: 0, out: 'Proto Recv-Q Send-Q Local Address Foreign Address (state)\n', err: '' }), /no owner column/],
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
