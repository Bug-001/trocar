// test/cli/status.test.mjs — `asight status` (RFC 1.6 §2, V32, V39): what it says of each agent — captured, or not and why (one reason from the closed set of 4.6) — from the desired
// state, the entry, the link, the daemon and when the process started; and what it prints when it cannot tell. Sandbox HOMEs, injected process tables and control sockets: nothing here
// reaches the machine (0.1 §3).
import test from 'node:test'
import assert from 'node:assert/strict'
import { judgeHarness, STATUS_REASONS } from '../../src/cli/status.mjs'
import { TRUST_REASONS } from '../../src/health/codes.mjs'

// ── V32: the judgement, over every combination of desired state × entry × link × daemon × (no process | one that started before the entry was written | one after) ──────────────────────
// Columns: desired · entry intact (T / F / N = unknown) · link attached (T / F / N) · daemon · what is said with no process | with a process older than installed_at | with a newer one.
// T = captured; F:reason = not captured, and why; ? = 不知道 (null). A process the daemon has not judged (`trusted: null`) is judged by its start time against the entry's `installed_at`.
const TABLE = [
  'on  T T run    | T                        | F:config-after-start     | T',
  'on  T T down   | F:daemon-not-running     | F:daemon-not-running     | F:daemon-not-running',
  'on  T T noresp | F:daemon-not-responding  | F:daemon-not-responding  | F:daemon-not-responding',
  'on  T T unk    | ?                        | ?                        | ?',
  'on  T F run    | F:link-missing           | F:link-missing           | F:link-missing',
  'on  T F down   | F:daemon-not-running     | F:daemon-not-running     | F:daemon-not-running',
  'on  T F noresp | F:daemon-not-responding  | F:daemon-not-responding  | F:daemon-not-responding',
  'on  T F unk    | ?                        | ?                        | ?',
  'on  T N run    | ?                        | ?                        | ?',
  'on  T N down   | F:daemon-not-running     | F:daemon-not-running     | F:daemon-not-running',
  'on  T N noresp | F:daemon-not-responding  | F:daemon-not-responding  | F:daemon-not-responding',
  'on  T N unk    | ?                        | ?                        | ?',
  'on  F T run    | F:entry-missing          | F:entry-missing          | F:entry-missing',
  'on  F T down   | F:daemon-not-running     | F:daemon-not-running     | F:daemon-not-running',
  'on  F T noresp | F:daemon-not-responding  | F:daemon-not-responding  | F:daemon-not-responding',
  'on  F T unk    | ?                        | ?                        | ?',
  'on  F F run    | F:link-missing           | F:link-missing           | F:link-missing',
  'on  F F down   | F:daemon-not-running     | F:daemon-not-running     | F:daemon-not-running',
  'on  F F noresp | F:daemon-not-responding  | F:daemon-not-responding  | F:daemon-not-responding',
  'on  F F unk    | ?                        | ?                        | ?',
  'on  F N run    | ?                        | ?                        | ?',
  'on  F N down   | F:daemon-not-running     | F:daemon-not-running     | F:daemon-not-running',
  'on  F N noresp | F:daemon-not-responding  | F:daemon-not-responding  | F:daemon-not-responding',
  'on  F N unk    | ?                        | ?                        | ?',
  'on  N T run    | ?                        | ?                        | ?',
  'on  N T down   | F:daemon-not-running     | F:daemon-not-running     | F:daemon-not-running',
  'on  N T noresp | F:daemon-not-responding  | F:daemon-not-responding  | F:daemon-not-responding',
  'on  N T unk    | ?                        | ?                        | ?',
  'on  N F run    | F:link-missing           | F:link-missing           | F:link-missing',
  'on  N F down   | F:daemon-not-running     | F:daemon-not-running     | F:daemon-not-running',
  'on  N F noresp | F:daemon-not-responding  | F:daemon-not-responding  | F:daemon-not-responding',
  'on  N F unk    | ?                        | ?                        | ?',
  'on  N N run    | ?                        | ?                        | ?',
  'on  N N down   | F:daemon-not-running     | F:daemon-not-running     | F:daemon-not-running',
  'on  N N noresp | F:daemon-not-responding  | F:daemon-not-responding  | F:daemon-not-responding',
  'on  N N unk    | ?                        | ?                        | ?',
  'off T T run    | F:desired-off            | F:desired-off            | F:desired-off',
  'off T T down   | F:desired-off            | F:desired-off            | F:desired-off',
  'off T T noresp | F:desired-off            | F:desired-off            | F:desired-off',
  'off T T unk    | F:desired-off            | F:desired-off            | F:desired-off',
  'off T F run    | F:desired-off            | F:desired-off            | F:desired-off',
  'off T F down   | F:desired-off            | F:desired-off            | F:desired-off',
  'off T F noresp | F:desired-off            | F:desired-off            | F:desired-off',
  'off T F unk    | F:desired-off            | F:desired-off            | F:desired-off',
  'off T N run    | F:desired-off            | F:desired-off            | F:desired-off',
  'off T N down   | F:desired-off            | F:desired-off            | F:desired-off',
  'off T N noresp | F:desired-off            | F:desired-off            | F:desired-off',
  'off T N unk    | F:desired-off            | F:desired-off            | F:desired-off',
  'off F T run    | F:desired-off            | F:desired-off            | F:desired-off',
  'off F T down   | F:desired-off            | F:desired-off            | F:desired-off',
  'off F T noresp | F:desired-off            | F:desired-off            | F:desired-off',
  'off F T unk    | F:desired-off            | F:desired-off            | F:desired-off',
  'off F F run    | F:desired-off            | F:desired-off            | F:desired-off',
  'off F F down   | F:desired-off            | F:desired-off            | F:desired-off',
  'off F F noresp | F:desired-off            | F:desired-off            | F:desired-off',
  'off F F unk    | F:desired-off            | F:desired-off            | F:desired-off',
  'off F N run    | F:desired-off            | F:desired-off            | F:desired-off',
  'off F N down   | F:desired-off            | F:desired-off            | F:desired-off',
  'off F N noresp | F:desired-off            | F:desired-off            | F:desired-off',
  'off F N unk    | F:desired-off            | F:desired-off            | F:desired-off',
  'off N T run    | F:desired-off            | F:desired-off            | F:desired-off',
  'off N T down   | F:desired-off            | F:desired-off            | F:desired-off',
  'off N T noresp | F:desired-off            | F:desired-off            | F:desired-off',
  'off N T unk    | F:desired-off            | F:desired-off            | F:desired-off',
  'off N F run    | F:desired-off            | F:desired-off            | F:desired-off',
  'off N F down   | F:desired-off            | F:desired-off            | F:desired-off',
  'off N F noresp | F:desired-off            | F:desired-off            | F:desired-off',
  'off N F unk    | F:desired-off            | F:desired-off            | F:desired-off',
  'off N N run    | F:desired-off            | F:desired-off            | F:desired-off',
  'off N N down   | F:desired-off            | F:desired-off            | F:desired-off',
  'off N N noresp | F:desired-off            | F:desired-off            | F:desired-off',
  'off N N unk    | F:desired-off            | F:desired-off            | F:desired-off',
]
const FLAG = { T: true, F: false, N: null }
const DAEMON = { run: 'running', down: 'not-running', noresp: 'not-responding', unk: 'unknown' }
const INSTALLED_AT = Date.parse('2026-10-07T10:00:00Z')
const PROCS = { none: [], before: [{ pid: 7, startedAt: INSTALLED_AT - 60_000, trusted: null }], after: [{ pid: 7, startedAt: INSTALLED_AT + 60_000, trusted: null }] }
const said = (cell) => (cell === 'T' ? { captured: true, reason: null } : cell === '?' ? { captured: null, reason: null } : { captured: false, reason: cell.slice(2) })

