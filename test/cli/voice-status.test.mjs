// voice-status.test.mjs — 1.6 §1.1 ④ (D58 ⑦) for `status`, `status --failures` and `doctor`: the default text says no word of the UNSAID table,
// fits 80 columns, and every fact it leaves out is in --details. Invariants over every reason, failure code and finding code; no screen's wording.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { unsaidIn, FAILURE_WORDS, statusNote } from '../../src/cli/words.mjs'
import { statusSummary, failuresBlock } from '../../src/cli/status-text.mjs'
import { doctorShort, doctorDetails } from '../../src/cli/doctor.mjs'
import { FINDING_CODES, findingFor } from '../../src/netenv/findings.mjs'
import { STATUS_REASONS } from '../../src/health/codes.mjs'

const NOW = Date.parse('2026-11-09T05:30:00Z'), ago = (min) => new Date(NOW - min * 60e3).toISOString()
const harness = (over = {}) => ({ desired: 'on', captured: true, reason: null, why: [], forms: [], processes: [], ...over })
const group = (i, over) => ({ level: 'problem', where: 'engine', count: i + 1, first_ts: ago(i + 9), last_ts: ago(i), reason: `reason ${i} at /home/alice/.x/${i}`, process: 'node', pid: 7000 + i, ...over })
const doc = (harnesses, groups = []) => ({
  daemon: { running: true, pid: 4012, responding: true, since: ago(60), runs_this_code: true },
  harnesses, install: { state: 'complete', harnesses: Object.keys(harnesses), pending: [] },
  cert: { fp256: 'ab', expires: '2036-10-15', root: { state: 'in-place' } }, connections: 3, relayed: { closing: 1, waiting: 1 },
  board: { state: 'serving', url: 'http://127.0.0.1:9800/' },
  failures: { problem: groups.reduce((n, g) => n + g.count, 0), since: ago(48 * 60), latest: ago(0), groups },
})
const plain = (lines, what) => {
  assert.deepEqual(unsaidIn(lines.join('\n')), [], `${what}:\n${lines.join('\n')}`)
  for (const l of lines) assert.ok(l.length <= 80, `${what}: ${l.length} columns: ${l}`)
}

test('status: the summary says no unsaid word for any reason, and --details names every pid, the service and the connections it leaves out', () => {
  for (const reason of STATUS_REASONS) {
    const processes = [{ pid: 5530, captured: false, reason }, { pid: 5531, captured: true, reason: null }]
    const d = doc({ 'claude-code': harness(), 'a-long-agent-name': harness({ captured: false, reason, processes }), opencode: harness({ desired: 'off', captured: false, reason: 'desired-off' }) })
    plain(statusSummary(d, { now: NOW }), `status (${reason})`)
    const full = statusSummary(d, { now: NOW, details: true }).join('\n')
    for (const fact of ['4012', '3 open']) assert.ok(full.includes(fact), `${reason}: --details says ${fact}`)
    if ((statusNote(reason, { harness: 'a-long-agent-name', pid: 5530 }) || '').includes('5530')) assert.ok(full.includes('5530'), `${reason}: --details names the pid its reason names`)
  }
  for (const daemon of [{ running: false }, { running: null, responding: false }, { running: null, error: 'the lock could not be read' }, { running: true, runs_this_code: false, code: '9.9.9' }]) {
    plain(statusSummary({ ...doc({ pi: harness() }), daemon }, { now: NOW }), `status (${JSON.stringify(daemon)})`)
  }
})

test('status --failures: no unsaid word for any code or reason; one row per agent and sentence, the counts adding up; --details keeps every reason, program and pid', () => {
  const codes = [...Object.keys(FAILURE_WORDS).map((k) => k.split('/')), ...STATUS_REASONS.map((r) => ['flow', 'untrusted', r]), ['engine', 'a-code-no-table-knows']]
  const groups = codes.map(([a, b, r], i) => group(i % 50, { ...(b ? { where: a, code: b } : { code: a }), ...(r ? { reason: r } : {}), ...(i % 3 ? { harness: 'pi' } : {}) }))
  const d = doc({ pi: harness({ captured: false, reason: 'config-after-start' }) }, groups)
  const short = failuresBlock(d.failures, { collector: { expected: { 'not-an-agent': 2 } } }, { now: NOW, restart: ['pi'] })
  plain(short, '--failures')
  // the rows: between the table head and the blank line; a row starts with its WHEN in column 2, a fold below it is deeper
  const head = short.findIndex((l) => /^ {2}WHEN\s/.test(l)), rows = short.slice(head + 1, short.indexOf('', head)).filter((l) => /^ {2}\S/.test(l))
  const counts = rows.map((l) => Number(l.slice(short[head].indexOf('COUNT')).split(/\s+/)[0]))
  assert.equal(counts.reduce((a, b) => a + b, 0), d.failures.problem, 'every problem is in one row')
  const full = failuresBlock(d.failures, { collector: { expected: { 'not-an-agent': 2 } } }, { now: NOW, details: true }).join('\n').replace(/\s+/g, ' ')
  for (const g of groups) for (const fact of [g.reason, String(g.pid)]) assert.ok(full.includes(fact), `--details keeps ${fact}`)
  assert.ok(/not-an-agent|not agents/.test(full), '--details keeps what was skipped by design')
})

test('doctor: no unsaid word and no pid for any finding; --details keeps every finding\'s sentence and command', () => {
  const ctx = { platform: 'linux', h: 'codex', hf: { behaviour: { fileKeys: [{ path: '/home/alice/.codex/.env', key: 'HTTPS_PROXY', format: 'dotenv' }], restart: { managed: true, processes: 'codex app-server' } }, procs: [{ name: 'codex app-server', pid: 6611 }], forms: [], negatives: [{ pid: 6612, host: 'api.x.test', cause: 'client-rejected-leaf' }] },
    t: { nodes: [], edges: [], branches: [] }, F: { routing: 'proxy', harnesses: {}, desired: {}, at: ago(0), autostart: { state: 'absent', reason: 'the login item is not registered' } }, user: 'alice', setting: { scheme: 'socks5', host: '127.0.0.1', port: 1080 },
    dead: { addr: '127.0.0.1', port: 7890 }, u: { name: 'node', pid: 42 }, listPath: '/home/alice/.trocar/agents.json', file: { path: '/home/alice/.trocar/agents.json', state: 'ok', problems: [{ index: 1, detail: 'a bad item' }] },
    pid: 5530, pids: [5532], port: 17992, upPort: 7890, online: 'codex', holders: [{ harness: 'codex', pid: 5533 }] }
  for (const code of FINDING_CODES) {
    const f = findingFor(code, ctx)
    const d = { findings: [f], summary: { problem: +(f.class === 'problem'), expected: +(f.class === 'expected'), note: +(f.class === 'note') }, undetermined: [], status: { failures: null }, install_notes: [] }
    const short = doctorShort(d, { now: NOW })
    plain(short.filter((l) => !/^ {3}(Fix|Check| {4})/.test(l)), `doctor (${code})`) // a command is the user's to copy, whatever its words
    assert.doesNotMatch(short.join('\n'), /\bpid\b|\b55\d\d\b|\b66\d\d\b/, `doctor (${code}): a pid only in --details:\n${short.join('\n')}`)
    const full = doctorDetails(d).join('\n').replace(/\s+/g, ' ')
    for (const fact of [f.what, ...f.commands.map((c) => c.run)]) assert.ok(full.includes(fact.replace(/\s+/g, ' ')), `${code}: --details keeps ${fact}`)
  }
})
