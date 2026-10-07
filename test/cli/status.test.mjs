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

test('a process the daemon has not judged: no start time is start-time-unknown, no installed_at to compare with is 不知道, an entry that is not intact comes first (a restart would not help)', () => {
  const j = (p, o = {}) => judgeHarness({ ...ready, procs: [p], ...o }).rows[0]
  assert.deepEqual(j({ pid: 4, startedAt: null, trusted: null }), { pid: 4, captured: false, reason: 'start-time-unknown' })
  assert.deepEqual(j({ pid: 4, startedAt: INSTALLED_AT - 1, trusted: null }, { installedAt: null }), { pid: 4, captured: null, reason: null })
  assert.deepEqual(j({ pid: 4, startedAt: INSTALLED_AT - 1, trusted: null }, { entryIntact: false }), { pid: 4, captured: false, reason: 'entry-missing' })
  assert.deepEqual(j({ pid: 4, startedAt: new Date(INSTALLED_AT + 5).toISOString(), trusted: null }, { installedAt: new Date(INSTALLED_AT).toISOString() }), { pid: 4, captured: true, reason: null }, 'times as ISO strings too')
})
