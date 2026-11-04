// test/health/flows.test.mjs — reading flows/ back for the capture-health endpoint and `collector status` (D38; RFC 4.4
// /api/capture-health 「只读、有界」, 4.6 §记录「看得到」, OPEN「flows/ 是否封存」): back to the last daemon-start and over
// the 24 h window, bounded, sealed files through src/raw/, an unreadable directory never "no failures"; the fold in
// file and line order; nothing but metadata leaves.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readFlows, foldFlows, pick, groupKey, HealthUnreadable } from '../../src/health/flows.mjs'

const NOW = Date.parse('2026-10-06T12:00:00Z')
const H = 3600e3
const at = (msAgo) => new Date(NOW - msAgo).toISOString()
function box() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trocar-flows-'))
  fs.mkdirSync(path.join(dir, 'flows'))
  const put = (day, recs, { tail = '' } = {}) => fs.writeFileSync(path.join(dir, 'flows', `${day}.ndjson`), recs.map((r) => JSON.stringify(r) + '\n').join('') + tail)
  return { dir, put, done: () => fs.rmSync(dir, { recursive: true, force: true }) }
}
const ids = (r) => r.records.map((x) => x.id)

test('readFlows: no flows/ is "nothing yet"; an unreadable flows/ throws (status: no health, an errors entry), never "no failures"', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trocar-flows-'))
  try {
    assert.deepEqual([readFlows({ dir, now: NOW }).missing, readFlows({ dir, now: NOW }).records.length], [true, 0])
    fs.writeFileSync(path.join(dir, 'flows'), 'not a directory')
    assert.throws(() => readFlows({ dir, now: NOW }), (e) => e instanceof HealthUnreadable && /ENOTDIR|not a directory/i.test(e.message))
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('readFlows: back to the last daemon-start and over 24 h, in file and line order; older days are not read', () => {
  const b = box()
  try {
    b.put('2026-10-02', [{ id: 'old', ts: at(90 * H), event: 'daemon-start' }])
    b.put('2026-10-05', [{ id: 's', ts: at(30 * H), event: 'daemon-start' }, { id: 'y', ts: at(20 * H), event: 'switch' }])
    b.put('2026-10-06', [{ id: 't1', ts: at(2 * H), event: 'switch' }, { id: 't2', ts: at(3 * H), event: 'switch' }], { tail: '{"id":"half' })
    const r = readFlows({ dir: b.dir, now: NOW })
    assert.deepEqual(ids(r), ['s', 'y', 't1', 't2'], 'file then line order (t2 is older by ts and stays after t1); a half-written last line is not read yet')
    assert.deepEqual([r.files.map((f) => path.basename(f)), r.truncated, r.unparsable], [['2026-10-06.ndjson', '2026-10-05.ndjson'], false, 0])
    // no daemon-start in the window: reading goes back until it finds one
    b.put('2026-10-05', [{ id: 'y', ts: at(20 * H), event: 'switch' }])
    assert.deepEqual(ids(readFlows({ dir: b.dir, now: NOW })), ['old', 'y', 't1', 't2'])
  } finally { b.done() }
})

test('readFlows: bounded — the newest bytes are kept, a cut head line is dropped, and it says truncated', () => {
  const b = box()
  try {
    const recs = Array.from({ length: 50 }, (_, i) => ({ id: `r${i}`, ts: at((50 - i) * 1000), event: 'switch', pad: 'x'.repeat(40) }))
    b.put('2026-10-05', [{ id: 'start', ts: at(30 * H), event: 'daemon-start' }])
    b.put('2026-10-06', recs)
    const r = readFlows({ dir: b.dir, now: NOW, maxBytes: 1000 })
    assert.equal(r.truncated, true)
    assert.ok(r.records.length > 3 && r.records.length < 50, `${r.records.length} kept`)
    assert.equal(r.records.at(-1).id, 'r49', 'the newest line is kept')
    assert.ok(r.records.every((x) => x.id !== 'start'), 'the older day was not reached')
    assert.equal(r.unparsable, 0, 'the line cut by the tail read is dropped, not counted as damage')
    assert.equal(readFlows({ dir: b.dir, now: NOW }).truncated, false)
    fs.rmSync(path.join(b.dir, 'flows', '2026-10-05.ndjson'))
    assert.equal(readFlows({ dir: b.dir, now: NOW, maxBytes: 1000 }).truncated, true, 'the only file, cut: still truncated')
  } finally { b.done() }
})

test('readFlows: one unreadable day file is listed and the rest is read; a line that does not parse is counted', () => {
  const b = box()
  try {
    b.put('2026-10-06', [{ id: 'a', ts: at(H), event: 'daemon-start' }], { tail: 'not json\n' })
    fs.mkdirSync(path.join(b.dir, 'flows', '2026-10-05.ndjson')) // cannot be read as a file
    const r = readFlows({ dir: b.dir, now: NOW })
    assert.deepEqual(ids(r), ['a'])
    assert.equal(r.unparsable, 1)
    // the start is in the newest file, but the window reaches into the 5th: the broken file is reported
    assert.deepEqual(r.errors.map((e) => path.basename(e.file)), ['2026-10-05.ndjson'])
  } finally { b.done() }
})

test('foldFlows: conditions since the last daemon-start, cleared by the events that end them — in line order, not ts order', () => {
  const recs = [
    { ts: at(40 * H), event: 'daemon-start', pid: 1 },
    { ts: at(39 * H), event: 'agent-untrusted', pid: 9, agent: 'claude-code', reason: 'var-missing' }, // the previous run's
    { ts: at(10 * H), event: 'daemon-start', pid: 2 },
    { ts: at(9 * H), event: 'agent-untrusted', pid: 10, agent: 'claude-code', reason: 'var-missing' },
    { ts: at(9 * H), event: 'agent-untrusted', pid: 11, agent: 'codex', reason: 'not-trusting' },
    { ts: at(8 * H), event: 'failure', where: 'engine', code: 'negative-cache', pid: 12, host: 'h.test', cause: 'client-rejected-leaf', reason: 'r' },
    { ts: at(8 * H), event: 'failure', where: 'engine', code: 'negative-cache', pid: 13, host: 'h.test', cause: 'upstream-cert', reason: 'r' },
    { ts: at(7 * H), event: 'helper-down', reason: 'exited', exit: 'load-failed', stderr: ['bpf: denied'] },
    { ts: at(7 * H), event: 'failure', where: 'switch', code: 'state-mismatch', desired: 'on', actual: 'off', reason: 'r' },
    { ts: at(6 * H), event: 'failure', where: 'ca', code: 'ca-invalid', which: 'expired', file: '/c/ca.pem', reason: 'r' },
    { ts: at(11 * H), event: 'agent-exit', pid: 10 }, // written later, stamped earlier (the clock went back): still ends it
    { ts: at(5 * H), event: 'agent-trusted', pid: 11 },
    { ts: at(5 * H), event: 'negative-cache-cleared', pid: 12, dropped: 1 },
    { ts: at(4 * H), event: 'switch', desired: 'on', actual: 'on' },
  ]
  const f = foldFlows(recs, { now: NOW })
  assert.deepEqual(f.conditions.map((c) => [c.kind, c.pid ?? null]).sort(), [['ca-invalid', null], ['degraded', null], ['negative-cache', 13]])
  assert.ok(f.conditions.every((c) => c.failure === true && c.since))
  assert.deepEqual([f.last_start.pid, f.last_stop, f.partial], [2, null, false])
  assert.deepEqual(f.conditions.find((c) => c.kind === 'degraded').stderr, ['bpf: denied'])
  const stopped = foldFlows([...recs, { ts: at(H), event: 'daemon-stop', signal: 'SIGHUP' }], { now: NOW })
  assert.equal(stopped.last_stop.signal, 'SIGHUP')
  const again = foldFlows([...recs, { ts: at(H), event: 'daemon-start', pid: 3 }], { now: NOW })
  assert.deepEqual(again.conditions, [], 'a new daemon-start: the last run\'s conditions are no longer current')
  assert.equal(foldFlows([{ ts: at(H), event: 'agent-untrusted', pid: 4, reason: 'x' }], { now: NOW }).partial, true, 'no daemon-start read: said')
  // a start's own lines written before daemon-start (the CA check, the helper's protocol) belong to that run (4.6 §事件与码)
  const S = Date.parse(at(H)), t = (ms) => new Date(S - ms).toISOString()
  const prelude = [
    { ts: t(30 * 60e3), event: 'agent-untrusted', pid: 20, reason: 'x' }, // the crashed run's, long before
    { ts: t(5000), event: 'failure', where: 'daemon', code: 'unclean-stop', reason: 'r' },
    { ts: t(4000), event: 'failure', where: 'ca', code: 'ca-invalid', which: 'pair', file: '/c', reason: 'r' },
    { ts: t(3000), event: 'helper-version-mismatch', got: 3, expected: 2, reason: 'r' },
    { ts: at(H), event: 'daemon-start', pid: 5 },
  ]
  assert.deepEqual(foldFlows(prelude, { now: NOW }).conditions.map((c) => c.kind).sort(), ['ca-invalid', 'helper-version'])
  const crashed = [{ ts: t(20e3), event: 'agent-untrusted', pid: 21, reason: 'x' }, ...prelude.slice(1)] // within 60 s, but before the unclean-stop
  assert.ok(!foldFlows(crashed, { now: NOW }).conditions.some((c) => c.pid === 21), 'the line before this start\'s unclean-stop is the last run\'s')
  const stoppedBefore = [{ ts: t(9000), event: 'agent-untrusted', pid: 22, reason: 'x' }, { ts: t(8000), event: 'daemon-stop' }, ...prelude.slice(2)]
  assert.deepEqual(foldFlows(stoppedBefore, { now: NOW }).conditions.map((c) => c.kind).sort(), ['ca-invalid', 'helper-version'], 'a daemon-stop bounds it too')
  const refusedBefore = [{ ts: t(9000), event: 'helper-version-mismatch', got: 3, expected: 2, reason: 'r' }, { ts: t(8000), event: 'failure', where: 'start', code: 'start-failed', reason: 'r' }, { ts: at(H), event: 'daemon-start', pid: 6 }]
  assert.deepEqual(foldFlows(refusedBefore, { now: NOW }).conditions, [], 'a refused start bounds it: its lines are not this run\'s')
})

// RFC 4.8 §5.5 · W17: the pair is (neg_key ?? pid, host). A connection with no pid says "<route>.<group>" in neg_key; two forms with no pid are two entries.
test('foldFlows: negative-cache entries are keyed by (neg_key ?? pid, host): two forms with no pid are listed apart; a clearing removes only its own key', () => {
  const neg = (extra) => ({ ts: at(8 * H), event: 'failure', where: 'engine', code: 'negative-cache', host: 'h.test', cause: 'client-rejected-leaf', reason: 'r', ...extra })
  const recs = [
    { ts: at(10 * H), event: 'daemon-start', pid: 2 },
    neg({ pid: null, neg_key: 'of.claude-code.cli' }), neg({ pid: null, neg_key: 'of.codex.cli' }), neg({ pid: 12, neg_key: '12' }), neg({ pid: 13 }), // the last: a line from before neg_key
  ]
  const keys = (r) => foldFlows(r, { now: NOW }).conditions.map((c) => `${c.neg_key ?? c.pid}|${c.host}`).sort()
  assert.deepEqual(keys(recs), ['12|h.test', '13|h.test', 'of.claude-code.cli|h.test', 'of.codex.cli|h.test'], 'four entries, none folded into (null, host)')
  const cleared = (e) => keys([...recs, { ts: at(5 * H), event: 'negative-cache-cleared', ...e, dropped: 1 }])
  assert.deepEqual(cleared({ pid: null, neg_key: 'of.claude-code.cli' }), ['12|h.test', '13|h.test', 'of.codex.cli|h.test'], 'clears by neg_key: only that form')
  assert.deepEqual(cleared({ pid: 12, neg_key: '12' }), ['13|h.test', 'of.claude-code.cli|h.test', 'of.codex.cli|h.test'])
  assert.deepEqual(cleared({ pid: 13 }), ['12|h.test', 'of.claude-code.cli|h.test', 'of.codex.cli|h.test'], 'an old clearing without neg_key falls back to the pid')
  const exit = keys([...recs, { ts: at(5 * H), event: 'agent-exit', pid: 12 }])
  assert.deepEqual(exit, ['13|h.test', 'of.claude-code.cli|h.test', 'of.codex.cli|h.test'], 'a process exiting clears its own pid\'s entry and no form\'s')
  assert.equal(foldFlows(recs, { now: NOW }).conditions.find((c) => c.neg_key === 'of.codex.cli').pid, null, 'neg_key survives the metadata whitelist')
})

// RFC 4.6 W22 (the board's half): a negative-cache entry ends at its retry time, so a record whose retry_at is past is no condition; a refused
// leaf seen by the door (trust-rejected, critical) of the same pair stays either way
test('W22 foldFlows: a negative-cache record past its retry_at is no condition; a trust-rejected record of the same pair stays critical', () => {
  const rec = (code, extra) => ({ ts: at(2 * H), event: 'failure', where: 'engine', code, pid: 31, neg_key: '31', agent: 'claude-code', host: 'h.test', reason: 'r', ...extra })
  const kinds = (retryAt) => foldFlows([
    { ts: at(3 * H), event: 'daemon-start', pid: 2 },
    rec('negative-cache', { cause: 'client-rejected-leaf', retry_at: retryAt }),
    rec('trust-rejected', { level: 'critical' }),
  ], { now: NOW }).conditions.filter((c) => c.host === 'h.test').map((c) => c.kind).sort()
  assert.deepEqual(kinds(at(H)), ['trust-rejected'], 'retry time passed: no negative-cache condition')
  assert.deepEqual(kinds(new Date(NOW + H).toISOString()), ['negative-cache', 'trust-rejected'], 'retry time ahead: the condition stands')
})

test('foldFlows: 24 h failure groups (folded counts included), expected counts, per-agent last capture and failure', () => {
  const recs = [
    { ts: at(30 * H), event: 'failure', where: 'engine', code: 'lookup-miss', reason: 'old' },
    { ts: at(3 * H), event: 'failure', where: 'engine', code: 'lookup-miss', reason: 'a' },
    { ts: at(2 * H), event: 'failure', where: 'engine', code: 'lookup-miss', reason: 'b', suppressed: 4, folded: true },
    { ts: at(2 * H), event: 'agent-untrusted', pid: 5, agent: 'codex', reason: 'var-missing' },
    { ts: at(2 * H), flow_id: 'f1', pid: 5, agent: 'codex', decision: 'direct', not_captured: 'untrusted', reason: 'untrusted: var-missing' },
    { ts: at(2 * H), flow_id: 'f2', pid: 6, agent: 'claude-code', decision: 'splice', reason: 'client-rejected-leaf' },
    { ts: at(1 * H), flow_id: 'f3', pid: 6, agent: 'claude-code', decision: 'decrypt', host: 'api.test' },
    { ts: at(1 * H), flow_id: 'f4', pid: 6, agent: 'claude-code', decision: 'splice', not_captured: 'policy' },
    { ts: at(1 * H), flow_id: 'f5', pid: 6, agent: 'claude-code', decision: 'splice', not_captured: 'policy' },
    { ts: at(1 * H), event: 'switch', desired: 'on', actual: 'on' },
  ]
  const f = foldFlows(recs, { now: NOW })
  const g = Object.fromEntries(f.groups.map((x) => [x.key, x.count]))
  assert.deepEqual(g, { 'engine/lookup-miss': 5, 'agent-untrusted:var-missing': 1, 'flow:untrusted': 1, 'flow:client-rejected-leaf': 1 })
  // 'a' + the 4 folded into 'b' (the folded line stands for the suppressed ones only: test/collector/f-group F3(e))
  assert.equal(f.groups.find((x) => x.key === 'engine/lookup-miss').last.reason, 'b')
  assert.deepEqual(f.expected, { policy: 2 })
  const cc = f.agents.find((a) => a.agent === 'claude-code')
  assert.deepEqual([cc.last_captured, cc.last_failure_key], [at(H), 'flow:client-rejected-leaf'])
  assert.equal(f.agents.find((a) => a.agent === 'codex').last_captured, null)
  assert.equal(f.last_ts, at(H))
  assert.equal(groupKey({ event: 'log-gap', reason: 'r' }), 'log-gap')
})

test('pick: metadata only — no tail_raw, prelude or body; long text clipped and said; error as {type, message, side}', () => {
  const row = { ts: 't', flow_id: 'f', pid: 1, proc: { pid: 1, agent: 'codex', exe: '/x' }, decision: 'decrypt', ws: { frames: 9, tail_raw: 'AAAA', failures: 2 },
    req_body: 'secret body', prelude: 'Proxy-Authorization: Basic eA==', req_head_raw: 'GET / HTTP/1.1', reason: 'r'.repeat(5000), error: { type: 'ECONNRESET', message: 'm', side: 'client', stack: 's' } }
  const p = pick(row)
  assert.deepEqual(Object.keys(p).sort(), ['agent', 'decision', 'error', 'flow_id', 'pid', 'reason', 'ts', 'ws_failures'])
  assert.deepEqual([p.agent, p.ws_failures, p.error], ['codex', 2, { type: 'ECONNRESET', message: 'm', side: 'client' }])
  assert.ok(p.reason.length < 1100 && p.reason.endsWith('… (5000 chars)'), 'clipped, and the full length said')
  assert.doesNotMatch(JSON.stringify(p), /AAAA|secret|Proxy-Authorization|HTTP\/1\.1|stack/)
})

test('foldFlows: expected_groups — each expected not_captured code of the window with its count and first / last ts (C.3 failures.groups, level expected)', () => {
  const recs = [
    { ts: at(30 * H), flow_id: 'f0', pid: 6, agent: 'codex', decision: 'splice', not_captured: 'policy' },
    { ts: at(3 * H), flow_id: 'f1', pid: 6, agent: 'codex', decision: 'splice', not_captured: 'policy' },
    { ts: at(1 * H), flow_id: 'f2', pid: 6, agent: 'codex', decision: 'splice', not_captured: 'policy' },
    { ts: at(2 * H), flow_id: 'f3', pid: 6, agent: 'codex', decision: 'direct', not_captured: 'https-proxy' },
  ]
  const f = foldFlows(recs, { now: NOW })
  assert.deepEqual(f.expected_groups, { policy: { count: 2, first_ts: at(3 * H), last_ts: at(H) }, 'https-proxy': { count: 1, first_ts: at(2 * H), last_ts: at(2 * H) } })
})

// 4.6 §记录「连接行」: rows a door forwards by design fold into `expected` under their reason (status names them), never into a failure group
test('foldFlows: by-design untracked / untrusted rows count as expected under their reason; a real untracked reason is a failure group', () => {
  const row = (nc, reason) => ({ ts: at(1000), flow_id: `f-${nc}-${reason}`, decision: 'splice', agent: 'claude-code', not_captured: nc, reason })
  const f = foldFlows([row('untracked', 'not-an-agent'), row('untracked', 'not-an-agent'), row('untracked', 'group-off'), row('untrusted', 'not-verified'), row('untracked', 'pid-unresolved')], { now: NOW })
  assert.deepEqual(f.expected, { 'not-an-agent': 2, 'group-off': 1, 'not-verified': 1 })
  assert.deepEqual(f.groups.map((g) => [g.last.not_captured, g.last.reason, g.count]), [['untracked', 'pid-unresolved', 1]])
})

// ── a connection row is written when the connection closes, with `ts` = its open time (4.6 §看得到): rows are not in time order, and every
// first / last time of the fold is a min / max over the lines' times — a row's time is its close, ts + duration_ms — whatever order they were written in ──
test('foldFlows: the same times in every write order; a connection row stands for its close (ts + duration_ms), also for the 24 h window', () => {
  const row = (agent, openAgo, dur, more = {}) => ({ ts: at(openAgo), agent, decision: 'decrypt', not_captured: null, duration_ms: dur, ...more })
  const lines = [
    row('codex', 10 * H, 9.5 * H), // long-lived, captured, closed 0.5 h ago
    row('codex', 2 * H, 1000),
    row('codex', 5 * H, 4 * H, { not_captured: 'untrusted', reason: 'not-verified' }), // expected, closed 1 h ago
    row('codex', 3 * H, 0, { not_captured: 'untrusted', reason: 'not-verified' }),
    { ts: at(4 * H), event: 'failure', where: 'engine', code: 'leaf-error', agent: 'codex', reason: 'x' },
    row('codex', 6 * H, 5.75 * H, { decision: 'tunnel', not_captured: 'upstream-cert', reason: 'CERT_HAS_EXPIRED' }), // failed, closed 0.25 h ago
    { ts: at(1.5 * H), event: 'failure', where: 'engine', code: 'describe-error', agent: 'claude-code', reason: 'y' },
    row('claude-code', 30 * H, 29 * H), // opened outside the window, closed inside it
    row('claude-code', 30 * H, 1 * H, { not_captured: 'untrusted', reason: 'not-verified' }), // closed outside the window
  ]
  const end = (r) => Date.parse(r.ts) + (r.duration_ms || 0)
  const byTs = [...lines].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts))
  const orders = { opened: byTs, reversed: [...byTs].reverse(), closed: [...lines].sort((a, b) => end(a) - end(b)), 'long-lived last': [...byTs.slice(1), byTs[0]] }
  const view = (f) => ({ last_ts: f.last_ts, expected: f.expected, expected_groups: f.expected_groups,
    groups: f.groups.map((g) => ({ key: g.key, count: g.count, first_ts: g.first_ts, last_ts: g.last_ts })),
    agents: [...f.agents].sort((a, b) => (a.agent < b.agent ? -1 : 1)) })
  const want = {
    last_ts: at(0.25 * H), expected: { 'not-verified': 2 }, expected_groups: { 'not-verified': { count: 2, first_ts: at(3 * H), last_ts: at(1 * H) } },
    groups: [
      { key: groupKey(lines[5]), count: 1, first_ts: at(0.25 * H), last_ts: at(0.25 * H) },
      { key: groupKey(lines[6]), count: 1, first_ts: at(1.5 * H), last_ts: at(1.5 * H) },
      { key: groupKey(lines[4]), count: 1, first_ts: at(4 * H), last_ts: at(4 * H) },
    ],
    agents: [
      { agent: 'claude-code', last_captured: at(1 * H), last_failure: at(1.5 * H), last_failure_key: groupKey(lines[6]) },
      { agent: 'codex', last_captured: at(0.5 * H), last_failure: at(0.25 * H), last_failure_key: groupKey(lines[5]) },
    ],
  }
  for (const [name, recs] of Object.entries(orders)) assert.deepEqual(view(foldFlows(recs, { now: NOW })), want, `written ${name}`)
  // two failures of one group, the later-opened one closing first: the span is still first ≤ last
  const twice = [row('codex', 6 * H, 5 * H, { not_captured: 'upstream-cert', reason: 'a' }), row('codex', 3 * H, 0, { not_captured: 'upstream-cert', reason: 'b' })]
  for (const recs of [twice, [...twice].reverse()]) {
    const [g] = foldFlows(recs, { now: NOW }).groups
    assert.deepEqual([g.count, g.first_ts, g.last_ts], [2, at(3 * H), at(1 * H)])
  }
})
