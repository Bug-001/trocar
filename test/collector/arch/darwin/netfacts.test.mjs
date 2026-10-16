// test/collector/arch/darwin/netfacts.test.mjs — macOS's part of the network facts (RFC 4.9 §10, 1.6 §9.7; the assertions are the linux twin's, test/collector/arch/linux/netfacts.test.mjs, adapted where 4.9 §10 names
// a darwin row): the processes of each harness with the watch table's verdict, whether it runs as root (euid/root), the listeners of this user, the OS proxy with PAC's own scutil
// flag; the per-form half (certificate, proxy, the doors) is the model's (core/proxymode/status-facts.mjs). Everything is injected: a fake `lsof` / `scutil` / `ps` runner; nothing reads the machine and nothing is spawned.
import test from 'node:test'
import assert from 'node:assert/strict'
import { darwinNetFacts as gather, parseLsof, processName, versionOf } from '../../../../src/collector/arch/darwin/netfacts.mjs'
import { settingSha } from '../../../../src/netenv/redact.mjs'
import { tmpDir } from '../../../helpers/tmp.mjs'
import { buildTopology, renderCompact } from '../../../../src/netenv/topology.mjs'
import { facts } from '../../../netenv/fixtures/rows.mjs'

const HOME = tmpDir('darwin-netfacts') // an empty HOME: nothing installed, so the per-form half (core/proxymode/status-facts.mjs) has no form to read
const darwinNetFacts = (ctx, deps) => gather({ home: HOME, ...ctx }, deps)

const LSOF = [
  'mihomo   777 user    7u  IPv4 0x2fa994562d6e90a6      0t0  TCP 127.0.0.1:7890 (LISTEN)',
  'mihomo   777 user    8u  IPv6 0xf88899a95ce14746      0t0  TCP [::1]:9090 (LISTEN)',
  'ControlCe  787 user    9u  IPv4 0xc2b53e0384067da2      0t0  TCP *:7000 (LISTEN)',
  '                  user    3u  IPv4 0xabe      0t0  TCP *:22 (LISTEN)', // a LISTEN row with no owner: not a shape lsof's answer has on macOS (a listener of another user is not in the answer at all) — kept for the shared listener shape, the linux twin's owner-unreadable
].join('\n')

/** The runner of `lsof` / `scutil` / `ps`: spawnSync-shaped, answers from a table, records what it was asked. */
const runner = (table, calls = []) => (file, args) => {
  calls.push([file, ...args].join(' '))
  const r = table[[file, ...args].join(' ')] ?? { status: null, stdout: '', stderr: '', error: new Error(`spawnSync ${file} ENOENT`) }
  return { status: 0, stdout: '', stderr: '', ...r }
}
const SCUTIL_OFF = '<dictionary> {\n  HTTPSEnable : 0\n}'
const TABLE = { 'lsof -nP -iTCP -sTCP:LISTEN': { stdout: LSOF }, 'scutil --proxy': { stdout: SCUTIL_OFF } }
const row = (pid, over = {}) => ({ pid, trusted: true, reason: null, negative: false, startedAt: Date.parse('2026-10-07T09:30:00Z'), ...over })
const statusOf = (rows, reply = { agents: [{ pid: 4121, decrypt: true }] }, matched = []) => ({ daemon: { state: 'running', reply }, harnesses: [{ id: 'claude-code', procs: rows }], matched })
const current = (value = null, over = {}) => ({ value, scheme: null, host: null, port: null, source: [], sha256: value ? settingSha(value) : null, changedAt: null, ...over })

test('parseLsof: address and port, the owner when lsof shows one, IPv6 without brackets and the all-interfaces star; a line it does not know is skipped, and a row with no owner is kept for the shape the topology reads (not a shape lsof prints on macOS)', () => {
  assert.deepEqual(parseLsof(`${LSOF}\nsomething else\n`), [
    { addr: '127.0.0.1', port: 7890, pid: 777, comm: 'mihomo' }, { addr: '::1', port: 9090, pid: 777, comm: 'mihomo' }, { addr: '*', port: 7000, pid: 787, comm: 'ControlCe' }, { addr: '*', port: 22 }])
})

