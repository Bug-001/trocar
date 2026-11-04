// test/cli/cli-output.test.mjs — the CLI text layer's own rules. Colour (D58): a non-TTY or NO_COLOR run emits zero ANSI bytes anywhere (status, plan and
// receipt alike), a TTY colours the verdict lines. R6: `--dry-run` still prints the receipt the real run will. Then the seams: the platform-correct
// autostart lines, the degenerate adopted chain that says nothing, the one-time harness notes, the watch dedup, and the daemon log files (D46, which now
// covers the log files alone — made at unit-write time, listed in the manifest, never truncated by a later on).
// What `status` itself prints (the summary's shape, the health line, `--failures`, the exit codes) is test/cli/status-doctor-en.test.mjs, the guard under
// the manual's samples; the digest's old 日志 / 记录 line is not in §3.5 any more, so nothing asserts it.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { runOnCli } from '../../src/cli/on.mjs'
import { formatPlan, formatOnReceipt } from '../../src/cli/receipt.mjs'
import { colors, useColor, noColor } from '../../src/cli/text.mjs'
import { readManifest } from '../../src/off/manifest.mjs'
import { appendEvent } from '../../src/collector/core/events.mjs'
import { installedHome } from '../off/fixtures/off-ctx.mjs'
import { fakeIo, onCtx, seedClaude, fakeSystem, installFirst } from './fixtures/on-ctx.mjs'
import { runStatus, reply, asDaemon } from './fixtures/status-ctx.mjs'
import { tmpDir } from '../helpers/tmp.mjs'

const HEALTH_OK = { summary: { state: 'ok', since: '2026-10-12T00:00:00.000Z' }, collector: { installed: true, daemon: { state: 'running' }, conditions: [], failures: [], expected: {} }, raw: { problems: [] }, read: { errors: [], truncated: false } }