test('V32: judgeHarness over every desired × entry × link × daemon × process-timing combination equals the literal table; every reason is in the closed set', () => {
  assert.equal(TABLE.length, 2 * 3 * 3 * 4, 'every combination has a line')
  assert.equal(new Set(TABLE.map((l) => l.split('|')[0].trim())).size, TABLE.length, 'and none twice')
  const seen = new Set()
  for (const line of TABLE) {
    const [key, ...cells] = line.split('|').map((s) => s.trim())
    const [desired, entry, link, daemon] = key.split(/\s+/)
    ;['none', 'before', 'after'].forEach((proc, i) => {
      const want = said(cells[i])
      const got = judgeHarness({ desired, entryIntact: FLAG[entry], linkAttached: FLAG[link], daemon: DAEMON[daemon], procs: PROCS[proc], installedAt: INSTALLED_AT })
      const rows = proc === 'none' ? [want] : [{ pid: 7, ...want }]
      assert.deepEqual(got, { captured: want.captured, rows }, `${key} / ${proc}`)
      if (got.rows[0].reason) seen.add(got.rows[0].reason)
    })
  }
  for (const r of seen) assert.ok(STATUS_REASONS.includes(r), `${r} is in STATUS_REASONS`)
  assert.deepEqual([...seen].sort(), ['config-after-start', 'daemon-not-responding', 'daemon-not-running', 'desired-off', 'entry-missing', 'link-missing'], 'the table exercises each of them')
})

test('the closed set: asight\'s own reasons and every trust reason of 4.6, no duplicates, frozen', () => {
  const own = ['desired-off', 'entry-missing', 'entry-changed', 'link-missing', 'daemon-not-running', 'daemon-not-responding', 'helper-missing', 'negative-cache']
  for (const r of [...own, ...TRUST_REASONS]) assert.ok(STATUS_REASONS.includes(r), r)
  assert.equal(new Set(STATUS_REASONS).size, STATUS_REASONS.length)
  assert.ok(Object.isFrozen(STATUS_REASONS))
})

const ready = { desired: 'on', entryIntact: true, linkAttached: true, daemon: 'running', installedAt: INSTALLED_AT }
test('the daemon\'s own verdict on a process stands: untrusted says its reason, trusted is captured, trusted with a refused host is negative-cache; the harness is captured only when every process is', () => {
  const j = (procs, o = {}) => judgeHarness({ ...ready, procs, ...o })
  assert.deepEqual(j([{ pid: 1, trusted: false, reason: 'var-missing' }]), { captured: false, rows: [{ pid: 1, captured: false, reason: 'var-missing' }] })
  assert.deepEqual(j([{ pid: 1, trusted: true }, { pid: 2, trusted: true, negative: true }]), { captured: false, rows: [{ pid: 1, captured: true, reason: null }, { pid: 2, captured: false, reason: 'negative-cache' }] })
  assert.deepEqual(j([{ pid: 1, trusted: true }, { pid: 2, trusted: true }]).captured, true)
  assert.deepEqual(j([{ pid: 1, trusted: true }, { pid: 2, trusted: null, startedAt: INSTALLED_AT + 1 }, { pid: 3, trusted: null, startedAt: INSTALLED_AT + 1 }], { entryIntact: null }).captured, null, 'one unknown and the rest captured: not known')
  assert.deepEqual(j([{ pid: 1, trusted: true }, { pid: 2, trusted: false, reason: 'config-after-start' }], { entryIntact: null }).captured, false, 'a process that is not captured decides it, whatever else is unknown')
  assert.deepEqual(j([{ pid: 1, trusted: false, reason: 'off' }]).rows, [{ pid: 1, captured: false, reason: 'desired-off' }], 'the daemon calls an agent of an off harness "off"; status says desired-off')
  assert.deepEqual(j([{ pid: 1, trusted: true }], { entryIntact: false }).captured, true, 'what the daemon judges is not overruled by the entry (its 5 s check turns it untrusted itself)')
})