test('processName / versionOf: the program (and its sub-command), a runtime named for the harness, the version from the path', () => {
  assert.equal(processName(['claude'], '/Users/u/.local/share/claude/versions/2.1.291', 'claude-code'), 'claude')
  assert.equal(processName(['codex', 'app-server', '--managed-daemon'], '/opt/homebrew/bin/codex', 'codex'), 'codex app-server')
  assert.equal(processName(['node', '/opt/dsh/cli.js'], '/opt/homebrew/bin/node', 'deepseek-dsh'), 'deepseek-dsh')
  // the native Claude Code is a file named by its version: that is not a program's name, so it is named for the harness like a runtime is (never `2.1.289`)
  assert.equal(processName(['2.1.289'], '/Users/u/.local/share/claude/versions/2.1.289', 'claude-code'), 'claude-code')
  assert.equal(processName(null, '/Users/u/.local/share/claude/versions/2.1.289', 'claude-code'), 'claude-code')
  assert.equal(processName(null, '/opt/homebrew/Cellar/codex/0.160.1/bin/codex', 'codex'), 'codex')
  assert.equal(processName(['claude'], '/Users/u/.local/share/claude/versions/2.1.289', 'claude-code'), 'claude', 'a program with a name keeps it')
  assert.equal(versionOf('/Users/u/.local/share/claude/versions/2.1.291'), '2.1.291')
  assert.equal(versionOf('/opt/homebrew/Cellar/codex/0.160.1/bin/codex'), '0.160.1')
  assert.equal(versionOf('/opt/homebrew/bin/mihomo'), null)
})

test('darwinNetFacts: routing is proxy; the listeners are named by their owner (the exe from the process table, else the name lsof gave), a row lsof gives no owner for says so; no TUN / route fact (D49); the OS proxy is scutil\'s dictionary with PAC\'s own flag', async () => {
  const matched = [{ h: null, p: { pid: 777, exe: '/opt/homebrew/bin/mihomo', argv: ['mihomo'], uid: 501, startedAt: Date.parse('2026-10-07T09:30:00Z') } }] // a process of no harness: the listener's owner
  const calls = []
  const f = await darwinNetFacts({ status: statusOf([], { agents: [] }, matched), settings: {}, env: {} }, { exec: runner(TABLE, calls) })
  assert.equal(f.routing, 'proxy')
  assert.deepEqual(f.listeners, [
    { addr: '127.0.0.1', port: 7890, pid: 777, exe: '/opt/homebrew/bin/mihomo' }, { addr: '::1', port: 9090, pid: 777, exe: '/opt/homebrew/bin/mihomo' },
    { addr: '*', port: 7000, pid: 787, exe: 'ControlCe' }, // not in the process table: the name lsof gave (lsof truncates it to the column's width)
    { addr: '*', port: 22, unknown: { reason: 'owner-unreadable', detail: "lsof names no process for it — not a shape its answer has on macOS; a listener of another user is not in the answer at all, for without privilege lsof cannot open its fd table" } }])
  assert.deepEqual(f.systemProxy, { value: null, pac: false })
  assert.ok(!('tun' in f), 'D49: no TUN fact')
  assert.deepEqual(f.unknowns, [])
  assert.deepEqual(calls, ['lsof -nP -iTCP -sTCP:LISTEN', 'scutil --proxy'], 'only these two reads: no route / ifconfig lookup, nothing is resolved, nothing goes out')
})

