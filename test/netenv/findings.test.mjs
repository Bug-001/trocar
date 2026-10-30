// test/netenv/findings.test.mjs — RFC 1.6 附录 B `doctor`'s findings (V49 the catalogue, both directions · V51 the fallback when an agent cannot connect and nothing explains it). Table-driven: every code has the
// injected facts that call for it, and those facts call for exactly its codes; every code the catalogue defines has such a set. Facts are injected, nothing here reads the machine (0.1 §3).
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildTopology } from '../../src/netenv/topology.mjs'
import { diagnose, FINDINGS, FINDING_CODES, renderFindings } from '../../src/netenv/findings.mjs'
import { validateFinding, validateTopology } from '../../src/cli/schema.mjs'
import { NET_CODES, ROUTE_CODES, ROUTE_TRUST_REASONS, STATUS_REASONS, TRUST_REASONS } from '../../src/health/codes.mjs'
import { FINDINGS_WIN32 } from '../../src/netenv/findings-win32.mjs'
import { ROWS, facts, proc, proxyOf, form, fwForm, pfacts, MIHOMO, mihomoVpn } from './fixtures/rows.mjs'
import { proxyPlaces, writtenPlaces } from '../../src/netenv/adopt.mjs'
import { writeRoutes } from '../../src/collector/core/proxymode/entries.mjs'
import { world, put } from '../collector/core/proxymode/fixtures/entries-ctx.mjs'
import { loadHarnesses } from '../../src/collector/harness/index.mjs'
import { linuxNetFacts } from '../../src/collector/arch/linux/netfacts.mjs'
import { installedViaCli } from '../cli/fixtures/dispatch-ctx.mjs'
import fs from 'node:fs'
import os from 'node:os'
import { tmpDir } from '../helpers/tmp.mjs'
import { readAgentList } from '../../src/off/identity.mjs'
import { createRegistry } from '../../src/collector/core/registry.mjs'
import path from 'node:path'

const row = (n) => ROWS.find((r) => r.n === n)
const codesOf = (f, h, names = null) => diagnose({ facts: f, topology: buildTopology(f), harnesses: names, user: 'alice' }).filter((x) => !x.harness || x.harness === h).map((x) => x.code).sort()
const findingsOf = (f, names = null) => diagnose({ facts: f, topology: buildTopology(f), harnesses: names, user: 'alice' })
const mihomoVia = { listeners: [MIHOMO] }
const viaProxy = (value = 'http://127.0.0.1:7890') => ({ setting: proxyOf(value) })

// status's name list per harness (1.6 §9.7 `identity`), the shape the facts carry it in
const LIST = '/home/alice/.trocar/agents.json'
function idOf(h, { unknown = [] } = {}) { return { [h]: { names: [{ name: 'claude', source: 'preset' }], ignored: [], unknown } } }

// one injected fact set per code: { codes: exactly what it must give, h, facts }. The rows of §9.3 serve for the codes they illustrate; the others are built here.
const SETS = {
  'config-after-start': { h: 'claude-code', facts: row(5).facts, codes: row(5).findings },
  'desired-off': { h: 'claude-code', facts: row(4).facts, codes: row(4).findings },
  'not-seen': { h: 'claude-code', facts: facts('claude-code', {}, { procs: [proc(4121), proc(4122, { watched: 'unknown', trusted: null, start: 'not-seen' })] }), codes: ['not-seen'] },
  'negative-cache': { h: 'claude-code', facts: row(6).facts, codes: row(6).findings },
  'daemon-not-running': { h: 'claude-code', facts: row(7).facts, codes: row(7).findings },
  'daemon-not-responding': { h: 'claude-code', facts: facts('claude-code', { daemon: { state: 'not-responding', pid: 4012, enginePort: 47123 } }), codes: ['daemon-not-responding'] },
  'helper-missing': { h: 'claude-code', facts: facts('claude-code', { link: { attached: null, helper: 'missing', ids: [] } }), codes: ['helper-missing'] },
  'link-missing': { h: 'claude-code', facts: facts('claude-code', { link: { attached: false, helper: 'ok', ids: [] } }), codes: ['link-missing'] },
  'entry-missing': { h: 'claude-code', facts: facts('claude-code', {}, { entry: { state: 'missing' }, procs: [] }), codes: ['entry-missing'] },
  'entry-changed': { h: 'claude-code', facts: facts('claude-code', {}, { entry: { state: 'changed' }, procs: [] }), codes: ['entry-changed'] },
  'not-routed': { h: 'codex', facts: row(11).facts, codes: row(11).findings },
  'system-proxy-pac': { h: 'codex', facts: row(22).facts, codes: row(22).findings },
  'route-loop': { h: 'codex', facts: pfacts('codex', form('codex.cli', { routeLoop: true, entry: null, procs: [proc(5530, { name: 'codex app-server' })] }), fwForm(17992)), codes: ['route-loop'] },
  'proxy-dead': { h: 'claude-code', facts: facts('claude-code', {}, viaProxy()), codes: ['proxy-dead'] }, // claude-code's HTTPS_PROXY path is measured on Linux (V54): no hint about inferred data
  'proxy-unsupported': { h: 'deepseek-dsh', facts: facts('deepseek-dsh', mihomoVia, { setting: proxyOf('socks5://127.0.0.1:7890') }), codes: ['proxy-unsupported', 'inferred-behaviour'] },
  'proxy-changed': { h: 'codex', facts: row(17).facts, codes: row(17).findings },
  'elevated-agent': { h: 'claude-code', facts: row(19).facts, codes: row(19).findings },
  'forwarder-down': { h: 'codex', facts: row(13).facts, codes: row(13).findings },
  'upstream-unreachable': { h: 'codex', facts: pfacts('codex', form('codex.cli', { setting: proxyOf('http://proxy.corp:8080'), procs: [proc(5530, { name: 'codex app-server' })] }), fwForm(17992, { upstream: 'http://proxy.corp:8080', source: 'agent', upstream_error: 'ECONNREFUSED' })), codes: ['upstream-unreachable'] },
  'shim-not-on-path': { h: 'kimi-code', facts: facts('kimi-code', {}, { procs: [proc(7001, { name: 'kimi', trusted: false, reason: 'shim-not-on-path' })] }), codes: ['shim-not-on-path'] }, // kimi's own trust reason (harness/kimi-code.mjs refine): no launch shim was installed
  'egress-differs': { h: 'codex', facts: row(9).facts, codes: row(9).findings },
  'linger-off': { h: null, facts: facts('claude-code', { linger: false }), codes: ['linger-off'] },
  'other-redirector': { h: null, facts: facts('claude-code', { otherRedirector: true }), codes: ['other-redirector'] },
  'fake-ip': { h: 'claude-code', facts: facts('claude-code', {}, { fakeIp: true }), codes: ['fake-ip'] },
  'inferred-behaviour': { h: 'hermes', facts: row(21).facts, codes: row(21).findings }, // hermes on Linux: inferred from the Windows measurements (claude-code's proxy path is measured there: V54)
  'cause-unknown': { h: 'claude-code', facts: facts('claude-code'), names: ['claude-code'], codes: ['cause-unknown'] },
  'process-unknown': { h: 'claude-code', facts: facts('claude-code', { identity: idOf('claude-code', { unknown: [{ name: 'claude-canary', wide: false, pid: 7002, door: 'claude-code.settings' }] }) }), codes: ['process-unknown'] },
  // 4.11 §3 ⑱: the issuer from the daemon's /status `cert`, the trust verdicts the proxy-mode verdict gives a process, the window's proxy the door could not recover (the forwarder form's source)
  'cert-key-missing': { h: null, facts: facts('claude-code', { cert: { key: 'missing', intermediate: 'key-missing' } }), codes: ['cert-key-missing'] },
  'cert-intermediate-unavailable': { h: null, facts: facts('claude-code', { cert: { key: 'unknown', intermediate: 'unavailable' } }), codes: ['cert-intermediate-unavailable'] },
  'not-users-file': { h: 'codex', facts: pfacts('codex', form('codex.cli', { procs: [proc(5530, { name: 'codex app-server', trusted: false, reason: 'not-users-file' })] }), fwForm(17992)), codes: ['not-users-file'] },
  'not-verified': { h: 'codex', facts: pfacts('codex', form('codex.cli', { procs: [proc(5530, { name: 'codex app-server', trusted: false, reason: 'not-verified' })] }), fwForm(17992)), codes: ['not-verified'] },
  'prior-proxy-unknown': { h: 'codex', facts: pfacts('codex', form('codex.cli', { procs: [proc(5530, { name: 'codex app-server' })] }), fwForm(17992, { source: 'unknown' })), codes: ['prior-proxy-unknown'] },
  'agent-list-invalid': { h: null, facts: facts('claude-code', { agentList: { path: LIST, state: 'ok', problems: [{ index: 1, code: 'wide-name-needs-args', detail: 'agents[1]: node is an interpreter name; add "args"' }] } }), codes: ['agent-list-invalid'] },
}
// D51③⑤ (1.6 附录 B): the name list's two findings — a state event of the door and a failure code of the harness part, both in health/codes.mjs's closed sets
const IDENTITY_CODES = ['process-unknown', 'agent-list-invalid']
const CERT_CODES = ['cert-key-missing', 'cert-intermediate-unavailable', 'not-users-file'] // 1.6 §9.7's cert group, as findings
const REFUSAL_CODES = ['collectors-online'] // a command's refusal (uninstall), rendered by findingFor, not by diagnose
const STATUS_REASONS_IN_CATALOGUE = ['config-after-start', 'daemon-not-running', 'daemon-not-responding', 'helper-missing', 'link-missing', 'entry-missing', 'entry-changed', 'desired-off', 'negative-cache', 'not-seen']