test('the entry says what is wrong with it (missing or changed), a helper that is missing or the wrong version is helper-missing, no link is link-missing even for a trusted process', () => {
  const j = (o) => judgeHarness({ ...ready, procs: [], ...o })
  assert.deepEqual(j({ entryIntact: false, entryWhy: 'entry-changed' }), { captured: false, rows: [{ captured: false, reason: 'entry-changed' }] })
  assert.deepEqual(j({ entryIntact: false }).rows[0].reason, 'entry-missing', 'false without a reason is missing')
  assert.deepEqual(j({ helper: 'missing', procs: [{ pid: 3, trusted: true }] }).rows, [{ pid: 3, captured: false, reason: 'helper-missing' }])
  assert.deepEqual(j({ linkAttached: false, procs: [{ pid: 3, trusted: true }] }).rows, [{ pid: 3, captured: false, reason: 'link-missing' }])
})

test('the order of the reasons is off · daemon · helper · link: a missing helper outranks a link that is not there (a dead helper leaves no link, and the fix is the helper), and is outranked by the switch and by the daemon', async () => {
  const j = (o) => judgeHarness({ ...ready, helper: 'missing', procs: [{ pid: 3, trusted: true }], ...o })
  const why = (o) => j(o).rows[0].reason
  assert.equal(why({ linkAttached: false }), 'helper-missing', 'not link-missing: the user is sent to sudo asight setup-helper, not to asight on')
  assert.equal(why({ linkAttached: null }), 'helper-missing')
  assert.equal(why({ linkAttached: true }), 'helper-missing')
  assert.equal(why({ linkAttached: false, procs: [] }), 'helper-missing', 'the harness\'s own row too')
  assert.equal(why({ desired: 'off', linkAttached: false }), 'desired-off')
  assert.equal(why({ daemon: 'not-running', linkAttached: false }), 'daemon-not-running')
  assert.equal(why({ daemon: 'not-responding', linkAttached: false }), 'daemon-not-responding')
  assert.deepEqual(j({ daemon: 'unknown', linkAttached: false, procs: [] }), { captured: null, rows: [{ captured: null, reason: null }] }, 'a daemon that is not known: the helper it reports is not known either')
  assert.equal(judgeHarness({ ...ready, linkAttached: false, procs: [{ pid: 3, trusted: true }] }).rows[0].reason, 'link-missing', 'with a helper that is there, the link is what is missing')
})

test('a process the daemon has not judged: no start time is start-time-unknown, no installed_at to compare with is 不知道, an entry that is not intact comes first (a restart would not help)', () => {
  const j = (p, o = {}) => judgeHarness({ ...ready, procs: [p], ...o }).rows[0]
  assert.deepEqual(j({ pid: 4, startedAt: null, trusted: null }), { pid: 4, captured: false, reason: 'start-time-unknown' })
  assert.deepEqual(j({ pid: 4, startedAt: INSTALLED_AT - 1, trusted: null }, { installedAt: null }), { pid: 4, captured: null, reason: null })
  assert.deepEqual(j({ pid: 4, startedAt: INSTALLED_AT - 1, trusted: null }, { entryIntact: false }), { pid: 4, captured: false, reason: 'entry-missing' })
  assert.deepEqual(j({ pid: 4, startedAt: new Date(INSTALLED_AT + 5).toISOString(), trusted: null }, { installedAt: new Date(INSTALLED_AT).toISOString() }), { pid: 4, captured: true, reason: null }, 'times as ISO strings too')
})

// ── the command, over a sandbox HOME in which `asight on` has really run (the real turnOn, a fake systemd, a fake daemon behind the control socket) ────────────────────────────────────────────────
import fs from 'node:fs'
import path from 'node:path'
import { installedHome } from '../off/fixtures/off-ctx.mjs'
import { snapshot, changedFiles, fakeIo } from './fixtures/on-ctx.mjs'
import { runStatus, down, reply, asDaemon, claudeProc, NO_VPN, CLASH, SOCK } from './fixtures/status-ctx.mjs'
import { validateReceipt } from '../../src/cli/schema.mjs'
import { runStatusCli } from '../../src/cli/status.mjs'
import { tmpDir } from '../helpers/tmp.mjs'

const run = runStatus