test('darwinNetFacts: a tool that is not there, is refused or prints what it should not leaves the fact unknown with the reason (never an empty list)', async () => {
  const f = await darwinNetFacts({ status: statusOf([]), settings: {} }, { exec: runner({}) })
  assert.deepEqual(f.listeners, [])
  assert.deepEqual(f.unknowns.map((u) => [u.fact, u.reason]), [['listeners', 'absent'], ['systemProxy', 'absent']])
  const refused = await darwinNetFacts({ status: statusOf([]), settings: {} }, { exec: runner({ 'lsof -nP -iTCP -sTCP:LISTEN': { status: 1, stderr: 'permission denied' } }) })
  assert.deepEqual([refused.unknowns[0].fact, refused.unknowns[0].reason, refused.unknowns[0].detail], ['listeners', 'denied', 'lsof -nP -iTCP -sTCP:LISTEN: permission denied'])
  assert.match(f.unknowns[0].detail, /^lsof -nP -iTCP -sTCP:LISTEN: /)
  const timed = await darwinNetFacts({ status: statusOf([]), settings: {} }, { exec: runner({ 'lsof -nP -iTCP -sTCP:LISTEN': { status: null, stderr: 'spawnSync lsof ETIMEDOUT' } }) })
  assert.deepEqual(timed.unknowns.map((u) => [u.fact, u.reason]), [['listeners', 'timeout'], ['systemProxy', 'absent']])
  assert.deepEqual(timed.systemProxy, { unknown: { reason: 'absent', detail: 'scutil --proxy: spawnSync scutil ENOENT' } })
  const unparsable = await darwinNetFacts({ status: statusOf([]), settings: {} }, { exec: runner({ ...TABLE, 'scutil --proxy': { stdout: 'garbage' } }) })
  assert.deepEqual(unparsable.systemProxy, { unknown: { reason: 'unparseable', detail: 'scutil --proxy: answer' } })
  assert.deepEqual(unparsable.unknowns.map((u) => [u.fact, u.reason]), [['systemProxy', 'unparseable']])
})

test('darwinNetFacts: the OS proxy is the HTTPS hop of scutil\'s dictionary; PAC is its own flag, kept beside the value (the topology prefers the flag); a proxy only in the HTTP keys sends HTTPS direct', async () => {
  const ask = async (stdout) => (await darwinNetFacts({ status: statusOf([]), settings: {} }, { exec: runner({ ...TABLE, 'scutil --proxy': { stdout } }) })).systemProxy
  assert.deepEqual(await ask('<dictionary> {\n  HTTPSEnable : 1\n  HTTPPort : 7897\n  HTTPProxy : 127.0.0.1\n  HTTPSEnable : 1\n  HTTPSPort : 7897\n  HTTPSProxy : 127.0.0.1\n  ProxyAutoConfigEnable : 0\n}'), { value: 'http://127.0.0.1:7897', pac: false })
  assert.deepEqual(await ask('<dictionary> {\n  HTTPSEnable : 1\n  HTTPPort : 7897\n  HTTPProxy : 127.0.0.1\n  ProxyAutoConfigEnable : 0\n}'), { value: null, pac: false }, 'the HTTP keys alone are not where an HTTPS request goes (WinINET\'s own rule, kept apart in the upstream reader too)')
  assert.deepEqual(await ask('<dictionary> {\n  HTTPSEnable : 1\n  HTTPSPort : 7897\n  HTTPSProxy : 127.0.0.1\n  ProxyAutoConfigEnable : 1\n}'), { value: 'http://127.0.0.1:7897', pac: true }, 'PAC is its own flag, on with the static keys still in the dictionary')
})

test('darwinNetFacts: a process carries the watch table\'s verdict (decrypt / no-decrypt / absent / unknown when the daemon did not answer), its name, version and start time', async () => {
  const exe = '/Users/u/.local/share/claude/versions/2.1.291'
  const matched = (pid) => [{ h: 'claude-code', p: { pid, exe, argv: ['claude'], uid: 501, startedAt: Date.parse('2026-10-07T09:30:00Z'), env: () => new Map() } }]
  const ask = (rows, reply, m) => darwinNetFacts({ status: statusOf(rows, reply, m), settings: { 'claude-code': current() } }, { exec: runner(TABLE) })
  const one = (await ask([row(4121)], { agents: [{ pid: 4121, decrypt: true }] }, matched(4121))).procs['claude-code'][0]
  assert.deepEqual([one.pid, one.name, one.version, one.startedAt, one.watched, one.trusted, one.negative], [4121, 'claude', '2.1.291', '2026-10-07T09:30:00.000Z', 'decrypt', true, false])
  assert.equal((await ask([row(4121)], { agents: [{ pid: 4121 }] }, matched(4121))).procs['claude-code'][0].watched, 'no-decrypt')
  assert.equal((await ask([row(4121)], { agents: [{ pid: 4121, off: true }] }, matched(4121))).procs['claude-code'][0].watched, 'absent', 'asight let it go (off)')
  assert.equal((await ask([row(4121)], { agents: [] }, matched(4121))).procs['claude-code'][0].watched, 'absent', 'not in the table')
  assert.equal((await ask([row(4121)], null, matched(4121))).procs['claude-code'][0].watched, 'unknown', 'no daemon answer: not known, not "absent"')
  assert.equal((await ask([row(4121, { negative: true, reason: 'negative-cache' })], { agents: [{ pid: 4121, decrypt: true }] }, matched(4121))).procs['claude-code'][0].negative, true)
})

