// test/netenv/topology-win32.test.mjs — RFC 4.8 §10.2 (W29): every row a–s drawn from facts, literally (the node kinds, the verdict, the compact text — the row's own NetFacts is in
// fixtures/rows-win32.mjs, written by hand), the host-set and doctor lines drawn from hand-written facts, and what the REAL gatherNetFacts path (archFacts =
// gatherWin32Facts) says when the helper is gone. The cases that read the old collector's forms / forwarder half of gatherWin32Facts (the entry edge, the
// elevated detector, env-unreadable, the host set, the proxy hop, not-routed by why) went with it (D57); proxy mode draws the proxy-mode rows from the
// model for both OSes. Nothing here runs Windows or reads the machine: the helper is a fake, the collector dir is a sandbox's, the clock is fixed (0.1 §3).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { buildTopology, renderCompact, renderDetail } from '../../src/netenv/topology.mjs'
import { validateTopology } from '../../src/cli/schema.mjs'
import { gatherNetFacts } from '../../src/netenv/facts.mjs'
import { gatherWin32Facts } from '../../src/collector/arch/win32/netfacts.mjs'
import { loadHarnesses } from '../../src/collector/harness/index.mjs'
import { newManifest, applyJsonKey } from '../../src/collector/core/trust/journal.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { ROWS } from './fixtures/rows-win32.mjs'
import { squash, pfacts, form, fwForm, proc } from './fixtures/rows.mjs'
import { spawn as nodeSpawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
// the resident helper a command starts for itself: the Node stand-in of test/collector/arch/win32/fixtures/fake-helper.mjs, speaking the same
// line protocol (nothing here runs Windows), and the child `spawn` hands back when the program is not there
const FAKE_HELPER = fileURLToPath(new URL('../collector/arch/win32/fixtures/fake-helper.mjs', import.meta.url))
const fakeSpawn = (fixture) => (exe, args, opts) => nodeSpawn(process.execPath, [FAKE_HELPER, JSON.stringify(fixture)], { ...opts, env: { ...process.env, TROCAR_FAKE_HELPER: '1' } })
const ghostChild = (emit) => { const c = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), pid: undefined, kill: () => true }); process.nextTick(() => emit(c)); return c }

const all = await loadHarnesses()
const kindOf = (t, id) => t.nodes.find((x) => x.id === id).kind
const NOW = Date.parse('2026-10-10T10:00:00.000Z')
const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text) }

// ---------- W29: the rows of 4.8 §10.2, drawn literally ----------
for (const row of ROWS) {
  test(`W29 row ${row.n}: ${row.title}`, () => {
    const topo = buildTopology(row.facts), t = topo[row.h]
    assert.deepEqual(t.branches.map((b) => [b.name, b.form]), row.names.map((n, i) => [n, row.forms[i]]), 'one branch per form (and per way of a form)')
    assert.deepEqual(t.branches.map((b) => b.path.map((id) => kindOf(t, id))), row.kinds, 'the kinds of the nodes on each branch')
    assert.deepEqual([t.on_path, t.captured, t.reason], [row.on_path, row.captured, row.reason], 'the verdict')
    for (const b of t.branches) assert.deepEqual([b.on_path, b.captured, b.reason], [row.on_path, row.captured, row.reason], 'every branch says the same of the form')
    assert.deepEqual(renderCompact(t).map(squash), row.compact.map(squash), 'the compact line, written out')
    assert.deepEqual(t.notes, row.notes || [], 'the notes the row adds')
    assert.deepEqual(validateTopology(topo), [], 'and the object is one the schema accepts (V43)')
  })
}

test('W29/D49 the one line about per-process rules of a VPN / proxy: in `status <h>` for every row where trocar is on the path, whatever the machine has (a–f, h, i, k, m, q, r), absent where it is not — and it is a line of the detail view, not a note of the topology, so `on`\'s plan (which renders the notes) never prints it', () => {
  const LINE = (h) => `If your VPN or proxy routes by process, it sees trocar, not ${h}.`
  for (const row of ROWS) {
    const t = buildTopology(row.facts)[row.h]
    const detail = renderDetail(t, { now: NOW }).join('\n')
    assert.equal(detail.includes(LINE(row.h)), row.on_path === true, `row ${row.n}: the line is ${row.on_path === true ? 'there' : 'not there'}`)
    assert.ok(!t.notes.some((n) => /routes by process/.test(n)), `row ${row.n}: it is not a note, so nothing else renders it`)
  }
  assert.ok(ROWS.some((r) => r.on_path === true) && ROWS.some((r) => r.on_path === false), 'both sides are covered')
})

