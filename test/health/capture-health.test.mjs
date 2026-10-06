// test/health/capture-health.test.mjs — captureHealth(), the payload of GET /api/capture-health and of `asight collector
// status` without a daemon (D38; RFC 4.4 端点表 + #14, 1.5 状态矩阵, 4.6 F3(b)(c)(g)(h), F6, F9): from disk only; the
// daemon judged by its lock; installed / residue / not installed; the switch; the worst state wins.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { captureHealth, HealthUnreadable, LOCK_FRESH_MS } from '../../src/health/read.mjs'

const NOW = Date.parse('2026-10-06T12:00:00Z')
const H = 3600e3
const at = (msAgo) => new Date(NOW - msAgo).toISOString()
const day = (iso) => iso.slice(0, 10)
const ME = { start_time: '900', boot_id: 'b1' }
function home() {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-ch-'))
  const c = path.join(h, 'collector')
  const flows = (recs) => { fs.mkdirSync(path.join(c, 'flows'), { recursive: true }); for (const r of recs) fs.appendFileSync(path.join(c, 'flows', `${day(r.ts)}.ndjson`), JSON.stringify(r) + '\n') }
  const manifest = (m) => { fs.mkdirSync(c, { recursive: true }); fs.writeFileSync(path.join(c, 'install-manifest.json'), typeof m === 'string' ? m : JSON.stringify(m)) }
  const lock = (agoMs = 0) => { fs.writeFileSync(path.join(c, 'lock'), JSON.stringify({ pid: 4242, ...ME })); const t = new Date(NOW - agoMs); fs.utimesSync(path.join(c, 'lock'), t, t) }
  const state = (desired, ts) => fs.writeFileSync(path.join(c, 'state.json'), JSON.stringify({ desired, updated_at: ts }))
  const health = (o = {}) => captureHealth({ home: h, now: NOW, alive: () => true, identity: () => ME, ...o })
  return { h, c, flows, manifest, lock, state, health, done: () => fs.rmSync(h, { recursive: true, force: true }) }
}
const installed = (b) => { b.manifest({ version: 1, complete: true, created_at: at(100 * H), entries: [], files: [] }); b.flows([{ ts: at(2 * H), event: 'daemon-start', pid: 4242 }]) }

test('not installed anywhere → installed:false and "not-installed", never "0 failures" (F9)', () => {
  const b = home()
  try {
    const r = b.health()
    assert.deepEqual([r.installed, r.summary], [false, { state: 'not-installed' }])
    // an uninstall that could not undo two entries keeps the manifest (D-18): "未安装 · 残留 N 项"
    b.manifest({ complete: false, entries: [], files: [], uninstall_left: [{ path: '/a', harness: 'claude-code', result: 'left-link' }, { path: '/b', harness: 'claude-code', result: 'left-unparsable' }] })
    const res = b.health()
    assert.deepEqual([res.installed, res.summary.state, res.summary.n, res.collector.residue.map((x) => x.result)], [false, 'residue', 2, ['left-link', 'left-unparsable']])
  } finally { b.done() }
})

test('running: ✓ since the later of the daemon-start and switching on; off → "off since T"; a failure → failing N', () => {
  const b = home()
  try {
    installed(b); b.lock(); b.state('on', at(H))
    const ok = b.health()
    assert.deepEqual([ok.installed, ok.summary.state, ok.summary.since, ok.collector.daemon.state, ok.collector.daemon.pid], [true, 'ok', at(H), 'running', 4242])
    b.state('off', at(H / 2))
    assert.deepEqual([b.health().summary.state, b.health().summary.since], ['off', at(H / 2)], 'F3(g): not ✓, not empty')
    b.flows([{ ts: at(H / 4), event: 'agent-untrusted', pid: 7, agent: 'claude-code', reason: 'var-missing' }, { ts: at(H / 4), event: 'failure', where: 'engine', code: 'lookup-miss', reason: 'r' }])
    const f = b.health()
    // N = current failure conditions (the untrusted pid) + 24 h failure groups (agent-untrusted, lookup-miss)
    assert.deepEqual([f.summary.state, f.summary.n, f.collector.conditions.map((c) => c.kind)], ['failing', 3, ['untrusted']])
    b.state('{"desired"', at(0)); fs.writeFileSync(path.join(b.c, 'state.json'), '{"desired"')
    assert.ok(b.health().read.errors.some((e) => /state\.json/.test(e.file)) && b.health().summary.read_errors === 1, 'an unreadable state.json is listed, the bar says 读不全')
  } finally { b.done() }
})

