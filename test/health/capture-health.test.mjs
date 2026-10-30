// test/health/capture-health.test.mjs — captureHealth(), the payload of GET /api/capture-health and of `trocar collector
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
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'trocar-ch-'))
  const c = path.join(h, 'collector')
  const flows = (recs) => { fs.mkdirSync(path.join(c, 'flows'), { recursive: true }); for (const r of recs) fs.appendFileSync(path.join(c, 'flows', `${day(r.ts)}.ndjson`), JSON.stringify(r) + '\n') }
  const manifest = (m) => { fs.mkdirSync(c, { recursive: true }); fs.writeFileSync(path.join(c, 'install-manifest.json'), typeof m === 'string' ? m : JSON.stringify(m)) }
  const lock = (agoMs = 0) => { fs.writeFileSync(path.join(c, 'lock'), JSON.stringify({ pid: 4242, ...ME })); const t = new Date(NOW - agoMs); fs.utimesSync(path.join(c, 'lock'), t, t) }
  const state = (desired, ts) => fs.writeFileSync(path.join(c, 'state.json'), JSON.stringify({ desired, updated_at: ts }))
  const health = (o = {}) => captureHealth({ home: h, now: NOW, alive: () => true, identity: () => ME, ...o })
  return { h, c, flows, manifest, lock, state, health, done: () => fs.rmSync(h, { recursive: true, force: true }) }
}
const installed = (b) => { b.manifest({ version: 3, install: { state: 'complete' }, created_at: at(100 * H), entries: [], files: [] }); b.flows([{ ts: at(2 * H), event: 'daemon-start', pid: 4242 }]) }

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

test('a leftover old capture events file is not read (4.6 F8): the reading is the same with or without it, and alone it is "not-installed"', () => {
  for (const withCollector of [false, true]) {
    const a = home(), b = home()
    try {
      if (withCollector) { installed(a); installed(b) }
      fs.mkdirSync(path.join(b.h, 'logs'), { recursive: true })
      fs.writeFileSync(path.join(b.h, 'logs', 'mitm-events.ndjson'), [{ ts: at(H), event: 'failure', where: 'mitm', code: 'tls-handshake', reason: 'r' }, { ts: at(H), event: 'daemon-start', pid: 1 }].map((r) => JSON.stringify(r)).join('\n') + '\n{not json\n')
      const same = (r, h) => JSON.parse(JSON.stringify(r).replaceAll(h, '<home>'))
      const r = b.health()
      assert.deepEqual(same(r, b.h), same(a.health(), a.h), withCollector ? 'installed' : 'nothing installed')
      if (!withCollector) assert.deepEqual([r.installed, r.summary], [false, { state: 'not-installed' }])
    } finally { a.done(); b.done() }
  }
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

test('an unreadable flows/ or collector directory throws (status: no health, an errors entry); an unparsable manifest is "unknown", listed', () => {
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
    b.manifest({ version: 3, install: { state: 'complete' }, created_at: created, entries: [], files: [] })
    b.flows([{ ts: at(100 * H - 1000), event: 'install-note', kind: 'skipped-block', harness: 'claude-code', file: '/u/ca.der', type: 'DER', index: 0, reason: 'not a PEM block' }, { ts: at(H), event: 'daemon-start', pid: 4242 }])
    b.lock()
    const r = b.health()
    assert.deepEqual(r.collector.install.install.map((n) => [n.kind, n.file, n.type]), [['skipped-block', '/u/ca.der', 'DER']])
    assert.ok(!r.read.files.some((f) => f.includes(day(created))), 'the old day was not part of the window read')
  } finally { b.done() }
})

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
  const { formatHealth } = await import('../../src/cli/status-text.mjs')
  try {
    b.manifest({ version: 3, install: { state: 'complete' }, created_at: at(100 * H), entries: [], files: [] }); b.lock(); b.state('on', at(72 * H))
    b.flows([{ ts: at(72 * H), event: 'daemon-start', pid: 4242 }, { ts: at(72 * H - 1000), event: 'agent-untrusted', pid: 77, agent: 'claude-code', reason: 'var-missing' }])
    const rows = []
    for (let i = 0; i < 3000; i++) rows.push({ ts: at(2 * H - i * 1000), flow_id: `flow_${i}`, decision: 'decrypt', pid: 78, agent: 'claude-code', host: 'api.anthropic.com', dst: { address: '1.2.3.4', port: 443 } })
    b.flows(rows)
    let r = b.health({ maxBytes: 64 << 10 })
    assert.deepEqual([r.read.truncated, r.collector.conditions_partial, r.collector.conditions.length], [true, true, 0], 'precondition: the start and the untrusted agent are outside what was read')
    assert.deepEqual([r.summary.state, r.summary.partial], ['unknown', true], 'never ✓ 采集中')
    assert.match(formatHealth(r, { daemonLine: false }).join('\n'), /unknown \(the current conditions could not be read whole/)
    b.state('off', at(H))
    assert.equal(b.health({ maxBytes: 64 << 10 }).summary.state, 'unknown', 'nor ○ 采集关')
    b.state('on', at(72 * H))
    r = b.health() // read whole: the condition is there, ⚠
    assert.deepEqual([r.collector.conditions_partial, r.collector.conditions.map((c) => c.pid), r.summary.state], [undefined, [77], 'failing'])
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
    assert.deepEqual([r.raw.problems.map((p) => p.outcome), r.summary.state, r.summary.n], [['refused'], 'failing', 1])
    fs.rmSync(j); fs.mkdirSync(j)
    const u = b.health()
    assert.ok(u.raw.error && u.read.errors.some((e) => e.file === j) && u.summary.read_errors === 1)
  } finally { b.done() }
})

