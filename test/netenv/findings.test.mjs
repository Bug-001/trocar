// test/netenv/findings.test.mjs — RFC 1.6 §9.6 `doctor`'s findings (V49 the catalogue, both directions · V51 the fallback when an agent cannot connect and nothing explains it). Table-driven: every code has the
// injected facts that call for it, and those facts call for exactly its codes; every code the catalogue defines has such a set. Facts are injected, nothing here reads the machine (0.1 §3).
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildTopology } from '../../src/netenv/topology.mjs'
import { diagnose, FINDINGS, FINDING_CODES, renderFindings } from '../../src/netenv/findings.mjs'
import { validateFinding } from '../../src/cli/schema.mjs'
import { NET_CODES, TRUST_REASONS } from '../../src/health/codes.mjs'
import { ROWS, facts, proc, proxyOf, form, fwForm, pfacts, MIHOMO, mihomoVpn } from './fixtures/rows.mjs'
import { loadHarnesses } from '../../src/collector/harness/index.mjs'
import { linuxNetFacts } from '../../src/collector/arch/linux/netfacts.mjs'
import { installedViaCli } from '../cli/fixtures/dispatch-ctx.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

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
    if (FINDINGS[f.code] && FINDINGS[f.code].asightFirst && f.commands.some((c) => c.shell !== 'gui')) assert.ok(f.commands[0].run.startsWith('asight '), `${at}: the first command is asight's`) // a finding that says nothing needs doing (driver-mode proxy-changed) has no command to run
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

test('V51 a harness the user names with nothing in the facts to explain it: `cause-unknown` — a hint, worded as a condition (「如果 … 仍连不上」: asight has no fact that says it cannot connect), the first command `asight off <harness>`, the text 「仍连不上 → 与 asight 无关」; never labelled a failure on a harness that is captured', () => {
  const f = facts('claude-code') // on, steered, trusted: captured, nothing wrong that asight can read
  const found = findingsOf(f, ['claude-code']).find((x) => x.code === 'cause-unknown')
  assert.equal(found.class, 'hint', 'asight cannot say that it fails to connect: it is not a failure')
  assert.match(found.what, /^如果 claude-code 仍连不上/, 'a condition, not a statement')
  assert.equal(found.commands[0].run, 'asight off claude-code')
  const text = renderFindings([found]).join('\n')
  assert.ok(text.includes('仍连不上 → 与 asight 无关'))
  assert.doesNotMatch(text, /\[失败\]/)
  assert.match(text, /^\[提示\] claude-code · cause-unknown — 如果 claude-code 仍连不上/)
  assert.match(found.verify, /仍连不上 → 与 asight 无关/)
  assert.deepEqual(validateFinding(found), [])
  // it comes after every other finding: it is what is left when nothing above explains
  const withHints = findingsOf(row(2).facts, ['claude-code']).map((x) => x.code)
  assert.deepEqual(withHints, ['inferred-behaviour', 'cause-unknown'], 'a hint about the data does not explain a failure to connect: both are said, the condition last')
})

test('V51 what explains the harness is not repeated by it: a failure or an expected finding for the harness (not on the path, off, a daemon that is down, a process that started before `on`) means no cause-unknown; nor for a harness that is off, one that is not named, or one that is not installed', () => {
  const explained = (f, h = 'claude-code') => findingsOf(f, [h]).some((x) => x.code === 'cause-unknown')
  assert.equal(explained(SETS['daemon-not-running'].facts), false, 'a failure that explains it')
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
  assert.ok(c[0].run.startsWith('关掉所有 codex 窗口'), 'the harness\'s own step first')
  assert.deepEqual(c[1], { run: 'kill 5530', shell: 'sh' })
  assert.deepEqual(steps({ ...cx(), platform: 'win32' })[1], { run: 'Stop-Process -Id 5530', shell: 'powershell' })
  assert.deepEqual(steps(facts('codex', {}, { procs: [proc(5521, { ...stale, name: 'codex' })] })).map((x) => x.shell), ['gui'], 'the managed process is not running: nothing to end')
  const cc = findingsOf(facts('claude-code', {}, { procs: [proc(4121, stale)] }), ['claude-code']).find((x) => x.code === 'config-after-start').commands
  assert.deepEqual(cc.map((x) => x.shell), ['gui'], 'a harness with no managed process: the step alone')
  const neg = steps(facts('codex', { listeners: [] }, { procs: [proc(5530, { name: 'codex app-server', negative: true })], negatives: [{ pid: 5530, host: 'chatgpt.com', reason: 'negative-cache' }] }), 'negative-cache')
  assert.ok(neg.some((x) => x.run === 'kill 5530'), 'a negative cache lasts as long as the process: ending it is the way out')
})