test('the daemon by its lock alone: not running (clean stop · SIGHUP), not running (unclean), not responding, unknown (F3(b)(c)(h))', () => {
  const b = home()
  try {
    installed(b)
    b.flows([{ ts: at(H), event: 'agent-untrusted', pid: 7, reason: 'var-missing' }, { ts: at(H / 2), event: 'daemon-stop', pid: 4242, signal: 'SIGHUP' }])
    const stopped = b.health()
    assert.deepEqual([stopped.summary.state, stopped.summary.signal, stopped.summary.since], ['not-running', 'SIGHUP', at(H / 2)], 'no lock: "没在跑 · 因 SIGHUP", last record at T')
    assert.equal(stopped.collector.conditions_as_of, at(H / 2), 'conditions are "as of T, daemon not running"')
    b.lock()
    const reused = b.health({ identity: () => ({ start_time: '1', boot_id: 'b1' }) })
    assert.deepEqual([reused.summary.state, /another process/.test(reused.summary.reason), reused.collector.daemon.unclean], ['not-running', true, true], 'a reused pid is never "running"')
    assert.equal(b.health({ alive: () => false }).summary.state, 'not-running')
    b.lock(LOCK_FRESH_MS + 2000)
    const stuck = b.health()
    assert.deepEqual([stuck.summary.state, stuck.summary.since], ['not-responding', at(LOCK_FRESH_MS + 2000)], 'SIGSTOP: not refreshed for 5 s')
    fs.writeFileSync(path.join(b.c, 'lock'), '{"pid":')
    assert.equal(b.health().summary.state, 'failing', 'state unknown, but pid 7 is a current failure: ⚠ outranks ?')
    b.flows([{ ts: at(H / 3), event: 'agent-exit', pid: 7 }])
    const unk = b.health({ now: NOW + 24 * H }) // pid 7 gone, its failure out of the window
    assert.deepEqual([unk.summary.state, /not valid JSON/.test(unk.summary.reason)], ['unknown', true], '? 采集器状态不明')
  } finally { b.done() }
})

test('an unreadable flows/ or collector directory throws (503); an unparsable manifest is "unknown", listed', () => {
  const b = home()
  try {
    installed(b)
    fs.rmSync(path.join(b.c, 'flows'), { recursive: true }); fs.writeFileSync(path.join(b.c, 'flows'), 'x')
    assert.throws(() => b.health(), HealthUnreadable)
    fs.rmSync(path.join(b.c, 'flows'))
    if (process.getuid && process.getuid() !== 0) { // root reads through 000
      fs.chmodSync(b.h, 0o000)
      try { assert.throws(() => b.health(), (e) => e instanceof HealthUnreadable && /EACCES/.test(e.message), 'a collector directory that cannot be looked at is not "not installed"') } finally { fs.chmodSync(b.h, 0o700) }
    }
    b.manifest('{not json'); b.lock() // a daemon that runs: nothing worse than not knowing (no lock: ✗ wins)
    const r = b.health()
    assert.deepEqual([r.collector.installed, r.summary.state, r.read.errors.length], [null, 'unknown', 1])
  } finally { b.done() }
})

test('the last install\'s notes come from the manifest\'s date when the window no longer reaches them (F1(e), F6)', () => {
  const b = home()
  try {
    const created = at(100 * H)
    b.manifest({ complete: true, created_at: created, entries: [], files: [] })
    b.flows([{ ts: at(100 * H - 1000), event: 'install-note', kind: 'skipped-block', harness: 'claude-code', file: '/u/ca.der', type: 'DER', index: 0, reason: 'not a PEM block' }, { ts: at(H), event: 'daemon-start', pid: 4242 }])
    b.lock()
    const r = b.health()
    assert.deepEqual(r.collector.install.install.map((n) => [n.kind, n.file, n.type]), [['skipped-block', '/u/ca.der', 'DER']])
    assert.ok(!r.read.files.some((f) => f.includes(day(created))), 'the old day was not part of the window read')
  } finally { b.done() }
})