test('the daemon answers: each agent is captured or says why, and the exit code is 1 while one is not; every agent captured is exit 0', async () => {
  const s = await installedHome()
  const agents = [{ pid: 4121, agent: 'claude-code', trusted: true }, { pid: 4388, agent: 'claude-code', trusted: false, reason: 'config-after-start', hint: 'the trust entry was written after this process started; restart it once' }]
  let r = await run(s, [], { request: asDaemon(reply({ agents })) })
  assert.equal(r.exit, 1, r.text)
  assert.match(r.text, /claude-code\s+没有: config-after-start[^\n]*期望 on/)
  assert.match(r.text, /pid 4121\s+已被采集/)
  assert.match(r.text, /pid 4388\s+没有: config-after-start — [^\n]*重启后才会被采集/)
  assert.match(r.text, /codex\s+正在被采集/, 'a harness with no process is judged by the link and the entry')
  r = await run(s, [], { request: asDaemon(reply({ agents: agents.slice(0, 1) })) })
  assert.equal(r.exit, 0, r.text)
  assert.match(r.text, /claude-code\s+正在被采集/)
  r = await run(s, ['claude'], { request: asDaemon(reply()) })
  assert.ok(!/codex/.test(r.text.split('\n').filter((l) => /^ {2}\w/.test(l)).join('\n')), 'a name restricts the table (the alias claude is claude-code)')
  r = await run(s, [], { request: asDaemon(reply({ actual: 'off', mismatch: true })) })
  assert.match(r.text, /claude-code\s+没有: link-missing/); assert.equal(r.exit, 1)
  r = await run(s, [], { request: asDaemon(reply({ helper: { pid: null, proto: null, ok: false, down: 'ENOENT', expected_proto: 1 } })) })
  assert.match(r.text, /没有: helper-missing[^\n]*sudo asight setup-helper/)
  r = await run(s, [], { request: asDaemon(reply({ actual: 'off', mismatch: true, helper: { pid: null, proto: null, ok: false, down: 'ENOENT', expected_proto: 1 } })) })
  assert.match(r.text, /claude-code\s+没有: helper-missing[^\n]*sudo asight setup-helper/, 'a dead helper leaves the kernel with no link: the reason is the helper, not the link')
  assert.ok(!/link-missing/.test(r.text), r.text)
  r = await run(s, [], { request: asDaemon(reply({ agents: [{ pid: 4121, agent: 'claude-code', trusted: true }], negatives: [{ pid: 4121, host: 'api.anthropic.com', cause: 'client-rejected-leaf' }] })) })
  assert.match(r.text, /pid 4121\s+没有: negative-cache/)
})

test('the entry on disk decides when no process does: intact when the value is there (the file may have been rewritten), entry-missing when it is gone, entry-changed when it is something else', async () => {
  const s = await installedHome()
  const settings = path.join(s.home, '.claude', 'settings.json')
  const ok = JSON.parse(fs.readFileSync(settings, 'utf8'))
  fs.writeFileSync(settings, JSON.stringify({ ...ok, theme: 'dark' }, null, 4)) // Claude Code rewrote the file: the key is still there
  let r = await run(s, ['claude-code'], { request: asDaemon(reply()) })
  assert.match(r.text, /claude-code\s+正在被采集[^\n]*信任入口完好/); assert.equal(r.exit, 0)
  const cur = JSON.parse(fs.readFileSync(settings, 'utf8'))
  fs.writeFileSync(settings, JSON.stringify({ ...cur, env: { ...cur.env, NODE_EXTRA_CA_CERTS: '/elsewhere/ca.pem' } }))
  r = await run(s, ['claude-code'], { request: asDaemon(reply()) })
  assert.match(r.text, /claude-code\s+没有: entry-changed[^\n]*信任入口被改过/); assert.equal(r.exit, 1)
  fs.writeFileSync(settings, JSON.stringify({ theme: 'dark' }))
  r = await run(s, ['claude-code'], { request: asDaemon(reply()) })
  assert.match(r.text, /claude-code\s+没有: entry-missing[^\n]*信任入口不在了/)
  fs.rmSync(settings)
  r = await run(s, ['claude-code'], { request: asDaemon(reply()) })
  assert.match(r.text, /entry-missing/)
})

test('no daemon: nothing is captured (daemon-not-running), read from the disk, with the processes found by the manifest\'s signatures — each one says the daemon is not running, whenever it started (the entry and the start time only come into it once a daemon answers)', async () => {
  const s = await installedHome()
  const old = Date.now() - 3600e3
  const r = await run(s, [], { procs: async () => [claudeProc(5000, old), claudeProc(5001, Date.now() + 5000)] })
  assert.equal(r.exit, 1, r.text)
  assert.match(r.text, /守护进程: 没在跑/)
  assert.match(r.text, /claude-code\s+没有: daemon-not-running/)
  assert.match(r.text, /pid 5000\s+没有: daemon-not-running/); assert.match(r.text, /pid 5001\s+没有: daemon-not-running/)
  assert.match(r.text, /capture health:/, 'and the capture health read from disk follows (the failures of 24 h)')
})

test('the daemon answers but has not listed a process of a harness (it started since the daemon last looked): the entry and when it started decide (V32) — older than the entry: config-after-start and told to restart; newer: captured, and said to be by entry and start time; entry gone: entry-missing; a pid the daemon lists is not added twice', async () => {
  const s = await installedHome()
  const old = Date.now() - 3600e3, fresh = Date.now() + 5000
  const procs = async () => [claudeProc(5000, old), claudeProc(5001, fresh), claudeProc(5002, fresh)]
  const request = asDaemon(reply({ agents: [{ pid: 5002, agent: 'claude-code', trusted: true }] }))
  let r = await run(s, [], { procs, request })
  assert.equal(r.exit, 1, r.text)
  assert.match(r.text, /pid 5000\s+没有: config-after-start — [^\n]*重启后才会被采集/)
  assert.match(r.text, /pid 5001\s+已被采集\(守护进程还没判过它,这是按信任入口与启动时间判的\)/)
  assert.match(r.text, /pid 5002\s+已被采集$/m, 'the daemon\'s own verdict carries no caveat')
  assert.match(r.text, /需要你做的: 正在跑的 claude-code\(pid 5000\)重启后才会被采集/)
  const doc = (await run(s, ['--json'], { procs, request })).io.json()
  const rows = doc.harnesses.find((h) => h.harness === 'claude-code').rows.map((x) => [x.pid, x.captured, x.reason]).sort((a, b) => a[0] - b[0])
  assert.deepEqual(rows, [[5000, false, 'config-after-start'], [5001, true, null], [5002, true, null]], 'three rows: the listed pid once')
  assert.deepEqual(doc.restart, [{ harness: 'claude-code', pid: 5000, reason: 'config-after-start' }])
  // the entry is gone: a restart would not help, so it is the entry that is said — for the one the daemon has not judged only (the daemon turns its own untrusted by itself)
  fs.rmSync(path.join(s.home, '.claude', 'settings.json'))
  r = await run(s, [], { procs, request })
  assert.match(r.text, /pid 5001\s+没有: entry-missing/); assert.match(r.text, /pid 5000\s+没有: entry-missing/); assert.match(r.text, /pid 5002\s+已被采集$/m)
  // a process of another harness, or one that matches no signature, is not added to this one
  r = await run(s, ['codex'], { procs, request: asDaemon(reply()) })
  assert.ok(!/pid 500\d/.test(r.text.split('\n').filter((l) => /^ {2}\w|^ {6}pid/.test(l)).join('\n')), r.text)
})

