// test/cli/status.test.mjs — `trocar status` (RFC 1.6 §2, V32, V39): what it says of each agent — captured, or not and why (one reason from the closed set of 4.6) — from the desired
// state, the entry, the link, the daemon and when the process started; and what it prints when it cannot tell. Sandbox HOMEs, injected process tables and control sockets: nothing here
// reaches the machine (0.1 §3).
import test from 'node:test'
import assert from 'node:assert/strict'
import { judgeHarness, STATUS_REASONS } from '../../src/cli/status.mjs'
import { certOfForms } from '../../src/netenv/verdict.mjs'
import { TRUST_REASONS } from '../../src/health/codes.mjs'
import { darwinNetFacts } from '../../src/collector/arch/darwin/netfacts.mjs'

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
      const got = judgeHarness({ desired, entryIntact: FLAG[entry], attached: FLAG[link], daemon: DAEMON[daemon], procs: PROCS[proc], installedAt: INSTALLED_AT })
      const rows = proc === 'none' ? [want] : [{ pid: 7, ...want }]
      assert.deepEqual(got, { captured: want.captured, rows }, `${key} / ${proc}`)
      if (got.rows[0].reason) seen.add(got.rows[0].reason)
    })
  }
  for (const r of seen) assert.ok(STATUS_REASONS.includes(r), `${r} is in STATUS_REASONS`)
  assert.deepEqual([...seen].sort(), ['config-after-start', 'daemon-not-responding', 'daemon-not-running', 'desired-off', 'entry-missing', 'link-missing'], 'the table exercises each of them')
})

test('the closed set: trocar\'s own reasons and every trust reason of 4.6, no duplicates, frozen', () => {
  const own = ['desired-off', 'entry-missing', 'entry-changed', 'link-missing', 'daemon-not-running', 'daemon-not-responding', 'helper-missing', 'negative-cache']
  for (const r of [...own, ...TRUST_REASONS]) assert.ok(STATUS_REASONS.includes(r), r)
  assert.equal(new Set(STATUS_REASONS).size, STATUS_REASONS.length)
  assert.ok(Object.isFrozen(STATUS_REASONS))
})

const ready = { desired: 'on', entryIntact: true, attached: true, daemon: 'running', installedAt: INSTALLED_AT }
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
  assert.deepEqual(j({ attached: false, procs: [{ pid: 3, trusted: true }] }).rows, [{ pid: 3, captured: false, reason: 'link-missing' }])
})

test('the order of the reasons is off · daemon · helper · link: a missing helper outranks a link that is not there (a dead helper leaves no link, and the fix is the helper), and is outranked by the switch and by the daemon', async () => {
  const j = (o) => judgeHarness({ ...ready, helper: 'missing', procs: [{ pid: 3, trusted: true }], ...o })
  const why = (o) => j(o).rows[0].reason
  assert.equal(why({ attached: false }), 'helper-missing', 'not link-missing: the user is sent to sudo trocar setup-helper, not to trocar on')
  assert.equal(why({ attached: null }), 'helper-missing')
  assert.equal(why({ attached: true }), 'helper-missing')
  assert.equal(why({ attached: false, procs: [] }), 'helper-missing', 'the harness\'s own row too')
  assert.equal(why({ desired: 'off', attached: false }), 'desired-off')
  assert.equal(why({ daemon: 'not-running', attached: false }), 'daemon-not-running')
  assert.equal(why({ daemon: 'not-responding', attached: false }), 'daemon-not-responding')
  assert.deepEqual(j({ daemon: 'unknown', attached: false, procs: [] }), { captured: null, rows: [{ captured: null, reason: null }] }, 'a daemon that is not known: the helper it reports is not known either')
  assert.equal(judgeHarness({ ...ready, attached: false, procs: [{ pid: 3, trusted: true }] }).rows[0].reason, 'link-missing', 'with a helper that is there, the link is what is missing')
})

test('V32 the certificate step: after the world and the entry, before the start time; a process the daemon judged is not overruled; the harness\'s own row too — over every cert × entry × process kind', () => {
  const kinds = { none: [], judged: [{ pid: 1, trusted: true }], refused: [{ pid: 1, trusted: false, reason: 'var-missing' }], before: [{ pid: 1, trusted: null, startedAt: INSTALLED_AT - 1 }], after: [{ pid: 1, trusted: null, startedAt: INSTALLED_AT + 1 }], nostart: [{ pid: 1, trusted: null, startedAt: null }] }
  for (const cert of [true, null, 'cert-root-missing', 'cert-not-installed', 'entry-changed']) for (const entryIntact of [true, false, null]) for (const [k, procs] of Object.entries(kinds)) {
    const base = judgeHarness({ ...ready, entryIntact, procs }), got = judgeHarness({ ...ready, entryIntact, procs, cert }), at = `${cert} × ${entryIntact} × ${k}`
    if (cert === true || k === 'judged' || k === 'refused' || entryIntact !== true) { assert.deepEqual(got, base, `${at}: the certificate does not decide`); continue }
    assert.deepEqual(got.rows.map((r) => [r.captured, r.reason]), [[cert === null ? null : false, cert === null ? null : cert]], `${at}: the certificate decides, before the start time`)
    for (const world of [{ desired: 'off' }, { daemon: 'not-running' }, { attached: false }]) assert.deepEqual(judgeHarness({ ...ready, entryIntact, procs, cert, ...world }), judgeHarness({ ...ready, entryIntact, procs, ...world }), `${at} ${JSON.stringify(world)}: the world comes first`)
  }
  assert.equal(certOfForms([]), true); assert.equal(certOfForms(undefined), true)
  const form = (in_effect, code = null, carrier = 'root') => ({ certificate: { in_effect, carrier, code } })
  assert.equal(certOfForms([form(true, null, 'config-key'), form(true)]), true)
  assert.equal(certOfForms([form(true, null, 'config-key'), form(false, 'cert-root-pending')]), 'cert-root-pending', 'one form whose certificate is not in effect is enough')
  assert.equal(certOfForms([form(false, null)]), null, 'not in effect with no code (the root store unreadable): not known')
})

test('a process the daemon has not judged: no start time is start-time-unknown, no installed_at to compare with is 不知道, an entry that is not intact comes first (a restart would not help)', () => {
  const j = (p, o = {}) => judgeHarness({ ...ready, procs: [p], ...o }).rows[0]
  assert.deepEqual(j({ pid: 4, startedAt: null, trusted: null }), { pid: 4, captured: false, reason: 'start-time-unknown' })
  assert.deepEqual(j({ pid: 4, startedAt: INSTALLED_AT - 1, trusted: null }, { installedAt: null }), { pid: 4, captured: null, reason: null })
  assert.deepEqual(j({ pid: 4, startedAt: INSTALLED_AT - 1, trusted: null }, { entryIntact: false }), { pid: 4, captured: false, reason: 'entry-missing' })
  assert.deepEqual(j({ pid: 4, startedAt: new Date(INSTALLED_AT + 5).toISOString(), trusted: null }, { installedAt: new Date(INSTALLED_AT).toISOString() }), { pid: 4, captured: true, reason: null }, 'times as ISO strings too')
})

// ── the command, over a sandbox HOME in which `trocar on` has really run (the real turnOn, a fake systemd, a fake daemon behind the control socket) ────────────────────────────────────────────────
import fs from 'node:fs'
import path from 'node:path'
import { installedHome } from '../off/fixtures/off-ctx.mjs'
import { snapshot, changedFiles, fakeIo } from './fixtures/on-ctx.mjs'
import { runStatus, down, reply, asDaemon, claudeProc, SOCK } from './fixtures/status-ctx.mjs'
import { validateReceipt, EXIT } from '../../src/cli/schema.mjs'
import { runStatusCli } from '../../src/cli/status.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { absentSpawn } from '../helpers/no-real-os.mjs'

const run = runStatus

