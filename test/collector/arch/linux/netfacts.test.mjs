// test/collector/arch/linux/netfacts.test.mjs — Linux's part of the network facts (RFC 1.6 §9.7, 4.6 「eBPF 模式下的网络拓扑」): the processes of each harness with the watch table's verdict and the proxy each was started with,
// the listeners on the machine Everything is injected: a synthetic /proc, a fake `ss` / `ip` runner, a sandbox HOME; nothing reads the machine and nothing is spawned.
import test from 'node:test'
import assert from 'node:assert/strict'
import { linuxNetFacts, parseSs, processName, versionOf } from '../../../../src/collector/arch/linux/netfacts.mjs'
import { settingSha } from '../../../../src/netenv/redact.mjs'
import { loadHarnesses } from '../../../../src/collector/harness/index.mjs'
import { fakeProc } from './fixtures/fake-proc.mjs'
import { buildTopology, renderCompact } from '../../../../src/netenv/topology.mjs'
import { facts } from '../../../netenv/fixtures/rows.mjs'

const descs = await loadHarnesses() // the keys a process's proxy is read from are each harness's own (`proxy.env`)

const SS = [
  'LISTEN 0 4096 127.0.0.1:7890 0.0.0.0:* users:(("mihomo",pid=777,fd=7))',
  'LISTEN 0 4096 [::1]:9090 [::]:* users:(("mihomo",pid=777,fd=8))',
  'LISTEN 0 128 0.0.0.0:22 0.0.0.0:*',
].join('\n')

/** The runner of `ss` / `ip`: spawnSync-shaped, answers from a table, records what it was asked. */
const runner = (table, calls = []) => (file, args) => {
  calls.push([file, ...args].join(' '))
  const r = table[[file, ...args].join(' ')] ?? { status: null, stdout: '', stderr: '', error: new Error(`spawnSync ${file} ENOENT`) }
  return { status: 0, stdout: '', stderr: '', ...r }
}
const TABLE = { 'ss -ltnpH': { stdout: SS } }
const row = (pid, over = {}) => ({ pid, trusted: true, reason: null, negative: false, startedAt: Date.parse('2026-10-07T09:30:00Z'), ...over })
const statusOf = (rows, reply = { agents: [{ pid: 4121, decrypt: true }] }, matched = []) => ({ daemon: { state: 'running', reply }, harnesses: [{ id: 'claude-code', procs: rows }], matched })
const current = (value = null, over = {}) => ({ value, scheme: null, host: null, port: null, source: [], sha256: value ? settingSha(value) : null, changedAt: null, ...over })

test('parseSs: address and port, the owner when ss shows one, IPv6 without brackets; a line it does not know is skipped', () => {
  assert.deepEqual(parseSs(`${SS}\nsomething else\n`), [
    { addr: '127.0.0.1', port: 7890, pid: 777, comm: 'mihomo' }, { addr: '::1', port: 9090, pid: 777, comm: 'mihomo' }, { addr: '0.0.0.0', port: 22 }])
})

test('processName / versionOf: the program (and its sub-command), a runtime named for the harness, the version from the path', () => {
  assert.equal(processName(['claude'], '/home/u/.local/share/claude/versions/2.1.291', 'claude-code'), 'claude')
  assert.equal(processName(['codex', 'app-server', '--managed-daemon'], '/x/codex', 'codex'), 'codex app-server')
  assert.equal(processName(['node', '/opt/dsh/cli.js'], '/usr/bin/node', 'deepseek-dsh'), 'deepseek-dsh')
  // the native Claude Code is a file named by its version: that is not a program's name, so it is named for the harness like a runtime is (never `2.1.289`)
  assert.equal(processName(['2.1.289'], '/home/u/.local/share/claude/versions/2.1.289', 'claude-code'), 'claude-code')
  assert.equal(processName(null, '/home/u/.local/share/claude/versions/2.1.289', 'claude-code'), 'claude-code')
  assert.equal(processName(null, '/opt/codex/releases/0.160.1', 'codex'), 'codex')
  assert.equal(processName(['claude'], '/home/u/.local/share/claude/versions/2.1.289', 'claude-code'), 'claude', 'a program with a name keeps it')
  assert.equal(versionOf('/home/u/.local/share/claude/versions/2.1.291'), '2.1.291')
  assert.equal(versionOf('/opt/codex/releases/0.160.1/bin/codex'), '0.160.1')
  assert.equal(versionOf('/usr/bin/mihomo'), null)
})

