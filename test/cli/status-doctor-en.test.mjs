// test/cli/status-doctor-en.test.mjs — RFC 1.6 §3.5 · §3.7 · D58: what `status` and `doctor` print is English, ASCII, 80 columns, says `unknown` with a reason
// and never leaks an internal name, a section number or a JavaScript value. The layout itself is the manual's samples; this file is the guard under them.
import test from 'node:test'
import assert from 'node:assert/strict'
import { statusSummary, statusDetail, failuresBlock, noteText } from '../../src/cli/status-text.mjs'
import { statusExit } from '../../src/cli/status.mjs'
import { FINDING_CODES, findingFor, renderFindings } from '../../src/netenv/findings.mjs'
import { EXIT } from '../../src/cli/schema.mjs'
import { loadHarnesses } from '../../src/collector/harness/index.mjs'
import { STATUS_REASONS } from '../../src/health/codes.mjs'

const NOW = Date.parse('2026-10-18T12:24:00Z')
const BAD = [[/[\u3000-\u9fff\uff00-\uffef]/, 'CJK'], [/\bundefined\b/, 'undefined'], [/\bnull\b/, 'null'], [/\bNaN\b/, 'NaN'], [/§/, 'a section sign'], [/\bD\d+\b/, 'a decision number'], [/<[a-z_]+>/, 'an unfilled placeholder'], [/[^\x20-\x7e]/, 'a non-ASCII character']]

/** Every rule of D58 one output must keep. `whole`: commands that print whole on their line, however long (§1.1⑥: a command is never folded). */
function clean(lines, what, whole = []) {
  for (const l of lines) {
    for (const [re, name] of BAD) assert.doesNotMatch(l, re, `${what}: ${name} in ${JSON.stringify(l)}`)
    assert.ok(l.length <= 80 || whole.some((c) => l.endsWith(` ${c}`)), `${what}: ${l.length} columns in ${JSON.stringify(l)}`)
  }
}

const harness = (over = {}) => ({ desired: 'on', captured: true, reason: null, why: [], forms: [], processes: [], ...over })
const doc = (over = {}) => ({
  schema: 2, command: 'status', ok: true,
  daemon: { running: true, pid: 4012, responding: true, since: '2026-10-18T09:12:00Z', error: null },
  harnesses: { 'claude-code': harness(), codex: harness({ captured: false, reason: 'config-after-start', processes: [{ pid: 5530, name: 'codex', captured: false, reason: 'config-after-start' }], forms: [{ form: 'codex.cli', certificate: { in_effect: true, carrier: 'root' }, proxy: { connected: true, written: 'http://127.0.0.1:17992', prior: null } }] }), opencode: harness({ desired: 'off', captured: false, reason: 'desired-off' }) },
  install: { state: 'complete', harnesses: ['claude-code', 'codex', 'opencode'], pending: [] },
  cert: { fp256: '3f9a', expires: '2036-10-15', root: { state: 'in-place' }, key: { custody: 'keychain', state: 'present' }, intermediate: { state: 'current' }, bundles: [] },
  holders: [], relayed: { closing: 3, waiting: 0, cut: 0 }, agent_list: { path: '~/.trocar/agents.json', state: 'ok', problems: [] },
  failures: { problem: 1, expected: 2, note: 0, since: null, latest: '2026-10-18T12:14:00Z' }, errors: [], ...over,
})

test('§3.5 the summary: conclusion first, one row per harness, the three facts under it, and where the detail is — in the steady world and in the empty one', () => {
  const lines = statusSummary(doc(), { now: NOW })
  clean(lines, 'status')
  assert.match(lines[0], /^Capturing 1 of 3 installed harnesses\. Daemon running \(pid 4012, up 3h 12m\)\.$/)
  assert.ok(lines.some((l) => /^ {2}HARNESS\s+CAPTURED\s+NOTE$/.test(l)))
  assert.ok(lines.some((l) => /^ {2}codex\s+no\s+pid 5530 started before capture was on; restart codex$/.test(l)))
  assert.ok(lines.some((l) => /^ {2}opencode\s+off$/.test(l)), 'a harness that is off says off, not a reason code')
  assert.ok(lines.some((l) => /^ {2}Problems\s+1 in the last 24 hours, latest 10 min ago$/.test(l)))
  assert.ok(lines.at(-1).startsWith('More: trocar status codex'), lines.at(-1))
  assert.ok(!lines.some((l) => l.includes('->')), 'V44: the summary draws no chain')

  const fresh = statusSummary(doc({ harnesses: {}, install: { state: null, harnesses: [], pending: [] }, cert: { fp256: null, expires: null, root: { state: 'unknown' }, key: {}, intermediate: {}, bundles: [] } }), { now: NOW })
  clean(fresh, 'status (nothing installed)')
  assert.match(fresh[0], /^No harness is set up for capture yet\.$/)
  assert.ok(fresh.includes('Next: trocar install'))
})

