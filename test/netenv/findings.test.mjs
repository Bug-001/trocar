// test/netenv/findings.test.mjs — RFC 1.6 §9.6 `doctor`'s findings (V49 the catalogue, both directions · V51 the fallback when an agent cannot connect and nothing explains it). Table-driven: every code has the
// injected facts that call for it, and those facts call for exactly its codes; every code the catalogue defines has such a set. Facts are injected, nothing here reads the machine (0.1 §3).
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildTopology } from '../../src/netenv/topology.mjs'
import { diagnose, FINDINGS, FINDING_CODES, renderFindings } from '../../src/netenv/findings.mjs'
import { validateFinding } from '../../src/cli/schema.mjs'
import { NET_CODES, TRUST_REASONS } from '../../src/health/codes.mjs'
import { ROWS, facts, proc, proxyOf, form, fwForm, pfacts, MIHOMO, mihomoVpn } from './fixtures/rows.mjs'

const row = (n) => ROWS.find((r) => r.n === n)
const codesOf = (f, h, names = null) => diagnose({ facts: f, topology: buildTopology(f), harnesses: names, user: 'alice' }).filter((x) => !x.harness || x.harness === h).map((x) => x.code).sort()
const findingsOf = (f, names = null) => diagnose({ facts: f, topology: buildTopology(f), harnesses: names, user: 'alice' })
const mihomoVia = { listeners: [MIHOMO], vpn: mihomoVpn() }
const viaProxy = (value = 'http://127.0.0.1:7890') => ({ setting: proxyOf(value) })

// one injected fact set per code: { codes: exactly what it must give, h, facts }. The rows of §9.3 serve for the codes they illustrate; the others are built here.
const SETS = {
  'config-after-start': { h: 'claude-code', facts: row(5).facts, codes: row(5).findings },
  'desired-off': { h: 'claude-code', facts: row(4).facts, codes: row(4).findings },
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
  'proxy-dead': { h: 'claude-code', facts: facts('claude-code', {}, viaProxy()), codes: ['proxy-dead', 'inferred-behaviour'] },
  'proxy-unsupported': { h: 'deepseek-dsh', facts: facts('deepseek-dsh', mihomoVia, { setting: proxyOf('socks5://127.0.0.1:7890') }), codes: ['proxy-unsupported', 'inferred-behaviour'] },
  'proxy-changed': { h: 'codex', facts: row(17).facts, codes: row(17).findings },
  'netenv-changed': { h: 'claude-code', facts: facts('claude-code', { vpn: mihomoVpn({ tun: true }), vpnKnown: true }, { adopted: { at: 'T', routing: 'driver', chain: 'c', source: [], sha256: null, file_sha256: null, proxy: null, vpn: { product: 'mihomo', version: '1.19.32', port: 7890, tun: false } } }), codes: ['netenv-changed'] },
  'elevated-agent': { h: 'claude-code', facts: row(19).facts, codes: row(19).findings },
  'forwarder-down': { h: 'codex', facts: row(13).facts, codes: row(13).findings },
  'upstream-unreachable': { h: 'codex', facts: pfacts('codex', form('codex.cli', { setting: proxyOf('http://proxy.corp:8080'), procs: [proc(5530, { name: 'codex app-server' })] }), fwForm(17992, { upstream: 'http://proxy.corp:8080', source: 'agent', upstream_error: 'ECONNREFUSED' })), codes: ['upstream-unreachable'] },
  'opt-in-needed': { h: 'kimi-code', facts: row(15).facts, codes: row(15).findings },
  'shim-not-on-path': { h: 'kimi-code', facts: row(16).facts, codes: row(16).findings },
  'not-via-entry': { h: 'kimi-code', facts: pfacts('kimi-code', form('kimi-code.cli', { entry: null, optIn: { state: 'broken', code: 'not-via-entry', enable: 'asight on kimi-code --opt-in kimi-code.cli' }, procs: [proc(7001, { name: 'kimi' })] }), fwForm(17993)), codes: ['not-via-entry'] },
  'needs-admin': { h: 'kimi-code', facts: pfacts('kimi-code', form('kimi-code.cli', { entry: null, optIn: { state: 'pending-admin', code: 'needs-admin', enable: 'asight on kimi-code --opt-in kimi-code.machine', elevated: 'Start-Process powershell -Verb RunAs -ArgumentList "asight-admin.ps1"' }, procs: [proc(7001, { name: 'kimi' })] }), fwForm(17993)), codes: ['needs-admin'] },
  'egress-differs': { h: 'codex', facts: row(9).facts, codes: row(9).findings },
  'linger-off': { h: null, facts: facts('claude-code', { linger: false }), codes: ['linger-off'] },
  'other-redirector': { h: null, facts: facts('claude-code', { otherRedirector: true }), codes: ['other-redirector'] },
  'fake-ip': { h: 'claude-code', facts: facts('claude-code', {}, { fakeIp: true }), codes: ['fake-ip'] },
  'inferred-behaviour': { h: 'claude-code', facts: row(2).facts, codes: row(2).findings },
  'cause-unknown': { h: 'claude-code', facts: facts('claude-code'), names: ['claude-code'], codes: ['cause-unknown'] },
}
const STATUS_REASONS_IN_CATALOGUE = ['config-after-start', 'daemon-not-running', 'daemon-not-responding', 'helper-missing', 'link-missing', 'entry-missing', 'entry-changed', 'desired-off', 'negative-cache']