test('W29 row e (v2rayN) is a proxy hop named by its executable and its port, and nothing else about it (D49: no product, no mode, no rule, no secret, no node name of the user\'s)', () => {
  const row = ROWS.find((r) => r.n === 'e'), t = buildTopology(row.facts).codex
  const hop = t.nodes.find((n) => n.kind === 'proxy')
  assert.deepEqual(hop, { id: hop.id, kind: 'proxy', name: 'v2rayN.exe', addr: '127.0.0.1', port: 10808, pid: 23001 })
  assert.equal(renderCompact(t)[0].includes('v2rayN.exe :10808'), true)
  for (const n of t.nodes) assert.ok(!/password|secret|HK-|proxies:/i.test(JSON.stringify(n)))
})

// ---------- the REAL facts path (archFacts = gatherWin32Facts) with injected readers ----------
const statusOf = (ids, { agents = [], desired = 'on', appliedHosts = null } = {}) => ({
  daemon: { state: 'running', pid: 4121, reply: { engine: { port: 17990 }, links: [], negatives: [], agents, ...(appliedHosts ? { applied_hosts: appliedHosts } : {}) }, lock: { engine_port: 17990 } },
  link: { attached: null, helper: 'ok', ids: [] },
  // status's own process rows: the daemon's row of each process it judged (an agent row without `agent` is the first harness's), as status takes it
  harnesses: ids.map((id) => ({ id, installed: true, desired, entry: { state: 'intact' }, installedAt: '2026-10-09T09:00:00.000Z', procs: agents.filter((a) => (a.agent || ids[0]) === id).map((a) => ({ pid: a.pid, trusted: a.trusted === true, reason: a.reason ?? null })) })),
})
const gather = (home, { helper, ids = ['claude-code'], env = {}, agents = [], desired = 'on', manifest = null, appliedHosts = null, spawn = null, netenv = { result: { products: [], unknown: [] } } } = {}) =>
  gatherNetFacts({ platform: 'win32', home, env, harnesses: all, status: { ...statusOf(ids, { agents, desired, appliedHosts }), ...(manifest ? { manifest: { value: manifest, error: null } } : {}) }, netenv, archFacts: gatherWin32Facts, adopted: null, now: () => NOW, deps: { helper, ...(spawn ? { spawn } : {}) } })
const KERNEL_URL = 'http://claude-code.settings:s3-listener-token@127.0.0.1:17991'
/** The collector dir of an installed proxy mode: the kernel's lock, the ports of ingress.json, and the manifest's record of the entry that was written over the user's own proxy. */
function collectorOf(home, { url = KERNEL_URL, prior = 'http://proxy.corp:8080', groupPorts = { 'claude-code.settings': 17991 } } = {}) {
  const dir = path.join(home, '.trocar', 'collector')
  put(path.join(dir, 'ingress.json'), `${JSON.stringify({ enginePort: 17990, groupPorts, ingressToken: 'a'.repeat(32), listenerToken: 's3-listener-token' })}\n`)
  const settings = path.join(home, '.claude', 'settings.json')
  if (prior != null) put(settings, `${JSON.stringify({ env: { HTTPS_PROXY: prior } }, null, 2)}\n`)
  const manifest = newManifest()
  applyJsonKey({ phase: 'on', dir, manifest, harness: 'claude-code', file: settings, keys: ['env', 'HTTPS_PROXY'], value: url, home, now: new Date('2026-10-09T09:00:00Z'), fs })
  return { dir, settings }
}