test('the old capture: running / failing / stopped; no events but a fresh capture file is "no-events", not "not installed" (F8)', () => {
  const b = home()
  try {
    const ev = (recs) => { fs.mkdirSync(path.join(b.h, 'logs'), { recursive: true }); fs.writeFileSync(path.join(b.h, 'logs', 'mitm-events.ndjson'), recs.map((r) => JSON.stringify(r) + '\n').join('')) }
    fs.writeFileSync(path.join(b.h, 'claude-capture.ndjson'), '{}\n')
    fs.utimesSync(path.join(b.h, 'claude-capture.ndjson'), new Date(NOW - H), new Date(NOW - H))
    const ne = b.health()
    assert.deepEqual([ne.installed, ne.summary.state, ne.summary.part], [true, 'no-events', 'legacy'])
    fs.utimesSync(path.join(b.h, 'claude-capture.ndjson'), new Date(NOW - 30 * H), new Date(NOW - 30 * H))
    assert.equal(b.health().summary.state, 'not-installed', 'an old capture file alone is not a running capture')
    ev([{ ts: at(3 * H), event: 'mitm-start', pid: 99, port: 9898 }])
    assert.deepEqual([b.health().summary.state, b.health().summary.since], ['ok', at(3 * H)], '✓ 旧 MITM · 最后启动于 T')
    assert.equal(b.health({ alive: () => false }).summary.state, 'not-running', 'its pid is gone without mitm-stop')
    ev([{ ts: at(3 * H), event: 'mitm-start', pid: 99 }, { ts: at(H), event: 'failure', where: 'mitm', code: 'tls-client-error', reason: 'unknown ca', servername: 'api.anthropic.com' }])
    const lf = b.health()
    assert.deepEqual([lf.summary.state, lf.summary.n, lf.legacy.failures[0].key], ['failing', 1, 'mitm/tls-client-error'])
    // with the collector installed and fine, the old capture's failure still wins (the worse of the two)
    installed(b); b.lock(); b.state('on', at(H))
    assert.deepEqual([b.health().summary.state, b.health().summary.part], ['failing', 'legacy'])
    b.flows([{ ts: at(H / 2), event: 'failure', where: 'engine', code: 'lookup-miss', reason: 'r' }])
    assert.equal(b.health().summary.n, 2, 'both failing: the counts add up')
    ev([{ ts: at(3 * H), event: 'mitm-start', pid: 99 }])
    assert.deepEqual([b.health({ alive: (p) => p !== 99 }).summary.state, b.health({ alive: (p) => p !== 99 }).summary.part], ['not-running', 'legacy'], 'an old MITM gone without a clean stop is worse than a failing collector')
    ev([{ ts: at(3 * H), event: 'mitm-start', pid: 99 }, { ts: at(2 * H), event: 'mitm-stop', pid: 99, signal: 'SIGTERM' }])
    assert.deepEqual([b.health().summary.state, b.health().summary.part], ['failing', 'collector'], 'one stopped cleanly is not: the collector\'s failure shows')
  } finally { b.done() }
})

// 4.1 落地细节 (3): no start / stop line of any source in what was read is never "stopped" by itself — an events
// file holding only another line next to a fresh capture file is "no-events"; a start pushed out of the tail read is
// "unknown".
test('the old capture with no start / stop line read: a fresh capture file is no-events, a cut tail is unknown — never stopped', () => {
  const b = home()
  try {
    fs.mkdirSync(path.join(b.h, 'logs'), { recursive: true })
    const evFile = path.join(b.h, 'logs', 'mitm-events.ndjson')
    fs.writeFileSync(path.join(b.h, 'claude-capture.ndjson'), '{}\n')
    fs.utimesSync(path.join(b.h, 'claude-capture.ndjson'), new Date(NOW - 60e3), new Date(NOW - 60e3)) // an old MITM writes now
    fs.writeFileSync(evFile, JSON.stringify({ ts: at(30 * H), event: 'failure', where: 'shard', code: 'shard-failed', reason: 'x' }) + '\n')
    let r = b.health()
    assert.deepEqual([r.legacy.state, r.summary.state, r.summary.part], ['no-events', 'no-events', 'legacy'], 'a shard line only: no-events, not "stopped"')
    fs.utimesSync(path.join(b.h, 'claude-capture.ndjson'), new Date(NOW - 30 * H), new Date(NOW - 30 * H))
    assert.equal(b.health().legacy.state, 'stopped', 'nothing written for 24 h, nothing read about a start: stopped')
    // a running MITM, then over 1 MiB of later lines: its mitm-start is outside the tail read
    const lines = [JSON.stringify({ ts: at(40 * H), event: 'mitm-start', source: 'mitm', pid: 99, port: 9898 })]
    for (let i = 0; i < 4000; i++) lines.push(JSON.stringify({ ts: at(30 * H), event: 'failure', where: 'mitm', code: 'ECONNRESET', servername: 'api.anthropic.com', reason: 'x'.repeat(300) }))
    fs.writeFileSync(evFile, lines.join('\n') + '\n')
    r = b.health()
    assert.deepEqual([r.read.truncated, r.legacy.state, r.summary.state], [true, 'unknown', 'unknown'], 'a cut tail: unknown, never stopped')
    assert.match(r.summary.reason, /whether the old capture runs is unknown/)
  } finally { b.done() }
})