for (const [code, set] of Object.entries(SETS)) {
  test(`V49 ${code}: its facts call for exactly ${JSON.stringify([...set.codes].sort())}`, () => {
    const got = codesOf(set.facts, set.h, set.names || null)
    assert.deepEqual(got, [...set.codes].sort())
    assert.ok(got.includes(code), `${code} is among them`)
  })
}

test('V49 both directions: every code of the closed sets (§9.7 net codes, the status reasons §9.6 uses) has a fact set, and the catalogue defines no code outside them', () => {
  const closed = new Set([...NET_CODES, ...STATUS_REASONS_IN_CATALOGUE, ...IDENTITY_CODES, ...CERT_CODES])
  const EVENT_ONLY = ['netenv-changed'] // D49: the system-proxy watcher's event code, not a finding: diagnose never gives it
  for (const code of closed) if (!EVENT_ONLY.includes(code) && !(TRUST_REASONS.includes(code) && !FINDINGS[code])) assert.ok(SETS[code], `${code} has a fact set`)
  for (const code of ['opt-in-needed', 'needs-admin', 'not-via-entry']) assert.ok(!closed.has(code) && !FINDINGS[code] && !FINDINGS_WIN32[code], `${code} went with named items (D57, 4.11 §3 ⑱)`)
  for (const code of EVENT_ONLY) assert.ok(!FINDINGS[code] && !SETS[code], `${code} is no finding`)
  for (const code of Object.keys(FINDINGS)) assert.ok(closed.has(code) || TRUST_REASONS.includes(code) || REFUSAL_CODES.includes(code), `${code} is in a closed set`)
  assert.deepEqual(Object.keys(SETS).filter((c) => !closed.has(c)), [], 'and no fact set is for a code nobody defined')
})

// The Windows half (1.6 §9.7 / 4.8 §10.4): its codes are in the closed sets too — the net codes, the status reasons (which already hold form-unsupported),
// the route codes (engine-port-taken, forwarder-start-failed, forwarder-binary-missing, forwarder-digest-mismatch, forwarder-download-failed, socktable-unavailable) and the trust reasons — and FINDING_CODES, what
// schema.mjs checks a finding against, is exactly the union of the two catalogues and the trust reasons (the literal per-row shape of FINDINGS_WIN32 is held by topology-win32.test.mjs, W36).
test('V49 both directions, the Windows half: FINDINGS_WIN32 defines no code outside the closed sets (net codes, status reasons, route codes, trust reasons), and FINDING_CODES is exactly FINDINGS ∪ FINDINGS_WIN32 ∪ the trust reasons (the Windows collector\'s own trust reasons included)', () => {
  const closed = new Set([...NET_CODES, ...STATUS_REASONS, ...ROUTE_CODES, ...TRUST_REASONS])
  assert.ok(Object.keys(FINDINGS_WIN32).length === 14, 'the §10.4 rows (held row-by-row by topology-win32.test.mjs; the forwarder-* family retired with the kernel, D47 twin)')
  for (const code of Object.keys(FINDINGS_WIN32)) assert.ok(closed.has(code), `${code} is in a closed set`)
  assert.deepEqual([...FINDING_CODES].sort(), [...new Set([...Object.keys(FINDINGS), ...Object.keys(FINDINGS_WIN32), ...TRUST_REASONS, ...ROUTE_TRUST_REASONS])].sort(), 'the union, nothing defined that the doctor cannot name')
})