test('W69 the host-set lines of `status` (4.8 §3): the host program\'s other connections only forward and only the form\'s host set reaches the engine; settings that cannot be read leave the set at the defaults and extra_hosts, said with the reason and the hosts that are still captured; a fresh read that differs from the applied set says the kernel\'s is old and names the command — three notes of the detail view, none when the set is current and reads', () => {
  const hostForm = (hosts) => form('kimi-code.vscode', { entry: { where: 'settings.json http.proxy', trocar: true, opt_in: true, intact: true }, optIn: { state: 'done' }, procs: [proc(8100, { name: 'Code', exe: 'C:\\Program Files\\Microsoft VS Code\\Code.exe', version: null })], hosts })
  const DEFAULTS = ['api.kimi.com', 'api.kimi.ai', 'api.moonshot.ai', 'api.moonshot.cn']
  const tree = "VS Code's other connections are forwarded only; only the hosts of Kimi are captured"
  // a read that agrees with the applied set: only the host-tree line
  const current = buildTopology(pfacts('kimi-code', hostForm({ program: 'VS Code', extension: 'Kimi', defaults: [...DEFAULTS], hosts: [...DEFAULTS, 'relay.corp.example'], settings: 'read', dropped: [], applied: [...DEFAULTS, 'relay.corp.example'] }), fwForm(17995)))['kimi-code']
  assert.deepEqual(current.notes, [tree], 'the set is current: no line about an older set')
  // the settings changed after `on`: the kernel's set is old, the command that recomputes it is named — `status` itself changes nothing
  const stale = buildTopology(pfacts('kimi-code', hostForm({ program: 'VS Code', extension: 'Kimi', defaults: [...DEFAULTS], hosts: [...DEFAULTS, 'relay.corp.example'], settings: 'read', dropped: [], applied: [...DEFAULTS] }), fwForm(17995)))['kimi-code']
  assert.deepEqual(stale.notes, [tree, "the host set in use is older than Kimi's settings; to bring it up to date run: trocar on kimi-code"])
  const staleDetail = renderDetail(stale, { now: NOW }).join('\n')
  assert.ok(staleDetail.includes('the host set in use is older') && staleDetail.includes('trocar on kimi-code'), 'the detail view prints it, with the command')
  // the settings cannot be read: only the defaults and extra_hosts are captured — said with the reason and the hosts that are, never silent
  const unreadable = buildTopology(pfacts('kimi-code', hostForm({ program: 'VS Code', extension: 'Kimi', defaults: [...DEFAULTS], hosts: [...DEFAULTS, 'relay.extra.example'], settings: { unreadable: { reason: 'denied', detail: 'EACCES' } }, dropped: [] }), fwForm(17995)))['kimi-code']
  assert.deepEqual(unreadable.notes, [tree, `Kimi's own settings could not be read (denied: EACCES): only its default hosts (${DEFAULTS.join(', ')}) are captured`])
  const detail = renderDetail(unreadable, { now: NOW }).join('\n')
  assert.ok(detail.includes('could not be read (denied: EACCES)') && detail.includes(DEFAULTS.join(', ')), 'the detail view prints the reason and the hosts that are still captured')
  // a settings file that is simply not there: nothing configured, not a problem — no line about an unreadable one
  const absent = buildTopology(pfacts('kimi-code', hostForm({ program: 'VS Code', extension: 'Kimi', defaults: [...DEFAULTS], hosts: [...DEFAULTS], settings: 'absent', dropped: [] }), fwForm(17995)))['kimi-code']
  assert.deepEqual(absent.notes, [tree], 'absent is not unreadable: no line')
})

test('a helper that cannot be started, and one that answers nothing: every read it owned is an unknown with its reason, the routing stays proxy and nothing is invented (R11)', async () => {
  const home = tmpDir('trocar-wf-dead-')
  collectorOf(home)
  const broken = { call: async () => { throw Object.assign(new Error('helper-down'), { code: 'helper-down' }) }, close: async () => {} }
  // the injected helper fails AND one of this command's own cannot be started (the program is not there): both halves are said, nothing is invented
  const f = await gather(home, { helper: broken, ids: ['codex'], spawn: () => ghostChild((c) => c.emit('error', Object.assign(new Error('spawn powershell.exe ENOENT'), { code: 'ENOENT' }))) })
  assert.equal(f.routing, 'proxy')
  assert.ok(f.unknowns.length >= 2, `the processes and the listeners are each said: ${JSON.stringify(f.unknowns)}`)
  for (const u of f.unknowns) assert.ok(['denied', 'timeout', 'absent', 'unparseable'].includes(u.reason), `${JSON.stringify(u)}: a reason of the closed set`)
  assert.deepEqual(f.listeners, [])
})