test('V47 (a) / V49 proxy-changed in driver mode: the harness is still steered, so it is `expected` and nothing needs doing — no command to run (a step that says so), the way to look is `verify`; in proxy mode the same drift is a failure whose first command is `asight on <h>`', () => {
  const rec = { at: 'T', routing: 'driver', chain: 'c', source: [SRC_F1], sha256: 'sha-http://proxy.old:3128', file_sha256: 'sha-http://proxy.old:3128', proxy: 'http://proxy.old:3128', vpn: null }
  const changed = proxyOf('http://proxy.new:3128', [SRC_F1])
  const f = facts('claude-code', { listeners: [], vpn: null }, { setting: changed, fileSetting: changed, adopted: rec, behaviour: behaviourOf('claude-code', CC_FILES) })
  const found = findingsOf(f, ['claude-code']).find((x) => x.code === 'proxy-changed')
  assert.ok(found, 'the file now holds another proxy than `on` found: the finding is there')
  assert.equal(found.class, 'expected')
  assert.deepEqual(found.commands.filter((c) => c.shell !== 'gui'), [], 'nothing to run')
  assert.ok(!found.commands.some((c) => /^asight /.test(c.run)))
  assert.match(found.commands[0].run, /无需操作/)
  assert.match(found.verify, /asight status claude-code/)
  assert.deepEqual(validateFinding(found), [])
  assert.ok(!findingsOf({ ...f, harnesses: { 'claude-code': { ...f.harnesses['claude-code'], adopted: { ...rec, file_sha256: changed.sha256, sha256: changed.sha256 } } } }, ['claude-code']).some((x) => x.code === 'proxy-changed'), 'the same setting as `on` found: no finding')
  const proxyMode = findingsOf(row(17).facts, ['codex']).find((x) => x.code === 'proxy-changed')
  assert.equal(proxyMode.class, 'failure')
  assert.equal(proxyMode.commands[0].run, 'asight on codex')
})

test('renderFindings: what and why, each command on a line of its own (shell named when it is not sh; a step in an application has no $), and how to check', () => {
  const lines = renderFindings(findingsOf({ ...SETS['proxy-dead'].facts, platform: 'win32' }).filter((f) => f.code === 'proxy-dead'))
  assert.match(lines[0], /^\[失败\] claude-code · proxy-dead — /)
  assert.ok(lines.some((l) => /\$ netstat -ano -p TCP \| findstr ":7890"  \(PowerShell\)$/.test(l)))
  assert.ok(lines.some((l) => /^ {2}怎么做: 打开你的代理软件/.test(l)))
  assert.match(lines[lines.length - 1], /^ {2}怎么验证: /)
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
  assert.match(at(SRC_ENV), /unset HTTPS_PROXY/)
  assert.doesNotMatch(at(SRC_ENV), /settings\.json|\.claude\.json/, 'the setting is not in a file')
  assert.match(at(SRC_F1), /\/h\/\.claude\/settings\.json 里的 env\.HTTPS_PROXY/)
  assert.doesNotMatch(at(SRC_F1), /\.claude\.json/)
  assert.match(at(SRC_F2), /\/h\/\.claude\.json 里的 env\.https_proxy/, 'the second file, and the key that really held it')
  assert.doesNotMatch(at(SRC_F2), /settings\.json/)
  for (const source of [SRC_ENV, SRC_F1, SRC_F2]) {
    const text = at(source)
    assert.doesNotMatch(text, /删掉[^\n]*写成|写成[^\n]*删掉/, 'one verb for one step')
    assert.match(text, /^或者(删掉|去掉)这个设置:/m)
  }
  // a dotenv file: the line is `KEY=`
  const codex = facts('codex', { listeners: [] }, { setting: proxyOf('http://127.0.0.1:7890', [{ kind: 'file', where: '/h/.codex/.env', key: 'HTTPS_PROXY' }]), behaviour: behaviourOf('codex', CODEX_FILES) })
  assert.match(gui(findingsOf(codex), 'proxy-dead'), /\/h\/\.codex\/\.env 里的 HTTPS_PROXY= 那一行/)
  assert.doesNotMatch(gui(findingsOf(codex), 'proxy-dead'), /config\.toml/)
})