test('§1.1 · §3.5 a long NOTE folds under its own column: every line of the summary inside 80 columns, for every reason and harness name', () => {
  const names = ['pi', 'opencode', 'a-harness-of-twenty'] // the HARNESS column's width moves where NOTE starts; each name is also in its own note
  for (const code of STATUS_REASONS) {
    const harnesses = Object.fromEntries(names.map((h, i) => [h, harness({ captured: false, reason: code, processes: [{ pid: 40000 + i, captured: false, reason: code }] })]))
    const lines = statusSummary(doc({ harnesses, install: { state: 'complete', harnesses: [], pending: [] } }), { now: NOW })
    clean(lines, `status (${code})`)
    const at = lines.findIndex((l) => /^ {2}HARNESS\s/.test(l)), note = lines[at].indexOf('NOTE')
    const table = lines.slice(at + 1, lines.indexOf('', at))
    table.forEach((l, i) => {
      if (names.some((h) => l.startsWith(`  ${h} `))) return
      assert.equal(l.search(/\S/), note, `${code}: a folded line starts under NOTE: ${JSON.stringify(l)}`)
      assert.ok(table[i - 1].length + 1 + l.trim().match(/^(trocar [a-z][a-z-]*\S*|\S+)/)[0].length > 80, /* `trocar <command>` is one word to the wrapper (§1.1⑥) */ `${code}: folded only where the next word does not fit: ${JSON.stringify(table[i - 1])}`)
    })
  }
})

test('§1.1 · D38 a row that could not be read says why, whole, folded under NOTE: only a word longer than the room (a path) passes 80 columns', () => {
  const why = '/var/folders/b1/_1pdzqc97_39d45tv31x1mjw0000gn/T/trocar-run-fyS8zy/.trocar/collector/state.json: EACCES (permission denied while it was read)'
  const lines = statusSummary(doc({ harnesses: { 'claude-code': harness({ captured: null, why: [why] }) }, install: { state: 'complete', harnesses: [], pending: [] } }), { now: NOW })
  const at = lines.findIndex((l) => /^ {2}HARNESS\s/.test(l)), note = lines[at].indexOf('NOTE'), row = lines.slice(at + 1, lines.indexOf('', at))
  assert.ok(row.join(' ').replace(/\s+/g, ' ').includes(why), `the reason is said whole: ${JSON.stringify(row)}`)
  for (const l of row.slice(1)) assert.equal(l.search(/\S/), note, `a folded line starts under NOTE: ${JSON.stringify(l)}`)
  for (const l of row) assert.ok(l.length <= 80 || !/\s/.test(l.trim()), `over 80 columns only as one unbroken word: ${JSON.stringify(l)}`)
})

test('§1.1 · §3.5 the Forms block of `status <harness>`: a long certificate sentence folds under its own column, inside 80 columns, for every reason', () => {
  for (const code of STATUS_REASONS) {
    const forms = [{ form: 'a-harness-of-twenty.cli', certificate: { in_effect: false, code }, proxy: { written: 'http://127.0.0.1:17992', prior: 'http://127.0.0.1:7897' } }]
    const lines = statusDetail(doc({ harnesses: { 'a-harness-of-twenty': harness({ captured: false, reason: code, forms }) } }), 'a-harness-of-twenty', { now: NOW })
    clean(lines, `status <harness> (${code})`)
    const at = lines.findIndex((l) => l.includes(' certificate  ')), col = lines[at].indexOf(' certificate  ') + 14
    for (const l of lines.slice(at + 1, lines.findIndex((l) => l.includes(' proxy  ')))) assert.equal(l.search(/\S/), col, `${code}: a folded line starts under its sentence: ${JSON.stringify(l)}`)
  }
})