test('an INJECTED helper (the daemon\'s warm one) that fails does not end the diagnosis — this command starts its own helper, says it did (D38), and every axis is read', async () => {
  const home = tmpDir('trocar-wf-fallback-')
  collectorOf(home)
  const asked = []
  const broken = { call: async (verb) => { asked.push(verb); throw Object.assign(new Error('helper-down'), { code: 'helper-down' }) }, close: async () => {} }
  const fixture = { verbs: {
    ps: { data: { procs: [{ pid: 4242, name: 'claude.exe', exe: 'C:\\Users\\u\\.local\\bin\\claude.exe', cmdline: 'claude', cmdlineState: 'ok' }] } },
    'tcp-table': { data: { rows: [{ localAddr: '127.0.0.1', localPort: 7890, pid: 4242, state: 'listen' }] } },
    'reg-read': { data: { keyExists: true, values: { ProxyEnable: 0 } } },
  } }
  const f = await gather(home, { helper: broken, ids: ['claude-code'], spawn: fakeSpawn(fixture), agents: [{ pid: 4242, decrypt: true, trusted: true }] })
  assert.deepEqual(asked, ['ps'], 'the daemon\'s helper was asked once, and is not asked again')
  assert.deepEqual(f.unknowns.filter((u) => u.fact === 'procs' || u.fact === 'listeners'), [], 'the process and listener axes are READ, not denied: that is the diagnosis the user needs')
  assert.deepEqual(f.listeners, [{ addr: '127.0.0.1', port: 7890, pid: 4242, exe: 'C:\\Users\\u\\.local\\bin\\claude.exe' }])
  assert.deepEqual(f.harnesses['claude-code'].procs.map((p) => p.pid), [4242])
  const said = f.unknowns.filter((u) => u.fact === 'helper')
  assert.equal(said.length, 1, `the fallback is never silent (D38): ${JSON.stringify(f.unknowns)}`)
  assert.match(said[0].detail, /did not answer \(helper-down\), so this command started its own/)
})


test('the win32 facts are darwin\'s shape (routing proxy, the processes by the name list, the listeners, the OS proxy); the per-form half is the model\'s, so with nothing installed there is no form to draw and the topology says so', async () => {
  const home = tmpDir('trocar-wf-shape-')
  const helper = { close: async () => {}, call: async (verb) => {
    if (verb === 'ps') return { procs: [{ pid: 4242, name: 'claude.exe', exe: 'C:\\Users\\u\\.local\\bin\\claude.exe', cmdline: 'claude', cmdlineState: 'ok' },
      { pid: 5151, name: 'Code.exe', exe: 'C:\\Program Files\\Microsoft VS Code\\Code.exe', cmdline: '"C:\\Program Files\\Microsoft VS Code\\Code.exe"', cmdlineState: 'ok' }] }
    if (verb === 'tcp-table') return { rows: [{ localAddr: '127.0.0.1', localPort: 7890, pid: 4242, state: 'listen' }] }
    throw Object.assign(new Error('not in this fake'), { code: 'helper-forbidden-key' })
  } }
  const f = await gather(home, { helper, ids: ['claude-code', 'kimi-code'], agents: [{ pid: 4242, decrypt: true, trusted: true }] })
  assert.equal(f.routing, 'proxy')
  assert.deepEqual(f.forwarder.forms, {}, 'no door of an installed form')
  assert.deepEqual(f.harnesses['claude-code'].forms || [], [], 'no forms half')
  assert.deepEqual(f.harnesses['claude-code'].procs.map((p) => [p.pid, p.watched]), [[4242, 'decrypt']], 'the process is judged by the name list, with the daemon\'s word on it')
  assert.deepEqual(f.harnesses['kimi-code'].procs.map((p) => p.pid), [5151], 'the host program (VS Code) is the harness of its hostTree form: the base descriptor\'s win32 proxyMode.forms hosts.processes')
  const t = buildTopology(f)['claude-code']
  assert.match(t.notes.join(' '), /could not be worked out/)
  assert.deepEqual([t.on_path, t.captured], [null, null])
})

// ---------- W36: the Windows doctor commands (4.8 §10.4) ----------
// The catalogue is `src/netenv/findings-win32.mjs` (one entry per code row of the §10.4 table, the commands filled from the facts); `diagnose` picks it on win32 (findings.mjs's `make`). Nothing here
// runs anything: the literals are what `doctor` PRINTS (R8), compared against hand-written expected lines — the values filled, a value that cannot be read 「不知道 · <原因>」, never a placeholder.
import { diagnose, FINDINGS, FINDING_CODES } from '../../src/netenv/findings.mjs'
import { FINDINGS_WIN32 } from '../../src/netenv/findings-win32.mjs'
import { validateFinding } from '../../src/cli/schema.mjs'
import { fileURLToPath } from 'node:url'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
/** A finding's context, filled the way `diagnose` fills it (`fm` = the form facts of the branch that carries the reason, the extras what the daemon's records will hand over). */
const CTX = (over = {}) => ({ F: {}, h: 'codex', hf: null, t: null, user: 'u', sh: 'powershell', platform: 'win32', setting: null, ...over })
const cmd = (run, shell = 'powershell') => ({ run, shell })
const A = (run) => cmd(run) // trocar's own, in the platform's shell

