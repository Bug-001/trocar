// test/off/main.test.mjs — `asight off` as a command line (RFC 1.6 §2, §3, R4–R7, V5's names and --json half, V6 for off): the arguments, root, the platform,
// --json, --dry-run, --now, and the receipt text of the §7 example. A sandbox HOME in which the real `on` has run; the daemon, systemd and the process table injected.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import os from 'node:os'
import { runOffCli, resolveOffNames } from '../../src/off/main.mjs'
import { formatOffReceipt } from '../../src/off/receipt.mjs'
import { validateReceipt } from '../../src/cli/schema.mjs'
import { fakeIo, snapshot } from '../cli/fixtures/on-ctx.mjs'
import { installedHome, flowEvents } from './fixtures/off-ctx.mjs'
import { tmpDir } from '../helpers/tmp.mjs'

const ctx = (s, io, { deps = {}, platform = 'linux' } = {}) => ({ io, home: s.home, env: s.sh.env, platform, deps: s.offDeps({ getuid: () => 1000, ...deps }) })
const changedRel = (s, r) => r.changed.map((c) => path.relative(s.home, c.path)).sort()

test('V6 (off): an unknown option and an unknown harness exit 2, name what is known, and leave the sandbox HOME byte for byte; a name given twice or by alias is one harness', async () => {
  const s = await installedHome({ names: ['claude-code', 'codex'] }); const before = snapshot(s.home)
  let io = fakeIo(); assert.equal(await runOffCli(['--nope'], ctx(s, io)), 2); assert.match(io.text(), /unknown option --nope/)
  io = fakeIo(); assert.equal(await runOffCli(['clade', 'codex'], ctx(s, io)), 2)
  assert.match(io.text(), /unknown harness clade; the names are: claude-code, codex, hermes, opencode, deepseek-dsh, kimi-code, z-code, claude, dsh, kimi, zcode/)
  assert.deepEqual(snapshot(s.home), before, 'exit 2: not one byte moved, nothing asked of the daemon')
  assert.deepEqual(s.sys.daemon.calls.filter((c) => c.startsWith('POST /off')), [])
  assert.deepEqual(resolveOffNames(['claude', 'claude-code', 'kimi']), { ok: true, ids: ['claude-code', 'kimi-code'] })
  assert.deepEqual(resolveOffNames([]), { ok: true, ids: null })
  assert.equal(resolveOffNames(['constructor']).ok, false, 'a property name of Object is not a harness')
})

test('V5 (names and --json): off claude and off claude-code give the same result; --json is ONE document that names claude-code only, never the alias; the receipt validates (R5)', async () => {
  const a = await installedHome({ names: ['claude-code', 'codex'] }), b = await installedHome({ names: ['claude-code', 'codex'] })
  const ioA = fakeIo(), ioB = fakeIo()
  assert.equal(await runOffCli(['claude', '--json'], ctx(a, ioA)), 0)
  assert.equal(await runOffCli(['claude-code', '--json'], ctx(b, ioB)), 0)
  const ra = ioA.json(), rb = ioB.json() // JSON.parse of the whole of stdout: nothing else was printed there
  assert.deepEqual([validateReceipt(ra), validateReceipt(rb)], [[], []])
  assert.deepEqual([ra.harnesses, rb.harnesses, ra.command, ra.ok], [['claude-code'], ['claude-code'], 'off', true])
  assert.deepEqual([changedRel(a, ra), a.sys.daemon.calls.filter((c) => c.startsWith('POST /off'))], [changedRel(b, rb), b.sys.daemon.calls.filter((c) => c.startsWith('POST /off'))])
  assert.ok(!/"claude"/.test(ioA.stdoutText()), 'the alias is input only')
  assert.ok(ra.changed.every((c) => c.harness === 'claude-code'))
})

test('R7: off as root is refused, nothing is written, nothing is asked of the daemon, exit 1', async () => {
  const s = await installedHome({ names: ['claude-code'] }); const before = snapshot(s.home); const calls = s.sys.exec.calls.length
  const io = fakeIo()
  assert.equal(await runOffCli([], ctx(s, io, { deps: { getuid: () => 0 } })), 1)
  assert.match(io.text(), /root/)
  assert.deepEqual([snapshot(s.home), s.sys.exec.calls.length, s.sys.daemon.calls.filter((c) => c.startsWith('POST /off'))], [before, calls, []])
})

test('1.6 §4 (D39⑥ executed 2026-10-11: the legacy off went with the old capture): every platform runs the NEW off — the undo arms, the receipt, the daemon told to drain and exit', async () => {
  const s = await installedHome({ names: ['claude-code'] })
  const io = fakeIo()
  assert.equal(await runOffCli([], ctx(s, io, { platform: 'darwin' })), 0, io.text())
  assert.match(io.stdoutText(), /^asight 已关闭采集。/, 'the NEW off ran and printed its receipt')
  assert.doesNotMatch(io.stdoutText(), /NODE_EXTRA_CA_CERTS/, 'and it took no certificate item: those are install\'s (D55①)')
  assert.deepEqual(s.sys.daemon.calls.filter((c) => c.startsWith('POST /off')), ['POST /off {"exit":true}'], 'an arm only the new off has: the daemon was told to drain and exit')
})