test('linuxNetFacts: routing is driver; the listeners are named by their owner (the exe under /proc, else the name ss gave), another user\'s has no owner and says so; no TUN / route fact (D49)', async () => {
  const p = fakeProc(), calls = []
  try {
    p.add(777, { exe: '/usr/bin/mihomo', argv: ['mihomo'] })
    const f = await linuxNetFacts({ status: statusOf([]), settings: {}, env: {} }, { exec: runner(TABLE, calls), procRoot: p.root })
    assert.equal(f.routing, 'driver')
    assert.deepEqual(f.listeners, [
      { addr: '127.0.0.1', port: 7890, pid: 777, exe: '/usr/bin/mihomo' }, { addr: '::1', port: 9090, pid: 777, exe: '/usr/bin/mihomo' },
      { addr: '0.0.0.0', port: 22, unknown: { reason: 'owner-unreadable', detail: "ss lists no process for it: it is another user's, or ss was not allowed to see it" } }])
    assert.ok(!('tun' in f), 'D49: no TUN fact')
    assert.deepEqual(f.unknowns, [])
    assert.deepEqual(calls, ['ss -ltnpH'], 'only this one read: no route lookup, nothing is resolved, nothing goes out')
  } finally { p.done() }
})

test('linuxNetFacts: a tool that is not there, is refused or prints what it should not leaves the fact unknown with the reason (never an empty list)', async () => {
  const f = await linuxNetFacts({ status: statusOf([]), settings: {} }, { exec: runner({}), procRoot: '/nonexistent' })
  assert.deepEqual(f.listeners, [])
  assert.deepEqual(f.unknowns.map((u) => [u.fact, u.reason]), [['listeners', 'absent']])
  const refused = await linuxNetFacts({ status: statusOf([]), settings: {} }, { exec: runner({ 'ss -ltnpH': { status: 1, stderr: 'permission denied' } }), procRoot: '/x' })
  assert.deepEqual([refused.unknowns[0].fact, refused.unknowns[0].reason, refused.unknowns[0].detail], ['listeners', 'denied', 'ss -ltnpH: permission denied'])
  assert.match(f.unknowns[0].detail, /^ss -ltnpH: /)
  const timed = await linuxNetFacts({ status: statusOf([]), settings: {} }, { exec: runner({ 'ss -ltnpH': { status: null, stderr: 'spawnSync ss ETIMEDOUT' } }), procRoot: '/x' })
  assert.deepEqual(timed.unknowns.map((u) => [u.fact, u.reason]), [['listeners', 'timeout']])
})