test('W36 one entry per code row of §10.4 — no more, no less — and each entry\'s own output is a finding the schema accepts (a win-only code defines every field; no run holds a placeholder)', () => {
  assert.deepEqual(Object.keys(FINDINGS_WIN32), [
    'not-routed', 'entry-changed', 'egress-differs', 'elevated-agent', 'proxy-dead',
    'upstream-unreachable', 'engine-port-taken', 'forwarder-down', 'form-unsupported', 'proxy-unsupported',
    'system-proxy-pac', 'other-redirector', 'socktable-unavailable', 'cause-unknown',
  ])
  for (const [code, entry] of Object.entries(FINDINGS_WIN32)) {
    assert.equal(typeof entry.commands, 'function', `${code}: the commands are a function of the context`)
    const own = !FINDINGS[code]
    if (own) for (const f of ['cls', 'what', 'why', 'verify']) assert.ok(entry[f] !== undefined, `${code}: a code the cross-platform catalogue does not have defines ${f} itself`)
    const c = CTX({ h: 'codex', code, F: {}, dead: { addr: '127.0.0.1', port: 7890 }, enginePort: 17990, upPort: 7897, port: 17992, reason: 'port-taken', protocol: 'socks4',
      fm: { id: 'codex.app', entryPlace: { kind: 'file', file: 'C:\\Users\\u\\.codex\\.env', format: 'dotenv', key: 'HTTPS_PROXY' }, route: { reason: 'not-routed', why: 'system-proxy-pac' }, setting: null, systemProxy: null, procs: [] },
      hf: { forms: [], behaviour: {}, systemProxy: null }, setting: { scheme: 'socks4' } })
    const cls = typeof entry.cls === 'function' ? entry.cls(c) : entry.cls
    const finding = { code, class: cls === undefined ? 'problem' : cls, harness: 'codex',
      what: entry.what ? entry.what(c) : '(the cross-platform catalogue\'s own words)', why: entry.why ? entry.why(c) : '(the cross-platform catalogue\'s own words)',
      commands: entry.commands(c), verify: entry.verify ? entry.verify(c) : '(the cross-platform catalogue\'s own words)' }
    assert.deepEqual(validateFinding(finding), [], `${code}: the schema accepts the entry's own output`)
    for (const x of finding.commands) assert.ok(!/<[^>\n]+>/.test(x.run), `${code}: ${x.run} holds a placeholder`)
    if (entry.trocarFirst && finding.commands.some((x) => x.shell !== 'gui')) assert.ok(finding.commands[0].run.startsWith('trocar '), `${code}: the first command is trocar's`)
    assert.ok(FINDING_CODES.includes(code), `${code}: is in the finding codes' own list`)
  }
})

/** Every §10.4 row's commands with a filled context, as literals. `not-routed` and `forwarder-start-failed` have a variant each per their `why` / `reason`; the `reason` / `port` / `of` extras and the facts' `reinstall`
 *  lines are what the daemon's failure records will hand `diagnose` once /status relays them. */