test('off: every harness is desired-off, exit 0 — nothing is wrong with a switch that is off', async () => {
  const s = await installedHome()
  const off = await s.off(); assert.equal(off.exit, 0)
  const r = await run(s)
  assert.equal(r.exit, 0, r.text)
  assert.match(r.text, /claude-code\s+没有: desired-off[^\n]*期望态是 off/); assert.match(r.text, /codex\s+没有: desired-off/)
})

test('V32: no daemon and state.json unreadable: 不知道 with the file and the errno for every harness, exit 3 — and --json says the same (captured null)', async () => {
  const s = await installedHome()
  const stateF = path.join(s.dir, 'state.json')
  const broken = { ...fs, readFileSync: (f, ...a) => { if (f === stateF) throw Object.assign(new Error(`EACCES: permission denied, open '${f}'`), { code: 'EACCES' }); return fs.readFileSync(f, ...a) } }
  const r = await run(s, [], { fs: broken })
  assert.equal(r.exit, 3, r.text)
  assert.match(r.text, new RegExp(`期望态: 不知道[^\\n]*${stateF.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\n]*EACCES`))
  assert.match(r.text, /claude-code\s+不知道\([^)]*EACCES/)
  const j = await run(s, ['--json'], { fs: broken })
  assert.equal(j.exit, 3)
  const doc = j.io.json()
  assert.deepEqual(validateReceipt(doc), [])
  assert.deepEqual([doc.command, doc.ok, doc.harnesses.map((h) => [h.harness, h.captured, h.desired])], ['status', false, [['claude-code', null, 'unknown'], ['codex', null, 'unknown']]])
  // R11: 不知道 carries its reason in the JSON too — the file and the errno, at the top and for every harness that waits on it
  assert.ok(doc.state_error.includes(stateF) && doc.state_error.includes('EACCES'), doc.state_error)
  for (const h of doc.harnesses) assert.ok(h.why.some((w) => w.includes(stateF) && w.includes('EACCES')), `${h.harness}: ${JSON.stringify(h.why)}`)
  assert.ok(!('manifest_error' in doc) && !('health_error' in doc), 'what could be read has no error key')
})

test('R11: the daemon answers but could not read the kernel state: every harness that is on is 不知道 with the daemon\'s error and its code — in the text and in --json — exit 3, never 没有 and never 正在被采集', async () => {
  const s = await installedHome()
  const bad = (o) => asDaemon(reply({ actual: 'unknown', ...o }))
  let r = await run(s, [], { request: bad({ error: 'helper socket: connect EACCES /run/asight/helper.sock', error_code: 'EACCES' }) })
  assert.equal(r.exit, 3, r.text)
  assert.match(r.text, /claude-code\s+不知道\(the daemon could not read the kernel state: helper socket: connect EACCES \/run\/asight\/helper\.sock\)/)
  assert.match(r.text, /codex\s+不知道\(the daemon could not read the kernel state/)
  assert.ok(!/正在被采集|没有: link-missing/.test(r.text.split('\n').filter((l) => /^ {2}(claude-code|codex)/.test(l)).join('\n')), r.text)
  r = await run(s, ['--json'], { request: bad({ error: 'the helper did not answer', error_code: 'ETIMEDOUT' }) })
  const doc = r.io.json()
  assert.equal(r.exit, 3)
  assert.deepEqual(doc.harnesses.map((h) => [h.harness, h.captured, h.desired]), [['claude-code', null, 'on'], ['codex', null, 'on']])
  for (const h of doc.harnesses) assert.deepEqual(h.why, ['the daemon could not read the kernel state: the helper did not answer (ETIMEDOUT)'], 'a code the message does not name is added')
  r = await run(s, ['codex'], { request: bad({}) })
  assert.match(r.text, /codex\s+不知道\(the daemon could not read the kernel state: it gave no reason\)/)
  // a reply that carries no kernel state at all is not known either, and says what it carried
  r = await run(s, ['codex'], { request: asDaemon({ ...reply(), actual: undefined }) })
  assert.match(r.text, /codex\s+不知道\([^)]*does not say whether the kernel has this instance's link/); assert.equal(r.exit, 3)
})

test('a daemon that does not answer is daemon-not-responding; --json is one document that validates, with the code ids and the restart list', async () => {
  const s = await installedHome()
  const r = await run(s, [], { request: down('ETIMEDOUT') })
  assert.match(r.text, /守护进程: 没响应/); assert.match(r.text, /claude-code\s+没有: daemon-not-responding/); assert.equal(r.exit, 1)
  const agents = [{ pid: 4388, agent: 'claude-code', trusted: false, reason: 'config-after-start' }]
  const j = await run(s, ['--json'], { request: asDaemon(reply({ agents })) })
  const doc = j.io.json()
  assert.deepEqual(validateReceipt(doc), [])
  assert.deepEqual(doc.restart, [{ harness: 'claude-code', pid: 4388, reason: 'config-after-start' }])
  assert.deepEqual(doc.harnesses.map((h) => [h.harness, h.captured, h.reason]), [['claude-code', false, 'config-after-start'], ['codex', true, null]])
  assert.equal(j.io.stderrText(), '', 'stdout carries the one JSON, nothing leaks to stderr')
})

test('status changes nothing in the HOME but ~/.asight/netenv.json (the board\'s copy of the VPN probe, 0600), and usage errors (an unknown harness, an unknown option) exit 2 before anything is read', async () => {
  const s = await installedHome()
  const before = snapshot(s.home)
  await run(s); await run(s, ['--json']); await run(s, [], { request: asDaemon(reply()) })
  assert.deepEqual(changedFiles(before, snapshot(s.home)), [path.join('.asight', 'netenv.json')], 'read-only, but for the one cache')
  assert.equal(fs.statSync(path.join(s.home, '.asight', 'netenv.json')).mode & 0o777, 0o600)
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(s.home, '.asight', 'netenv.json'), 'utf8')).unknown, NO_VPN.unknown)
  let r = await run(s, ['claud']); assert.equal(r.exit, 2); assert.match(r.io.stderrText(), /unknown harness claud[^\n]*claude-code/); assert.equal(r.text, '')
  r = await run(s, ['--nope']); assert.equal(r.exit, 2); assert.match(r.io.stderrText(), /unknown option --nope/)
  const fresh = tmpDir('asight-fresh-')
  const f = await runStatusCli([], { io: fakeIo(), home: fresh, platform: 'linux', env: { HOME: fresh }, deps: { request: down(), socketPath: SOCK, procs: async () => [], netenv: async () => NO_VPN } })
  assert.equal(f, 0); assert.deepEqual(fs.readdirSync(fresh), [], 'on a machine with nothing installed it prints so, exits 0, and creates nothing')
})