test('only metadata leaves: a WebSocket row\'s tail_raw and an envelope-looking field never reach the payload (4.4 #14)', () => {
  const b = home()
  try {
    installed(b); b.lock(); b.state('on', at(H))
    b.flows([{ ts: at(H / 2), flow_id: 'f', pid: 3, agent: 'codex', decision: 'decrypt', not_captured: 'malformed-hello', ws: { tail_raw: 'U0VDUkVU', failures: 1 }, prelude: 'CONNECT x Proxy-Authorization: Basic c2VjcmV0', req_body: 'secret' }])
    const s = JSON.stringify(b.health())
    assert.ok(s.includes('malformed-hello'))
    assert.doesNotMatch(s, /U0VDUkVU|c2VjcmV0|secret|Proxy-Authorization/)
  } finally { b.done() }
})

// RFC 1.6 §6 「看板」 / V10: `netenv` rides in the payload, read from ~/.trocar/netenv.json (src/netenv writes it): missing says it is not written yet and why, an unreadable or unparsable
// file says the file and the errno, a good one is passed through — never an absent key, never a quiet 「无」; and a broken netenv.json does not turn the bar to 读不全 (it is a cache the next
// `trocar status` writes again, not capture health)
test('netenv: written → passed through; missing → present:false with the reason; unreadable or not JSON → the file and the error, and the read errors stay empty', () => {
  const b = home()
  try {
    installed(b); b.lock(); b.state('on', at(H))
    const none = b.health().netenv
    assert.deepEqual([none.present, typeof none.reason], [false, 'string'])
    assert.match(none.reason, /netenv\.json/)
    const doc = { schema: 1, at: at(H), products: [{ product: 'clash-verge', mode: 'rule', via: {} }], unknown: [] }
    fs.writeFileSync(path.join(b.h, 'netenv.json'), JSON.stringify(doc))
    assert.deepEqual(b.health().netenv, { present: true, ...doc })
    fs.writeFileSync(path.join(b.h, 'netenv.json'), '{"products"')
    const bad = b.health()
    assert.equal(bad.netenv.present, true)
    assert.match(bad.netenv.error, /netenv\.json[^\n]*(parse|JSON)/)
    assert.deepEqual([bad.read.errors.length, bad.summary.read_errors], [0, undefined], 'not capture health')
    fs.rmSync(path.join(b.h, 'netenv.json')); fs.mkdirSync(path.join(b.h, 'netenv.json'))
    assert.match(b.health({ fs: { ...fs, readFileSync: (f, ...r) => { if (String(f).endsWith('netenv.json')) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); return fs.readFileSync(f, ...r) } } }).netenv.error, /netenv\.json: EACCES/)
  } finally { b.done() }
})
