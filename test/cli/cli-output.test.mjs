// test/cli/cli-output.test.mjs — D46 (2026-10-12): the CLI text layer's own rules. (a) the unnamed `asight status` digest fits one screen in a quiet world;
// (b) the whole failure wall is `--failures`, the digest itself carries count + newest only; (c) a non-TTY or NO_COLOR run emits zero ANSI bytes anywhere
// (status, plan and receipt alike); (d) a TTY run colours the verdict lines; (e) `--dry-run` still prints the receipt the real run word for word (R6).
// Then the rework seams: the platform-correct autostart line, the degenerate adopted chain that says nothing, the one-time harness notes, the watch
// dedup, and the daemon log files (made at unit-write time, listed in the manifest, never truncated by a later on).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { runOnCli } from '../../src/cli/on.mjs'
import { formatPlan, formatOnReceipt } from '../../src/cli/receipt.mjs'
import { colors, useColor, noColor } from '../../src/cli/color.mjs'
import { readManifest } from '../../src/off/manifest.mjs'
import { appendEvent } from '../../src/collector/core/events.mjs'
import { installedHome } from '../off/fixtures/off-ctx.mjs'
import { fakeIo, onCtx, seedClaude, fakeSystem } from './fixtures/on-ctx.mjs'
import { runStatus, reply, asDaemon } from './fixtures/status-ctx.mjs'
import { tmpDir } from '../helpers/tmp.mjs'

const HEALTH_OK = { summary: { state: 'ok', since: '2026-10-12T00:00:00.000Z' }, collector: { installed: true, daemon: { state: 'running' }, conditions: [], failures: [], expected: {} }, legacy: { present: false }, raw: { problems: [] }, read: { errors: [], truncated: false } }