// 1.5 order, 4.4: a manifest that cannot be read is "unknown", but never above what is worse — the daemon and
// the failures are judged all the same; the top-level installed is null then, not false.
test('an unreadable manifest: unknown never hides a failure or a dead daemon, and installed is null, not false', () => {
  const b = home()
  try {
    installed(b); b.lock(); b.state('on', at(H))
    b.flows([{ ts: at(H / 2), event: 'failure', where: 'engine', code: 'lookup-miss', reason: 'r' }])
    b.manifest('{oops')
    let r = b.health()
    assert.deepEqual([r.installed, r.collector.installed, r.summary.state, r.summary.n], [null, null, 'failing', 1], '⚠ is not hidden by ?')
    r = b.health({ alive: () => false })
    assert.deepEqual([r.summary.state, r.installed], ['not-running', null], '✗ is not hidden by ?')
    fs.rmSync(path.join(b.c, 'flows'), { recursive: true }); b.flows([{ ts: at(2 * H), event: 'daemon-start', pid: 4242 }])
    r = b.health()
    assert.deepEqual([r.summary.state, /does not parse/.test(r.summary.reason)], ['unknown', true], 'nothing worse: still unknown, with why')
  } finally { b.done() }
})

// 4.6 §记录「记录本身写不成」: a long-running daemon's daemon-start and an agent-untrusted of days ago sit behind
// more than the bytes read; the conditions are then partial — the summary is never ✓ (nor ○), and status says so.
test('conditions folded without the last daemon-start are partial: unknown, never ok or off; status says it', async () => {
  const b = home()
  const { formatHealth } = await import('../../src/collector/cli.mjs')
  try {
    b.manifest({ version: 1, complete: true, created_at: at(100 * H), entries: [], files: [] }); b.lock(); b.state('on', at(72 * H))
    b.flows([{ ts: at(72 * H), event: 'daemon-start', pid: 4242 }, { ts: at(72 * H - 1000), event: 'agent-untrusted', pid: 77, agent: 'claude-code', reason: 'var-missing' }])
    const rows = []
    for (let i = 0; i < 3000; i++) rows.push({ ts: at(2 * H - i * 1000), flow_id: `flow_${i}`, decision: 'decrypt', pid: 78, agent: 'claude-code', host: 'api.anthropic.com', dst: { address: '1.2.3.4', port: 443 } })
    b.flows(rows)
    let r = b.health({ maxBytes: 64 << 10 })
    assert.deepEqual([r.read.truncated, r.collector.conditions_partial, r.collector.conditions.length], [true, true, 0], 'precondition: the start and the untrusted agent are outside what was read')
    assert.deepEqual([r.summary.state, r.summary.partial], ['unknown', true], 'never ✓ 采集中')
    assert.match(formatHealth(r, { daemonLine: false }).join('\n'), /conditions are partial/)
    b.state('off', at(H))
    assert.equal(b.health({ maxBytes: 64 << 10 }).summary.state, 'unknown', 'nor ○ 采集关')
    b.state('on', at(72 * H))
    r = b.health() // read whole: the condition is there, ⚠
    assert.deepEqual([r.collector.conditions_partial, r.collector.conditions.map((c) => c.pid), r.summary.state], [undefined, [77], 'failing'])
  } finally { b.done() }
})