test('linuxNetFacts: a process carries the watch table\'s verdict (decrypt / no-decrypt / absent / unknown when the daemon did not answer), its name, version and start time', async () => {
  const p = fakeProc()
  try {
    const exe = '/home/u/.local/share/claude/versions/2.1.291'
    p.add(4121, { exe, argv: ['claude'], env: {} })
    const matched = (pid) => [{ h: 'claude-code', p: { pid, exe, argv: ['claude'], startedAt: Date.parse('2026-10-07T09:30:00Z'), env: () => new Map() } }]
    const ask = (rows, reply, m) => linuxNetFacts({ status: statusOf(rows, reply, m), settings: { 'claude-code': current() } }, { exec: runner(TABLE), procRoot: p.root })
    const one = (await ask([row(4121)], { agents: [{ pid: 4121, decrypt: true }] }, matched(4121))).procs['claude-code'][0]
    assert.deepEqual([one.pid, one.name, one.version, one.startedAt, one.watched, one.trusted, one.negative, one.startSetting], [4121, 'claude', '2.1.291', '2026-10-07T09:30:00.000Z', 'decrypt', true, false, null])
    assert.equal((await ask([row(4121)], { agents: [{ pid: 4121 }] }, matched(4121))).procs['claude-code'][0].watched, 'no-decrypt')
    assert.equal((await ask([row(4121)], { agents: [{ pid: 4121, off: true }] }, matched(4121))).procs['claude-code'][0].watched, 'absent', 'asight let it go (off)')
    assert.equal((await ask([row(4121)], { agents: [] }, matched(4121))).procs['claude-code'][0].watched, 'absent', 'not in the table')
    assert.equal((await ask([row(4121)], null, matched(4121))).procs['claude-code'][0].watched, 'unknown', 'no daemon answer: not known, not "absent"')
    assert.equal((await ask([row(4121, { negative: true, reason: 'negative-cache' })], { agents: [{ pid: 4121, decrypt: true }] }, matched(4121))).procs['claude-code'][0].negative, true)
  } finally { p.done() }
})

test('linuxNetFacts: a harness that is off — the daemon lists its agent as `off`, the process table may not name the process — still has an agent named for the program or the harness, never for the version-named file it runs from (`claude-code 4121`, not `2.1.289 4121`)', async () => {
  const exe = '/home/u/.local/share/claude/versions/2.1.289', startedAt = Date.parse('2026-10-07T09:30:00Z')
  const off = { agents: [{ pid: 4121, off: true, exe }] }
  const ask = async (matched) => (await linuxNetFacts({ status: statusOf([row(4121)], off, matched), settings: { 'claude-code': current() } }, { exec: runner(TABLE), procRoot: '/x' })).procs['claude-code'][0]
  const unnamed = await ask([])
  assert.deepEqual([unnamed.name, unnamed.version, unnamed.watched], ['claude-code', '2.1.289', 'absent'], 'only the daemon\'s row names the file: the harness gives the name, the path gives the version')
  const byArgv = await ask([{ h: 'claude-code', p: { pid: 4121, exe, argv: ['2.1.289'], startedAt, env: () => new Map() } }])
  assert.equal(byArgv.name, 'claude-code')
  const named = await ask([{ h: 'claude-code', p: { pid: 4121, exe, argv: ['claude'], startedAt, env: () => new Map() } }])
  assert.equal(named.name, 'claude', 'the table names it: unchanged')
  // and it is that name the topology draws for the harness that is off
  const t = buildTopology(facts('claude-code', { desired: { 'claude-code': 'off' } }, { procs: [{ ...unnamed, trusted: false }] }))['claude-code']
  assert.match(renderCompact(t)[0], /^claude-code 4121 → /)
})