const LITERALS = {
  'not-routed': {
    pac: { ctx: CTX({ h: 'codex', pac: true, fm: { id: 'codex.app', route: { reason: 'not-routed', why: 'system-proxy-pac' }, entryPlace: { kind: 'file', file: 'C:\\Users\\u\\.codex\\.env', format: 'dotenv', key: 'HTTPS_PROXY' } } }),
      what: 'New connections from codex (codex.app) do not go through trocar.', why: 'The system proxy this form follows is a PAC script, which trocar does not run.',
      commands: [cmd('Put the line HTTPS_PROXY=unknown proxy address (pac) in C:\\Users\\u\\.codex\\.env', 'gui'), A('trocar on codex')], verify: 'trocar status codex' },
    'system-proxy-unreadable': { ctx: CTX({ h: 'codex', fm: { id: 'codex.app', route: { reason: 'not-routed', why: 'system-proxy-unreadable', detail: 'denied' } } }),
      why: 'Your system proxy could not be read (denied), and trocar does not guess, so it did not connect this form.',
      commands: [A('trocar on codex'), A('trocar doctor codex'), cmd('reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable')] },
    'upstream-unparseable': { ctx: CTX({ h: 'claude-code', fm: { id: 'claude-code.cli', route: { reason: 'not-routed', why: 'upstream-unparseable' }, entryPlace: { kind: 'file', file: 'C:\\Users\\u\\.claude\\settings.json', format: 'json', key: 'env.HTTPS_PROXY' } } }),
      why: 'trocar cannot read the proxy address this form had, so it did not connect it.',
      commands: [cmd('Write it as http://host:port or socks5://host:port', 'gui'), cmd('Open C:\\Users\\u\\.claude\\settings.json in Notepad and set env.HTTPS_PROXY to "unknown proxy address (absent)"', 'gui'), A('trocar on claude-code'), A('trocar off claude-code')] },
    'credentials-in-system-proxy': { ctx: CTX({ h: 'codex', fm: { id: 'codex.app', route: { reason: 'not-routed', why: 'upstream-unparseable', detail: 'credentials-in-system-proxy' }, entryPlace: { kind: 'file', file: 'C:\\Users\\u\\.codex\\.env', format: 'dotenv', key: 'HTTPS_PROXY' } } }),
      why: 'Your system proxy address carries a login, which Windows itself does not use, so trocar did not connect this form.',
      commands: [cmd('Take the login out of your system proxy address', 'gui'), cmd('Put the line HTTPS_PROXY=unknown proxy address (absent) in C:\\Users\\u\\.codex\\.env', 'gui'), A('trocar on codex'), A('trocar off codex')] },
    'no-why': { ctx: CTX({ h: 'kimi-code', fm: null }),
      why: 'This form has no entry trocar can use.',
      commands: [cmd("Use kimi-code's CLI form instead", 'gui'), A('trocar status kimi-code')] },
  },
  'entry-changed': { ctx: CTX({ h: 'z-code' }), commands: [A('trocar on z-code')], verify: 'trocar status z-code' },
  'egress-differs': { ctx: CTX({ h: 'codex' }), commands: [A('trocar off codex')], verify: 'trocar status codex' },
  'elevated-agent': { ctx: CTX({ h: 'claude-code' }),
    commands: [cmd('Quit claude-code and start it again without administrator rights', 'gui'), cmd('whoami /groups | findstr /i "Mandatory"')], verify: 'trocar status claude-code' },
  'proxy-dead': { ctx: CTX({ h: 'claude-code', dead: { addr: '127.0.0.1', port: 7890 } }),
    commands: [cmd('netstat -ano -p TCP | findstr ":7890"'), cmd('Start your proxy, so that it listens on 127.0.0.1:7890', 'gui'), cmd('Or turn off the system proxy that points at it', 'gui')], verify: 'trocar status claude-code' },
  'upstream-unreachable': { ctx: CTX({ h: 'codex', upPort: 7897 }),
    commands: [cmd('netstat -ano -p TCP | findstr ":7897"'), cmd('Start your proxy, or turn off the system proxy that points at it', 'gui')], verify: 'trocar status codex' },
  'engine-port-taken': { ctx: CTX({ h: 'codex', enginePort: 17990 }),
    what: 'Another program holds the port trocar listens on, so nothing is captured.', why: 'trocar picks another port after a restart.',
    commands: [cmd('netstat -ano -p TCP | findstr ":17990"'), A('trocar off'), A('trocar on')], verify: 'trocar status' },
  'forwarder-down': { ctx: CTX({ h: 'codex' }),
    commands: [A('trocar on'), A('trocar off codex'), cmd('Restart codex after that, and it connects without trocar', 'gui')], verify: 'trocar status' },
  'form-unsupported': { ctx: CTX({ h: 'claude-code', fm: { id: 'claude-code.desktop' } }),
    what: 'claude-code (claude-code.desktop) cannot take an upstream proxy that needs a login.', why: 'Its entry takes no login, so trocar does not hand it one.',
    commands: [cmd("Use claude-code's CLI form or its editor extension instead", 'gui')], verify: 'trocar status claude-code' },
  'proxy-unsupported': { ctx: CTX({ h: 'deepseek-dsh', protocol: 'socks4', fm: { entryPlace: { kind: 'file', file: 'C:\\Users\\u\\.dsh\\.env', format: 'dotenv', key: 'HTTPS_PROXY' } } }),
    what: 'deepseek-dsh does not support the proxy scheme socks4.', why: 'trocar cannot use a socks4 proxy as its upstream, so it did not connect this form.',
    commands: [cmd('Write it as http://host:port or socks5://host:port', 'gui'), cmd('Put the line HTTPS_PROXY=unknown proxy address (absent) in C:\\Users\\u\\.dsh\\.env', 'gui'), A('trocar on deepseek-dsh'), A('trocar off deepseek-dsh')], verify: 'trocar status deepseek-dsh' },
  'system-proxy-pac': { ctx: CTX({}),
    commands: [cmd("Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings' -Name AutoConfigURL")], verify: 'trocar status' },
  'other-redirector': { ctx: CTX({}), commands: [cmd('netsh winsock show catalog')], verify: 'trocar status' },
  'socktable-unavailable': { ctx: CTX({}),
    what: 'Windows did not say which program owns a connection, so it was forwarded only.', why: 'trocar never guesses the owner of a connection; it forwards it instead of capturing it.',
    commands: [cmd('No action needed: that connection was forwarded, not captured; the next one is asked again', 'gui')], verify: 'trocar status' },
  'cause-unknown': { ctx: CTX({ h: 'codex' }), commands: [A('trocar off codex'), cmd('Try codex again: if it still fails, trocar is not the cause', 'gui')], verify: 'Try codex again' },
}