for (const [code, set] of Object.entries(SETS)) {
  test(`V49 ${code}: its facts call for exactly ${JSON.stringify([...set.codes].sort())}`, () => {
    const got = codesOf(set.facts, set.h, set.names || null)
    assert.deepEqual(got, [...set.codes].sort())
    assert.ok(got.includes(code), `${code} is among them`)
  })
}

test('V49 both directions: every code of the closed sets (§9.7 net codes, the status reasons §9.6 uses) has a fact set, and the catalogue defines no code outside them', () => {
  const closed = new Set([...NET_CODES, ...STATUS_REASONS_IN_CATALOGUE])
  for (const code of closed) assert.ok(SETS[code], `${code} has a fact set`)
  for (const code of Object.keys(FINDINGS)) assert.ok(closed.has(code) || TRUST_REASONS.includes(code), `${code} is in a closed set`)
  assert.deepEqual(Object.keys(SETS).filter((c) => !closed.has(c)), [], 'and no fact set is for a code nobody defined')
})

test('V49 every trust reason is a finding (the restart ones expected, the rest failures), says what and why, and gives a command', () => {
  for (const reason of TRUST_REASONS) {
    const f = facts('claude-code', {}, { procs: [proc(4121, { watched: 'no-decrypt', trusted: false, reason, hint: reason === 'var-missing' ? 'the NODE_EXTRA_CA_CERTS variable is not set' : undefined })] })
    const found = findingsOf(f).filter((x) => x.code === reason)
    assert.equal(found.length, 1, reason)
    const restart = ['config-after-start', 'env-frozen', 'start-time-unknown', 'no-marker', 'kimi-not-via-shim'].includes(reason)
    if (reason !== 'shim-not-on-path') assert.equal(found[0].class, restart ? 'expected' : 'failure', reason)
    assert.deepEqual(validateFinding(found[0]), [], reason)
  }
})

test('V49 each finding: what, why and verify say something; a failure or an expected finding has a command (a hint may have none); the commands are whole lines with no <…> left; asight\'s own come first where the catalogue says so; it validates', () => {
  const all = [...Object.values(SETS), ...TRUST_REASONS.map((r) => ({ facts: facts('claude-code', {}, { procs: [proc(4121, { watched: 'no-decrypt', trusted: false, reason: r })] }) }))]
  const seen = new Set()
  for (const s of all) for (const f of findingsOf(s.facts, s.names || null)) {
    const at = `${f.code} (${f.class})`
    assert.deepEqual(validateFinding(f), [], at)
    assert.ok(f.what && f.why && f.verify, at)
    if (f.class !== 'hint') assert.ok(f.commands.length >= 1, at)
    for (const c of f.commands) assert.ok(!/<[^>]+>/.test(c.run) && ['sh', 'powershell', 'gui'].includes(c.shell), `${at}: ${c.run}`)
    if (FINDINGS[f.code] && FINDINGS[f.code].asightFirst) assert.ok(f.commands[0].run.startsWith('asight '), `${at}: the first command is asight's`)
    if (FINDINGS[f.code] && f.class === 'failure' && !FINDINGS[f.code].asightFirst) assert.ok(f.commands.length >= 1)
    seen.add(f.code)
  }
  for (const code of Object.keys(FINDINGS)) assert.ok(seen.has(code), `${code} was produced by some fact set`)
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
  const admin = findingsOf(SETS['needs-admin'].facts).find((f) => f.code === 'needs-admin')
  assert.equal(admin.commands[0].run, 'Start-Process powershell -Verb RunAs -ArgumentList "asight-admin.ps1"')
  assert.equal(admin.commands[0].shell, 'powershell')
  const pac = findingsOf(SETS['not-routed'].facts).find((f) => f.code === 'not-routed')
  assert.ok(pac.commands.some((c) => c.run.includes('不知道 · pac')), 'the PAC\'s address is not known: said, not guessed')
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

test('V51 an agent that cannot connect and nothing explains it: `cause-unknown`, the first command is `asight off <harness>`, the text says 仍连不上 → 与 asight 无关; a harness that is off gets none, and nor does one that has a failure of its own', () => {
  const f = facts('claude-code')
  const found = findingsOf(f, ['claude-code']).find((x) => x.code === 'cause-unknown')
  assert.equal(found.class, 'failure')
  assert.equal(found.commands[0].run, 'asight off claude-code')
  assert.ok(renderFindings([found]).join('\n').includes('仍连不上 → 与 asight 无关'))
  assert.match(found.verify, /仍连不上 → 与 asight 无关/)
  assert.deepEqual(findingsOf({ ...f, desired: { 'claude-code': 'off' } }, ['claude-code']).map((x) => x.code), ['desired-off'], 'off: asight is not on the path, the finding is that it is off')
  assert.ok(!findingsOf(SETS['daemon-not-running'].facts, ['claude-code']).some((x) => x.code === 'cause-unknown'), 'a failure that explains it')
  assert.ok(!findingsOf(f, null).some((x) => x.code === 'cause-unknown'), 'it answers a symptom somebody named')
})

test('renderFindings: what and why, each command on a line of its own (shell named when it is not sh; a step in an application has no $), and how to check', () => {
  const lines = renderFindings(findingsOf({ ...SETS['proxy-dead'].facts, platform: 'win32' }).filter((f) => f.code === 'proxy-dead'))
  assert.match(lines[0], /^\[失败\] claude-code · proxy-dead — /)
  assert.ok(lines.some((l) => /\$ netstat -ano -p TCP \| findstr ":7890"  \(PowerShell\)$/.test(l)))
  assert.ok(lines.some((l) => /^ {2}怎么做: 打开你的代理软件/.test(l)))
  assert.match(lines[lines.length - 1], /^ {2}怎么验证: /)
})