test('linuxNetFacts: the proxy a process was started with is read from its environment and compared with what a new one reads now — the same is null, another is redacted with a hash, none is a null value, an unreadable environment is unknown', async () => {
  const exe = '/home/u/.local/share/claude/versions/2.1.291', startedAt = Date.parse('2026-10-07T09:30:00Z')
  const startOf = async (envMap, cur) => {
    const m = [{ h: 'claude-code', p: { pid: 4121, exe, argv: ['claude'], startedAt, env: () => envMap } }]
    return (await linuxNetFacts({ status: statusOf([row(4121)], undefined, m), settings: { 'claude-code': cur }, harnesses: descs }, { exec: runner(TABLE), procRoot: '/x' })).procs['claude-code'][0].startSetting
  }
  const now = current('http://127.0.0.1:7890')
  assert.equal(await startOf(new Map([['HTTPS_PROXY', 'http://127.0.0.1:7890']]), now), null, 'started with what a new process reads now')
  const old = await startOf(new Map([['HTTPS_PROXY', 'http://alice:pw@old.corp:3128']]), now)
  assert.deepEqual([old.value, old.host, old.port, old.sha256, old.source], ['http://***@old.corp:3128', 'old.corp', 3128, settingSha('http://alice:pw@old.corp:3128'), [{ kind: 'env', where: 'HTTPS_PROXY' }]])
  assert.ok(!/alice|pw@/.test(JSON.stringify(old)))
  const none = await startOf(new Map(), now)
  assert.deepEqual([none.value, none.sha256], [null, null], 'started with none, a new one reads one')
  assert.equal((await startOf(null, now)).unknown.reason, 'denied', 'the environment of a process of another user cannot be read')
  assert.equal((await startOf(new Map([['HTTPS_PROXY', 'not a url s3cr3t']]), now)).unknown.reason, 'unparseable')
  assert.ok(!/s3cr3t/.test(JSON.stringify(await startOf(new Map([['HTTPS_PROXY', 'not a url s3cr3t']]), now))))
  assert.equal(await startOf(new Map([['HTTPS_PROXY', 'x']]), { unknown: { reason: 'denied', detail: 'd' } }), null, 'when what a new one reads is not known there is nothing to compare')
})

test('linuxNetFacts: a setting from a FILE that changed after the process started leaves the process on the value it had — only `adopted` remembers it; without that, not known', async () => {
  const exe = '/x/claude', startedAt = Date.parse('2026-10-07T09:30:00Z')
  const m = [{ h: 'claude-code', p: { pid: 4121, exe, argv: ['claude'], startedAt, env: () => new Map() } }]
  const file = { kind: 'file', where: '/h/.claude/settings.json', key: 'env.HTTPS_PROXY' }
  const after = current('http://127.0.0.1:7890', { source: [file], changedAt: '2026-10-07T09:45:00.000Z' })
  const ask = async (cur, adopted) => (await linuxNetFacts({ status: statusOf([row(4121)], undefined, m), settings: { 'claude-code': cur }, adopted, harnesses: descs }, { exec: runner(TABLE), procRoot: '/x' })).procs['claude-code'][0].startSetting
  assert.deepEqual((await ask(after, null)).unknown.reason, 'absent')
  const had = await ask(after, { 'claude-code': { proxy: 'http://***@old.corp:3128', source: [file], sha256: 'abc' } })
  assert.deepEqual([had.value, had.host, had.inferred, had.sha256], ['http://***@old.corp:3128', 'old.corp', true, 'abc'])
  const hadNone = await ask(after, { 'claude-code': { proxy: null, source: [], sha256: null } })
  assert.deepEqual([hadNone.value, hadNone.inferred], [null, true], 'it had none when `on` looked')
  assert.equal(await ask(current('http://127.0.0.1:7890', { source: [file], changedAt: '2026-10-07T09:00:00.000Z' }), null), null, 'a file older than the process: the process read it')
})