test('darwinNetFacts: a harness that is off — the daemon lists its agent as `off`, the process table may not name the process — still has an agent named for the program or the harness, never for the version-named file it runs from (`claude-code 4121`, not `2.1.289 4121`)', async () => {
  const exe = '/Users/u/.local/share/claude/versions/2.1.289', startedAt = Date.parse('2026-10-07T09:30:00Z')
  const off = { agents: [{ pid: 4121, off: true, exe }] }
  const ask = async (matched) => (await darwinNetFacts({ status: statusOf([row(4121)], off, matched), settings: { 'claude-code': current() } }, { exec: runner(TABLE) })).procs['claude-code'][0]
  const unnamed = await ask([])
  assert.deepEqual([unnamed.name, unnamed.version, unnamed.watched], ['claude-code', '2.1.289', 'absent'], 'only the daemon\'s row names the file: the harness gives the name, the path gives the version')
  const byArgv = await ask([{ h: 'claude-code', p: { pid: 4121, exe, argv: ['2.1.289'], uid: 501, startedAt, env: () => new Map() } }])
  assert.equal(byArgv.name, 'claude-code')
  const named = await ask([{ h: 'claude-code', p: { pid: 4121, exe, argv: ['claude'], uid: 501, startedAt, env: () => new Map() } }])
  assert.equal(named.name, 'claude', 'the table names it: unchanged')
  // and it is that name the topology draws for the harness that is off
  const t = buildTopology(facts('claude-code', { desired: { 'claude-code': 'off' } }, { procs: [{ ...unnamed, trusted: false }] }))['claude-code']
  assert.match(renderCompact(t)[0], /^claude-code 4121 → /)
})

test('darwinNetFacts: elevation is euid/root — the process table\'s uid answers it (0 is root); a process only the daemon listed (another user\'s, the case that makes it matter) is asked of ps once; a ps that does not answer leaves it not-known', async () => {
  const startedAt = Date.parse('2026-10-07T09:30:00Z')
  const proc = (uid) => [{ h: 'claude-code', p: { pid: 4121, exe: '/Users/u/claude', argv: ['claude'], ...(uid === undefined ? {} : { uid }), startedAt, env: () => new Map() } }]
  const ask = async (matched, table = TABLE, calls = []) => (await darwinNetFacts({ status: statusOf([row(4121)], { agents: [{ pid: 4121, decrypt: true }] }, matched), settings: {} }, { exec: runner(table, calls) })).procs['claude-code'][0]
  assert.equal((await ask(proc(501))).elevated, false, 'a process of this user: the table\'s uid')
  assert.equal((await ask(proc(0))).elevated, true, 'root in the table (a sudo-launched agent)')
  const calls = []
  assert.equal((await ask([], { ...TABLE, 'ps -o uid= -p 4121': { stdout: '0' } }, calls)).elevated, true, 'a process only the daemon listed: ps is asked for its uid')
  assert.deepEqual(calls, ['ps -o uid= -p 4121', 'lsof -nP -iTCP -sTCP:LISTEN', 'scutil --proxy'], 'one ps ask, then the reads of the machine')
  assert.equal((await ask([], { ...TABLE, 'ps -o uid= -p 4121': { stdout: '501' } })).elevated, false)
  assert.equal((await ask([], TABLE)).elevated, null, 'ps did not answer: not known, not "not elevated"')
  assert.equal((await ask(proc(undefined))).elevated, null, 'a table row with no uid says not-known (the ask is for processes the table does not have)')
})