// The proxy mode's own trust reason (ROUTE_TRUST_REASONS: `smart-app-control`, 4.11 ⑯ · ⑱) is a status reason and a finding inside the code list the schema checks;
// a throwing `make` would take `doctor` down with the state.
test('V49 the proxy mode\'s own trust reasons are findings and status reasons the schema accepts (smart-app-control, 4.11 ⑯)', () => {
  const F = pfacts('kimi-code', form('kimi-code.cli', { procs: [proc(8121, { trusted: false, reason: 'smart-app-control', hint: 'Smart App Control is on, so install placed no wrapper' })] }), fwForm(17993))
  const t = buildTopology(F)['kimi-code']
  assert.equal(t.reason, 'smart-app-control', 'the branch carries the verdict (judgeHarness passes an untrusted proc\'s reason through)')
  assert.deepEqual(validateTopology({ 'kimi-code': t }), [], 'and the schema knows it as a status reason')
  const found = diagnose({ facts: F, topology: { 'kimi-code': t }, harnesses: ['kimi-code'], user: 'u' }).find((f) => f.code === 'smart-app-control')
  assert.ok(found, 'the finding exists (the trust entry renders it)')
  assert.equal(found.class, 'problem')
  assert.match(found.what, /kimi-code is not captured/)
  assert.match(found.why, /Smart App Control is on/, 'the reason is named: the daemon\'s own hint')
  assert.deepEqual(validateFinding(found), [], 'the schema accepts it')
})

test('V49 every trust reason is a finding (the restart ones expected, the rest failures), says what and why, and gives a command', () => {
  for (const reason of TRUST_REASONS) {
    const f = facts('claude-code', {}, { procs: [proc(4121, { watched: 'no-decrypt', trusted: false, reason, hint: reason === 'var-missing' ? 'the NODE_EXTRA_CA_CERTS variable is not set' : undefined })] })
    const found = findingsOf(f).filter((x) => x.code === reason)
    assert.equal(found.length, 1, reason)
    const restart = ['config-after-start', 'env-frozen', 'start-time-unknown', 'no-marker', 'kimi-not-via-shim'].includes(reason)
    if (!FINDINGS[reason]) assert.equal(found[0].class, restart ? 'expected' : 'problem', reason)
    else assert.equal(found[0].class, typeof FINDINGS[reason].cls === 'string' ? FINDINGS[reason].cls : found[0].class, `${reason}: its own catalogue entry decides the class (not-verified is expected, 1.6 附录 B)`)
    assert.deepEqual(validateFinding(found[0]), [], reason)
  }
})

test('V49 each finding: what, why and verify say something; a problem or an expected finding has a command (a note may have none); the commands are whole lines with no <…> left; trocar\'s own come first where the catalogue says so; it validates', () => {
  const all = [...Object.values(SETS), ...TRUST_REASONS.map((r) => ({ facts: facts('claude-code', {}, { procs: [proc(4121, { watched: 'no-decrypt', trusted: false, reason: r })] }) }))]
  const seen = new Set()
  for (const s of all) for (const f of findingsOf(s.facts, s.names || null)) {
    const at = `${f.code} (${f.class})`
    assert.deepEqual(validateFinding(f), [], at)
    assert.ok(f.what && f.why && f.verify, at)
    if (f.class !== 'note') assert.ok(f.commands.length >= 1, at)
    for (const c of f.commands) assert.ok(!/<[^>]+>/.test(c.run) && ['sh', 'powershell', 'gui'].includes(c.shell), `${at}: ${c.run}`)
    if (FINDINGS[f.code] && FINDINGS[f.code].trocarFirst && f.commands.some((c) => c.shell !== 'gui')) assert.ok(f.commands[0].run.startsWith('trocar ') || f.commands.find((c) => c.shell !== 'gui').run.startsWith('trocar '), `${at}: the first command that is not a step in an application is trocar's`)
    if (FINDINGS[f.code] && f.class === 'problem' && !FINDINGS[f.code].trocarFirst) assert.ok(f.commands.length >= 1)
    seen.add(f.code)
  }
  for (const code of Object.keys(FINDINGS)) if (!REFUSAL_CODES.includes(code)) assert.ok(seen.has(code), `${code} was produced by some fact set`)
  assert.ok(FINDING_CODES.length >= Object.keys(FINDINGS).length)
})

test('V49 the commands are filled with the values of the facts: the port to look at, the user name, the file and the line of the setting, the elevated line of an opt-in; a value that cannot be read says why', () => {
  const dead = findingsOf(SETS['proxy-dead'].facts).find((f) => f.code === 'proxy-dead')
  assert.deepEqual(dead.commands.map((c) => [c.shell, c.run]).filter(([s]) => s === 'sh'), [['sh', "ss -ltnp 'sport = :7890'"]])
  assert.match(dead.what, /127\.0\.0\.1:7890/)
  assert.ok(dead.commands.some((c) => c.shell === 'gui' && /HTTPS_PROXY/.test(c.run)), 'the line of the setting to remove')
  const win = findingsOf({ ...SETS['proxy-dead'].facts, platform: 'win32' }).find((f) => f.code === 'proxy-dead')
  assert.ok(win.commands.some((c) => c.shell === 'powershell' && c.run === 'netstat -ano -p TCP | findstr ":7890"'))
  assert.equal(findingsOf(SETS['linger-off'].facts)[0].commands[0].run, 'loginctl enable-linger alice')
  const nameless = diagnose({ facts: SETS['linger-off'].facts, topology: buildTopology(SETS['linger-off'].facts), harnesses: null, user: null })[0]
  assert.equal(nameless.commands[0].run, 'loginctl enable-linger "$(id -un)"', 'a name that is not known is read by the shell, not left as a placeholder')
  const pac = findingsOf(SETS['not-routed'].facts).find((f) => f.code === 'not-routed')
  assert.ok(pac.commands.some((c) => c.run.includes('unknown proxy address (pac)')), 'the PAC\'s address is not known: said, not guessed')
  const bpf = findingsOf(SETS['other-redirector'].facts)[0]
  assert.equal(bpf.commands[0].run, 'sudo bpftool cgroup tree /sys/fs/cgroup', 'printed for the user; doctor never runs it')
})

test('V49 `doctor <harness>` reports that harness only; with no name, all of them and the machine\'s', () => {
  const f = facts('claude-code', { linger: false, desired: { 'claude-code': 'on', codex: 'off' } }, { entry: { state: 'missing' }, procs: [] })
  f.harnesses.codex = { ...f.harnesses['claude-code'] }
  const T = buildTopology(f)
  const named = diagnose({ facts: f, topology: T, harnesses: ['codex'] })
  assert.ok(named.length > 0 && named.every((x) => x.harness === 'codex'), 'only codex, and nothing of the machine\'s')
  const all = diagnose({ facts: f, topology: T, harnesses: null })
  assert.deepEqual([...new Set(all.map((x) => x.harness))].sort(), [undefined, 'claude-code', 'codex'].sort())
  assert.ok(all.some((x) => x.code === 'linger-off' && !x.harness))
})