test('V49 proxy-unsupported names the place of the setting and the value to put there, as one sentence (no 「http://…:」 left stuck to the next phrase)', () => {
  const dsh = (source) => facts('deepseek-dsh', { listeners: [MIHOMO], vpn: mihomoVpn() }, { setting: proxyOf('socks5://127.0.0.1:7890', [source]), behaviour: behaviourOf('deepseek-dsh', [{ path: '/h/.dsh/config.json', format: 'json', key: 'proxy' }], { unsupported: { socks5: 'silent-direct' }, schemes: ['http', 'https'] }) })
  const env = gui(findingsOf(dsh(SRC_ENV)), 'proxy-unsupported')
  assert.match(env, /export HTTPS_PROXY=http:\/\/127\.0\.0\.1:7890/)
  assert.doesNotMatch(env, /\.dsh\/config\.json/, 'not the first file of the descriptor: the setting came from the shell')
  const file = gui(findingsOf(dsh({ kind: 'file', where: '/h/.dsh/config.json', key: 'proxy' })), 'proxy-unsupported')
  assert.match(file, /\/h\/\.dsh\/config\.json 里的 proxy 写成 "http:\/\/127\.0\.0\.1:7890"/)
  for (const t of [env, file]) assert.doesNotMatch(t, /…:/, 'no garble')
})

test('V49 route-loop names where the setting that loops lives; a harness with no setting of its own gets the place a new one goes (the first file it reads, else the variable it reads)', () => {
  const loop = (setting, behaviour) => pfacts('codex', form('codex.cli', { routeLoop: true, entry: null, setting, procs: [proc(5530, { name: 'codex app-server' })] }), fwForm(17992), {})
  const f = loop(proxyOf('http://127.0.0.1:17992', [{ kind: 'file', where: '/h/.codex/.env', key: 'HTTPS_PROXY' }]))
  f.harnesses.codex.behaviour = behaviourOf('codex', CODEX_FILES, { measured: 'lab' })
  assert.match(gui(findingsOf(f), 'route-loop'), /\/h\/\.codex\/\.env 里写一行 HTTPS_PROXY=/)
  const g = loop(proxyOf('http://127.0.0.1:17992', [SRC_ENV]))
  g.harnesses.codex.behaviour = behaviourOf('codex', CODEX_FILES, { measured: 'lab' })
  assert.match(gui(findingsOf(g), 'route-loop'), /export HTTPS_PROXY=/)
  assert.doesNotMatch(gui(findingsOf(g), 'route-loop'), /\.codex\/\.env/)
  // no setting: the PAC step of not-routed says where a new one goes
  const pac = ROWS.find((r) => r.n === 11).facts
  pac.harnesses.codex.behaviour = behaviourOf('codex', CODEX_FILES, { measured: 'lab' })
  assert.match(gui(findingsOf(pac), 'not-routed'), /\/h\/\.codex\/\.env 里写一行 HTTPS_PROXY=/)
  pac.harnesses.codex.behaviour = behaviourOf('codex', [], { measured: 'lab', env: ['ZCODE_HTTP_PROXY'] })
  assert.match(gui(findingsOf(pac), 'not-routed'), /export ZCODE_HTTP_PROXY=/, 'the variable the harness reads, not always HTTPS_PROXY')
})

test('V49 end to end, with the real descriptors: a proxy that came from the invoking shell\'s HTTPS_PROXY is `unset` there and no file is named; one from ~/.claude.json names that file', async () => {
  const descs = await loadHarnesses()
  const s = await installedViaCli({ status: { engine: { port: 47123 } } })
  const deps = { netFactsDeps: async () => ({ harnesses: descs, archFacts: linuxNetFacts }) }
  const SRC = path.join(os.tmpdir(), 'none')
  const base = s.ctx().env
  const dead = async (env) => {
    const r = await s.run(['doctor', 'claude-code', '--json', '--source', SRC], { env: { ...base, ...env }, deps })
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
  assert.ok(fromFile.text.includes(`${second} 里的 env.HTTPS_PROXY`), fromFile.text)
  assert.ok(!fromFile.text.includes('settings.json'))
})