test('connections still relayed after an off: N closing and M waiting, in the text and in --json (cut is 0: only off --now cuts); none is said as none, with no daemon there is no engine', async () => {
  const s = await installedHome()
  let r = await run(s, [], { request: asDaemon(reply({ relayed: { closing: 2, waiting: 1 } })) })
  assert.match(r.text, /^仍经 asight 的连接: 2 条仍经 asight 中转,本次响应\(或本轮\)结束后关闭;另 1 条等它自己关闭\(asight off --now 立即切断\)$/m)
  assert.deepEqual((await run(s, ['--json'], { request: asDaemon(reply({ relayed: { closing: 2, waiting: 1 } })) })).io.json().relayed, { closing: 2, waiting: 1, cut: 0 })
  r = await run(s, [], { request: asDaemon(reply()) })
  assert.match(r.text, /^仍经 asight 的连接: 没有/m)
  assert.deepEqual((await run(s, ['--json'])).io.json().relayed, { closing: 0, waiting: 0, cut: 0 }, 'no daemon: no engine, so none — a known zero')
})

test('the VPN line: the product, its mode, TUN and the system proxy, which harnesses go through it (only the ones asked about), and what is not known; on Linux asight says it did not change it', async () => {
  const s = await installedHome()
  let r = await run(s, [], { netenv: async () => CLASH({ tun: true, mode: 'global', live: false, reason: 'no core answered' }) })
  assert.match(r.text, /^本机网络环境: Clash Verge\(全局模式,TUN 已开,系统代理已开,没问到它的控制接口\);claude-code、codex 的流量经过它;asight 没有改它$/m)
  assert.match(r.text, /^ {2}说明: no core answered$/m)
  assert.ok(!/hermes/.test(r.text.split('\n').filter((l) => l.startsWith('本机网络环境')).join('\n')), 'only the harnesses in the table')
  r = await run(s, ['codex'], { netenv: async () => CLASH({ via: { 'claude-code': true, codex: false, hermes: 'unknown' } }) })
  assert.match(r.text, /^本机网络环境: Clash Verge\(规则模式,系统代理已开\);codex 不经过它;asight 没有改它$/m)
  const j = (await run(s, ['--json'], { netenv: async () => CLASH() })).io.json()
  assert.equal(j.netenv.products[0].product, 'clash-verge')
})