test('V51 a harness the user names with nothing in the facts to explain it: `cause-unknown` — a note, worded as a condition (`If … still cannot connect`: trocar has no fact that says it cannot connect), the first command `trocar off <harness>`, the text `if it still fails, trocar is not the cause`; never labelled a problem on a harness that is captured', () => {
  const f = facts('claude-code') // on, steered, trusted: captured, nothing wrong that trocar can read
  const found = findingsOf(f, ['claude-code']).find((x) => x.code === 'cause-unknown')
  assert.equal(found.class, 'note', 'trocar cannot say that it fails to connect: it is not a problem')
  assert.match(found.what, /^If claude-code still cannot connect: /, 'a condition, not a statement')
  assert.equal(found.commands[0].run, 'trocar off claude-code')
  const text = renderFindings([found]).join('\n')
  assert.ok(text.includes('if it still fails, trocar is not the cause'))
  assert.doesNotMatch(text, /^\d+\. /m, 'a note is not numbered among the problems')
  assert.match(text, /^Note: If claude-code still cannot connect: /)
  assert.match(found.verify, /Try claude-code again/)
  assert.deepEqual(validateFinding(found), [])
  // it comes after every other finding: it is what is left when nothing above explains
  const withHints = findingsOf(row(21).facts, ['hermes']).map((x) => x.code)
  assert.deepEqual(withHints, ['inferred-behaviour', 'cause-unknown'], 'a note about the data does not explain a failure to connect: both are said, the condition last')
  assert.deepEqual(findingsOf(row(2).facts, ['claude-code']).map((x) => x.code), ['cause-unknown'], 'claude-code behind a proxy of its own on Linux: its behaviour was measured (V54), so there is no hint about inferred data')
})

test('V51 what explains the harness is not repeated by it: a problem or an expected finding for the harness (not on the path, off, a daemon that is down, a process that started before `on`) means no cause-unknown; nor for a harness that is off, one that is not named, or one that is not installed', () => {
  const explained = (f, h = 'claude-code') => findingsOf(f, [h]).some((x) => x.code === 'cause-unknown')
  assert.equal(explained(SETS['daemon-not-running'].facts), false, 'a problem that explains it')
  assert.equal(explained(row(5).facts), false, 'an expected finding (it started before `on`: config-after-start) explains why it is not captured')
  assert.equal(explained(row(4).facts), false, 'off: the finding is that it is off')
  assert.equal(explained(row(17).facts, 'codex'), false, 'proxy mode, the proxy was changed: it explains it')
  assert.equal(explained(facts('claude-code', {}, { installed: false })), false, 'not installed: nothing to connect')
  assert.equal(explained(facts('claude-code', { desired: { 'claude-code': 'off' } })), false)
  assert.ok(!findingsOf(facts('claude-code'), null).some((x) => x.code === 'cause-unknown'), 'it answers a symptom somebody named')
  assert.equal(explained(facts('claude-code')), true, 'and nothing explains a healthy one the user named')
})

test('V49 where the harness keeps its settings in a managed process its windows do not end (Codex\'s app-server), the restart is the harness\'s step and then `kill <pid>` with the pid the facts hold — not a TUI\'s pid, and nothing for a harness with no such process; on Windows `Stop-Process`', () => {
  const BEFORE = '2026-10-07T08:00:00.000Z'
  const stale = { startedAt: BEFORE, watched: 'no-decrypt', trusted: false, reason: 'config-after-start' }
  const cx = (over = {}) => facts('codex', {}, { procs: [proc(5521, { ...stale, name: 'codex' }), proc(5530, { ...stale, name: 'codex app-server' })], ...over })
  const steps = (f, code = 'config-after-start') => findingsOf(f, ['codex']).find((x) => x.code === code).commands
  const c = steps(cx())
  assert.deepEqual(c.map((x) => x.shell), ['gui', 'sh'])
  assert.ok(c[0].run.startsWith('Quit every codex window'), 'the harness\'s own step first')
  assert.deepEqual(c[1], { run: 'kill 5530', shell: 'sh' })
  assert.deepEqual(steps({ ...cx(), platform: 'win32' })[1], { run: 'Stop-Process -Id 5530', shell: 'powershell' })
  assert.deepEqual(steps(facts('codex', {}, { procs: [proc(5521, { ...stale, name: 'codex' })] })).map((x) => x.shell), ['gui'], 'the managed process is not running: nothing to end')
  const cc = findingsOf(facts('claude-code', {}, { procs: [proc(4121, stale)] }), ['claude-code']).find((x) => x.code === 'config-after-start').commands
  assert.deepEqual(cc.map((x) => x.shell), ['gui'], 'a harness with no managed process: the step alone')
  const neg = steps(facts('codex', { listeners: [] }, { procs: [proc(5530, { name: 'codex app-server', negative: true })], negatives: [{ pid: 5530, host: 'chatgpt.com', reason: 'negative-cache' }] }), 'negative-cache')
  assert.ok(neg.some((x) => x.run === 'kill 5530'), 'a negative cache lasts as long as the process: ending it is the way out')
  // 1.6 附录 B: only a refused trocar certificate is fixed by a restart; an upstream's certificate or handshake is not
  const byCause = (cause) => findingsOf(facts('codex', { listeners: [] }, { procs: [proc(5530, { name: 'codex app-server', negative: true })], negatives: [{ pid: 5530, host: 'chatgpt.com', reason: 'negative-cache', cause }] }), ['codex']).find((x) => x.code === 'negative-cache')
  for (const cause of ['upstream-cert', 'upstream-handshake']) {
    const f = byCause(cause)
    assert.ok(f.commands.length && !f.commands.some((x) => x.run === 'kill 5530' || x.run.startsWith('Quit every')), `${cause}: ${JSON.stringify(f.commands)}`)
    assert.notEqual(f.what, byCause('client-rejected-leaf').what, cause)
  }
})

test('V47 (a) / V49 proxy-changed in driver mode: the harness is still steered, so it is `expected` and the one command only looks (附录 B: 「重启后自己生效,不用改东西」); in proxy mode the same drift is a problem whose first command is `trocar on <h>`', () => {
  const rec = { at: 'T', routing: 'driver', chain: 'c', source: [SRC_F1], sha256: 'sha-http://proxy.old:3128', file_sha256: 'sha-http://proxy.old:3128', proxy: 'http://proxy.old:3128', vpn: null }
  const changed = proxyOf('http://proxy.new:3128', [SRC_F1])
  const f = facts('claude-code', { listeners: [], vpn: null }, { setting: changed, fileSetting: changed, adopted: rec, behaviour: behaviourOf('claude-code', CC_FILES) })
  const found = findingsOf(f, ['claude-code']).find((x) => x.code === 'proxy-changed')
  assert.ok(found, 'the file now holds another proxy than `on` found: the finding is there')
  assert.equal(found.class, 'expected')
  assert.deepEqual(found.commands, [{ run: 'trocar status claude-code', shell: 'sh' }], '附录 B: driver mode gets `trocar status <harness>` — nothing to change')
  assert.ok(!found.commands.some((c) => /^trocar (on|off) /.test(c.run)), 'nothing that changes anything')
  assert.match(found.verify, /trocar status claude-code/)
  assert.deepEqual(validateFinding(found), [])
  assert.ok(!findingsOf({ ...f, harnesses: { 'claude-code': { ...f.harnesses['claude-code'], adopted: { ...rec, file_sha256: changed.sha256, sha256: changed.sha256 } } } }, ['claude-code']).some((x) => x.code === 'proxy-changed'), 'the same setting as `on` found: no finding')
  const proxyMode = findingsOf(row(17).facts, ['codex']).find((x) => x.code === 'proxy-changed')
  assert.equal(proxyMode.class, 'problem')
  assert.equal(proxyMode.commands[0].run, 'trocar on codex')
})