test('R6: --dry-run writes nothing — not a byte, not a flows/ line, nothing asked of the daemon — exits 0, prints the same files in the future tense as the real run then changes; --now is passed on; the old --remove-ca is a plain unknown option now', async () => {
  const s = await installedHome({ names: ['claude-code', 'codex'] }); const before = snapshot(s.home); const calls = s.sys.exec.calls.length
  const dry = fakeIo()
  assert.equal(await runOffCli(['--dry-run', '--json'], ctx(s, dry)), 0)
  const d = dry.json()
  assert.deepEqual([snapshot(s.home), s.sys.exec.calls.length, s.sys.daemon.calls.filter((c) => c.startsWith('POST /off'))], [before, calls, []])
  assert.deepEqual([d.dry_run, d.ok, validateReceipt(d)], [true, true, []])
  const ca = fakeIo(); assert.equal(await runOffCli(['--remove-ca'], ctx(s, ca)), 2); assert.match(ca.stderrText(), /^asight off: unknown option --remove-ca\n/)
  const text = fakeIo(); assert.equal(await runOffCli(['--dry-run'], ctx(s, text)), 0)
  assert.match(text.stdoutText(), /^asight 将关闭采集。/); assert.doesNotMatch(text.stdoutText(), /settings\.json|已关闭|已回到/, 'the plan names no certificate item: off spares them (D55①)')
  assert.deepEqual(snapshot(s.home), before)
  const real = fakeIo(); const t = await installedHome({ names: ['claude-code', 'codex'] })
  assert.equal(await runOffCli(['--now', '--json'], ctx(t, real)), 0)
  assert.deepEqual(changedRel(t, real.json()), changedRel(s, d).map((p) => p), 'the dry run named the files the real run changed')
  assert.deepEqual(t.sys.daemon.calls.filter((c) => c.startsWith('POST /off')), ['POST /off {"now":true,"exit":true}'])
})

test('1.6 §7: the receipt text of an off with no names — no certificate item (D55①), the autostart, the daemon draining with its connections, who still trusts the CA, the processes the user started — and a failed off says what is left', async () => {
  const s = await installedHome({ names: ['claude-code', 'codex'], daemon: { relayed: { closing: 2, waiting: 1, cut: 0 }, exitOnOff: false } })
  fs.appendFileSync(path.join(s.home, '.codex', '.env'), 'EXTRA=1\n')
  const procs = async () => [
    { pid: 4388, ppid: 1, uid: 1000, startedAt: Date.now() + 5000, exe: '/home/u/.local/share/claude/versions/2.1.289', argv: ['claude'], env: () => new Map() },
    { pid: 5310, ppid: 1, uid: 1000, startedAt: 1, exe: '/usr/bin/node', argv: ['node', '/repo/bin/asight.mjs', 'serve'], env: () => new Map() },
  ]
  const io = fakeIo()
  assert.equal(await runOffCli([], ctx(s, io, { deps: { procs } })), 0, io.text())
  const out = io.stdoutText()
  assert.match(out, /^asight 已关闭采集。\n/)
  assert.match(out, /没有改任何用户文件/, 'no certificate item is touched, the edited one neither (D55①)')
  assert.match(out, /说明: what asight install wrote stays — off never touches it; asight uninstall removes it: .*\.codex\/\.env/, 'they are named as staying, once')
  assert.match(out, /自启已停用;守护进程仍在排空:pid 4242,还剩 1 条等它们自己关闭;asight off --now 立即切断: 2 条连接仍经 asight 中转,本次响应\(或本轮\)结束后关闭;其中 1 条是透传连接或看不到终止消息的 WebSocket/)
  assert.doesNotMatch(out, /重启前仍信任 asight CA/, 'off took no trust away, so it names no one as still trusting it')
  assert.match(out, /你自己起的 asight 进程仍在跑: asight serve\(pid 5310,只读看板,不在 agent 路径上\)/)
  assert.match(out, /引流: 已摘\(守护进程回复了,已确认\)/)
  assert.ok(out.trimEnd().endsWith('再开  asight on'), 'the last line says how to turn it back on')
  const bad = formatOffReceipt({ ok: false, all: true, harnesses: [], routing: { confirmed: true }, daemon: { pid: 9, state: 'unresponsive' }, relayed: 'unknown', relayed_reason: 'the daemon does not answer', changed: [], removed: [], skipped: [], left: [{ path: '/h/.codex/.env', result: 'left-unparsable', reason: 'is no longer valid JSON' }], problems: ['x'], notes: [] }, { home: '/h' })
  assert.match(bad, /^asight 没有做完\(引流已摘,其余原因在下面\)。/m)
  assert.match(bad, /守护进程\(pid 9\)没响应,也停不掉:手动停止 kill -9 9/); assert.match(bad, /仍经 asight 的连接数: 不知道\(the daemon does not answer\)/)
  assert.match(bad, /没撤掉: ~\/\.codex\/\.env\(is no longer valid JSON\)/)
})