// (c)+(d) colour (D58): TTY-only, NO_COLOR honoured — and zero ANSI bytes anywhere else
test('D58: a non-TTY or NO_COLOR run emits zero ANSI bytes (status, plan, receipt); a TTY run colours the verdict lines', async () => {
  const s = await installedHome()
  for (const tty of [false, true]) { // a pipe, and a TTY under NO_COLOR
    process.env.NO_COLOR = '1'
    try {
      const io = fakeIo({ tty })
      const r = await runStatus(s, [], { request: asDaemon(reply({ health: HEALTH_OK })), io })
      assert.ok(!r.text.includes('\u001b'), 'status carries no ANSI byte on ' + (tty ? 'a TTY with NO_COLOR' : 'a pipe'))
      const home = tmpDir('trocar-color-'); seedClaude(home); await installFirst(home)
      const on = fakeIo({ tty })
      await runOnCli(['--dry-run'], onCtx(home, on))
      assert.ok(!on.text().includes('\u001b'), 'the plan and the receipt either')
    } finally { delete process.env.NO_COLOR }
  }
  const tty = fakeIo({ tty: true })
  const r = await runStatus(s, [], { request: asDaemon(reply({ health: HEALTH_OK })), io: tty })
  assert.match(r.text.split('\n')[0], /^\u001b\[1m/, 'the verdict line of the summary is bold on a TTY: ' + JSON.stringify(r.text.split('\n')[0]))
  assert.match(r.text.split('\n')[0].replace(/\u001b\[\d+m/g, ''), /^Capturing |^No harness is set up/, 'and it strips back to the same words')
  const home = tmpDir('trocar-color-'); seedClaude(home); await installFirst(home)
  const sys = fakeSystem(); const on = fakeIo({ tty: true })
  await runOnCli(['--yes'], onCtx(home, on, { exec: sys.exec, daemon: sys.daemon }))
  assert.match(on.stdoutText(), /\u001b\[32mCapturing\u001b\[\d+m/, 'the receipt verdict is green on a TTY')
  const c = colors({ stdout: { isTTY: true } }, {})
  const codes = new Set([...r.text.matchAll(/\u001b\[(\d+)m/g)].map((m) => m[1]).filter((x) => !['0', '22', '39'].includes(x)))
  assert.ok(codes.size <= 5, 'at most the five palette codes appear: ' + [...codes])
  assert.match(c.green('x'), /^\u001b\[32mx\u001b\[\d+m$/); assert.equal(noColor().green('x'), 'x')
  assert.equal(useColor({ stdout: { isTTY: true } }), true); assert.equal(useColor({ stdout: {} }), false)
})

// (e) R6 once more through the reworked words: the dry run prints the receipt of the real run, word for word, and writes nothing
test('R6: --dry-run still prints the same receipt the real run will — the same files in the future tense, zero writes', async () => {
  const home = tmpDir('trocar-r6-'); seedClaude(home); await installFirst(home)
  assert.equal(await runOnCli(['--dry-run'], onCtx(home, fakeIo())), 0)
  const realHome = tmpDir('trocar-r6-'); seedClaude(realHome); await installFirst(realHome); await installFirst(realHome); const sys = fakeSystem()
  const real = fakeIo()
  assert.equal(await runOnCli(['--yes'], onCtx(realHome, real, { exec: sys.exec, daemon: sys.daemon })), 0, real.text())
  const dryHome = tmpDir('trocar-r6-'); seedClaude(dryHome); await installFirst(dryHome); await installFirst(dryHome); const dry = fakeIo()
  assert.equal(await runOnCli(['--dry-run'], onCtx(dryHome, dry)), 0, dry.text())
  assert.match(dry.stdoutText(), /^trocar will start capturing /m, 'the dry run is the same receipt in the future tense')
  // the same files, named the same way: `trocar will make:` in the dry run, `trocar's own files:` after the real one
  const files = (t, head, home) => (t.replace(/\n\s+/g, ' ').split('\n').find((l) => l.startsWith(head)) || '').slice(head.length).trim().split(/\s+/).map((f) => f.replace(home, '')).sort()
  assert.deepEqual(files(dry.stdoutText(), 'trocar will make:', dryHome), files(real.stdoutText(), "trocar's own files:", realHome), 'the dry run names the files the real run writes')
  assert.match(dry.stdoutText(), /No file of yours will be changed\./, 'every user file trocar changes is install\'s (D55①): the on after it changes none')
})

// the autostart plan names the mechanism of the platform by its own file (D46): a plist on darwin — the hardcoded systemd wording is gone
test('the plan autostart line is the platform own mechanism — a launchd plist on darwin, never the systemd wording', () => {
  const mac = formatPlan({ unit: { path: '/h/Library/LaunchAgents/com.trocar.collector.plist', env: {}, links: [] }, entries: [], files: [], owned: [], watch: [] }, { home: '/h', platform: 'darwin' })
  assert.ok(mac.includes('~/Library/LaunchAgents/com.trocar.collector.plist'), 'the plist is named')
  assert.ok(!mac.includes('systemd'), 'no systemd word on a Mac')
  const linux = formatPlan({ unit: { path: '/h/.config/systemd/user/trocar-collector.service', env: {}, links: ['/h/.config/systemd/user/default.target.wants/trocar-collector.service'] }, entries: [], files: [], owned: [], watch: [] }, { home: '/h', platform: 'linux' })
  for (const p of ['~/.config/systemd/user/trocar-collector.service', '~/.config/systemd/user/default.target.wants/trocar-collector.service']) assert.ok(linux.includes(p), `linux names ${p}`)
})

// the degenerate adopted chain (the harness own name and nothing else) says nothing and is not printed
test('a chain that is the harness itself is not printed as an adopted line — a chain with a hop is', () => {
  const degenerate = { harness: 'claude-code', chain: 'claude-code' }
  const hopful = { harness: 'codex', chain: 'codex -> [ebpf] trocar -> api.openai.com:443 (direct)' }
  const receipt = formatOnReceipt({ changed: [], created: [], skipped: [], restart: [], notes: [], adopted: { 'claude-code': degenerate, codex: hopful } }, { home: '/h' }).replace(/\n\s+/g, ' ')
  assert.ok(!receipt.includes('claude-code'), 'the degenerate chain is not printed')
  assert.equal(receipt.match(/\bcodex\b/g).length, 1, `the route line names its harness once (1.6 §3.3 sample: route: codex -> ...)\n${receipt}`)
})

// §1.1⑥ · D38: a proxy-mode chain starts with the running process (A.1), not the harness; each route line still says whose route it is
test('a route line whose chain does not start with its harness names the harness — two harnesses behind the same process name are told apart', () => {
  const adopted = { 'claude-code': { chain: 'node (pid 7712) -> trocar :17992 -> api.anthropic.com:443 (direct)' }, opencode: { chain: 'node (pid 7790) -> trocar :17993 -> api.openai.com:443 (direct)' } }
  const lines = formatOnReceipt({ changed: [], created: [], skipped: [], restart: [], notes: [], adopted }, { home: '/h' }).replace(/\n\s+/g, ' ').split('\n')
  for (const [h, x] of Object.entries(adopted)) {
    const pid = x.chain.match(/pid (\d+)/)[1]
    assert.equal(lines.filter((l) => l.includes(pid) && new RegExp(`(^|\\W)${h}(\\W|$)`).test(l)).length, 1, `${h}'s route line names ${h}\n${lines.join('\n')}`)
  }
})

// §1.1⑥: a label that lists several paths prints each on its own line, two deeper than the label — never two paths on one line
test('a receipt label that lists several paths prints one path a line, two deeper than its label', () => {
  const long = (n) => `/h/.config/${n}/${'x'.repeat(48)}.json`
  const paths = [long('a'), long('b'), long('c')], made = ['/h/.trocar/netenv.json', '/h/.trocar/collector/ingress.json']
  const text = formatOnReceipt({ changed: [], created: made, unchanged: paths.map((p) => ({ path: p })), skipped: [], restart: [], notes: [] }, { home: '/h' })
  const lines = text.split('\n')
  for (const p of [...paths, ...made]) {
    const shown = p.replace('/h/', '~/'), i = lines.findIndex((l) => l.trim() === shown)
    assert.ok(i > 0, `${shown} is alone on its line\n${text}`)
    let j = i - 1; while (j > 0 && lines[j].trim().startsWith('~/')) j--
    const indent = (l) => l.length - l.trimStart().length
    assert.equal(indent(lines[i]), indent(lines[j]) + 2, `${shown} sits two deeper than its label\n${text}`)
  }
})

// the one-time harness notes: printed when THIS run wires the harness, relocated to doctor / --json afterwards (D46); the receipt object is untouched
test('a harness one-time note prints on its first wiring only; an idempotent on prints none', () => {
  const r = { changed: [], created: [], skipped: [], restart: [], log: null, notes: ['claude-code: a NODE_EXTRA_CA_CERTS exported only in a shell trocar did not see no longer reaches Claude Code', 'codex: something about codex', 'install: the collector CA is in the user trust store'] }
  const flat = (t) => t.replace(/\n\s+/g, ' ')
  const first = flat(formatOnReceipt({ ...r, created: ['x'] }, { fresh: new Set(['claude-code']) }))
  assert.match(first, /Note: claude-code: a NODE_EXTRA_CA_CERTS/)
  assert.doesNotMatch(first, /Note: codex:/, 'codex was wired before: its note lives in doctor and --json')
  assert.match(first, /Note: install: the collector CA/, 'a machine-level note still prints when this run did something new')
  const idempotent = flat(formatOnReceipt({ ...r }, { fresh: new Set() }))
  assert.doesNotMatch(idempotent, /Note: /, 'an idempotent on prints no note at all')
  assert.match(flat(formatOnReceipt({ ...r, created: ['x'] }, { fresh: new Set(['codex']) })), /Note: codex: something/, 'codex own first wiring prints its note')
})

// the same watch fact in several entries (OpenCode package.json ×4) is ONE plan line (D46)
test('the plan folds the watch entries of one (harness, reason) into one line that names them all', () => {
  const why = 'OpenCode installs @opencode-ai/plugin there on its first run with any plugin'
  const watch = ['package.json', 'package-lock.json', 'bun.lock', 'node_modules'].map((n) => ({ harness: 'opencode', path: '/h/.config/opencode/' + n, why }))
  const text = formatPlan({ watch, entries: [], files: [], owned: [] }, { home: '/h' }).replace(/\n\s+/g, ' ')
  const said = text.split('\n').filter((l) => l.includes('opencode itself may write'))
  assert.equal(said.length, 1, 'one line, not four:\n' + text)
  assert.match(said[0], /~\/\.config\/opencode\/package\.json \(\+3 more: package-lock\.json, bun\.lock, node_modules\)/)
  assert.match(said[0], new RegExp(why.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})

// the daemon own log files (D46): made at unit-write time, owner-only, listed in the manifest — and never truncated by a later on
test('D46: the unit write makes the daemon log directory (0700, two 0600 files), lists them in the manifest, and a later on does not truncate them', async () => {
  const home = tmpDir('trocar-dlogs-'); seedClaude(home); await installFirst(home)
  const sys = fakeSystem()
  assert.equal(await runOnCli(['--yes'], onCtx(home, fakeIo(), { exec: sys.exec, daemon: sys.daemon })), 0)
  const logs = path.join(home, '.trocar', 'collector', 'logs')
  assert.equal(fs.statSync(logs).mode & 0o777, 0o700, 'the directory is owner-only')
  for (const name of ['daemon-out.log', 'daemon-err.log']) {
    assert.equal(fs.statSync(path.join(logs, name)).mode & 0o777, 0o600, name + ' is owner-only (a stack dump may quote request material)')
  }
  const unitText = fs.readFileSync(path.join(home, '.config', 'systemd', 'user', 'trocar-collector.service'), 'utf8')
  assert.match(unitText, new RegExp('StandardOutput=append:' + path.join(logs, 'daemon-out.log').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(unitText, new RegExp('StandardError=append:' + path.join(logs, 'daemon-err.log').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  const m = readManifest(path.join(home, '.trocar', 'collector'))
  assert.deepEqual(m.files.filter((f) => f.role === 'daemon-log').map((f) => f.path).sort(), [path.join(logs, 'daemon-err.log'), path.join(logs, 'daemon-out.log')].sort(), 'the manifest lists them like every file trocar owns')
  fs.appendFileSync(path.join(logs, 'daemon-out.log'), 'a line the daemon printed at login\n')
  const sys2 = fakeSystem()
  assert.equal(await runOnCli(['--yes'], onCtx(home, fakeIo(), { exec: sys2.exec, daemon: sys2.daemon })), 0, 'the second on succeeds')
  assert.match(fs.readFileSync(path.join(logs, 'daemon-out.log'), 'utf8'), /a line the daemon printed at login/, 'a later on never truncates the log')
})