test('renderFindings (§3.7): a problem is numbered, a note says `Note:`, what then why, each command on a line of its own after `Fix`, then `Check`, inside 80 columns', () => {
  const lines = renderFindings(findingsOf({ ...SETS['proxy-dead'].facts, platform: 'win32' }).filter((f) => f.code === 'proxy-dead'))
  assert.match(lines[0], /^1\. Nothing is listening on 127\.0\.0\.1:7890, the proxy claude-code is set to use\.$/)
  assert.match(lines[1], /^ {3}Your proxy is not running; trocar did not write this setting\.$/)
  assert.ok(lines.some((l) => l === '   Fix    netstat -ano -p TCP | findstr ":7890"'), lines.join('\n'))
  assert.ok(lines.some((l) => /^ {10}Start your proxy, so that it listens on 127\.0\.0\.1:7890$/.test(l)), 'the step in an application is a line of its own')
  assert.match(lines[lines.length - 1], /^ {3}Check {2}trocar status claude-code$/)
  assert.ok(lines.every((l) => l.length <= 80), lines.join('\n'))
})

test('§3.7: a note carries no `Fix` (it is not a problem), and one fact several harnesses share is one line that names them', () => {
  const note = (h, code = 'inferred-behaviour') => ({ code, class: 'note', harness: h, what: `${h}'s proxy behaviour on this platform is inferred, not measured.`, why: 'It was measured on another platform.', commands: [], verify: 'trocar status' })
  const lines = renderFindings([note('claude-code'), note('codex'), note('hermes'), note('z-code')])
  assert.equal(lines.filter((l) => l.startsWith('Note: ')).length, 1, `the same fact is one line:\n${lines.join('\n')}`)
  assert.match(lines[0], /^Note: claude-code, codex, hermes and z-code's proxy behaviour /)
  // a note that says what you may do about it labels it an Option, never a Fix — a Fix under "no problems" is a contradiction
  const withCmd = renderFindings([{ ...note('codex', 'egress-differs'), what: 'Some of codex\'s connections now leave through a different hop.', commands: [{ run: 'trocar off codex', shell: 'sh' }] }])
  assert.ok(withCmd.some((l) => l === '      Option trocar off codex'), withCmd.join('\n'))
  assert.ok(!withCmd.some((l) => /\bFix\b/.test(l)), withCmd.join('\n'))
  // and a note about one harness, with something to do about it, is not folded with another harness's
  const two = renderFindings([{ ...note('codex', 'egress-differs'), commands: [{ run: 'trocar off codex', shell: 'sh' }] }, { ...note('hermes', 'egress-differs'), commands: [{ run: 'trocar off hermes', shell: 'sh' }] }])
  assert.equal(two.filter((l) => l.startsWith('Note: ')).length, 2)
})

// B3 (the mac machine 2026-10-19): the live codex processes were the VS Code extension's app-servers, and the restart step printed was the CLI's
// ("end the managed codex app-server process"). The steps come from the form the process runs from (its `paths`), as data in the descriptor.
test('V49 the restart steps come from the form the process belongs to (the descriptor\'s per-form restart), not one fixed sentence', async () => {
  const descs = await loadHarnesses()
  const codex = descs.find((d) => d.name === 'codex')
  const byForm = Object.fromEntries(codex.proxyMode.forms.map((f) => [f.id, f.restart || null]))
  assert.ok(byForm['codex.vscode'] && byForm['codex.vscode'].hint, 'the descriptor carries the VS Code form\'s own words')
  const EXT = '/h/.vscode/extensions/openai.chatgpt-0.5.17'
  const at = (exe, paths, id) => {
    const fm = form(id, { paths, procs: [proc(5530, { name: 'codex app-server', exe })] })
    const f = pfacts('codex', fm, fwForm(17992), { platform: 'darwin' })
    f.harnesses.codex.forms[0].restart = byForm[id]
    f.harnesses.codex.procs[0].reason = 'config-after-start'
    f.harnesses.codex.procs[0].trusted = false
    f.harnesses.codex.procs[0].hint = null
    const fd = findingsOf(f).find((x) => x.code === 'config-after-start')
    return { fd, text: fd ? fd.commands.map((c) => c.run).join('\n') : '' }
  }
  const ext = at(`${EXT}/bin/macos-aarch64/codex`, [EXT], 'codex.vscode')
  assert.ok(ext.fd, 'the process started before capture was on: config-after-start')
  assert.match(ext.text, /Reload Window/, 'the extension\'s own step')
  assert.doesNotMatch(ext.text, /kill |Quit every codex window/, 'not the CLI\'s step for a process the user cannot quit')
  const cli = at('/h/.local/bin/codex', ['/h/.local/bin/codex'], 'codex.cli')
  assert.match(cli.text, /Quit every codex window[\s\S]*kill 5530/, 'the CLI form keeps the harness\'s own step, with the managed process')
  // the why names what was written after the process started, not only the certificate
  assert.doesNotMatch(ext.fd.why, /trust entry/)
})

// ── where the line to edit is (V49): the setting's own source, not the first key of the first file ────────────────────────────────────────────────────────────────────────────────────────────────────
const CC_FILES = [{ path: '/h/.claude/settings.json', format: 'json', key: 'env.HTTPS_PROXY' }, { path: '/h/.claude.json', format: 'json', key: 'env.HTTPS_PROXY' }]
const CODEX_FILES = [{ path: '/h/.codex/.env', format: 'dotenv', key: 'HTTPS_PROXY' }, { path: '/h/.codex/config.toml', format: 'dotenv', key: 'x' }]
const behaviourOf = (h, fileKeys, over = {}) => ({ ...facts(h).harnesses[h].behaviour, env: h === 'codex' ? ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY'] : ['HTTPS_PROXY', 'https_proxy'], fileKeys, ...over })
const SRC_ENV = { kind: 'env', where: 'HTTPS_PROXY' }
const SRC_F1 = { kind: 'file', where: '/h/.claude/settings.json', key: 'env.HTTPS_PROXY' }
const SRC_F2 = { kind: 'file', where: '/h/.claude.json', key: 'env.https_proxy' }
const gui = (fs, code) => fs.find((f) => f.code === code).commands.filter((c) => c.shell === 'gui').map((c) => c.run).join('\n')
const deadFacts = (source) => facts('claude-code', {}, { setting: proxyOf('http://127.0.0.1:7890', [source]), behaviour: behaviourOf('claude-code', CC_FILES) })

test('V49 the place a command names for the setting is where the setting came from (its `source`): the shell\'s variable is `unset` in the shell, a value from the second file names the second file and the key that held it — and a step reads as one sentence', () => {
  const at = (source) => gui(findingsOf(deadFacts(source)), 'proxy-dead')
  assert.match(at(SRC_ENV), /In the terminal that starts claude-code, run: unset HTTPS_PROXY/)
  assert.doesNotMatch(at(SRC_ENV), /settings\.json|\.claude\.json/, 'the setting is not in a file')
  assert.match(at(SRC_F1), /Remove env\.HTTPS_PROXY from \/h\/\.claude\/settings\.json/)
  assert.doesNotMatch(at(SRC_F1), /\.claude\.json/)
  assert.match(at(SRC_F2), /Remove env\.https_proxy from \/h\/\.claude\.json/, 'the second file, and the key that really held it')
  assert.doesNotMatch(at(SRC_F2), /settings\.json/)
  for (const source of [SRC_ENV, SRC_F1, SRC_F2]) {
    const text = at(source)
    assert.doesNotMatch(text, /Remove[^\n]*\bSet\b|Set [^\n]*\bRemove\b/, 'one verb for one step')
    assert.match(text, /^(Remove |In the terminal that starts claude-code, run: unset )/m, 'the step that takes the setting away is there')
  }
  // a dotenv file: the line is `KEY=`
  const codex = facts('codex', { listeners: [] }, { setting: proxyOf('http://127.0.0.1:7890', [{ kind: 'file', where: '/h/.codex/.env', key: 'HTTPS_PROXY' }]), behaviour: behaviourOf('codex', CODEX_FILES) })
  assert.match(gui(findingsOf(codex), 'proxy-dead'), /Remove the HTTPS_PROXY= line from \/h\/\.codex\/\.env/)
  assert.doesNotMatch(gui(findingsOf(codex), 'proxy-dead'), /config\.toml/)
})

// B2 (the mac machine 2026-10-19): trocar's door is on the path, the user's own proxy at its upstream has quit, and BOTH spellings of their key still name it.
// The finding is upstream-unreachable, and the places it asks the user to clear are their own keys only — the key trocar wrote holds the door (removing it
// changes nothing: `off` writes the prior value back).
test('V49 upstream-unreachable: trocar on the path with a dead upstream is not proxy-dead; its places are the user\'s own keys that hold that address, never the key trocar wrote', () => {
  const SET = '/h/.claude/settings.json'
  const place = (key) => ({ kind: 'file', path: SET, key, format: 'json', scheme: 'http', host: '127.0.0.1', port: 7897 })
  const fm = form('claude-code.cli', { entry: { where: `${SET}#env.HTTPS_PROXY`, trocar: true, opt_in: false, intact: true },
    setting: proxyOf('http://127.0.0.1:7897', [{ kind: 'file', where: SET, key: 'env.HTTPS_PROXY' }]), procs: [proc(4121)] })
  const f = pfacts('claude-code', fm, fwForm(17991, { upstream: 'http://127.0.0.1:7897', source: 'config-prior' }), { listeners: [], platform: 'darwin' })
  f.harnesses['claude-code'].proxyPlaces = [place('env.HTTPS_PROXY'), place('env.HTTP_PROXY')]
  f.harnesses['claude-code'].writtenPlaces = [`${SET}#env.HTTPS_PROXY`]
  const out = findingsOf(f)
  const codes = out.map((x) => x.code)
  assert.ok(codes.includes('upstream-unreachable'), codes.join(','))
  assert.ok(!codes.includes('proxy-dead'), 'the dead hop is trocar\'s upstream, not a proxy the agent points at')
  const u = out.find((x) => x.code === 'upstream-unreachable')
  assert.deepEqual(u.places, [place('env.HTTP_PROXY')], 'the user\'s own key alone')
  assert.deepEqual(validateFinding(u), [])
  const text = u.commands.map((c) => c.run).join('\n')
  assert.match(text, /Remove env\.HTTP_PROXY from \/h\/\.claude\/settings\.json/)
  assert.doesNotMatch(text, /HTTPS_PROXY/, 'the key trocar wrote is never named as one for the user to remove')
  assert.match(text, /trocar off claude-code[\s\S]*trocar on claude-code/, 'off, clear your own keys, on')
})

test('V49 upstream-unreachable, codex\'s dotenv route through the REAL writers: the user\'s own line in $CODEX_HOME/.env is a place, the line trocar\'s block wrote is not', async () => {
  const desc = (await loadHarnesses()).find((d) => d.name === 'codex')
  const w = world({ os: 'darwin' })
  for (const fo of desc.proxyMode.forms.filter((x) => x.os.includes('darwin') && x.route === 'env')) w.present(fo)
  const envFile = desc.proxy.files[0].path({ home: w.home, env: {} })
  put(envFile, 'HTTPS_PROXY=http://127.0.0.1:7897\n')
  const res = writeRoutes(desc, w.ctx, () => 'http://127.0.0.1:17991')
  assert.deepEqual(res.results.map((x) => [x.route, x.ok]), [['env', true]])
  const places = proxyPlaces(desc, { home: w.home, env: {}, fs })
  const written = writtenPlaces(w.ctx.manifest, 'codex')
  const fm = form('codex.cli', { entry: { where: `${envFile}#HTTPS_PROXY`, trocar: true, opt_in: false, intact: true }, setting: proxyOf('http://127.0.0.1:17991', [{ kind: 'file', where: envFile, key: 'HTTPS_PROXY' }]), procs: [proc(5530, { name: 'codex app-server' })] })
  const f = pfacts('codex', fm, fwForm(17991, { upstream: 'http://127.0.0.1:7897', source: 'config-prior' }), { listeners: [{ addr: '127.0.0.1', port: 17991, pid: 6120, exe: 'trocar-engine' }], platform: 'darwin' })
  Object.assign(f.harnesses.codex, { proxyPlaces: places, writtenPlaces: written })
  const u = findingsOf(f).find((x) => x.code === 'upstream-unreachable')
  assert.ok(u, 'the dead hop is trocar\'s upstream')
  assert.deepEqual(u.places, [{ kind: 'file', path: envFile, key: 'HTTPS_PROXY', format: 'dotenv', scheme: 'http', host: '127.0.0.1', port: 7897 }], 'the user\'s own line, which `off` puts back')
  assert.deepEqual(validateFinding(u), [])
  assert.match(u.commands.map((c) => c.run).join('\n'), new RegExp(`Remove the HTTPS_PROXY= line from ${envFile.replace(/[.\\/]/g, '\\$&')}`))
  assert.equal(places.some((p) => p.port === 17991), false, 'trocar\'s own block is no place of the user\'s')
})

test('V49 / 4.8 §10.4 on Windows: proxy-dead and upstream-unreachable name the user\'s own places too, one step per place', () => {
  const SET = 'C:\\Users\\u\\.claude\\settings.json'
  const place = (key) => ({ kind: 'file', path: SET, key, format: 'json', scheme: 'http', host: '127.0.0.1', port: 7897 })
  const fm = form('claude-code.cli', { entry: { where: `${SET}#env.HTTPS_PROXY`, trocar: true, opt_in: false, intact: true },
    setting: proxyOf('http://127.0.0.1:7897', [{ kind: 'file', where: SET, key: 'env.HTTPS_PROXY' }]), procs: [proc(4121)] })
  const f = pfacts('claude-code', fm, fwForm(17991, { upstream: 'http://127.0.0.1:7897', source: 'config-prior' }), { listeners: [] })
  Object.assign(f.harnesses['claude-code'], { proxyPlaces: [place('env.HTTPS_PROXY'), place('env.HTTP_PROXY')], writtenPlaces: [`${SET}#env.HTTPS_PROXY`] })
  // trocar on the path with the dead address as its upstream (upstream-unreachable), and trocar nowhere near it (proxy-dead)
  const dead = facts('claude-code', { platform: 'win32', listeners: [] }, { setting: proxyOf('http://127.0.0.1:7897', [{ kind: 'file', where: SET, key: 'env.HTTPS_PROXY' }]) })
  Object.assign(dead.harnesses['claude-code'], { proxyPlaces: [place('env.HTTP_PROXY')], writtenPlaces: [] })
  for (const [code, facts_] of [['upstream-unreachable', f], ['proxy-dead', dead]]) {
    const x = findingsOf(facts_).find((y) => y.code === code)
    assert.ok(x, `${code}: ${findingsOf(facts_).map((y) => y.code).join(',')}`)
    assert.deepEqual(x.places, [place('env.HTTP_PROXY')], `${code}: the user's own key alone`)
    const text = x.commands.map((cc) => cc.run).join('\n')
    assert.match(text, /Remove env\.HTTP_PROXY from C:\\Users\\u\\\.claude\\settings\.json/, `${code} names the place`)
    assert.doesNotMatch(text, /HTTPS_PROXY/, `${code} never names the key trocar wrote`)
  }
})

test('V49 proxy-unsupported names the place of the setting and the value to put there, as one sentence (no 「http://…:」 left stuck to the next phrase)', () => {
  const dsh = (source) => facts('deepseek-dsh', { listeners: [MIHOMO], vpn: mihomoVpn() }, { setting: proxyOf('socks5://127.0.0.1:7890', [source]), behaviour: behaviourOf('deepseek-dsh', [{ path: '/h/.dsh/config.json', format: 'json', key: 'proxy' }], { unsupported: { socks5: 'silent-direct' }, schemes: ['http', 'https'] }) })
  const env = gui(findingsOf(dsh(SRC_ENV)), 'proxy-unsupported')
  assert.match(env, /export HTTPS_PROXY=http:\/\/127\.0\.0\.1:7890/)
  assert.doesNotMatch(env, /\.dsh\/config\.json/, 'not the first file of the descriptor: the setting came from the shell')
  const file = gui(findingsOf(dsh({ kind: 'file', where: '/h/.dsh/config.json', key: 'proxy' })), 'proxy-unsupported')
  assert.match(file, /Set proxy in \/h\/\.dsh\/config\.json to "http:\/\/127\.0\.0\.1:7890"/)
  for (const t of [env, file]) assert.doesNotMatch(t, /…:/, 'no garble')
})

test('V49 route-loop names where the setting that loops lives; a harness with no setting of its own gets the place a new one goes (the first file it reads, else the variable it reads)', () => {
  const loop = (setting, behaviour) => pfacts('codex', form('codex.cli', { routeLoop: true, entry: null, setting, procs: [proc(5530, { name: 'codex app-server' })] }), fwForm(17992), {})
  const f = loop(proxyOf('http://127.0.0.1:17992', [{ kind: 'file', where: '/h/.codex/.env', key: 'HTTPS_PROXY' }]))
  f.harnesses.codex.behaviour = behaviourOf('codex', CODEX_FILES, { measured: 'lab' })
  assert.match(gui(findingsOf(f), 'route-loop'), /Put the line HTTPS_PROXY=.* in \/h\/\.codex\/\.env/)
  const g = loop(proxyOf('http://127.0.0.1:17992', [SRC_ENV]))
  g.harnesses.codex.behaviour = behaviourOf('codex', CODEX_FILES, { measured: 'lab' })
  assert.match(gui(findingsOf(g), 'route-loop'), /export HTTPS_PROXY=/)
  assert.doesNotMatch(gui(findingsOf(g), 'route-loop'), /\.codex\/\.env/)
  // a loop with no source of its own: the place comes from the behaviour — the first file it reads, else the variable it reads (not always HTTPS_PROXY)
  const nosrc = loop(proxyOf('http://127.0.0.1:17992', []))
  nosrc.harnesses.codex.behaviour = behaviourOf('codex', [], { measured: 'lab', env: ['ZCODE_HTTP_PROXY'] })
  assert.match(gui(findingsOf(nosrc), 'route-loop'), /export ZCODE_HTTP_PROXY=/)
  const nosrcFile = loop(proxyOf('http://127.0.0.1:17992', []))
  nosrcFile.harnesses.codex.behaviour = behaviourOf('codex', CODEX_FILES, { measured: 'lab' })
  assert.match(gui(findingsOf(nosrcFile), 'route-loop'), /Put the line HTTPS_PROXY=.* in \/h\/\.codex\/\.env/)
  // no setting: the PAC step of not-routed says where a new one goes — on Windows from the entry place the facts carry (gatherWin32Facts fills it for every form; the hand-built form models the real one)
  const pac = ROWS.find((r) => r.n === 11).facts
  pac.harnesses.codex.behaviour = behaviourOf('codex', CODEX_FILES, { measured: 'lab' })
  pac.harnesses.codex.forms[0].entryPlace = { kind: 'file', file: '/h/.codex/.env', format: 'dotenv', key: 'HTTPS_PROXY' }
  assert.match(gui(findingsOf(pac), 'not-routed'), /Put the line HTTPS_PROXY=.* in \/h\/\.codex\/\.env/)
})

test('V49 end to end, with the real descriptors: a proxy that came from the invoking shell\'s HTTPS_PROXY is `unset` there and no file is named; one from ~/.claude.json names that file', async () => {
  const descs = await loadHarnesses()
  const s = await installedViaCli({ status: { engine: { port: 47123 } } })
  const deps = { netFactsDeps: async () => ({ harnesses: descs, archFacts: linuxNetFacts }) }
  const SRC = path.join(os.tmpdir(), 'none')
  const base = s.ctx().env
  const dead = async (env) => {
    const r = await s.run(['doctor', 'claude-code', '--json'], { env: { ...base, ...env, TROCAR_SOURCE: SRC }, deps })
    const f = r.io.json().findings.find((x) => x.code === 'proxy-dead')
    return { f, text: f ? f.commands.filter((c) => c.shell === 'gui').map((c) => c.run).join('\n') : '' }
  }
  const fromShell = await dead({ HTTPS_PROXY: 'http://127.0.0.1:7890' })
  assert.ok(fromShell.f, 'nobody listens on 7890: proxy-dead')
  assert.match(fromShell.text, /unset HTTPS_PROXY/)
  assert.doesNotMatch(fromShell.text, /settings\.json|\.claude\.json/)
  const second = path.join(s.home, '.claude.json')
  fs.writeFileSync(second, `${JSON.stringify({ env: { HTTPS_PROXY: 'http://127.0.0.1:7890' } })}\n`)
  const fromFile = await dead({})
  assert.ok(fromFile.text.includes(`Remove env.HTTPS_PROXY from ${second}`), fromFile.text)
  assert.ok(!fromFile.text.includes('settings.json'))
})

// ── V66 (D51③⑤, G5): the line process-unknown gives closes the loop — written into a sandbox agents.json, the same facts are claimed by that harness ────────────────
test('V66 process-unknown: its line, written into agents.json, makes the registry claim the same process for that harness; a WIDE name gets no such line; agent-list-invalid has its code, the file and the item', async () => {
  const home = tmpDir('trocar-v66-')
  const list = path.join(home, '.trocar', 'agents.json')
  const F = facts('claude-code', { agentList: { path: list, state: 'absent', problems: [] }, identity: { 'claude-code': { ...idOf('claude-code')['claude-code'], unknown: [{ name: 'claude-canary', wide: false, pid: 7002, door: 'claude-code.settings' }, { name: 'python', wide: true, pid: 7003, door: 'claude-code.settings' }] } } })
  const found = findingsOf(F).filter((x) => x.code === 'process-unknown')
  assert.equal(found.length, 2, 'one finding per name')
  for (const f of found) { assert.equal(f.class, 'note'); assert.deepEqual(validateFinding(f), [], f.what); assert.equal(f.verify, 'trocar status claude-code') }
  const [named, wide] = [found.find((f) => /claude-canary/.test(f.what)), found.find((f) => /python/.test(f.what))]
  const line = /Add (\{.*?\}) to the agents list in (\S+)/.exec(named.commands[0].run)
  assert.ok(line, named.commands[0].run)
  assert.equal(line[2], list, 'the path is filled in')
  assert.ok(!/\{"harness"/.test(wide.commands[0].run) && /An interpreter name needs its script name/.test(wide.commands[0].run), 'a WIDE name gets no line to paste')
  const proc = { os: 'linux', pid: 7002, exe: '/opt/canary/claude-canary', argv: ['claude-canary'], env: () => new Map() }
  const ds = await loadHarnesses()
  assert.equal(createRegistry(ds, { agentList: readAgentList({ home }).entries }).match(proc).agent, null, 'on no list before')
  fs.mkdirSync(path.dirname(list), { recursive: true })
  fs.writeFileSync(list, JSON.stringify({ version: 1, agents: [JSON.parse(line[1])] }))
  const read = readAgentList({ home })
  assert.deepEqual([read.state, read.problems], ['ok', []])
  assert.equal(createRegistry(ds, { agentList: read.entries }).match(proc).agent, 'claude-code', 'the same facts are claude-code\'s now')
  const bad = findingsOf(SETS['agent-list-invalid'].facts).find((x) => x.code === 'agent-list-invalid')
  assert.equal(bad.class, 'problem'); assert.ok(!bad.harness, 'the file is the machine\'s, not a harness\'s')
  assert.match(bad.what, new RegExp(LIST.replace(/[.]/g, '\\.')))
  assert.match(bad.commands[0].run, /entry 2 of .*: agents\[1\]: node is an interpreter name/)
  assert.deepEqual(validateFinding(bad), [])
})

test('V66 process-unknown `named` (a preset name whose args missed, e.g. the Z Code GUI main): no bare {harness, name} line — it would claim every process of that name — and it does not say "not on the list"', () => {
  const F = facts('z-code', { agentList: { path: '/h/.trocar/agents.json', state: 'absent', problems: [] }, identity: { 'z-code': { ...idOf('z-code')['z-code'], unknown: [{ name: 'zcode', wide: false, named: true, pid: 7004, door: 'z-code.desktop' }] } } })
  const [f] = findingsOf(F).filter((x) => x.code === 'process-unknown')
  assert.ok(f)
  assert.deepEqual(validateFinding(f), [], f.what)
  assert.ok(!/\{"harness"/.test(f.commands[0].run), f.commands[0].run)
  assert.match(f.commands[0].run, /"args"/)
  assert.match(f.why, /only with argument patterns this process did not match/)
  assert.doesNotMatch(f.why, /is on no list/)
})

test('4.11 §3 ⑱ not-routed says the model plan\'s reason for the form (the route record\'s reason and place), and uninstall\'s collectors-online gives trocar off then trocar uninstall', async () => {
  const { findingFor } = await import('../../src/netenv/findings.mjs')
  const nr = (reason, at) => findingsOf(pfacts('hermes', form('hermes.cli', { entry: null, route: { code: 'not-routed', reason, ...(at ? { at } : {}) }, procs: [] }), fwForm(17993), { platform: 'darwin' }), ['hermes']).find((f) => f.code === 'not-routed')
  const absent = nr('absent', '/Users/a/.hermes/.env')
  assert.ok(absent.commands.some((c) => c.run.includes('/Users/a/.hermes/.env')) && absent.commands.at(-1).run === 'trocar on hermes', 'Hermes: its own setup first, then trocar on')
  const blocker = nr('blocker', '/Users/a/Library/x.json#proxy')
  assert.ok(blocker.commands[0].run.includes('/Users/a/Library/x.json#proxy') && blocker.why.includes('/Users/a/Library/x.json#proxy'))
  const reasons = ['system-pac', 'blocker', 'own-egress', 'blocker-unreadable', 'unreadable', 'absent', 'credentialed-own-leg', 'no-path', 'no-applied-entry']
  assert.equal(new Set(reasons.map((r) => nr(r, '/x').why)).size >= 6, true, 'the reasons are told apart')
  for (const r of reasons) assert.deepEqual(validateFinding(nr(r, '/x')), [], r)
  const refused = findingFor('collectors-online', { platform: 'darwin', online: 'codex' })
  assert.deepEqual([refused.class, refused.commands.map((c) => c.run)], ['problem', ['trocar off', 'trocar uninstall']])
})