test('the daemon answers: each agent is captured or says why, and the exit code is 1 while one is not; every agent captured is exit 0', async () => {
  const s = await installedHome()
  const agents = [{ pid: 4121, agent: 'claude-code', trusted: true }, { pid: 4388, agent: 'claude-code', trusted: false, reason: 'config-after-start', hint: "trocar's settings for this agent were written after this process started; restart it once" }]
  const docOf = async (argv, o) => (await run(s, [...argv, '--json'], o)).io.json()
  let r = await run(s, [], { request: asDaemon(reply({ agents })) })
  assert.equal(r.exit, 1, r.text)
  // the summary (§3.5): one row per harness — the verdict and one short clause, the pid-level detail in the document
  assert.match(r.text, /^  codex {8}yes$/m)
  const detail = await run(s, ['claude-code'], { request: asDaemon(reply({ agents })) })
  assert.match(detail.text, /^claude-code: on, not captured$/m)
  assert.match(detail.text, /^ {2}Why {4}claude-code is not captured: pid 4388 started before capture was on\.$/m)
  const one = (await docOf(['claude-code'], { request: asDaemon(reply({ agents })) })).harnesses['claude-code']
  assert.deepEqual([one.captured, one.reason], [false, 'config-after-start'])
  assert.deepEqual(one.processes.map((p) => [p.pid, p.captured, p.reason]), [[4121, true, null], [4388, false, 'config-after-start']])
  r = await run(s, [], { request: asDaemon(reply({ agents: agents.slice(0, 1) })), procs: async () => [claudeProc(4121, Date.now() + 5000)] })
  assert.equal(r.exit, 0, r.text)
  assert.match(r.text, /^Capturing 2 of 2 installed harnesses\./m)
  assert.match(r.text, /^ {2}claude-code {2}yes$/m)
  r = await run(s, ['claude'], { request: asDaemon(reply()) })
  assert.match(r.text, /^claude-code: on, /m, 'the alias claude is claude-code')
  assert.ok(!/^codex:/m.test(r.text), 'a name restricts the output to it')
  const reasonsOf = (doc) => Object.fromEntries(Object.entries(doc.harnesses).map(([h, x]) => [h, x.reason]))
  r = await run(s, [], { request: asDaemon(reply({ actual: 'off', mismatch: true })) })
  assert.match(r.text, /^ {2}claude-code {2}no {8}trocar is not attached$/m); assert.equal(r.exit, 1)
  assert.deepEqual(reasonsOf(await docOf([], { request: asDaemon(reply({ actual: 'off', mismatch: true })) })), { 'claude-code': 'link-missing', codex: 'link-missing' })
  const helperDown = { helper: { pid: null, proto: null, ok: false, down: 'ENOENT', expected_proto: 1 } }
  r = await run(s, [], { request: asDaemon(reply(helperDown)) })
  assert.deepEqual(reasonsOf(await docOf([], { request: asDaemon(reply({ actual: 'off', mismatch: true, ...helperDown })) })), { 'claude-code': 'helper-missing', codex: 'helper-missing' }, 'a dead helper leaves the kernel with no link: the reason is the helper, not the link')
  const neg = await docOf(['claude-code'], { request: asDaemon(reply({ agents: [{ pid: 4121, agent: 'claude-code', trusted: true }], negatives: [{ pid: 4121, host: 'api.anthropic.com', cause: 'client-rejected-leaf' }] })) })
  assert.deepEqual(neg.harnesses['claude-code'].processes.map((p) => [p.pid, p.reason]), [[4121, 'negative-cache']])
})

test('the entry on disk decides when no process does: intact when the value is there (the file may have been rewritten), entry-missing when it is gone, entry-changed when it is something else', async () => {
  const s = await installedHome()
  const settings = path.join(s.home, '.claude', 'settings.json')
  const ok = JSON.parse(fs.readFileSync(settings, 'utf8'))
  fs.writeFileSync(settings, JSON.stringify({ ...ok, theme: 'dark' }, null, 4)) // Claude Code rewrote the file: the key is still there
  const verdict = async () => {
    const r = await run(s, ['claude-code', '--json'], { request: asDaemon(reply()) })
    const h = r.io.json().harnesses['claude-code']
    return [h.captured, h.reason, r.exit]
  }
  assert.deepEqual(await verdict(), [true, null, 0])
  const cur = JSON.parse(fs.readFileSync(settings, 'utf8'))
  fs.writeFileSync(settings, JSON.stringify({ ...cur, env: { ...cur.env, NODE_EXTRA_CA_CERTS: '/elsewhere/ca.pem' } }))
  assert.deepEqual(await verdict(), [false, 'entry-changed', 1])
  // the summary says it in words, once (§3.5: one short clause per row, no code name)
  assert.match((await run(s, [], { request: asDaemon(reply()) })).text, /^ {2}claude-code {2}no {8}the setting that points at trocar holds something else$/m)
  fs.writeFileSync(settings, JSON.stringify({ theme: 'dark' }))
  assert.deepEqual(await verdict(), [false, 'entry-missing', 1])
  fs.rmSync(settings)
  assert.deepEqual(await verdict(), [false, 'entry-missing', 1])
})

test('no daemon: nothing is captured (daemon-not-running), read from the disk, with the processes found by the manifest\'s signatures — each one says the daemon is not running, whenever it started (the entry and the start time only come into it once a daemon answers)', async () => {
  const s = await installedHome()
  const old = Date.now() - 3600e3
  const r = await run(s, [], { procs: async () => [claudeProc(5000, old), claudeProc(5001, Date.now() + 5000)] })
  assert.equal(r.exit, 1, r.text)
  assert.match(r.text, /^Capturing 0 of 2 installed harnesses\.$/m)
  assert.match(r.text, /^Daemon not running; nothing is captured\. Start it: trocar on$/m)
  assert.match(r.text, /^ {2}claude-code {2}no {8}trocar is not running in the background$/m)
  const doc = (await run(s, ['claude-code', '--json'], { procs: async () => [claudeProc(5000, old), claudeProc(5001, Date.now() + 5000)] })).io.json()
  const h = doc.harnesses['claude-code']
  assert.deepEqual([h.captured, h.reason], [false, 'daemon-not-running'])
  assert.deepEqual(h.processes.map((p) => [p.pid, p.reason]).sort((a, b) => a[0] - b[0]), [[5000, 'daemon-not-running'], [5001, 'daemon-not-running']])
  assert.match(r.text, /^ {2}Problems {5}(none in the last 24 hours|\d)/m, 'and the capture health read from disk follows (the summary names it; the wall is --failures)')
})

test('the daemon answers but has not listed a process of a harness (it started since the daemon last looked): the entry and when it started decide (V32) — older than the entry: config-after-start and told to restart; newer: captured, and said to be by entry and start time; entry gone: entry-missing; a pid the daemon lists is not added twice', async () => {
  const s = await installedHome()
  const old = Date.now() - 3600e3, fresh = Date.now() + 5000
  const procs = async () => [claudeProc(5000, old), claudeProc(5001, fresh), claudeProc(5002, fresh)]
  const request = asDaemon(reply({ agents: [{ pid: 5002, agent: 'claude-code', trusted: true }] }))
  let r = await run(s, [], { procs, request })
  assert.equal(r.exit, 1, r.text)
  const doc = (await run(s, ['claude-code', '--json'], { procs, request })).io.json()
  const rows = doc.harnesses['claude-code'].processes.map((x) => [x.pid, x.captured, x.reason]).sort((a, b) => a[0] - b[0])
  assert.deepEqual(rows, [[5000, false, 'config-after-start'], [5001, true, null], [5002, true, null]], 'three rows: the listed pid once')
  assert.deepEqual(doc.restart, [{ harness: 'claude-code', pid: 5000, reason: 'config-after-start' }])
  // the entry is gone: a restart would not help, so it is the entry that is said — for the one the daemon has not judged only (the daemon turns its own untrusted by itself)
  fs.rmSync(path.join(s.home, '.claude', 'settings.json'))
  const gone = (await run(s, ['claude-code', '--json'], { procs, request })).io.json().harnesses['claude-code']
  assert.deepEqual(gone.processes.map((x) => [x.pid, x.reason]).sort((a, b) => a[0] - b[0]), [[5000, 'entry-missing'], [5001, 'entry-missing'], [5002, null]])
  // a process of another harness, or one that matches no signature, is not added to this one
  const other = (await run(s, ['codex', '--json'], { procs, request: asDaemon(reply()) })).io.json().harnesses.codex
  assert.deepEqual(other.processes, [], JSON.stringify(other.processes))
})