test('the harnesses\' proxy settings reach the probe from the running processes\' environment (the URLs are the probe\'s to compare and drop: never printed); an asight serve you started is listed, not killed', async () => {
  const s = await installedHome()
  let seen = null
  const procs = async () => [claudeProc(5000, Date.now() + 5000, new Map([['HTTPS_PROXY', 'http://alice:pw@127.0.0.1:7897']])), { pid: 5310, ppid: 1, uid: 1000, startedAt: 1, exe: '/usr/bin/node', argv: ['node', '/repo/bin/asight.mjs', 'serve'], env: () => new Map() }]
  const r = await run(s, [], { procs, request: asDaemon(reply()), netenv: async ({ proxies }) => { seen = proxies; return NO_VPN } })
  assert.deepEqual(seen, { 'claude-code': ['http://alice:pw@127.0.0.1:7897'] })
  assert.ok(!r.text.includes('alice:pw'))
  assert.match(r.text, /^你自己起的 asight 进程仍在跑: asight serve\(pid 5310,只读看板,不在 agent 路径上\)$/m)
  const down2 = await run(s, [], { procs: async () => { throw new Error('the process table /proc cannot be read (EACCES)') } })
  assert.match(down2.text, /^你自己起的 asight 进程: 不知道\(the process table/m)
})

// R11 / D38: the copy of the VPN probe the board reads is a cache; that it could not be refreshed is said, not dropped (a board that keeps showing the old one is a silent failure)
const rootCanWrite = typeof process.getuid === 'function' && process.getuid() === 0 ? 'root can write into a directory with no write bit' : false
test('a netenv.json that could not be written is said: a line in the text, netenv_write_error (the file and the errno) in --json; the verdicts and the exit code do not change', { skip: rootCanWrite }, async () => {
  const s = await installedHome()
  const home = path.join(s.home, '.asight')
  const control = await run(s, [])
  assert.ok(!/没写成/.test(control.text), 'written: nothing to say')
  assert.ok(!('netenv_write_error' in (await run(s, ['--json'])).io.json()))
  fs.rmSync(path.join(home, 'netenv.json'))
  fs.chmodSync(home, 0o500)
  try {
    const r = await run(s, [])
    assert.match(r.text, new RegExp(`^本机网络环境的副本没写成: ${path.join(home, 'netenv.json').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: EACCES;看板读的是它,会一直显示旧的$`, 'm'))
    assert.equal(r.exit, control.exit)
    const j = await run(s, ['--json'])
    assert.equal(j.io.json().netenv_write_error, `${path.join(home, 'netenv.json')}: EACCES`)
    assert.equal(j.exit, control.exit)
    assert.deepEqual(validateReceipt(j.io.json()), [])
    // a platform with no new collector says it too
    const mac = tmpDir('asight-st-mac-'); fs.mkdirSync(path.join(mac, '.asight'), { mode: 0o700 }); fs.chmodSync(path.join(mac, '.asight'), 0o500)
    for (const [argv, check] of [[[], (io) => assert.match(io.stdoutText(), /^本机网络环境的副本没写成: [^\n]*netenv\.json: EACCES/m)], [['--json'], (io) => assert.match(io.json().netenv_write_error, /netenv\.json: EACCES$/)]]) {
      const io = fakeIo()
      await runStatusCli(argv, { io, home: mac, platform: 'darwin', env: {}, deps: { exec: fakeMac({ loaded: [], keychain: false }).run, netenv: async () => CLASH() } })
      check(io)
    }
    fs.chmodSync(path.join(mac, '.asight'), 0o700)
  } finally { fs.chmodSync(home, 0o700) }
})

// ── V39: logging out stops the daemon unless linger is on (1.6 §1.1) — `on` and `status` say so, give the command, and never run loginctl (R8) ───────────────────────────────────────────────────
import { runOnCli } from '../../src/cli/on.mjs'
import { onCtx, seedClaude, recordingExec } from './fixtures/on-ctx.mjs'
import { fakeMac } from './fixtures/legacy-ctx.mjs'

test('V39 status: linger off says 登出后停采(未开 linger) and loginctl enable-linger <user>, --json linger false; on says nothing; unreadable says 不知道 with the file and the errno, never 已开', async () => {
  const s = await installedHome()
  const noLoginctl = () => assert.ok(!s.sys.exec.calls.some((c) => /loginctl/.test(c)), 'loginctl is not run: asight says how, it does not do it')
  let r = await run(s, [], { lingerRead: () => ({ state: false }) })
  assert.match(r.text, /^登出后停采\(未开 linger\): 要登出后继续采集,跑 loginctl enable-linger alice$/m)
  assert.equal((await run(s, ['--json'], { lingerRead: () => ({ state: false }) })).io.json().linger, false)
  r = await run(s, [], { lingerRead: () => ({ state: true }) })
  assert.ok(!/linger|登出/.test(r.text), 'on: no line')
  assert.equal((await run(s, ['--json'], { lingerRead: () => ({ state: true }) })).io.json().linger, true)
  r = await run(s, [], { lingerRead: () => ({ state: null, error: '/var/lib/systemd/linger/alice: EACCES' }) })
  assert.match(r.text, /^登出后停采: 不知道\(\/var\/lib\/systemd\/linger\/alice: EACCES\)$/m); assert.ok(!/已开/.test(r.text))
  const j = (await run(s, ['--json'], { lingerRead: () => ({ state: null, error: 'EACCES' }) })).io.json()
  assert.deepEqual([j.linger, validateReceipt(j)], ['unknown', []])
  r = await run(s, [], { lingerRead: () => { throw new Error('the reader broke') } })
  assert.match(r.text, /^登出后停采: 不知道\(the reader broke\)$/m)
  noLoginctl()
})

test('V39 on: the same lines in the receipt (and in the plan\'s receipt when --json: linger is false / true / "unknown" with a reason); nothing runs loginctl', async () => {
  for (const [lingerRead, want] of [[() => ({ state: false }), false], [() => ({ state: true }), true], [() => ({ state: null, error: '/var/lib/systemd/linger/alice: EACCES' }), 'unknown']]) {
    const home = tmpDir('asight-v39-'); seedClaude(home)
    const io = fakeIo(), exec = recordingExec(), ctx = onCtx(home, io, { exec, deps: { lingerRead, linger: undefined } })
    assert.equal(await runOnCli(['--yes'], ctx), 0, io.text())
    if (want === false) assert.match(io.stdoutText(), /^登出后停采\(未开 linger\): 要登出后继续采集,跑 loginctl enable-linger alice$/m)
    else if (want === true) assert.ok(!/linger|登出/.test(io.stdoutText()))
    else { assert.match(io.stdoutText(), /^登出后停采: 不知道\(\/var\/lib\/systemd\/linger\/alice: EACCES\)$/m); assert.ok(!/已开/.test(io.stdoutText())) }
    const j = fakeIo(); const home2 = tmpDir('asight-v39-'); seedClaude(home2); const exec2 = recordingExec()
    assert.equal(await runOnCli(['--yes', '--json'], onCtx(home2, j, { exec: exec2, deps: { lingerRead, linger: undefined } })), 0)
    for (const e of [exec, exec2]) {
      assert.ok(e.calls.length > 0, 'on ran its OS tools through this runner: the check below looks at something')
      assert.ok(!e.has(/loginctl/), `loginctl is not run by on: asight says how, it does not do it (R8) — ${e.calls.join(' | ')}`)
    }
    const doc = j.json()
    assert.equal(doc.linger, want)
    if (want === 'unknown') assert.match(doc.linger_reason, /EACCES/)
  }
})

test('a platform without the new collector (macOS): status prints the old capture\'s health and also what the VPN software is (§6: every platform), without "asight 没有改它" (the old capture does steer Clash there); --json carries the probe; a probe that fails is 不知道 with the reason', async () => {
  const home = tmpDir('asight-st-mac-'); const exec = fakeMac({ loaded: [], keychain: false }).run // status reads launchd and the keychain there: the runner is the test's
  let io = fakeIo()
  let exit = await runStatusCli([], { io, home, platform: 'darwin', env: {}, deps: { exec, netenv: async () => CLASH() } })
  assert.match(io.stdoutText(), /本平台\(darwin\)还没有新采集器/)
  assert.match(io.stdoutText(), /本机网络环境: Clash Verge\(规则模式,系统代理已开\)/)
  assert.ok(!io.stdoutText().includes('asight 没有改它'), io.stdoutText())
  assert.ok([0, 1, 3].includes(exit))
  io = fakeIo()
  exit = await runStatusCli(['--json'], { io, home, platform: 'darwin', env: {}, deps: { exec, netenv: async () => CLASH() } })
  const v = io.json()
  assert.deepEqual(validateReceipt(v), [])
  assert.equal(v.netenv.products[0].product, 'clash-verge')
  io = fakeIo()
  await runStatusCli([], { io, home, platform: 'darwin', env: {}, deps: { exec, netenv: async () => { throw new Error('probe broke') } } })
  assert.match(io.stdoutText(), /本机网络环境: 不知道\(probe broke\)/)
  assert.deepEqual(fs.readdirSync(home), [], 'nothing was written: there is no ~/.asight here to keep the board\'s copy in')
})

test('semantics 2: an install manifest that parses but is not a manifest ({"version":2}, entries as an object) is 不知道 with the file and the reason — exit 3, no stack trace, never "没有装入口" — in the text and in --json', async () => {
  for (const body of ['{"version":2}', (m) => ({ ...m, entries: { a: 1 } })]) {
    const s = await installedHome()
    const file = path.join(s.dir, 'install-manifest.json')
    fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body(JSON.parse(fs.readFileSync(file, 'utf8')))))
    const r = await run(s, [], { request: asDaemon(reply()) })
    assert.equal(r.exit, 3, r.text)
    assert.match(r.text, /安装清单: 不知道\([^)]*install-manifest\.json[^)]*not an install manifest this build can use/)
    assert.ok(!/没有装入口/.test(r.text), 'a manifest nobody can read does not say "nothing is installed"')
    const doc = (await run(s, ['--json'], { request: asDaemon(reply()) })).io.json()
    assert.deepEqual(validateReceipt(doc), [])
    assert.match(doc.manifest_error, /install-manifest\.json.*not an install manifest this build can use/)
  }
})