test('R6 · R5: with --json a question about the marks goes to stderr and stdout stays one JSON document; with no manifest and no terminal the plan is in the receipt and the exit is 1', async () => {
  const s = await installedHome({ names: ['codex'] }); fs.rmSync(path.join(s.dir, 'install-manifest.json'))
  const io = fakeIo({ tty: false })
  assert.equal(await runOffCli(['--json'], ctx(s, io)), 1)
  const r = io.json()
  assert.deepEqual([r.ok, r.pending.map((p) => path.basename(p.path)), validateReceipt(r)], [false, ['.env'], []])
  assert.equal(flowEvents(s.dir).at(-1).outcome, 'partial')
})

test('the standalone asight-off passes no io: the process\'s own stdout and stderr are what it prints on', async () => {
  const written = []
  const real = process.stderr.write
  process.stderr.write = (chunk) => { written.push(String(chunk)); return true }
  try { assert.equal(await runOffCli(['--bogus']), 2) } finally { process.stderr.write = real }
  assert.match(written.join(''), /asight off: unknown option --bogus/)
})

// the flip's seam 2 (4.9 §4): runOffCli threads ITS platform into runOff's deps, so offWorld runs the arm the CLI was told — not the host's. Pre-flip a Linux
// sandbox on a Mac host silently ran the darwin arms (the gap surfaced when the darwin arm started asking launchctl). The observable that pins it on ANY
// host: win32's control.json — its socket AND its token are a win32-arm thing (offWorld reads control.json only there); without the threading the host's
// arm asks the lock's socket with no token at all.
test('the flip\'s platform threading: runOffCli\'s platform is offWorld\'s — the win32 arm (control.json\'s socket and token), not the host\'s', async () => {
  const home = tmpDir('asight-off-cli-plat-')
  const dir = path.join(home, '.asight', 'collector')
  fs.mkdirSync(dir, { recursive: true })
  // the real pipe shape, served on this host: a POSIX name may hold backslashes and a relative unix-socket path resolves against the cwd (see win32-control.test.mjs)
  const sock = '\\\\.\\pipe\\asight-0011223344556677'
  const cwd = process.cwd()
  process.chdir(tmpDir('asight-off-cli-pipe-'))
  const token = 'e'.repeat(64)
  const asked = []
  const server = http.createServer((req, res) => { asked.push([req.method, req.url, req.headers['x-asight-token']]); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ pid: 4242, confirmed: true })) })
  try {
    await new Promise((resolve) => server.listen(sock, resolve))
    fs.writeFileSync(path.join(dir, 'control.json'), JSON.stringify({ path: sock, token }))
    const lockFile = path.join(dir, 'lock')
    fs.writeFileSync(lockFile, JSON.stringify({ pid: 4242, start_time: '111', boot_id: 'boot-1', socket: sock, engine_port: 47123 }) + '\n')
    // one installed harness, so the off actually runs its steps (the routing switch is where the daemon is asked)
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{"env":{"NODE_EXTRA_CA_CERTS":"/x/asight.pem"}}\n')
    fs.writeFileSync(path.join(dir, 'install-manifest.json'), JSON.stringify({ version: 3, entries: [{ kind: 'json-key', phase: 'on', harness: 'claude-code', path: path.join(home, '.claude', 'settings.json'), keys: ['env', 'NODE_EXTRA_CA_CERTS'], backup: null }], files: [] }) + '\n')
    const io = fakeIo()
    // deps carries NO platform of its own — the CLI's platform must be what offWorld uses (a test's deps.platform still wins; that half is every other test here)
    const exit = await runOffCli(['claude-code'], { io, home, env: { HOME: home }, platform: 'win32', deps: { getuid: () => 1000, procs: async () => [], alive: () => false, identity: () => ({ start_time: '111', boot_id: 'boot-1' }), sleep: async () => {}, fs, exec: (file) => ({ status: 0, stdout: file === 'whoami' ? 'alice' : '', stderr: '' }) } }) // exec answers the arm's own reads (whoami); nothing it stubs ever runs for real
    assert.ok(asked.length > 0, 'the daemon was asked through the socket control.json names')
    assert.ok(asked.every(([, , t]) => t === token), `every request carried control.json's token — the win32 arm ran (${JSON.stringify(asked)})`)
    assert.ok([0, 1].includes(exit), `the off ran to its end: ${io.text()}`)
  } finally { process.chdir(cwd); await new Promise((resolve) => server.close(resolve)) }
})