test('off: every harness is desired-off, exit 0 — nothing is wrong with a switch that is off', async () => {
  const s = await installedHome()
  const off = await s.off(); assert.equal(off.exit, 0)
  const r = await run(s)
  assert.equal(r.exit, 0, r.text)
  assert.match(r.text, /^ {2}claude-code {2}off$/m)
  assert.match(r.text, /^ {2}codex {8}off$/m)
  const detail = await run(s, ['claude-code', 'codex'])
  assert.match(detail.text, /^claude-code: off, capture is off$/m); assert.match(detail.text, /^codex: off, capture is off$/m)
  const doc = (await run(s, ['--json'])).io.json()
  assert.deepEqual(Object.entries(doc.harnesses).map(([h, x]) => [h, x.desired, x.reason]), [['claude-code', 'off', 'desired-off'], ['codex', 'off', 'desired-off']])
})

test('V32: no daemon and state.json unreadable: 不知道 with the file and the errno for every harness, exit 3 — and --json says the same (captured null)', async () => {
  const s = await installedHome()
  const stateF = path.join(s.dir, 'state.json')
  const broken = { ...fs, readFileSync: (f, ...a) => { if (f === stateF) throw Object.assign(new Error(`EACCES: permission denied, open '${f}'`), { code: 'EACCES' }); return fs.readFileSync(f, ...a) } }
  const r = await run(s, [], { fs: broken })
  assert.equal(r.exit, 3, r.text)
  assert.match((await run(s, ['claude-code'], { fs: broken })).text, /^claude-code: unknown \(its on\/off state could not be read\), unknown \(/m)
  const j = await run(s, ['--json'], { fs: broken })
  assert.equal(j.exit, 3)
  const doc = j.io.json()
  assert.deepEqual(validateReceipt(doc), [])
  assert.deepEqual([doc.command, doc.ok, Object.entries(doc.harnesses).map(([h, x]) => [h, x.captured, x.desired])], ['status', false, [['claude-code', null, null], ['codex', null, null]]])
  // R11: unknown carries its reason in the JSON too — the file and the errno, in `errors` and for every harness that waits on it
  assert.deepEqual(doc.errors.filter((e) => e.where === 'the on/off state').map((e) => e.reason.includes(stateF) && e.reason.includes('EACCES')), [true], JSON.stringify(doc.errors))
  for (const [h, x] of Object.entries(doc.harnesses)) assert.ok(x.why.some((w) => w.includes(stateF) && w.includes('EACCES')), `${h}: ${JSON.stringify(x.why)}`)
  assert.deepEqual(doc.errors.filter((e) => ['the install record', 'capture health'].includes(e.where)), [], 'what could be read has no error entry')
})

test('R11: the daemon answers but could not read the kernel state: every harness that is on is 不知道 with the daemon\'s error and its code — in the text and in --json — exit 3, never 没有 and never 正在被采集', async () => {
  const s = await installedHome()
  const bad = (o) => asDaemon(reply({ actual: 'unknown', ...o }))
  let r = await run(s, [], { request: bad({ error: 'helper socket: connect EACCES /run/trocar/helper.sock', error_code: 'EACCES' }) })
  assert.equal(r.exit, 3, r.text)
  assert.match(r.text, /^ {2}codex {8}unknown {3}unknown \(the daemon could not read the kernel state/m)
  assert.ok(!/ (yes|no) /.test(r.text.split('\n').filter((l) => /^ {2}(claude-code|codex) /.test(l)).join('\n')), r.text)
  r = await run(s, ['--json'], { request: bad({ error: 'the helper did not answer', error_code: 'ETIMEDOUT' }) })
  const doc = r.io.json()
  assert.equal(r.exit, 3)
  assert.deepEqual(Object.entries(doc.harnesses).map(([h, x]) => [h, x.captured, x.desired]), [['claude-code', null, 'on'], ['codex', null, 'on']])
  for (const [h, x] of Object.entries(doc.harnesses)) assert.deepEqual(x.why, ['the daemon could not read the kernel state: the helper did not answer (ETIMEDOUT)'], `${h}: a code the message does not name is added`)
  r = await run(s, ['codex'], { request: bad({}) })
  assert.match(r.text, /^codex: on, unknown \(the daemon could not read the kernel state: it gave no reason\)$/m)
  // a reply that carries no kernel state at all is not known either, and says what it carried
  r = await run(s, ['codex'], { request: asDaemon({ ...reply(), actual: undefined }) })
  assert.match(r.text, /^codex: on, unknown \([^)]*does not say whether the kernel has this instance's link/m); assert.equal(r.exit, 3)
})

test('a daemon that does not answer is daemon-not-responding; --json is one document that validates, with the code ids and the restart list', async () => {
  const s = await installedHome()
  const r = await run(s, [], { request: down('ETIMEDOUT') })
  assert.match(r.text, /^Daemon does not answer \([^)]*ETIMEDOUT/m); assert.match(r.text, /^ {2}claude-code {2}no {8}trocar runs in the background but does not answer$/m); assert.equal(r.exit, 1)
  const agents = [{ pid: 4388, agent: 'claude-code', trusted: false, reason: 'config-after-start' }]
  const j = await run(s, ['--json'], { request: asDaemon(reply({ agents })) })
  const doc = j.io.json()
  assert.deepEqual(validateReceipt(doc), [])
  assert.deepEqual(doc.restart, [{ harness: 'claude-code', pid: 4388, reason: 'config-after-start' }])
  assert.deepEqual(Object.entries(doc.harnesses).map(([h, x]) => [h, x.captured, x.reason]), [['claude-code', false, 'config-after-start'], ['codex', true, null]])
  assert.equal(j.io.stderrText(), '', 'stdout carries the one JSON, nothing leaks to stderr')
})

test('status writes nothing at all (§3.5), and usage errors (an unknown harness, an unknown option) exit 2 before anything is read', async () => {
  const s = await installedHome()
  const before = snapshot(s.home)
  await run(s); await run(s, ['--json']); await run(s, [], { request: asDaemon(reply()) })
  assert.deepEqual(changedFiles(before, snapshot(s.home)), [], 'read-only: not even a cache of the topology')
  assert.ok(!fs.existsSync(path.join(s.home, '.trocar', 'netenv.json')), 'the board\'s copy is the daemon\'s to write, not status\'s')
  let r = await run(s, ['claud']); assert.equal(r.exit, 2); assert.match(r.io.stderrText(), /unknown harness 'claud'[^\n]*claude-code/); assert.equal(r.text, '')
  r = await run(s, ['--nope']); assert.equal(r.exit, 2); assert.match(r.io.stderrText(), /unknown option '--nope'/)
  const fresh = tmpDir('trocar-fresh-')
  const f = await runStatusCli([], { io: fakeIo(), home: fresh, platform: 'linux', env: { HOME: fresh }, deps: { request: down(), socketPath: SOCK, procs: async () => [], exec: () => ({ status: 0, stdout: '', stderr: '' }) } })
  assert.equal(f, 0); assert.deepEqual(fs.readdirSync(fresh), [], 'on a machine with nothing installed it prints so, exits 0, and creates nothing')
})

// every platform prints the collector's status (the old-capture branch went with it, D39⑥ executed 2026-10-11), and a harness name other than
// claude-code is a harness like any other. D57 (4.11 ⑱, CM25): no named item on macOS / Windows, so status asks no opt-in hook even when one is there.
test('the flip (9(b), 1.6 §4): win32 status is the NEW status — no opt-in hook is asked (D57), the old-capture branch is not taken, and a harness name other than claude-code is no longer exit 2', async () => {
  const fresh = tmpDir('trocar-fresh-')
  const asked = []
  const parts = { os: 'win32', harnesses: [], scan: async () => [], match: () => ({ agent: null }), arch: { optIn: { plan: (q) => { asked.push(q); return [] } } } }
  const deps = { request: down(), socketPath: SOCK, procs: async () => [], exec: () => ({ status: 0, stdout: '', stderr: '' }), parts, user: 'alice', spawn: absentSpawn }
  const io = fakeIo()
  const exit = await runStatusCli([], { io, home: fresh, platform: 'win32', env: { HOME: fresh, USERPROFILE: fresh }, deps })
  assert.equal(exit, 0, io.stdoutText())
  assert.equal(asked.length, 0, 'D57: no opt-in hook is asked on win32 (4.11 ⑱)')
  const j = fakeIo(); await runStatusCli(['--json'], { io: j, home: fresh, platform: 'win32', env: { HOME: fresh, USERPROFILE: fresh }, deps })
  assert.ok(!('opt_in' in JSON.parse(j.stdoutText())), 'status --json carries no opt_in (D57)')
  assert.ok(!/还没有新采集器|旧采集/.test(io.stdoutText()), 'not the only-claude-code old-capture branch')
  const named = fakeIo()
  assert.equal(await runStatusCli(['codex'], { io: named, home: fresh, platform: 'win32', env: { HOME: fresh, USERPROFILE: fresh }, deps }), 0, named.stdoutText() + named.stderrText())
  assert.ok(!/本平台只有 claude-code 的旧采集/.test(named.stderrText()), 'a name other than claude-code is a harness like any other on the new path')
  assert.deepEqual(fs.readdirSync(fresh), [], 'read-only: nothing created')
})

// a Mac's status is the collector's status (the old-capture branch went with it, D39⑥ executed 2026-10-11); no opt-in hook is asked (D57).
test('the flip (4.9 §4, 1.6 §4): darwin status is the NEW status — no opt-in hook is asked (D57), the old-capture branch is not taken, and a harness name other than claude-code is no longer exit 2', async () => {
  const fresh = tmpDir('trocar-fresh-')
  const asked = []
  const parts = { os: 'darwin', harnesses: [], scan: async () => [], match: () => ({ agent: null }), arch: { optIn: { plan: (q) => { asked.push(q); return [] } } } }
  const deps = { request: down(), socketPath: SOCK, procs: async () => [], exec: () => ({ status: 0, stdout: '', stderr: '' }), parts, user: 'alice', spawn: absentSpawn }
  const io = fakeIo()
  const exit = await runStatusCli([], { io, home: fresh, platform: 'darwin', env: { HOME: fresh }, deps })
  assert.equal(exit, 0, io.stdoutText())
  assert.equal(asked.length, 0, 'D57: no opt-in hook is asked on darwin (4.11 ⑱)')
  assert.ok(!/还没有新采集器|旧采集/.test(io.stdoutText()), 'not the only-claude-code old-capture branch')
  const named = fakeIo()
  assert.equal(await runStatusCli(['codex'], { io: named, home: fresh, platform: 'darwin', env: { HOME: fresh }, deps }), 0, named.stdoutText() + named.stderrText())
  assert.ok(!/本平台只有 claude-code 的旧采集/.test(named.stderrText()), 'a name other than claude-code is a harness like any other on the new path')
  assert.deepEqual(fs.readdirSync(fresh), [], 'read-only: nothing created')
})

test('connections still relayed after an off: N closing and M waiting, in the text and in --json (cut is 0: only off --now cuts); none is said as none, with no daemon there is no engine', async () => {
  const s = await installedHome()
  assert.deepEqual((await run(s, ['--json'], { request: asDaemon(reply({ relayed: { closing: 2, waiting: 1 } })) })).io.json().relayed, { closing: 2, waiting: 1, cut: 0 })
  const noresp = await run(s, [], { request: down('ETIMEDOUT') })
  assert.match(noresp.text.replace(/\s+/g, ' '), /Connections unknown \([^)]*ETIMEDOUT/, 'a daemon that does not answer cannot say: unknown with the reason, never 0 (R11)')
  assert.doesNotMatch(noresp.text, /Connections {2}\d/, 'and no count is invented')
  assert.equal((await run(s, ['--json'], { request: down('ETIMEDOUT') })).io.json().relayed, 'unknown')
  assert.deepEqual((await run(s, ['--json'])).io.json().relayed, { closing: 0, waiting: 0, cut: 0 }, 'no daemon: no engine, so none — a known zero')
})

test('D49: status looks at no VPN software — the digest has no 路径 row and no 本机网络环境 line, the detail view none either, and --json has no `netenv` key (V10)', async () => {
  const s = await installedHome()
  for (const argv of [[], ['claude-code']]) {
    const r = await run(s, argv)
    assert.ok(!/^路径 /m.test(r.text) && !/本机网络环境/.test(r.text), argv.join() || 'digest')
  }
  const j = (await run(s, ['--json'])).io.json()
  assert.ok(!('netenv' in j), 'no netenv key')
})

test('a harness process\'s proxy credentials are never printed, in the text or in the document; a process table that could not be read is an error entry with its reason (R11)', async () => {
  const s = await installedHome()
  const procs = async () => [claudeProc(5000, Date.now() + 5000, new Map([['HTTPS_PROXY', 'http://alice:pw@127.0.0.1:7897']])), { pid: 5310, ppid: 1, uid: 1000, startedAt: 1, exe: '/usr/bin/node', argv: ['node', '/repo/bin/trocar.mjs', 'serve'], env: () => new Map() }]
  const r = await run(s, [], { procs, request: asDaemon(reply()) })
  assert.ok(!r.text.includes('alice:pw'), r.text)
  assert.ok(!JSON.stringify((await run(s, ['--json'], { procs, request: asDaemon(reply()) })).io.json()).includes('alice:pw'))
  const down2 = await run(s, ['--json'], { procs: async () => { throw new Error('the process table /proc cannot be read (EACCES)') } })
  assert.deepEqual(down2.io.json().errors.filter((e) => e.where === 'the process table').map((e) => e.reason), ['the process table /proc cannot be read (EACCES)'])
})

// ── V39: logging out stops the daemon unless linger is on (1.6 §1.1) — `on` and `status` say so, give the command, and never run loginctl (R8) ───────────────────────────────────────────────────
import { runOnCli } from '../../src/cli/on.mjs'
import { onCtx, seedClaude, recordingExec, installFirst } from './fixtures/on-ctx.mjs'

test('V39 status: linger off says capture stops when you log out and gives loginctl enable-linger <user>, --json linger false; on says nothing; unreadable says unknown with the file and the errno, never "on"', async () => {
  const s = await installedHome()
  const noLoginctl = () => assert.ok(!s.sys.exec.calls.some((c) => /loginctl/.test(c)), 'loginctl is not run: trocar says how, it does not do it')
  let r = await run(s, [], { lingerRead: () => ({ state: false }) })
  assert.match(r.text, /^ {2}Logging out {2}capture stops when you log out; run: loginctl enable-linger alice$/m)
  assert.equal((await run(s, ['--json'], { lingerRead: () => ({ state: false }) })).io.json().linger, false)
  r = await run(s, [], { lingerRead: () => ({ state: true }) })
  assert.ok(!/linger|Logging out/.test(r.text), 'on: no line')
  assert.equal((await run(s, ['--json'], { lingerRead: () => ({ state: true }) })).io.json().linger, true)
  r = await run(s, [], { lingerRead: () => ({ state: null, error: '/var/lib/systemd/linger/alice: EACCES' }) })
  assert.match(r.text, /^ {2}Logging out {2}unknown \(\/var\/lib\/systemd\/linger\/alice: EACCES\)$/m); assert.ok(!/capture stops when you log out/.test(r.text))
  const j = (await run(s, ['--json'], { lingerRead: () => ({ state: null, error: 'EACCES' }) })).io.json()
  assert.deepEqual([j.linger, validateReceipt(j)], ['unknown', []])
  r = await run(s, [], { lingerRead: () => { throw new Error('the reader broke') } })
  assert.match(r.text, /^ {2}Logging out {2}unknown \(the reader broke\)$/m)
  noLoginctl()
})

test('V39 on: the same lines in the receipt (and in the plan\'s receipt when --json: linger is false / true / "unknown" with a reason); nothing runs loginctl', async () => {
  for (const [lingerRead, want] of [[() => ({ state: false }), false], [() => ({ state: true }), true], [() => ({ state: null, error: '/var/lib/systemd/linger/alice: EACCES' }), 'unknown']]) {
    const home = tmpDir('trocar-v39-'); seedClaude(home); await installFirst(home)
    const io = fakeIo(), exec = recordingExec(), ctx = onCtx(home, io, { exec, deps: { lingerRead, linger: undefined } })
    assert.equal(await runOnCli(['--yes'], ctx), 0, io.text())
    // the receipt's English line (src/cli/receipt.mjs lingerText) is wrapped to 80 columns: the fact is matched, not the layout
    const flat = io.stdoutText().replace(/\s+/g, ' ')
    if (want === false) assert.match(flat, /Capture stops when you log out\. To keep it on: loginctl enable-linger alice/)
    else if (want === true) assert.ok(!/linger|log out|logout/.test(io.stdoutText()))
    else { assert.match(flat, /Whether capture survives a logout is unknown \(\/var\/lib\/systemd\/linger\/alice: EACCES\)/); assert.ok(!/Capture stops when you log out/.test(flat), 'unreadable never claims capture is kept or lost') }
    const j = fakeIo(); const home2 = tmpDir('trocar-v39-'); seedClaude(home2); await installFirst(home2); const exec2 = recordingExec()
    assert.equal(await runOnCli(['--yes', '--json'], onCtx(home2, j, { exec: exec2, deps: { lingerRead, linger: undefined } })), 0)
    // D61: with a daemon already answering `on` runs no OS tool at all (it registers nothing), so the runner may be empty —
    // what is asserted is that loginctl is never among the calls: trocar says how to enable linger, it does not do it (R8)
    for (const e of [exec, exec2]) assert.ok(!e.has(/loginctl/), `loginctl is not run by on — ${e.calls.join(' | ')}`)
    const doc = j.json()
    assert.equal(doc.linger, want)
    if (want === 'unknown') assert.match(doc.linger_reason, /EACCES/)
  }
})

// the old capture's own status test went with it (D39⑥ executed 2026-10-11): status.mjs no longer has the legacy
// branch; every platform prints the collector's status, and the VPN lines it prints are the same cells above and below.
test('semantics 2: an install manifest that parses but is not a manifest ({"version":3}, entries as an object) is unknown with the file and the reason — exit 3, no stack trace, never "nothing is installed" — in the text and in --json', async () => {
  for (const body of ['{"version":3}', (m) => ({ ...m, entries: { a: 1 } })]) {
    const s = await installedHome()
    const file = path.join(s.dir, 'install-manifest.json')
    fs.writeFileSync(file, typeof body === 'string' ? body : JSON.stringify(body(JSON.parse(fs.readFileSync(file, 'utf8')))))
    const r = await run(s, [], { request: asDaemon(reply()) })
    assert.equal(r.exit, 3, r.text)
    assert.ok(!/No harness is set up for capture yet/.test(r.text), 'a manifest nobody can read does not say "nothing is installed"')
    const doc = (await run(s, ['--json'], { request: asDaemon(reply()) })).io.json()
    assert.deepEqual(validateReceipt(doc), [])
    assert.deepEqual(doc.errors.filter((e) => e.where === 'the install record').map((e) => /install-manifest\.json.*not an install manifest this build can use/.test(e.reason)), [true], JSON.stringify(doc.errors))
  }
})

// audit rule-b 6 (R11): with no daemon and no manifest — a fresh machine, or after uninstall — the process table is read all the same (the MANIFEST is needed only to match
// processes to harnesses), and what could not be read is said with its reason, never silently dropped.
test('R11: with no daemon and no install manifest the process table is still read — only the matching to harnesses is not known, and a table that could not be read is an error entry', async () => {
  const s = await installedHome()
  const out = await s.uninstall({ yes: true })
  assert.equal(out.exit, 0, JSON.stringify(out.receipt.problems))
  assert.ok(!fs.existsSync(path.join(s.dir, 'install-manifest.json')), 'nothing is installed any more')
  const serve = { pid: 7001, ppid: 1, uid: 1000, startedAt: Date.now() - 1000, exe: '/usr/bin/node', argv: ['/usr/bin/node', '/home/u/trocar/bin/trocar.mjs', 'serve', '--port', '4000'], env: () => null }
  const unrelated = { pid: 7002, ppid: 1, uid: 1000, startedAt: Date.now() - 1000, exe: '/usr/bin/vim', argv: ['vim'], env: () => null }
  const doc = (await run(s, ['--json'], { procs: async () => [serve, unrelated] })).io.json()
  assert.deepEqual(doc.errors.filter((e) => e.where === 'the process table'), [], 'the table was read without a manifest')
  // a table that cannot be read is said, with the reason
  const bad = (await run(s, ['--json'], { procs: async () => { throw new Error('ps failed (exit 1: nope)') } })).io.json()
  assert.deepEqual(bad.errors.filter((e) => e.where === 'the process table').map((e) => e.reason), ['ps failed (exit 1: nope)'])
  // what needs the manifest is still said as not known, with the reason: a named harness's entry
  const named = (await run(s, ['codex', '--json'], { procs: async () => [serve] })).io.json().harnesses.codex
  assert.ok(named.why.some((w) => w.includes('no install manifest in')), JSON.stringify(named.why))
})

// Accepted, not undone (D43⑦ · D47): in proxy mode the agents' proxy entries name trocar's door, and the door lives in the daemon. With the daemon
// down while the harness is desired on, status says the entries point at a dead door — forwarder-down, and the command that brings it back.
test('proxy mode, daemon down, desired on: the reason is forwarder-down (the entries point at a dead door) with trocar on; Linux keeps daemon-not-running', async () => {
  assert.equal(judgeHarness({ desired: 'on', daemon: 'not-running', deadDoor: true, procs: [{ pid: 3, trusted: true }] }).rows[0].reason, 'forwarder-down')
  assert.equal(judgeHarness({ desired: 'off', daemon: 'not-running', deadDoor: true }).rows[0].reason, 'desired-off', 'an off harness has no entry pointing anywhere')
  assert.equal(judgeHarness({ desired: 'on', daemon: 'not-running' }).rows[0].reason, 'daemon-not-running')
  const s = await installedHome()
  const io = fakeIo()
  await runStatusCli(['claude-code', '--json'], { io, home: s.home, platform: 'darwin', env: { ...s.sh.env }, deps: { request: down(), socketPath: SOCK, procs: async () => [], lingerRead: () => ({ state: true }), exec: () => ({ status: 0, stdout: '', stderr: '' }), parts: { arch: {}, harnesses: [] } } })
  assert.equal(JSON.parse(io.stdoutText()).harnesses['claude-code'].reason, 'forwarder-down')
})

// ── proxy mode (macOS / Windows): the two axes of V32 apart, generated over desired × daemon × door × the certificate's state, with literal expected codes ──────────────────────────
// The proxy axis gives codex's verdict: the model daemon answers `attached` per harness (its doors listen), a missing door with the daemon running is forwarder-down like a dead daemon.
// The certificate axis gives the `cert` block (1.6 §9.4): the key and the intermediate from the daemon's issuer (unknown, with a reason, when it is not there), the root from the user's store.
// Every cell is asserted both ways: a certificate row never changes the verdict, a proxy row never changes a certificate code (other than the daemon being there to ask).
import { modelWorld, rootStoreStub } from '../helpers/model-world.mjs'
import { emptyState, setDesired, writeStateAtomic } from '../../src/off/state.mjs'
import { turnOnModel } from '../../src/collector/model-on.mjs'
import { renderHook } from '../../src/collector/harness/templates/index.mjs'

const PROXY = [ // desired · daemon · door → codex's verdict
  'on  running up      | T',
  'on  running missing | F:forwarder-down',
  'on  down    up      | F:forwarder-down',
  'on  down    missing | F:forwarder-down',
  'on  noresp  up      | F:daemon-not-responding',
  'on  noresp  missing | F:daemon-not-responding',
  'off running up      | F:desired-off',
  'off running missing | F:desired-off',
  'off down    up      | F:desired-off',
  'off down    missing | F:desired-off',
  'off noresp  up      | F:desired-off',
  'off noresp  missing | F:desired-off',
]
const CERT = [ // the issuer's key · its state · the root in the user's store → key.code · intermediate.code · root.code (- = null), with the daemon there to ask
  'present ready       in  | -                | -                             | -',
  'missing key-missing in  | cert-key-missing | cert-intermediate-unavailable | -',
  'unknown unavailable in  | -                | cert-intermediate-unavailable | -',
  'present ready       out | -                | -                             | cert-root-missing',
]
const code = (c) => (c === '-' ? null : c)
const modelProc = { pid: 4242, holders: [{ harness: 'codex', pid: 4242, start: '111', why: 'started-while-on' }] }

async function modelStatus(w, { desired, daemon, door, key, st, root }) {
  writeStateAtomic(path.join(w.dir, 'state.json'), setDesired(emptyState(), ['codex'], desired))
  const r = { pid: 99, doors: door === 'up' ? { 'codex:all': 17995 } : {}, harnesses: { codex: { desired, attached: door === 'unknown' ? null : door === 'up' } }, holders: 1, cert: { key, intermediate: st, expires: st === 'ready' ? '2026-10-22T09:00:02Z' : null }, engine: {} }
  const request = daemon === 'running' ? async (q) => (q.path === '/status' ? r : q.path === '/holders' ? { count: 1, holders: modelProc.holders } : assert.fail(q.path)) : down(daemon === 'noresp' ? 'ETIMEDOUT' : 'ECONNREFUSED')
  const io = fakeIo()
  const exit = await runStatusCli(['--json'], { io, home: w.home, platform: 'darwin', env: w.env, deps: { request, socketPath: SOCK, procs: async () => [], exec: () => ({ status: 0, stdout: '', stderr: '' }), identity: () => ({ start_time: '111', boot_id: 'b' }), alive: () => true, netFactsDeps: async () => ({ harnesses: w.harnesses, archFacts: darwinNetFacts }), rootStore: root === 'in' ? w.store : root === 'throws' ? { has: async () => { throw Object.assign(new Error('trustd did not answer'), { code: 'EIO' }) } } : rootStoreStub(), user: 'alice' } })
  return { exit, j: JSON.parse(io.stdoutText()) }
}

test('V32 proxy mode: desired × daemon × door × certificate state — the verdict is the proxy axis\'s literal until the proxy path is clear, then the certificate\'s (codex\'s forms carry the root: root out is cert-root-missing); the per-form certificate: / proxy: lines do not move each other; every output validates (V9)', async () => {
  const w = await modelOn()
  for (const pl of PROXY) {
    const [pk, pcell] = pl.split('|').map((x) => x.trim()); const [desired, daemon, door] = pk.split(/\s+/)
    const proxies = new Set()
    for (const cl of CERT) {
      const [ck, ...codes] = cl.split('|').map((x) => x.trim()); const [key, st, root] = ck.split(/\s+/)
      const { j } = await modelStatus(w, { desired, daemon, door, key, st, root })
      const at = `${pk} × ${ck}`
      assert.deepEqual(validateReceipt(j), [], at)
      const h = j.harnesses.codex
      assert.deepEqual({ captured: h.captured, reason: h.reason }, pcell === 'T' && root === 'out' ? { captured: false, reason: 'cert-root-missing' } : said(pcell), at)
      assert.ok(h.forms && h.forms.length, `${at}: codex's forms are read`)
      for (const x of h.forms) assert.deepEqual([x.certificate.carrier, x.certificate.in_effect, x.certificate.code], ['root', root === 'in', root === 'in' ? null : 'cert-root-missing'], `${at} ${x.form}`)
      proxies.add(JSON.stringify(h.forms.map((x) => x.proxy)))
      const up = daemon === 'running'
      assert.deepEqual([j.cert.key.code, j.cert.intermediate.code, j.cert.root.code], up ? codes.map(code) : [null, null, code(codes[2])], at)
      assert.equal(j.cert.key.state, up ? { present: 'present', missing: 'missing', unknown: 'unknown' }[key] : 'unknown', at)
      assert.equal(j.cert.intermediate.state, up ? (st === 'ready' ? 'current' : 'unavailable') : 'unknown', at)
      if (!up) assert.ok(j.cert.key.reason && j.cert.intermediate.reason, `${at}: unknown says why`)
      assert.equal(j.cert.root.state, root === 'in' ? 'in-place' : 'missing', at)
      assert.equal(j.install.state, 'complete', at)
      assert.equal(j.cert.key.custody, w.custody.kind, `${at}: the custody install recorded`)
    }
    assert.equal(proxies.size, 1, `${pk}: the certificate axis does not move the proxy: lines`)
  }
})

test('1.6 §3.5: with no names, status lists every harness with a form present on this machine, also one installed after trocar — with its setup; an absent one is not listed', async () => {
  const w = await modelOn()
  for (const c of ['dsh', 'opencode']) fs.writeFileSync(path.join(w.home, 'bin', c), '#!/bin/sh\n', { mode: 0o755 }) // installed after `trocar install`
  const { j } = await modelStatus(w, { desired: 'on', daemon: 'running', door: 'up', key: 'present', st: 'ready', root: 'in' })
  for (const h of ['codex', 'deepseek-dsh', 'opencode']) assert.ok(['ready', 'needed', 'unknown'].includes(j.harnesses[h] && j.harnesses[h].setup.state), `${h}: ${JSON.stringify(j.harnesses[h])}`)
  assert.equal('hermes' in j.harnesses, false, 'no form of hermes is on this machine')
})

// one HOME with codex installed and turned on (the door half a stub), for the cases below
async function modelOn() {
  const w = await modelWorld({ os: 'darwin', commands: ['codex'] })
  assert.equal((await w.install()).exit, 0)
  fs.writeFileSync(path.join(w.dir, 'control.json'), JSON.stringify({ path: path.join(w.home, 'c.sock'), token: 'k'.repeat(32) }))
  const opens = async (q) => (q.path === '/on' ? { doors: Object.fromEntries(Object.entries(q.body.groups).map(([g, p]) => [g, `http://127.0.0.1:${p}`])) } : { doors: {} })
  assert.equal((await turnOnModel({ os: 'darwin', home: w.home, env: w.env, ids: ['codex'], harnesses: w.harnesses, ctx: w.ctx, isFree: async () => true, renderHook, request: opens })).exit, 0)
  return w
}

test('V26 proxy mode: status exits by the judgement — 0 with the door up, 1 with it missing (forwarder-down), 3 only when the daemon cannot tell whether the doors listen (captured itself unknown)', async () => {
  const w = await modelOn()
  const base = { desired: 'on', daemon: 'running', key: 'present', st: 'ready', root: 'in' }
  assert.equal((await modelStatus(w, { ...base, door: 'up' })).exit, EXIT.ok)
  assert.equal((await modelStatus(w, { ...base, door: 'missing' })).exit, EXIT.incomplete)
  for (const [cert, exit, said] of [[{ key: 'missing', st: 'key-missing' }, EXIT.incomplete, [true, null]], [{ root: 'out' }, EXIT.incomplete, [false, 'cert-root-missing']], [{ st: 'unavailable', key: 'unknown' }, EXIT.ok, [true, null]]]) {
    const r = await modelStatus(w, { ...base, door: 'up', ...cert })
    assert.equal(r.exit, exit, `1.6 §9.7 / R4: a certificate state the user must act on exits 1: ${JSON.stringify(cert)}`)
    const h = r.j.harnesses.codex
    assert.deepEqual([h.captured, h.reason], said, `V32: a root-carrier form with the root out is not captured; the issuer's key is the doors', not the agent's trust: ${JSON.stringify(cert)}`)
  }
  const r = await modelStatus(w, { ...base, door: 'unknown' })
  assert.equal(r.exit, EXIT.unknown)
  const h = r.j.harnesses.codex
  assert.equal(h.captured, null)
  assert.ok(h.why.some((x) => typeof x === 'string' && x.trim() !== ''), `不知道 says why: ${JSON.stringify(h.why)}`) // R11: the reason is there; its wording is the text's business, not this check's
})

test('1.6 §9.4 / §9.6 cert.root: the code follows the state — pending / declined (install\'s pending root-store item) and installed-but-gone exit 1 with their own codes; never installed is cert-not-installed (V32, R4)', async () => {
  const w = await modelOn()
  const mf = path.join(w.dir, 'install-manifest.json'), m0 = JSON.parse(fs.readFileSync(mf, 'utf8'))
  const base = { desired: 'on', daemon: 'running', door: 'up', key: 'present', st: 'ready', root: 'out' }
  for (const [install, state, code, exit] of [
    [{ ...m0.install, state: 'partial', pending: [{ item: 'root-store', state: 'pending', reason: 'no GUI session' }] }, 'pending', 'cert-root-pending', EXIT.incomplete],
    [{ ...m0.install, state: 'partial', pending: [{ item: 'root-store', state: 'declined', reason: 'the user said no' }] }, 'declined', 'cert-root-declined', EXIT.incomplete],
    [m0.install, 'missing', 'cert-root-missing', EXIT.incomplete],
    [undefined, 'missing', 'cert-not-installed', EXIT.ok],
  ]) {
    fs.writeFileSync(mf, JSON.stringify({ ...m0, install }))
    const r = await modelStatus(w, base)
    assert.deepEqual([r.j.cert.root.state, r.j.cert.root.code, r.exit], [state, code, exit], code)
    const h = r.j.harnesses.codex // the topology's per-form verdict on the same facts: test/netenv/model-rows.test.mjs (V32 rows)
    const want = install ? [false, code] : [true, null] // never installed: no install record, no forms to carry a root (the cert block says cert-not-installed)
    assert.deepEqual([h.captured, h.reason], want, `V32: the harness verdict carries the root's code: ${code}`)
    assert.deepEqual(validateReceipt(r.j), [], code)
  }
})

test('1.6 §9.4 cert.root: what cannot be read is unknown with its reason (store, certificate file), never pending or not-installed; an installed root whose certificate file is gone is cert-not-installed and exits 1', async () => {
  const w = await modelOn()
  const base = { desired: 'on', daemon: 'running', door: 'up', key: 'present', st: 'ready', root: 'throws' }
  const store = await modelStatus(w, base)
  assert.deepEqual([store.j.cert.root.state, store.j.cert.root.code, store.exit], ['unknown', null, EXIT.unknown], 'a store read that failed, no pending item')
  assert.match(store.j.cert.root.reason, /root store could not be read.*EIO/)
  assert.deepEqual(validateReceipt(store.j), [])
  const pem = path.join(w.dir, 'ca', 'trocar-ca.pem'), bytes = fs.readFileSync(pem)
  try {
    fs.rmSync(pem); fs.mkdirSync(pem) // there, and not readable as a file
    const odd = await modelStatus(w, { ...base, root: 'in' })
    assert.deepEqual([odd.j.cert.root.state, odd.j.cert.root.code, odd.exit], ['unknown', null, EXIT.unknown], 'a certificate file that cannot be read')
    assert.match(odd.j.cert.root.reason, /trocar-ca\.pem cannot be read/)
    assert.deepEqual(validateReceipt(odd.j), [])
    fs.rmdirSync(pem)
    const gone = await modelStatus(w, { ...base, desired: 'off', root: 'in' })
    assert.deepEqual([gone.j.cert.root.state, gone.j.cert.root.code, gone.exit], ['missing', 'cert-not-installed', EXIT.incomplete], 'installed, the certificate file gone: on refuses, so the user must act — even with nothing on')
    assert.deepEqual(validateReceipt(gone.j), [])
  } finally { if (!fs.existsSync(pem)) fs.writeFileSync(pem, bytes) }
})

test('CM23 status half: the holders\' pids — from the daemon\'s poll (GET /holders) when it answers, from the manifest\'s liveness and the process table when it does not', async () => {
  const w = await modelOn()
  const up = await modelStatus(w, { desired: 'off', daemon: 'running', door: 'up', key: 'present', st: 'ready', root: 'in' })
  assert.deepEqual(up.j.holders.map((x) => [x.harness, x.pid]), [['codex', 4242]])
  const mf = path.join(w.dir, 'install-manifest.json'), m = JSON.parse(fs.readFileSync(mf, 'utf8'))
  const onAt = Date.parse(m.liveness.codex.on_at || new Date(Date.now() - 60_000).toISOString())
  m.liveness.codex = { ...m.liveness.codex, on_at: new Date(onAt).toISOString(), off_at: new Date(onAt + 30_000).toISOString() }
  fs.writeFileSync(mf, JSON.stringify(m))
  writeStateAtomic(path.join(w.dir, 'state.json'), setDesired(emptyState(), ['codex'], 'off'))
  const io = fakeIo()
  const proc = { pid: 5151, ppid: 1, uid: 501, startedAt: onAt + 10_000, exe: path.join(w.home, 'bin', 'codex'), argv: ['codex'], env: () => new Map() }
  await runStatusCli(['--json'], { io, home: w.home, platform: 'darwin', env: w.env, deps: { request: down(), socketPath: SOCK, procs: async () => [proc], exec: () => ({ status: 0, stdout: '', stderr: '' }), identity: () => ({ start_time: '111', boot_id: 'b' }), alive: () => true, netFactsDeps: async () => ({ harnesses: w.harnesses, archFacts: null }), rootStore: w.store, user: 'alice' } })
  const j = JSON.parse(io.stdoutText())
  assert.deepEqual(j.holders.map((x) => [x.harness, x.pid]), [['codex', 5151]])
  assert.equal(j.cert.intermediate.state, 'unknown'); assert.match(j.cert.intermediate.reason, /not-running/)
})

// ── D62 task E / 1.6 §3.1: one question, one answer ──────────────────────────────────────────────────────────────────────
import { collectorDir } from '../../src/off/paths.mjs'

test('one `status` asks the OS each question once: on Windows the whole process table is one PowerShell and the daemon pid\'s identity comes out of that same answer (it used to be three starts, ~450 ms each on the Windows test machine)', async () => {
  const fresh = tmpDir('trocar-once-')
  const CREATED = 1_740_000_123_456, BOOTED = 1_740_000_000_000, PID = 4242
  const dir = collectorDir(fresh)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'lock'), `${JSON.stringify({ pid: PID, start_time: String(CREATED), boot_id: String(BOOTED), socket: SOCK, engine_port: 47123 })}\n`)
  const rows = [{ p: PID, pp: 1, n: 'node.exe', x: 'C:\\n.exe', s: CREATED, c: 'node trocar.mjs daemon' }]
  const calls = []
  const exec = (file, args) => {
    const cmd = [file, ...args].join(' ')
    calls.push(cmd)
    if (/Win32_Process \| ForEach-Object/.test(cmd)) return { status: 0, stdout: `boot ${BOOTED}\n${JSON.stringify(rows)}`, stderr: '' }
    if (/Win32_Process -Filter/.test(cmd)) return { status: 0, stdout: JSON.stringify({ s: CREATED, b: BOOTED }), stderr: '' }
    return { status: 0, stdout: '', stderr: '' }
  }
  const parts = { os: 'win32', harnesses: [], scan: async () => [], match: () => ({ agent: null }), arch: {} }
  const io = fakeIo()
  const exit = await runStatusCli(['--json'], { io, home: fresh, platform: 'win32', env: { HOME: fresh, USERPROFILE: fresh }, deps: { request: down(), socketPath: SOCK, exec, parts, user: 'alice', spawn: absentSpawn, alive: () => true } })
  const doc = JSON.parse(io.stdoutText())
  assert.equal(calls.filter((c) => /Win32_Process \| ForEach-Object/.test(c)).length, 1, 'the process table: one question for the whole command')
  assert.equal(calls.filter((c) => /Win32_Process -Filter/.test(c)).length, 0, 'and not one identity question of its own: the table\'s answer carries the pid\'s creation time and the machine\'s boot time')
  assert.deepEqual([doc.daemon.running, doc.daemon.responding], [null, false], 'the identity the table gave matched the lock byte for byte: a daemon that holds the lock and does not answer (a mismatch would read as a stale lock, [false, null])')
  assert.deepEqual(doc.errors.filter((e) => /read question/.test(e.reason)), [], 'and with no daemon answering, the read it could not answer is NOT an error of the user\'s machine: a control.json left behind by a stopped daemon is the normal no-daemon state')
  assert.equal(exit, EXIT.ok, io.stdoutText())
})

test('D62 (4.8 §1 §7): with the daemon answering, one `status` starts no PowerShell for the process facts or the pid\'s identity — the same daemon unable to answer that read falls back to the one local question, says so, and the document is unchanged', async () => {
  const CREATED = 1_740_000_123_456, BOOTED = 1_740_000_000_000, PID = 4242
  const row = { pid: PID, ppid: 1, name: 'node.exe', exe: 'C:\\n.exe', startedAt: CREATED, cmdline: 'node trocar.mjs daemon', cmdlineState: 'ok' }
  const cim = [{ p: PID, pp: 1, n: 'node.exe', x: 'C:\\n.exe', s: CREATED, c: 'node trocar.mjs daemon' }]
  const parts = { os: 'win32', harnesses: [], scan: async () => [], match: () => ({ agent: null }), arch: {} }
  const PIPE = '\\\\.\\pipe\\trocar-d62' // on win32 only a named pipe is asked (daemonState): a unix path in the lock is not connected to
  const once = async (warm, self = { pid: PID, start_time: String(CREATED), boot_id: String(BOOTED) }) => {
    const fresh = tmpDir('trocar-warm-')
    const dir = collectorDir(fresh)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'lock'), `${JSON.stringify({ pid: PID, start_time: String(CREATED), boot_id: String(BOOTED), socket: PIPE, engine_port: 47123 })}\n`)
    const shells = [], verbs = []
    const exec = (file, args) => {
      const cmd = [file, ...args].join(' ')
      if (/Win32_Process/.test(cmd)) shells.push(cmd)
      if (/Win32_Process \| ForEach-Object/.test(cmd)) return { status: 0, stdout: `boot ${BOOTED}\n${JSON.stringify(cim)}`, stderr: '' }
      if (/Win32_Process -Filter/.test(cmd)) return { status: 0, stdout: JSON.stringify({ s: CREATED, b: BOOTED }), stderr: '' }
      return { status: 0, stdout: '', stderr: '' }
    }
    const request = async ({ path: p, body }) => {
      if (p === '/status') return { pid: PID, harnesses: {}, actual: 'off', holders: 0, doors: {}, upstreams: {}, relayed: {}, engine: {} }
      if (p === '/holders') return { count: 0, holders: [] }
      if (p === '/helper') {
        verbs.push(body.verb)
        return warm ? { ok: true, data: { procs: [row] }, self }
          : { ok: false, error: 'ps: helper down: it exited with code 1', self }
      }
      throw Object.assign(new Error(`no route ${p}`), { status: 404 })
    }
    const io = fakeIo()
    const exit = await runStatusCli(['--json'], { io, home: fresh, platform: 'win32', env: { HOME: fresh, USERPROFILE: fresh }, deps: { request, socketPath: PIPE, exec, parts, user: 'alice', spawn: absentSpawn, alive: () => true } })
    return { exit, shells, verbs, doc: JSON.parse(io.stdoutText()) }
  }
  const hot = await once(true)
  assert.deepEqual([...new Set(hot.verbs)].sort(), ['ps', 'reg-read', 'tcp-table'], 'every read of the OS goes to the daemon\'s warm helper: the process snapshot, the socket table and Internet Settings (which used to start a helper of their own) — in whatever order they are asked')
  assert.equal(hot.verbs.filter((v) => v === 'ps').length, 1, 'and the snapshot the table and the platform\'s network facts both want is asked ONCE')
  assert.deepEqual(hot.shells, [], 'and no powershell.exe is started for the table or for the pid\'s identity (~450 ms each on the Windows test machine)')
  assert.deepEqual([hot.doc.daemon.running, hot.doc.daemon.responding], [true, true], 'the daemon\'s own identity, as its answer carried it, matched the lock')
  assert.equal(hot.exit, EXIT.ok, hot.io)

  const cold = await once(false)
  assert.equal(cold.verbs[0], 'ps', 'the daemon was asked')
  assert.deepEqual(cold.shells.map((c) => (/ForEach-Object/.test(c) ? 'table' : 'identity')), ['table'], 'and when it cannot answer that read, the one local question is asked — once, and no identity question of its own')
  const asked = cold.doc.errors.filter((e) => /did not answer the read question/.test(e.reason))
  assert.deepEqual(asked.map((e) => e.where), ['the process table'], 'the fallback is never silent (D38), under the closed-set name of the question (src/health/codes.mjs DOC_WHERE)')
  assert.match(asked[0].reason, /ps: helper down: it exited with code 1$/, 'and the prose — which reader could not answer, and why — is the reason')
  const sameSide = (d) => [d.daemon, d.holders, d.harnesses]
  assert.deepEqual(sameSide(cold.doc), sameSide(hot.doc), 'and what the table decides — the daemon\'s verdict, the holders, the harnesses — is the same, whichever side answered')

  // The judgement rests on the TABLE's own row for that pid, never on the daemon's word about ITSELF: the row carries the creation time the OS
  // would print, and the table came with the machine's boot time, so a `self` envelope that says something else changes nothing and starts nothing.
  const lying = await once(true, { pid: PID, start_time: String(CREATED + 1), boot_id: String(BOOTED) })
  assert.deepEqual(lying.shells, [], 'no OS question is started: the daemon\'s table answered the pid\'s identity')
  assert.deepEqual([lying.doc.daemon.running, lying.doc.daemon.responding], [true, true], 'and the lock is judged on the table\'s row, which says what the lock says')
})