test('§3.5 a read that failed is `unknown` with its reason, never 0 and never a stale pid as the present state', () => {
  const lines = statusSummary(doc({
    daemon: { running: null, pid: 4012, responding: null, since: null, error: 'the lock could not be read (EACCES)' },
    harnesses: { codex: harness({ captured: null, why: ['the process table could not be listed (EPERM)'] }) },
    relayed: 'unknown', relayed_reason: 'the daemon does not answer', connections: 'unknown', connections_reason: 'the daemon does not answer', failures: null,
  }), { now: NOW })
  clean(lines, 'status (unreadable)')
  assert.ok(lines.some((l) => /Daemon: unknown \(the lock could not be read \(EACCES\)\)/.test(l)))
  assert.ok(!lines.some((l) => /pid 4012/.test(l)), 'a daemon whose state is not known does not print its pid as the present state')
  assert.ok(lines.some((l) => /^ {2}Connections\s+unknown \(the daemon does not answer\)$/.test(l)))
  assert.ok(lines.some((l) => /^ {2}Problems\s+unknown \(capture health could not be read\)$/.test(l)))
})

test('§3.5 `status <harness>`: the verdict, Why / Fix / Check from the one catalogue, the forms, the routes and the two sentences 附录 A asks for', () => {
  const finding = { code: 'config-after-start', class: 'problem', harness: 'codex', what: 'codex is not captured: pid 5530 started before capture was on.', why: 'Certificates are read when a program starts.', commands: [{ run: 'Quit every codex window, then run: kill 5530', shell: 'sh' }], verify: 'trocar status codex' }
  const t = { harness: 'codex', routing: 'proxy', on_path: true, captured: false, reason: 'config-after-start',
    nodes: [{ id: 'a', kind: 'agent', name: 'codex', pid: 5530 }, { id: 'd', kind: 'trocar-forwarder', name: 'trocar', port: 17992, trocar: true, mode: 'on' }, { id: 'x', kind: 'egress', name: 'internet' }],
    edges: [{ from: 'a', to: 'd', via: 'proxy-http', trocar: true, entry: { where: '~/.codex/.env', kind: 'dotenv' } }, { from: 'd', to: 'x', via: 'egress' }, { from: 'a', to: 'x', via: 'direct' }],
    branches: [{ name: 'all', form: 'codex.cli', path: ['a', 'd', 'x'], off_path: ['a', 'x'], on_path: true, captured: false, reason: 'config-after-start' }], running: [], notes: [] }
  const lines = statusDetail(doc({ topology: { codex: t } }), 'codex', { finding, now: NOW })
  clean(lines, 'status codex')
  assert.match(lines[0], /^codex: on, not captured$/)
  assert.ok(lines.some((l) => /^ {2}Why\s+codex is not captured: pid 5530 started before capture was on\.$/.test(l)))
  assert.ok(lines.some((l) => /^ {2}Fix\s+Quit every codex window, then run: kill 5530$/.test(l)))
  assert.ok(lines.some((l) => /^ {2}Check\s+trocar status codex$/.test(l)))
  const certRow = lines.find((l) => /\scertificate\s/.test(l)), proxyRow = lines.find((l) => /\sproxy\s/.test(l) && l.includes(':17992'))
  assert.ok(certRow && proxyRow && certRow !== proxyRow, 'the two axes are apart')
  assert.ok(!certRow.includes(`(${doc().harnesses.codex.forms[0].certificate.carrier})`), 'the carrier in words, never its code')
  assert.ok(!proxyRow.includes('127.0.0.1'), 'a loopback address prints as its port')
  assert.ok(lines.some((l) => /^ {4}pid 5530\s+codex \(pid 5530\) -> .*trocar :17992 -> internet$/.test(l)))
  assert.ok(lines.some((l) => /^ {4}without trocar\s+codex \(pid 5530\) -> internet$/.test(l)))
  assert.ok(lines.includes('  If your VPN or proxy routes by process, it sees trocar, not codex.'))
  assert.ok(lines.some((l) => l.startsWith('  To change the proxy: edit codex')))
})

test('§3.5 `status <harness>`: each form note prints once after Forms, its paths beside it; every descriptor note keeps D58 (4.11 CM38)', async () => {
  const said = (await loadHarnesses()).flatMap((d) => (d.proxyMode.notes || []).map((n) => ({ code: 'harness-note', text: n.text })))
  const notes = [...said, { code: 'harness-note', text: 'the first run installs a package in the config folder; off deletes nothing', paths: ['/home/alice/.agent/node_modules'] }]
  const form = (id) => ({ form: id, certificate: { in_effect: true, carrier: 'plugin' }, proxy: { connected: true, written: 'http://127.0.0.1:17995', prior: null }, notes })
  const lines = statusDetail(doc({ harnesses: { agent: harness({ forms: [form('agent.cli'), form('agent.npm')] }) } }), 'agent', { now: NOW })
  clean(lines, 'status agent')
  const flat = lines.slice(lines.indexOf('  Forms')).join(' ').replace(/\s+/g, ' ') // after Forms
  for (const n of notes) { const s = `${n.text}${n.paths ? ` (${n.paths.join(', ')})` : ''}`; assert.equal(flat.split(s).length - 1, 1, `said once: ${s}`) }
})