test('the old capture per source (RFC 4.1 落地细节 (3)): MITM and reverse proxy each by their last start / stop; a clean stop is ○ below ✓', () => {
  const b = home()
  try {
    const ev = (recs) => { fs.mkdirSync(path.join(b.h, 'logs'), { recursive: true }); fs.writeFileSync(path.join(b.h, 'logs', 'mitm-events.ndjson'), recs.map((r) => JSON.stringify(r) + '\n').join('')) }
    const mitmStopped = [{ ts: at(5 * H), event: 'mitm-start', source: 'mitm', pid: 7 }, { ts: at(4 * H), event: 'mitm-stop', source: 'mitm', pid: 7, signal: 'SIGTERM' }]
    ev(mitmStopped)
    let r = b.health()
    assert.deepEqual([r.summary.state, r.summary.since, r.summary.signal, r.legacy.state], ['stopped', at(4 * H), 'SIGTERM', 'stopped'])
    ev([...mitmStopped, { ts: at(2 * H), event: 'mitm-start', source: 'proxy', pid: 8, port: 8899 }])
    r = b.health()
    assert.deepEqual([r.summary.state, r.summary.source, r.summary.since], ['ok', 'proxy', at(2 * H)], 'the reverse proxy runs: ✓ 旧反代')
    assert.deepEqual(r.legacy.sources.map((x) => [x.source, x.state]), [['mitm', 'stopped'], ['proxy', 'running']])
    r = b.health({ alive: (pid) => pid !== 8 })
    assert.deepEqual([r.summary.state, r.summary.source, r.summary.reason], ['not-running', 'proxy', 'pid 8 is gone without a clean stop'])
    ev([{ ts: at(2 * H), event: 'mitm-start', pid: 9 }]) // a line without source is the MITM's
    assert.equal(b.health().legacy.sources[0].source, 'mitm')
    installed(b); b.lock(); b.state('on', at(H)); b.flows([{ ts: at(H), event: 'daemon-start', pid: 4242 }])
    ev(mitmStopped)
    assert.deepEqual([b.health().summary.state, b.health().summary.part], ['ok', 'collector'], 'a running collector hides a cleanly stopped old capture')
    fs.rmSync(path.join(b.h, 'logs', 'mitm-events.ndjson')); fs.mkdirSync(path.join(b.h, 'logs', 'mitm-events.ndjson'))
    assert.ok(b.health().read.errors.some((e) => /mitm-events/.test(e.file)))
  } finally { b.done() }
})

test('the raw journal: non-success outcomes are listed and count as failures; an unreadable journal is an error, never empty (F7)', () => {
  const b = home()
  try {
    installed(b); b.lock(); b.state('on', at(H))
    fs.mkdirSync(path.join(b.h, 'raw'))
    const j = path.join(b.h, 'raw', 'journal.jsonl')
    fs.writeFileSync(j, [{ ts: at(H), op: 'seal', outcome: 'ok', file: '/s' }, { ts: at(H), op: 'seal', outcome: 'refused', file: '/s2', reason: 'no close marker' }].map((x) => JSON.stringify(x) + '\n').join(''))
    const r = b.health()
    assert.deepEqual([r.raw.problems.map((p) => p.outcome), r.summary.state, r.summary.n, r.summary.part], [['refused'], 'failing', 1, 'raw'])
    fs.rmSync(j); fs.mkdirSync(j)
    const u = b.health()
    assert.ok(u.raw.error && u.read.errors.some((e) => e.file === j) && u.summary.read_errors === 1)
  } finally { b.done() }
})

test('only metadata leaves: a WebSocket row\'s tail_raw and an envelope-looking field never reach the payload (4.4 #14)', () => {
  const b = home()
  try {
    installed(b); b.lock(); b.state('on', at(H))
    b.flows([{ ts: at(H / 2), flow_id: 'f', pid: 3, agent: 'codex', decision: 'decrypt', not_captured: 'ws-not-recorded', ws: { tail_raw: 'U0VDUkVU', failures: 1 }, prelude: 'CONNECT x Proxy-Authorization: Basic c2VjcmV0', req_body: 'secret' }])
    const s = JSON.stringify(b.health())
    assert.ok(s.includes('ws-not-recorded'))
    assert.doesNotMatch(s, /U0VDUkVU|c2VjcmV0|secret|Proxy-Authorization/)
  } finally { b.done() }
})