test('linuxNetFacts: a process\'s start-time proxy is read from the keys ITS harness reads (`proxy.env`, in its order) and from no other — ALL_PROXY is nothing to claude-code, HTTPS_PROXY nothing to z-code', async () => {
  const startedAt = Date.parse('2026-10-07T09:30:00Z')
  const ask = async (h, envMap, cur = current()) => {
    const m = [{ h, p: { pid: 4121, exe: `/x/${h}`, argv: [h], startedAt, env: () => envMap } }]
    const status = { daemon: { state: 'running', reply: { agents: [{ pid: 4121, decrypt: true }] } }, harnesses: [{ id: h, procs: [row(4121)] }], matched: m }
    return (await linuxNetFacts({ status, settings: { [h]: cur }, harnesses: descs }, { exec: runner(TABLE), procRoot: '/x' })).procs[h][0].startSetting
  }
  const only = (k, v) => new Map([[k, v]])
  // claude-code reads HTTPS_PROXY, https_proxy, HTTP_PROXY, http_proxy — not ALL_PROXY: a process that has only that was started with no proxy, and a new one reads none: the same
  assert.equal(await ask('claude-code', only('ALL_PROXY', 'socks5://127.0.0.1:1080')), null, 'ALL_PROXY is not a setting of claude-code')
  assert.equal(await ask('claude-code', only('all_proxy', 'socks5://127.0.0.1:1080')), null)
  assert.equal(await ask('claude-code', only('NO_PROXY', 'api.anthropic.com')), null)
  // its own keys are, in the descriptor's order: HTTPS_PROXY wins over HTTP_PROXY, the lower-case spelling comes after
  const both = new Map([['HTTP_PROXY', 'http://h.corp:1'], ['HTTPS_PROXY', 'http://s.corp:2']])
  assert.deepEqual([(await ask('claude-code', both)).host, (await ask('claude-code', both)).source], ['s.corp', [{ kind: 'env', where: 'HTTPS_PROXY' }]])
  assert.equal((await ask('claude-code', only('http_proxy', 'http://l.corp:3'))).host, 'l.corp')
  // the same process with a proxy that a new one reads now: not a difference
  assert.equal(await ask('claude-code', new Map([['ALL_PROXY', 'socks5://127.0.0.1:1080'], ['HTTPS_PROXY', 'http://127.0.0.1:7890']]), current('http://127.0.0.1:7890')), null)
  // z-code reads ZCODE_HTTP_PROXY alone: a process with HTTPS_PROXY was started with none
  assert.equal(await ask('z-code', only('HTTPS_PROXY', 'http://127.0.0.1:7890')), null, 'HTTPS_PROXY is nothing to z-code')
  assert.equal((await ask('z-code', only('ZCODE_HTTP_PROXY', 'socks5h://127.0.0.1:1080'))).host, '127.0.0.1')
  // codex does read ALL_PROXY (after HTTPS_PROXY)
  assert.equal((await ask('codex', only('ALL_PROXY', 'socks5://127.0.0.1:1080'))).scheme, 'socks5')
  // no descriptor for the harness → the keys are not known: no claim about what the process was started with
  assert.equal((await linuxNetFacts({ status: { daemon: { state: 'running', reply: { agents: [] } }, harnesses: [{ id: 'claude-code', procs: [row(4121)] }], matched: [{ h: 'claude-code', p: { pid: 4121, exe: '/x', argv: ['claude'], startedAt, env: () => only('HTTPS_PROXY', 'http://a:1') } }] }, settings: { 'claude-code': current() }, harnesses: [] }, { exec: runner(TABLE), procRoot: '/x' })).procs['claude-code'][0].startSetting, null)
})

test('linuxNetFacts: a process carries which of its harness\'s API hosts its own NO_PROXY covers — [] when none, null when its environment cannot be read (not "none")', async () => {
  const startedAt = Date.parse('2026-10-07T09:30:00Z')
  const ask = async (envMap) => {
    const m = [{ h: 'claude-code', p: { pid: 4121, exe: '/x/claude', argv: ['claude'], startedAt, env: () => envMap } }]
    return (await linuxNetFacts({ status: statusOf([row(4121)], undefined, m), settings: { 'claude-code': current() }, harnesses: descs }, { exec: runner(TABLE), procRoot: '/x' })).procs['claude-code'][0].noProxy
  }
  assert.deepEqual(await ask(new Map([['NO_PROXY', 'localhost,.anthropic.com']])), ['api.anthropic.com'])
  assert.deepEqual(await ask(new Map([['no_proxy', 'api.anthropic.com']])), ['api.anthropic.com'])
  assert.deepEqual(await ask(new Map([['NO_PROXY', 'example.com']])), [])
  assert.deepEqual(await ask(new Map()), [])
  assert.equal(await ask(null), null, 'an environment of another user\'s process: not known')
})