test('§3.5 `--failures`: one line per kind of problem, then Expected — and a health that could not be read says so', () => {
  const health = { collector: { failures: [{ count: 3, last_ts: '2026-10-18T12:14:00Z', last: { event: 'failure', where: 'engine', code: 'engine-error', reason: 'the upstream reset it' } }], expected: { 'not-an-agent': 12 } }, read: { errors: [] }, summary: { state: 'failing' } }
  const failures = { groups: [{ level: 'problem', where: 'engine', code: 'engine-error', count: 3, first_ts: '2026-10-18T12:00:00Z', last_ts: '2026-10-18T12:14:00Z', reason: 'the upstream reset it' }] }
  const lines = failuresBlock(failures, health, { now: NOW })
  clean(lines, 'status --failures')
  assert.match(lines[0], /^Problems in the last 24 hours: 3 in 1 kind$/)
  assert.ok(lines.includes('Expected') && lines.some((l) => /not agents[^:]*: 12$/.test(l)))
  clean(failuresBlock(null, null, { now: NOW }), 'status --failures (unreadable)')
  assert.match(failuresBlock(null, null)[0], /^Problems: unknown \(capture health could not be read\)$/)
})

test('§3.5 exit codes: 0 every harness that is on is captured, 1 one of them is not, 3 that cannot be judged — a stale health line never decides it', () => {
  const f = (harnesses, over = {}) => ({ harnesses, install: { state: 'complete' }, cert: { root: { code: null }, key: { state: 'present' } }, ...over })
  const on = (captured, desired = 'on') => ({ desired, judged: { captured, rows: [] } })
  assert.equal(statusExit(f([on(true), on(false, 'off')])), EXIT.ok)
  assert.equal(statusExit(f([on(false)])), EXIT.incomplete)
  assert.equal(statusExit(f([on(null)])), EXIT.unknown)
  // the daemon answered; a health line on disk still says it is not running — the daemon's own answer wins, so this is exit 0
  assert.equal(statusExit(f([on(true)], { health: { collector: { failures: [{ count: 1, last_ts: 'x', last: {} }] }, summary: { state: 'not-running' } } })), EXIT.ok)
  // a certificate the user must act on exits 1 even where no agent runs
  assert.equal(statusExit(f([], { cert: { root: { code: 'cert-root-pending' }, key: { state: 'present' } } })), EXIT.incomplete)
})

test('附录 B · §3.7: every code in the catalogue renders as English sentences with Fix and Check, every value filled in, inside 80 columns', () => {
  const ctx = { platform: 'linux', h: 'codex', hf: { behaviour: { fileKeys: [{ path: '/home/alice/.codex/.env', key: 'HTTPS_PROXY', format: 'dotenv' }], restart: {} }, procs: [], forms: [] },
    t: { nodes: [], edges: [], branches: [] }, F: { routing: 'proxy', harnesses: {}, desired: {} }, user: 'alice', setting: { scheme: 'socks5', host: '127.0.0.1', port: 1080 },
    dead: { addr: '127.0.0.1', port: 7890 }, u: { name: 'node', pid: 42 }, listPath: '/home/alice/.trocar/agents.json', file: { path: '/home/alice/.trocar/agents.json', state: 'ok', problems: [{ index: 1, code: 'wide-name-needs-args', detail: 'this name needs an args pattern' }] }, pid: 5530, port: 17992, upPort: 7890 }
  for (const code of FINDING_CODES) {
    const found = findingFor(code, ctx)
    assert.ok(found.what && found.why, `${code}: what and why say something`)
    assert.ok(['problem', 'expected', 'note'].includes(found.class), `${code}: ${found.class} is a class of 附录 B`)
    if (found.class !== 'note') assert.ok(found.commands.length, `${code}: a problem or an expected finding says what to do`)
    clean(renderFindings([found]), `doctor finding ${code}`, found.commands.map((c) => c.run))
  }
})

test('§3.5 the NOTE column never prints a code name, and an unknown code says so', () => {
  assert.equal(noteText('desired-off'), '')
  assert.match(noteText('config-after-start', { harness: 'codex', pid: 5530 }), /^pid 5530 started before capture was on; restart codex$/)
  assert.match(noteText('a-code-no-one-wrote-a-sentence-for'), /^unknown \(no reason was recorded\)$/)
})
