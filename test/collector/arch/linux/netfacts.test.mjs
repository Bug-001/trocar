// test/collector/arch/linux/netfacts.test.mjs — Linux's part of the network facts (RFC 1.6 §9.7, 4.6 「eBPF 模式下的网络拓扑」): the processes of each harness with the watch table's verdict and the proxy each was started with,
// the listeners on the machine and whether the way out is a TUN device. Everything is injected: a synthetic /proc, a fake `ss` / `ip` runner, a sandbox HOME; nothing reads the machine and nothing is spawned.
import test from 'node:test'
import assert from 'node:assert/strict'
import { linuxNetFacts, parseSs, processName, versionOf } from '../../../../src/collector/arch/linux/netfacts.mjs'
import { settingSha } from '../../../../src/netenv/redact.mjs'
import { fakeProc } from './fixtures/fake-proc.mjs'

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
const ROUTE = JSON.stringify([{ dst: '1.1.1.1', dev: 'eth0' }])
const TABLE = { 'ss -ltnpH': { stdout: SS }, 'ip -j route get 1.1.1.1': { stdout: ROUTE }, 'ip -j -d link show dev eth0': { stdout: JSON.stringify([{ ifname: 'eth0', linkinfo: {} }]) } }
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
  assert.equal(versionOf('/home/u/.local/share/claude/versions/2.1.291'), '2.1.291')
  assert.equal(versionOf('/opt/codex/releases/0.160.1/bin/codex'), '0.160.1')
  assert.equal(versionOf('/usr/bin/mihomo'), null)
})

test('linuxNetFacts: routing is driver; the listeners are named by their owner (the exe under /proc, else the name ss gave), another user\'s has no owner and says so; TUN is read from the link of the default route', async () => {
  const p = fakeProc(), calls = []
  try {
    p.add(777, { exe: '/usr/bin/mihomo', argv: ['mihomo'] })
    const f = await linuxNetFacts({ status: statusOf([]), settings: {}, env: {} }, { exec: runner(TABLE, calls), procRoot: p.root })
    assert.equal(f.routing, 'driver')
    assert.deepEqual(f.listeners, [
      { addr: '127.0.0.1', port: 7890, pid: 777, exe: '/usr/bin/mihomo' }, { addr: '::1', port: 9090, pid: 777, exe: '/usr/bin/mihomo' },
      { addr: '0.0.0.0', port: 22, unknown: { reason: 'owner-unreadable', detail: "ss lists no process for it: it is another user's, or ss was not allowed to see it" } }])
    assert.equal(f.tun, false)
    assert.deepEqual(f.unknowns, [])
    assert.deepEqual(calls, ['ss -ltnpH', 'ip -j route get 1.1.1.1', 'ip -j -d link show dev eth0'], 'only these three reads, and the route lookup names no host: nothing is resolved, nothing goes out')
    const tun = await linuxNetFacts({ status: statusOf([]), settings: {} }, { exec: runner({ ...TABLE, 'ip -j route get 1.1.1.1': { stdout: JSON.stringify([{ dev: 'Meta' }]) }, 'ip -j -d link show dev Meta': { stdout: JSON.stringify([{ linkinfo: { info_kind: 'tun' } }]) } }), procRoot: p.root })
    assert.equal(tun.tun, true)
  } finally { p.done() }
})

test('linuxNetFacts: a tool that is not there, is refused or prints what it should not leaves the fact unknown with the reason (never an empty list, never "no TUN")', async () => {
  const f = await linuxNetFacts({ status: statusOf([]), settings: {} }, { exec: runner({}), procRoot: '/nonexistent' })
  assert.deepEqual(f.listeners, [])
  assert.equal(f.tun, null)
  assert.deepEqual(f.unknowns.map((u) => [u.fact, u.reason]), [['listeners', 'absent'], ['tun', 'absent']])
  const refused = await linuxNetFacts({ status: statusOf([]), settings: {} }, { exec: runner({ 'ss -ltnpH': { status: 1, stderr: 'permission denied' } }), procRoot: '/x' })
  assert.deepEqual([refused.unknowns[0].fact, refused.unknowns[0].reason, refused.unknowns[0].detail], ['listeners', 'denied', 'ss -ltnpH: permission denied'])
  assert.match(f.unknowns[0].detail, /^ss -ltnpH: /)
  const timed = await linuxNetFacts({ status: statusOf([]), settings: {} }, { exec: runner({ 'ss -ltnpH': { status: null, stderr: 'spawnSync ss ETIMEDOUT' }, 'ip -j route get 1.1.1.1': { stdout: 'not json' } }), procRoot: '/x' })
  assert.deepEqual(timed.unknowns.map((u) => [u.fact, u.reason]), [['listeners', 'timeout'], ['tun', 'unparseable']])
  const nodev = await linuxNetFacts({ status: statusOf([]), settings: {} }, { exec: runner({ ...TABLE, 'ip -j -d link show dev eth0': { stdout: 'x' } }), procRoot: '/x' })
  assert.deepEqual(nodev.unknowns.map((u) => [u.fact, u.reason]), [['tun', 'unparseable']])
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

test('linuxNetFacts: the proxy a process was started with is read from its environment and compared with what a new one reads now — the same is null, another is redacted with a hash, none is a null value, an unreadable environment is unknown', async () => {
  const exe = '/home/u/.local/share/claude/versions/2.1.291', startedAt = Date.parse('2026-10-07T09:30:00Z')
  const startOf = async (envMap, cur) => {
    const m = [{ h: 'claude-code', p: { pid: 4121, exe, argv: ['claude'], startedAt, env: () => envMap } }]
    return (await linuxNetFacts({ status: statusOf([row(4121)], undefined, m), settings: { 'claude-code': cur } }, { exec: runner(TABLE), procRoot: '/x' })).procs['claude-code'][0].startSetting
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
  const ask = async (cur, adopted) => (await linuxNetFacts({ status: statusOf([row(4121)], undefined, m), settings: { 'claude-code': cur }, adopted }, { exec: runner(TABLE), procRoot: '/x' })).procs['claude-code'][0].startSetting
  assert.deepEqual((await ask(after, null)).unknown.reason, 'absent')
  const had = await ask(after, { 'claude-code': { proxy: 'http://***@old.corp:3128', source: [file], sha256: 'abc' } })
  assert.deepEqual([had.value, had.host, had.inferred, had.sha256], ['http://***@old.corp:3128', 'old.corp', true, 'abc'])
  const hadNone = await ask(after, { 'claude-code': { proxy: null, source: [], sha256: null } })
  assert.deepEqual([hadNone.value, hadNone.inferred], [null, true], 'it had none when `on` looked')
  assert.equal(await ask(current('http://127.0.0.1:7890', { source: [file], changedAt: '2026-10-07T09:00:00.000Z' }), null), null, 'a file older than the process: the process read it')
})