// (a) the digest: one screen in a quiet world — the daemon answers, every harness it watches is captured, nothing failed in 24 h
test('D46 (a): the unnamed status digest is at most 10 lines in a quiet world, and its shape is the approved one', async () => {
  const s = await installedHome()
  const r = await runStatus(s, [], { request: asDaemon(reply({ health: HEALTH_OK, agents: [{ pid: 4121, agent: 'claude-code', trusted: true }] })) })
  assert.equal(r.exit, 0, r.text)
  const lines = r.text.split('\n')
  assert.ok(lines.length <= 10, lines.length + ' lines:\n' + r.text)
  assert.match(lines[0], /^asight · 在采 2\/7 · 守护进程 在跑/) // claude-code and codex, of the seven asight knows
  assert.match(lines[1], /^  在采   claude-code\(pid 4121\) · codex$/) // the process annotation, only where one runs
  assert.match(lines[2], /^  未装   hermes · opencode · deepseek-dsh · kimi-code · z-code$/)
  assert.match(lines[3], /^路径    不知道\(/) // no VPN found: 不知道 with the reason, never 无 (R11)
  assert.match(lines[4], /^  claude-code\s+claude-code → /) // a known path is drawn per harness
  assert.match(r.text, /采集健康 ✓\(24 h 内无失败\)/) // zero failures is a ✓ line
  assert.match(r.text, /^日志     ~\/\.asight\/collector\/logs · 记录 ~\/\.asight · 关闭 asight off$/m)
})

// (b) the failure wall: the digest says count + kinds + the newest one (squashed, ×count) and points the way; the wall itself is --failures, in its old format
test('D46 (b): the digest health line is count + newest; --failures prints the whole wall (the format it always had), and neither changes the exit code', async () => {
  const s = await installedHome()
  const reason = 'EPERM: chmod $TMPDIR/asight-abc\n  at some/internal/place.mjs:2:3'
  appendEvent(s.dir, { event: 'failure', where: 'engine', code: 'lookup-miss', reason: 'no original destination' }) // the oldest: the newest below wins
  appendEvent(s.dir, { event: 'failure', where: 'start', code: 'EPERM', reason })
  appendEvent(s.dir, { event: 'failure', where: 'start', code: 'EPERM', reason })
  const r = await runStatus(s, []) // no daemon: the disk is the story, and its failures are the digest's
  assert.equal(r.exit, 1, 'a failure in 24 h is still exit 1 (R4 unchanged)')
  assert.match(r.text, /采集健康 ✗ 守护进程没在跑 · 24h 内 3 条失败\(2 类\) — 最新: EPERM EPERM: chmod \$TMPDIR\/asight-abc at some\/internal\/place\.mjs:2:3 ×2/, 'the state word, the count by kind, and the newest one squashed with its multiplier')
  assert.match(r.text, /全部明细: asight status --failures · 看板「采集健康」/)
  assert.ok(!/recent failures/.test(r.text), 'the wall itself is not in the plain digest')
  const wall = await runStatus(s, ['--failures'])
  assert.equal(wall.exit, r.exit, '--failures is a display flag: the exit code is the judgement alone')
  assert.match(wall.text, /recent failures \(2 kind\(s\), last 24 h\):/)
  assert.match(wall.text, /failure \(start\/EPERM\): EPERM: chmod \$TMPDIR\/asight-abc/)
  assert.match(wall.text, /\(×2 in 24 h\)/, 'the multiplier survives in the wall')
})

// (c)+(d) colour: TTY-only, NO_COLOR honoured — and zero ANSI bytes anywhere else
test('D46 (c)+(d): a non-TTY or NO_COLOR run emits zero ANSI bytes (status, plan, receipt); a TTY run colours the verdict lines', async () => {
  const s = await installedHome()
  for (const tty of [false, true]) { // a pipe, and a TTY under NO_COLOR
    process.env.NO_COLOR = '1'
    try {
      const io = fakeIo({ tty })
      const r = await runStatus(s, [], { request: asDaemon(reply({ health: HEALTH_OK })), io })
      assert.ok(!r.text.includes('\u001b'), 'status carries no ANSI byte on ' + (tty ? 'a TTY with NO_COLOR' : 'a pipe'))
      const home = tmpDir('asight-color-'); seedClaude(home)
      const on = fakeIo({ tty })
      await runOnCli(['--dry-run'], onCtx(home, on))
      assert.ok(!on.text().includes('\u001b'), 'the plan and the receipt either')
    } finally { delete process.env.NO_COLOR }
  }
  const tty = fakeIo({ tty: true })
  const r = await runStatus(s, [], { request: asDaemon(reply({ health: HEALTH_OK })), io: tty })
  const onTheRow = r.text.split('\n').find((l) => l.startsWith('  ') && l.includes('在采'))
  assert.ok(/\u001b\[32m/.test(onTheRow), 'the 在采 row is green on a TTY: ' + JSON.stringify(onTheRow))
  assert.match(r.text.split('\n')[0].replace(/\u001b\[\d+m/g, ''), /^asight · 在采/, 'the bold header strips back to the same words')
  const home = tmpDir('asight-color-'); seedClaude(home)
  const sys = fakeSystem(); const on = fakeIo({ tty: true })
  await runOnCli(['--yes'], onCtx(home, on, { exec: sys.exec, daemon: sys.daemon }))
  assert.match(on.stdoutText(), /\u001b\[32m✔\u001b\[0m 入口已写/, 'the receipt verdict mark is green on a TTY')
  const c = colors({ stdout: { isTTY: true } })
  const codes = new Set([...r.text.matchAll(/\u001b\[(\d+)m/g)].map((m) => m[1]).filter((x) => x !== '0'))
  assert.ok(codes.size <= 5, 'at most the five palette codes appear: ' + [...codes])
  assert.equal(c.green('x'), '\u001b[32mx\u001b[0m'); assert.equal(noColor().green('x'), 'x')
  assert.equal(useColor({ stdout: { isTTY: true } }), true); assert.equal(useColor({ stdout: {} }), false)
})

// (e) R6 once more through the reworked words: the dry run prints the receipt of the real run, word for word, and writes nothing
test('D46 (e): --dry-run still prints the same receipt the real run will (R6) — the same files in the future tense, zero writes', async () => {
  const home = tmpDir('asight-r6-'); seedClaude(home)
  assert.equal(await runOnCli(['--dry-run'], onCtx(home, fakeIo())), 0)
  const realHome = tmpDir('asight-r6-'); seedClaude(realHome); const sys = fakeSystem()
  const real = fakeIo()
  assert.equal(await runOnCli(['--yes'], onCtx(realHome, real, { exec: sys.exec, daemon: sys.daemon })), 0, real.text())
  const dryHome = tmpDir('asight-r6-'); seedClaude(dryHome); const dry = fakeIo()
  assert.equal(await runOnCli(['--dry-run'], onCtx(dryHome, dry)), 0, dry.text())
  assert.match(dry.stdoutText(), /^asight 将打开采集/m)
  for (const row of real.stdoutText().split('\n').filter((l) => l.startsWith('  ~/') && /备份|新建/.test(l))) {
    assert.ok(dry.stdoutText().includes(row.replace(/备份 ~\/\.asight\/backup\/[0-9a-zA-Z-]+/, '备份 改前先存进 ~/.asight/backup/')), 'the dry run lists the row the real run wrote: ' + row)
  }
  assert.match(dry.stdoutText(), /将改这些文件:/)
  assert.match(dry.stdoutText(), /不会改任何用户文件\.|将改这些文件:/)
})

// the autostart line names the real mechanism of the platform (D46): launchd on darwin — the hardcoded systemd wording is gone
test('D46: the plan autostart line is the platform own mechanism — launchd on darwin, systemd --user on linux', () => {
  const mac = formatPlan({ unit: { path: '/h/Library/LaunchAgents/com.asight.collector.plist', env: {}, links: [] }, entries: [], files: [], owned: [], watch: [] }, { home: '/h', platform: 'darwin' })
  assert.match(mac, /autostart unit \(launchd, RunAtLoad \+ KeepAlive\): ~\/Library\/LaunchAgents\/com\.asight\.collector\.plist/)
  assert.ok(!mac.includes('systemd'), 'no systemd word on a Mac')
  const linux = formatPlan({ unit: { path: '/h/.config/systemd/user/asight-collector.service', env: {}, links: ['/h/.config/systemd/user/default.target.wants/asight-collector.service'] }, entries: [], files: [], owned: [], watch: [] }, { home: '/h', platform: 'linux' })
  assert.match(linux, /autostart unit \(systemd --user, enabled --now\)/, 'linux keeps its own words')
})

// the degenerate adopted chain (the harness own name and nothing else) says nothing and is not printed (D46)
test('D46: a chain that is the harness itself is not printed as a adopted line — a chain with a hop (or a named proxy) is', () => {
  const degenerate = { harness: 'claude-code', chain: 'claude-code' }
  const hopful = { harness: 'codex', chain: 'codex → [eBPF] asight 引擎 :4711 → api.openai.com:443(直连)' }
  const withProxy = { harness: 'z-code', chain: 'z-code', proxy: 'http://127.0.0.1:7897' }
  const plan = formatPlan({ adopted: [degenerate, hopful, withProxy], entries: [], files: [], owned: [], watch: [] }, { home: '/h' })
  assert.doesNotMatch(plan, /接上后 claude-code 的路: claude-code/)
  assert.match(plan, /接上后 codex 的路: codex → /)
  assert.match(plan, /接上后 z-code 的路: z-code\(它的代理设置 http:\/\/127\.0\.0\.1:7897/, 'a degenerate chain with a real proxy setting still says something')
  const receipt = formatOnReceipt({ changed: [], created: [], skipped: [], restart: [], notes: [], adopted: { 'claude-code': degenerate, codex: hopful } }, { home: '/h' })
  assert.ok(!receipt.includes('接上后 claude-code 的路: claude-code'))
  assert.match(receipt, /接上后 codex 的路: codex → /)
})

// the one-time harness notes: printed when THIS run wires the harness, relocated to doctor / --json afterwards (D46); the receipt object is untouched
test('D46: a harness one-time note prints on its first wiring only; an idempotent on prints none', () => {
  const r = { changed: [], created: [], skipped: [], restart: [], log: null, notes: ['claude-code: a NODE_EXTRA_CA_CERTS exported only in a shell asight did not see no longer reaches Claude Code', 'codex: something about codex', "asight's kernel: found and verified (94a386ec…) in kernel/"] }
  const first = formatOnReceipt({ ...r, created: ['x'] }, { fresh: new Set(['claude-code']) })
  assert.match(first, /说明: claude-code: a NODE_EXTRA_CA_CERTS/)
  assert.doesNotMatch(first, /说明: codex:/, 'codex was wired before: its note lives in doctor and --json')
  assert.match(first, /说明: asight's kernel: found and verified/, 'a real install still says where the kernel came from')
  const idempotent = formatOnReceipt({ ...r }, { fresh: new Set() })
  assert.doesNotMatch(idempotent, /说明: /, 'an idempotent on prints no note at all')
  assert.match(formatOnReceipt({ ...r, created: ['x'] }, { fresh: new Set(['codex']) }), /说明: codex: something/, 'codex own first wiring prints its note')
})

// the same watch fact in several entries (OpenCode package.json ×4) is ONE plan line (D46)
test('D46: the plan folds the watch entries of one (harness, reason) into one line that names them all', () => {
  const why = 'OpenCode installs @opencode-ai/plugin there on its first run with any plugin'
  const watch = ['package.json', 'package-lock.json', 'bun.lock', 'node_modules'].map((n) => ({ harness: 'opencode', path: '/h/.config/opencode/' + n, why }))
  const text = formatPlan({ watch, entries: [], files: [], owned: [] }, { home: '/h' })
  const said = text.split('\n').filter((l) => l.includes('opencode itself may write'))
  assert.equal(said.length, 1, 'one line, not four:\n' + text)
  assert.match(said[0], /~\/\.config\/opencode\/package\.json \(\+3 more: package-lock\.json, bun\.lock, node_modules\)/)
  assert.match(said[0], new RegExp(why.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})

// the daemon own log files (D46): made at unit-write time, owner-only, listed in the manifest — and never truncated by a later on
test('D46: the unit write makes the daemon log directory (0700, two 0600 files), lists them in the manifest, and a later on does not truncate them', async () => {
  const home = tmpDir('asight-dlogs-'); seedClaude(home)
  const sys = fakeSystem()
  assert.equal(await runOnCli(['--yes'], onCtx(home, fakeIo(), { exec: sys.exec, daemon: sys.daemon })), 0)
  const logs = path.join(home, '.asight', 'collector', 'logs')
  assert.equal(fs.statSync(logs).mode & 0o777, 0o700, 'the directory is owner-only')
  for (const name of ['daemon-out.log', 'daemon-err.log']) {
    assert.equal(fs.statSync(path.join(logs, name)).mode & 0o777, 0o600, name + ' is owner-only (a stack dump may quote request material)')
  }
  const unitText = fs.readFileSync(path.join(home, '.config', 'systemd', 'user', 'asight-collector.service'), 'utf8')
  assert.match(unitText, new RegExp('StandardOutput=append:' + path.join(logs, 'daemon-out.log').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(unitText, new RegExp('StandardError=append:' + path.join(logs, 'daemon-err.log').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  const m = readManifest(path.join(home, '.asight', 'collector'))
  assert.deepEqual(m.files.filter((f) => f.role === 'daemon-log').map((f) => f.path).sort(), [path.join(logs, 'daemon-err.log'), path.join(logs, 'daemon-out.log')].sort(), 'the manifest lists them like every file asight owns')
  fs.appendFileSync(path.join(logs, 'daemon-out.log'), 'a line the daemon printed at login\n')
  const sys2 = fakeSystem()
  assert.equal(await runOnCli(['--yes'], onCtx(home, fakeIo(), { exec: sys2.exec, daemon: sys2.daemon })), 0, 'the second on succeeds')
  assert.match(fs.readFileSync(path.join(logs, 'daemon-out.log'), 'utf8'), /a line the daemon printed at login/, 'a later on never truncates the log')
})

// the status digest points at the daemon logs (the operations face); the daemon records stay in flows/ (the record, R11)
test('D46: the digest log line names the log directory and the records directory', async () => {
  const s = await installedHome()
  const r = await runStatus(s, [], { request: asDaemon(reply({ health: HEALTH_OK })) })
  assert.match(r.text, /~\/\.asight\/collector\/logs · 记录 ~\/\.asight · 关闭 asight off/)
})
