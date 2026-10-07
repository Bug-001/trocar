// test/off/main.test.mjs — `asight off` as a command line (RFC 1.6 §2, §3, R4–R7, V5's names and --json half, V6 for off): the arguments, root, the platform,
// --json, --dry-run, --now, and the receipt text of the §7 example. A sandbox HOME in which the real `on` has run; the daemon, systemd and the process table injected.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { runOffCli, resolveOffNames } from '../../src/off/main.mjs'
import { formatOffReceipt } from '../../src/off/receipt.mjs'
import { validateReceipt } from '../../src/cli/schema.mjs'
import { fakeIo, snapshot } from '../cli/fixtures/on-ctx.mjs'
import { installedHome, flowEvents } from './fixtures/off-ctx.mjs'

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

test('1.6 §4: a platform with no new collector goes to the legacy hook with the arguments, or — with none — says so, touches nothing and exits 1', async () => {
  const s = await installedHome({ names: ['claude-code'] }); const before = snapshot(s.home)
  const seen = []
  assert.equal(await runOffCli(['--now'], ctx(s, fakeIo(), { platform: 'darwin', deps: { legacyOff: async (argv) => { seen.push(argv); return 0 } } })), 0)
  assert.deepEqual(seen, [['--now']])
  const io = fakeIo()
  assert.equal(await runOffCli([], ctx(s, io, { platform: 'win32' })), 1); assert.match(io.text(), /win32|本平台/)
  assert.deepEqual(snapshot(s.home), before)
})

test('R6: --dry-run writes nothing — not a byte, not a flows/ line, nothing asked of the daemon — exits 0, prints the same files in the future tense as the real run then changes; --now is passed on; --remove-ca is accepted with one note', async () => {
  const s = await installedHome({ names: ['claude-code', 'codex'] }); const before = snapshot(s.home); const calls = s.sys.exec.calls.length
  const dry = fakeIo()
  assert.equal(await runOffCli(['--dry-run', '--json', '--remove-ca'], ctx(s, dry)), 0)
  const d = dry.json()
  assert.deepEqual([snapshot(s.home), s.sys.exec.calls.length, s.sys.daemon.calls.filter((c) => c.startsWith('POST /off'))], [before, calls, []])
  assert.deepEqual([d.dry_run, d.ok, validateReceipt(d), d.notes.filter((n) => /--remove-ca/.test(n)).length], [true, true, [], 1])
  const text = fakeIo(); assert.equal(await runOffCli(['--dry-run'], ctx(s, text)), 0)
  assert.match(text.stdoutText(), /^asight 将关闭采集。\n将撤掉:/); assert.match(text.stdoutText(), /~\/\.claude\/settings\.json/); assert.doesNotMatch(text.stdoutText(), /已关闭|已回到/)
  assert.deepEqual(snapshot(s.home), before)
  const real = fakeIo(); const t = await installedHome({ names: ['claude-code', 'codex'] })
  assert.equal(await runOffCli(['--now', '--json'], ctx(t, real)), 0)
  assert.deepEqual(changedRel(t, real.json()), changedRel(s, d).map((p) => p), 'the dry run named the files the real run changed')
  assert.deepEqual(t.sys.daemon.calls.filter((c) => c.startsWith('POST /off')), ['POST /off {"now":true,"exit":true}'])
})

test('1.6 §7: the receipt text of an off with no names — the files back as they were with their backups gone, the edited one with its backup kept, the autostart, the daemon draining with its connections, who still trusts the CA, the processes the user started — and a failed off says what is left', async () => {
  const s = await installedHome({ names: ['claude-code', 'codex'], daemon: { relayed: { closing: 2, waiting: 1, cut: 0 }, exitOnOff: false } })
  fs.appendFileSync(path.join(s.home, '.codex', '.env'), 'EXTRA=1\n')
  const procs = async () => [
    { pid: 4388, ppid: 1, uid: 1000, startedAt: Date.now() + 5000, exe: '/home/u/.local/share/claude/versions/2.1.289', argv: ['claude'], env: () => new Map() },
    { pid: 5310, ppid: 1, uid: 1000, startedAt: 1, exe: '/usr/bin/node', argv: ['node', '/repo/bin/asight.mjs', 'serve'], env: () => new Map() },
  ]
  const io = fakeIo()
  assert.equal(await runOffCli([], ctx(s, io, { deps: { procs } })), 0, io.text())
  const out = io.stdoutText()
  assert.match(out, /^asight 已关闭采集。\n撤掉了:\n/)
  assert.match(out, /~\/\.claude\/settings\.json +去掉 env\.NODE_EXTRA_CA_CERTS +已回到改前的样子,备份已删/)
  assert.match(out, /~\/\.codex\/\.env +去掉 asight 哨兵块\(SSL_CERT_FILE\) +已撤销,但不逐字节相同\(你之后改过这个文件:只撤了 asight 的部分,备份留在 ~\/\.asight\/backup\/[0-9a-f]{16}-/)
  assert.match(out, /自启已停用;守护进程仍在排空:pid 4242,还剩 1 条等它们自己关闭;asight off --now 立即切断: 2 条连接仍经 asight 中转,本次响应\(或本轮\)结束后关闭;其中 1 条是透传连接或看不到终止消息的 WebSocket/)
  assert.match(out, /重启前仍信任 asight CA\(不经 asight,只是还信任\): claude-code pid 4388\(重启后不再信任\)/)
  assert.match(out, /你自己起的 asight 进程仍在跑: asight serve\(pid 5310,只读看板,不在 agent 路径上\)/)
  assert.match(out, /引流: 已摘\(守护进程回复了,内核已确认\)/)
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