test('D62: `GET /holders` is asked only when the daemon\'s poll has rows — with nothing watched (`holders: null`) the rows are judged from the table `status` already read, and the daemon reads no second process snapshot for it', async () => {
  const CREATED = 1_740_000_123_456, BOOTED = 1_740_000_000_000, PID = 4343
  const PIPE = '\\\\.\\pipe\\trocar-holders'
  const paths = []
  const once = async (holders) => {
    const fresh = tmpDir('trocar-holders-')
    const dir = collectorDir(fresh)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'lock'), `${JSON.stringify({ pid: PID, start_time: String(CREATED), boot_id: String(BOOTED), socket: PIPE, engine_port: 47123 })}\n`)
    const request = async ({ path: p, body }) => {
      paths.push(p)
      if (p === '/status') return { pid: PID, harnesses: {}, actual: 'off', holders, doors: {}, upstreams: {}, relayed: {}, engine: {} }
      if (p === '/holders') return { count: 0, holders: [] }
      if (p === '/helper') return { ok: true, data: body.verb === 'ps' ? { procs: [] } : { rows: [] }, self: { pid: PID, start_time: String(CREATED), boot_id: String(BOOTED) } }
      throw Object.assign(new Error(`no route ${p}`), { status: 404 })
    }
    const io = fakeIo()
    await runStatusCli(['--json'], { io, home: fresh, platform: 'win32', env: { HOME: fresh, USERPROFILE: fresh }, deps: { request, socketPath: PIPE, exec: () => ({ status: 0, stdout: '', stderr: '' }), parts: { os: 'win32', harnesses: [], scan: async () => [], match: () => ({ agent: null }), arch: {} }, user: 'alice', spawn: absentSpawn, alive: () => true } })
    return JSON.parse(io.stdoutText())
  }
  await once(null)
  assert.deepEqual(paths.filter((p) => p === '/holders'), [], 'nothing is watched: the route that would read the whole process table again (41 ms on the Windows test machine) is not asked')
  paths.length = 0
  await once(0)
  assert.deepEqual(paths.filter((p) => p === '/holders'), ['/holders'], 'the poll has rows (a number, even 0): its own snapshot is the answer, and it is asked')
})

test('V91 · 附录 C.3: every harness status lists carries `setup` from the closed set; codex (the root carries its forms) is ready with the root in place, needed with root-missing when it is gone', async () => {
  const w = await modelOn()
  for (const root of ['in', 'out']) {
    const { j } = await modelStatus(w, { desired: 'on', daemon: 'running', door: 'up', key: 'present', st: 'ready', root })
    for (const [h, x] of Object.entries(j.harnesses)) {
      assert.ok(['ready', 'needed', 'unknown'].includes(x.setup.state) && Array.isArray(x.setup.missing), `${h}: ${JSON.stringify(x.setup)}`)
      if (x.setup.state === 'unknown') assert.ok(x.setup.reason, `${h}: unknown says why`)
    }
    assert.deepEqual(j.harnesses.codex.setup, root === 'in' ? { state: 'ready', missing: [] } : { state: 'needed', missing: [{ form: null, what: 'root-missing' }] })
  }
})