test('W36 each §10.4 command equals its literal (the values filled: the entry file and its key, the ports of the facts — no placeholder, no download address)', () => {
  const one = (name, spec, entry, ctx) => {
    assert.deepEqual(entry.commands(ctx), spec.commands, `${name}: the commands, as literals`)
    if (spec.verify) assert.equal(entry.verify(ctx), spec.verify, `${name}: how to check`)
    if (spec.why) assert.equal(entry.why(ctx), spec.why, `${name}: the why`)
    if (spec.what) assert.equal(entry.what(ctx), spec.what, `${name}: the what`)
  }
  for (const [code, spec] of Object.entries(LITERALS)) {
    const entry = FINDINGS_WIN32[code]
    for (const [variant, half] of Object.entries(spec)) {
      if (!half || !half.ctx) continue
      one(variant === 'ctx' ? code : `${code}(${variant})`, half, entry, { ...half.ctx, ...(code === 'forwarder-start-failed' ? { reason: variant } : {}) })
    }
  }
})

test('W36 form-unsupported: the plan\'s own reason is the branch\'s verdict (a status reason), and the finding says which form to use instead', () => {
  const f = pfacts('claude-code', form('claude-code.desktop', { entry: null, route: { reason: 'form-unsupported' }, procs: [proc(8801, { name: 'Claude', exe: 'C:\\Program Files\\Claude\\Claude.exe', version: null })] }), fwForm(17996))
  const t = buildTopology(f)['claude-code']
  assert.deepEqual([t.on_path, t.captured, t.reason], [false, false, 'form-unsupported'], 'the plan\'s reason names the verdict (not the generic not-routed)')
  assert.deepEqual(validateTopology({ 'claude-code': t }), [], 'and it is a status reason the schema accepts')
  const found = diagnose({ facts: f, topology: { 'claude-code': t }, harnesses: ['claude-code'], user: 'u' }).find((x) => x.code === 'form-unsupported')
  assert.equal(found.what, 'claude-code (claude-code.desktop) cannot take an upstream proxy that needs a login.')
  assert.deepEqual(found.commands, [{ run: "Use claude-code's CLI form or its editor extension instead", shell: 'gui' }])
})

test('W36 the static scans (4.8 E6): findings-win32.mjs has no command that changes Smart App Control, and the port check is always the netstat + findstr form', () => {
  const src = fs.readFileSync(path.join(REPO, 'src/netenv/findings-win32.mjs'), 'utf8').replace(/^\s*\/\/.*$/gm, '') // the code, not its comments (which say why each of these is absent)
  for (const bad of ['Set-ItemProperty', 'reg add', 'CI\\Policy', 'Get-NetTCPConnection']) assert.ok(!src.includes(bad), `${bad} is not in the Windows doctor table`)
  assert.ok((src.match(/netstat -ano -p TCP \| findstr/g) || []).length >= 1, 'the port check is the netstat + findstr form')
})