// audit rule-b 6 (R11): with no daemon and no manifest — a fresh machine, or after uninstall — `status` printed 「你自己起的 asight 进程: 不知道」 although the processes a user started
// themselves are found by their command line alone: the table was not read because the MANIFEST (needed only to match processes to harnesses) was missing.
test('R11: with no daemon and no install manifest the asight processes the user started themselves are still listed — the process table is read, only the matching to harnesses is not known', async () => {
  const s = await installedHome()
  const out = await s.uninstall({ yes: true })
  assert.equal(out.exit, 0, JSON.stringify(out.receipt.problems))
  assert.ok(!fs.existsSync(path.join(s.dir, 'install-manifest.json')), 'nothing is installed any more')
  const serve = { pid: 7001, ppid: 1, uid: 1000, startedAt: Date.now() - 1000, exe: '/usr/bin/node', argv: ['/usr/bin/node', '/home/u/asight/bin/asight.mjs', 'serve', '--port', '4000'], env: () => null }
  const unrelated = { pid: 7002, ppid: 1, uid: 1000, startedAt: Date.now() - 1000, exe: '/usr/bin/vim', argv: ['vim'], env: () => null }
  const r = await run(s, [], { procs: async () => [serve, unrelated] })
  assert.match(r.text, /你自己起的 asight 进程仍在跑: asight serve\(pid 7001,/)
  assert.ok(!/你自己起的 asight 进程: 不知道/.test(r.text), r.text)
  const doc = (await run(s, ['--json'], { procs: async () => [serve, unrelated] })).io.json()
  assert.deepEqual(doc.user_processes.map((p) => [p.pid, p.command]), [[7001, 'asight serve']])
  // a table that cannot be read is still 不知道, with the reason
  const bad = await run(s, [], { procs: async () => { throw new Error('ps failed (exit 1: nope)') } })
  assert.match(bad.text, /你自己起的 asight 进程: 不知道\(ps failed \(exit 1: nope\)\)/)
  // what needs the manifest is still said as not known, with the reason: a named harness's entry
  const named = await run(s, ['codex'], { procs: async () => [serve] })
  assert.match(named.text, /codex\s+没有: desired-off[^\n]*信任入口: 不知道\(no install manifest in /)
  assert.match(named.text, /你自己起的 asight 进程仍在跑: asight serve\(pid 7001,/)
})
