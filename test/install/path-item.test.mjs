// path-item.test.mjs — the script channel's PATH item and uninstall's last step (RFC 1.6 §3.2 「脚本渠道多一项 PATH」, §3.6 「脚本渠道的最后一步」, V112, V113, D74⑤⑧).
// The Windows registry half is not run here: powershell.exe is a guarded tool under npm test.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { tmpDir } from '../helpers/tmp.mjs'
import { runInstallCli } from '../../src/cli/install.mjs'
import { runUninstallCli } from '../../src/cli/uninstall.mjs'
import { readManifest } from '../../src/off/manifest.mjs'
import { pathItemTarget, psScript, WIN_ELEMENT } from '../../src/off/path-item.mjs'
import { appDir, launcherPath } from '../../src/off/paths.mjs'
import { orphanBackups } from '../../src/off/backup.mjs'
import { fakeIo, onCtx, seedClaude, snapshot, changedFiles } from '../cli/fixtures/on-ctx.mjs'
import { setupHelperCommand } from '../../src/version.mjs'
import { unitPath } from '../../src/collector/arch/linux/unit.mjs'
import { COMMANDS } from '../../src/cli/commands.mjs'
import { DEFAULT_REDIRECTOR_BIN } from '../../src/collector/arch/linux/redirector-client.mjs'
import { flowEvents } from '../off/fixtures/off-ctx.mjs'

test('V112: the start file is the one the (system, shell, ZDOTDIR) row names', () => {
  const h = '/h'
  const at = (platform, SHELL, extra = {}) => pathItemTarget({ platform, env: { SHELL, ...extra }, home: h }).file
  assert.deepEqual([at('darwin', '/bin/zsh'), at('linux', '/usr/bin/zsh', { ZDOTDIR: '/z' }), at('darwin', '/bin/bash'), at('linux', '/bin/bash'), at('linux', '/usr/bin/fish'), at('linux', '/bin/dash'), at('darwin', '')],
    ['/h/.zshrc', '/z/.zshrc', '/h/.bash_profile', '/h/.bashrc', '/h/.config/fish/conf.d/trocar.fish', '/h/.profile', '/h/.profile'])
})

// the line tells whoever reads the start file how it goes away: the command it names is one this trocar has, visible in help (commands.mjs)
test('the PATH line names a command that exists to take it out', () => {
  for (const shell of ['/bin/bash', '/usr/bin/fish']) {
    const { line } = pathItemTarget({ platform: 'linux', env: { SHELL: shell }, home: '/h' })
    const named = /`trocar ([^`]+)`/.exec(line)
    assert.ok(named && COMMANDS.some((c) => c.name === named[1] && !c.hidden), line)
  }
})

test('the line puts ~/.trocar/bin last on PATH once, however often the file is read', () => {
  const home = tmpDir('trocar-path-line-')
  const { line } = pathItemTarget({ platform: 'linux', env: { SHELL: '/bin/sh' }, home })
  const rc = path.join(home, 'rc'); fs.writeFileSync(rc, `${line}\n`)
  const r = spawnSync('/bin/sh', ['-c', '. "$1"; . "$1"; printf %s "$PATH"', 'sh', rc], { encoding: 'utf8', env: { HOME: home, PATH: '/usr/bin:/bin' } })
  assert.equal(r.stdout, `/usr/bin:/bin:${home}/.trocar/bin`, r.stderr)
})

test('V112 V113: a script-channel install adds the PATH item once; uninstall takes it out byte for byte and removes the launcher and ~/.trocar/app, keeping the records', async () => {
  const home = tmpDir('trocar-path-item-')
  seedClaude(home)
  const root = path.join(appDir(home), '9.9.9')
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true })
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"trocar-cli","version":"9.9.9"}\n')
  fs.writeFileSync(path.join(root, 'bin', 'trocar.mjs'), '')
  fs.mkdirSync(path.dirname(launcherPath(home, 'linux')), { recursive: true }); fs.writeFileSync(launcherPath(home, 'linux'), '#!/bin/sh\n')
  const rc = path.join(home, '.bashrc'); const mine = 'alias ll="ls -l"\n'; fs.writeFileSync(rc, mine)
  const raw = path.join(home, '.trocar', 'raw', 'r.ndjson'); fs.mkdirSync(path.dirname(raw), { recursive: true }); fs.writeFileSync(raw, '{"keep":1}\n')
  const ctx = (io) => { const c = onCtx(home, io); return { ...c, platform: 'linux', env: { ...c.env, SHELL: '/bin/bash' }, deps: { ...c.deps, root, fs: helperFs(false) } } }

  const io = fakeIo()
  assert.equal(await runInstallCli(['--yes', '--json'], ctx(io)), 0, io.text())
  const item = readManifest(path.join(home, '.trocar', 'collector')).path_item
  assert.equal(item && item.path, rc, 'the record names the file')
  const placed = fs.readFileSync(rc, 'utf8')
  assert.ok(placed.startsWith(mine) && placed.includes('.trocar/bin'), 'appended after the user\'s lines')
  assert.equal(await runInstallCli(['--yes'], ctx(fakeIo())), 0)
  assert.equal(fs.readFileSync(rc, 'utf8'), placed, 'a second install changes no byte')
  if (item.backup) assert.ok(!orphanBackups({ home, manifest: readManifest(path.join(home, '.trocar', 'collector')) }).includes(item.backup), 'the PATH item names its backup: no orphan')

  const un = fakeIo()
  assert.equal(await runUninstallCli(['--yes', '--json'], ctx(un)), 0, un.text())
  assert.equal(fs.readFileSync(rc, 'utf8'), mine, 'the file is as it was')
  assert.deepEqual([fs.existsSync(appDir(home)), fs.existsSync(path.dirname(launcherPath(home, 'linux'))), fs.readFileSync(raw, 'utf8')], [false, false, '{"keep":1}\n'], 'app/, the launcher and the bin/ they leave empty are gone; the records stay')
})

// The Windows script's patterns as PowerShell receives them (the text of psScript, not a copy): its single-quoted literals ('' is one '), $alt, and
// [regex]::Escape of the element and of its expansion. Evaluated here as .NET would, without a PowerShell: an element with or without a trailing
// backslash, REG_EXPAND_SZ (as written) and REG_SZ (expanded) shapes, first / middle / last / alone, is found by add and taken out by remove.
const ABS = 'C:\\Users\\u\\.trocar\\bin'
const netEscape = (x) => x.replace(/[\\*+?|{[()^$.#\s]/g, '\\$&') // .NET Regex.Escape's set
const psExpr = (expr, vars) => expr.split(' + ').map((t) => (t.startsWith("'") ? t.slice(1, -1).replace(/''/g, "'") : t in vars ? vars[t] : assert.fail(`unknown term ${t}`))).join('')
const netRegex = (p) => new RegExp(p.replace(/^\(\?i\)/, ''), /^\(\?i\)/.test(p) ? 'i' : '')
function scriptOps() {
  const vars = { '[regex]::Escape($el)': netEscape(WIN_ELEMENT), '[regex]::Escape($abs)': netEscape(ABS) }
  vars.$alt = psExpr(/^\$alt = (.+?)(?:,|$)/m.exec(psScript('add'))[1], vars)
  const calls = (op) => [...psScript(op).matchAll(/\[regex\]::(?:IsMatch|Match)\(\$v, ((?:'(?:[^']|'')*'|\$alt)(?: \+ (?:'(?:[^']|'')*'|\$alt))*)\)/g)].map((m) => netRegex(psExpr(m[1], vars)))
  const [present] = calls('add'), [mid, lead] = calls('remove')
  return {
    present: (v) => present.test(v),
    remove: (v) => { const m = mid.exec(v) || lead.exec(v); return m ? v.slice(0, m.index) + v.slice(m.index + m[0].length) : null },
  }
}
test('D74⑤: the Windows PATH script finds and takes out the element with or without its trailing backslash, unexpanded or expanded', () => {
  const ops = scriptOps()
  for (const el of [WIN_ELEMENT, `${WIN_ELEMENT}\\`, ABS, `${ABS}\\`, WIN_ELEMENT.toLowerCase()]) {
    for (const [v, rest] of [[`C:\\x;${el}`, 'C:\\x'], [`${el};D:\\y`, 'D:\\y'], [`C:\\x;${el};D:\\y`, 'C:\\x;D:\\y'], [el, '']]) {
      assert.equal(ops.present(v), true, `add sees it in ${v}`)
      assert.equal(ops.remove(v), rest, `remove takes exactly it out of ${v}`)
    }
  }
  for (const v of ['C:\\x;D:\\y', `C:\\x;${ABS}x`, `C:\\x;${ABS}?`, '']) {
    assert.equal(ops.present(v), false, `not in ${v}`)
    assert.equal(ops.remove(v), null, `nothing taken out of ${v}`)
  }
})

// the helper is there or not as the test says, whatever the machine running it has (a Linux host with trocar's helper installed)
const helperFs = (on) => ({ ...fs, existsSync: (p) => (p === DEFAULT_REDIRECTOR_BIN ? on : fs.existsSync(p)) })
// a script install on Linux with records on disk; `helper`: the capability helper is installed (its fixed path exists)
function scriptLinux({ helper = false } = {}) {
  const home = tmpDir('trocar-path-helper-')
  seedClaude(home)
  const root = path.join(appDir(home), '9.9.9')
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true })
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"trocar-cli","version":"9.9.9"}\n')
  fs.writeFileSync(path.join(root, 'bin', 'trocar.mjs'), '')
  fs.mkdirSync(path.dirname(launcherPath(home, 'linux')), { recursive: true }); fs.writeFileSync(launcherPath(home, 'linux'), '#!/bin/sh\n')
  const rc = path.join(home, '.bashrc'); fs.writeFileSync(rc, 'alias ll="ls -l"\n')
  const raw = path.join(home, '.trocar', 'raw', 'r.ndjson'); fs.mkdirSync(path.dirname(raw), { recursive: true }); fs.writeFileSync(raw, '{"keep":1}\n')
  const ctx = (io, h = helper) => { const c = onCtx(home, io); return { ...c, platform: 'linux', env: { ...c.env, SHELL: '/bin/bash' }, deps: { ...c.deps, root, fs: helperFs(h) } } }
  return { home, rc, raw, ctx, root }
}

// 1.6 §3.6: the helper is machine-wide; a user's uninstall undoes everything of this user's and keeps only the code and the PATH item the removal line needs
test('1.6 §3.6: a helper still installed: exit 0, one shared left row with the removal line; only the code and the PATH item stay; once it is gone the next run removes them', async () => {
  const s = scriptLinux({ helper: true })
  const before = snapshot(s.home)
  assert.equal(await runInstallCli(['--yes'], s.ctx(fakeIo(), false)), 0)
  const item = readManifest(path.join(s.home, '.trocar', 'collector')).path_item
  const placed = fs.readFileSync(s.rc, 'utf8')
  // plan = act: the dry run names the shared row and does not plan the code, the launcher or the PATH item away
  const dry = fakeIo()
  assert.equal(await runUninstallCli(['--dry-run', '--json'], s.ctx(dry)), 0, dry.text())
  const plan = JSON.parse(dry.text())
  assert.deepEqual((plan.left || []).map((l) => [l.shared, typeof l.command]), [[true, 'string']], JSON.stringify(plan.left))
  assert.deepEqual(plan.planned.filter((p) => [appDir(s.home), launcherPath(s.home, 'linux'), s.rc].includes(p.path)), [], 'the plan keeps what the run keeps')
  const io = fakeIo()
  assert.equal(await runUninstallCli(['--purge-data', '--yes', '--json'], s.ctx(io)), 0, io.text())
  const r = JSON.parse(io.text())
  assert.deepEqual([r.ok, r.purge_data, r.problems, r.left.map((l) => [l.shared, l.command])], [true, true, [], [[true, setupHelperCommand(['--remove'], { root: s.root })]]], io.text())
  // of trocar's, exactly the code (unchanged), the PATH line and what takes it out again (its backup, its record) remain: no unit, no manifest, no state, no proxy entry
  const rest = changedFiles(before, snapshot(s.home)).filter((f) => f !== '.bashrc' && f !== path.relative(s.home, s.raw))
  assert.equal(fs.readFileSync(s.rc, 'utf8'), placed)
  assert.ok(rest.length <= 2 && rest.every((f) => path.join(s.home, f) === item.backup || (() => { try { return JSON.stringify(JSON.parse(fs.readFileSync(path.join(s.home, f), 'utf8'))) === JSON.stringify(item) } catch { return false } })()), JSON.stringify(rest))
  assert.deepEqual([fs.existsSync(appDir(s.home)), fs.existsSync(launcherPath(s.home, 'linux')), fs.existsSync(s.raw), fs.existsSync(unitPath(s.home))], [true, true, false, false])

  const again = fakeIo()
  assert.equal(await runUninstallCli(['--yes', '--json'], s.ctx(again, false)), 0, again.text())
  const r2 = JSON.parse(again.text())
  // 1.6 §3.6: --purge-data asked that nothing of trocar's stay, and the second run is clean: it starts no new record of its own (a clean result line never creates
  // the records dir; D38 asks for failures, which always write): no ~/.trocar entry stays
  assert.deepEqual([fs.readFileSync(s.rc, 'utf8'), r2.left, r2.kept, fs.existsSync(path.join(s.home, '.trocar'))], ['alias ll="ls -l"\n', [], [], false], 'nothing of trocar stays')
  assert.equal(r2.log, null, 'the receipt names no record it did not write')
  assert.deepEqual([fs.existsSync(appDir(s.home)), fs.existsSync(launcherPath(s.home, 'linux'))], [false, false])
})

// D38: the same second run, failing (its PATH item record cannot be read), still writes its record, the records dir made for it
test('1.6 §3.6 · D38: after --purge-data a second uninstall that fails writes its record, the records dir made for it', async () => {
  const s = scriptLinux({ helper: true })
  assert.equal(await runInstallCli(['--yes'], s.ctx(fakeIo(), false)), 0)
  assert.equal(await runUninstallCli(['--purge-data', '--yes', '--json'], s.ctx(fakeIo())), 0)
  const dir = path.join(s.home, '.trocar', 'collector')
  assert.equal(fs.existsSync(path.join(dir, 'flows')), false, 'the purge took the records')
  fs.writeFileSync(path.join(dir, 'path-item.json'), '{ not json')
  const io = fakeIo()
  assert.equal(await runUninstallCli(['--yes', '--json'], s.ctx(io, false)), 1, io.text())
  assert.ok(flowEvents(dir).some((e) => e.kind === 'result' && e.outcome !== 'uninstalled'), 'the failed run is recorded')
})

// D38 (4.6 §卸载 5): a warning is of the failure class: a run that is otherwise clean (outcome `uninstalled`) still writes it, the records dir made for it
test('1.6 §3.6 · D38: after --purge-data a clean second uninstall with a warning writes it, the records dir made for it', async () => {
  const s = scriptLinux({ helper: true })
  assert.equal(await runInstallCli(['--yes'], s.ctx(fakeIo(), false)), 0)
  assert.equal(await runUninstallCli(['--purge-data', '--yes', '--json'], s.ctx(fakeIo())), 0)
  const dir = path.join(s.home, '.trocar', 'collector'), ingress = path.join(dir, 'ingress.json')
  fs.writeFileSync(ingress, '{}\n')
  const ctx = s.ctx(fakeIo(), false), io = fakeIo()
  const stuck = { ...fs, rmSync: (p, o) => { if (p === ingress) throw Object.assign(new Error('busy'), { code: 'EBUSY' }); return fs.rmSync(p, o) } }
  assert.equal(await runUninstallCli(['--yes', '--json'], { ...ctx, io, deps: { ...ctx.deps, fs: stuck } }), 0, io.text())
  const r = JSON.parse(io.text())
  assert.deepEqual([r.log, flowEvents(dir).filter((e) => e.code === 'residue-not-removed').map((e) => e.path)], [path.join(dir, 'flows'), [ingress]], 'the warning is recorded')
})

test('D38: a PATH item record that cannot be read is said, never taken as no PATH item', async () => {
  const s = scriptLinux({ helper: true })
  assert.equal(await runInstallCli(['--yes'], s.ctx(fakeIo(), false)), 0)
  // the flows result counts every left row the receipt has: a shared one apart from one left undone (one document never contradicts itself)
  const counted = (io) => { const r = JSON.parse(io.text()), c = flowEvents(path.join(s.home, '.trocar', 'collector')).filter((e) => e.kind === 'result').at(-1).counts
    return [c.left, c.shared ?? 0, r.left.filter((l) => !l.shared).length, r.left.filter((l) => l.shared).length] }
  const first = fakeIo()
  assert.equal(await runUninstallCli(['--yes', '--json'], s.ctx(first)), 0)
  assert.deepEqual(counted(first), [0, 1, 0, 1])
  const rec = path.join(s.home, '.trocar', 'collector', 'path-item.json')
  fs.writeFileSync(rec, '{ not json')
  const dry = fakeIo()
  assert.equal(await runUninstallCli(['--dry-run', '--json'], s.ctx(dry, false)), 0, dry.text())
  assert.deepEqual((JSON.parse(dry.text()).left || []).map((l) => l.path), [rec], 'the plan says it too')
  const io = fakeIo()
  assert.equal(await runUninstallCli(['--yes', '--json'], s.ctx(io, false)), 1, io.text())
  const r = JSON.parse(io.text())
  assert.deepEqual(r.left.map((l) => [l.path, l.shared ?? false]), [[rec, false]], 'the record is a left row that names it, not a crash')
  assert.deepEqual(counted(io), [1, 0, 1, 0])
  assert.ok(fs.readFileSync(s.rc, 'utf8').includes('.trocar/bin'), 'the PATH item is not quietly left behind as if gone')
})

test('D58: once a script uninstall removed trocar itself, its receipt names no trocar command; the kept records are named by path', async () => {
  const s = scriptLinux()
  assert.equal(await runInstallCli(['--yes'], s.ctx(fakeIo())), 0)
  const io = fakeIo()
  assert.equal(await runUninstallCli(['--yes'], s.ctx(io)), 0, io.text())
  assert.equal(fs.existsSync(appDir(s.home)), false)
  const named = COMMANDS.filter((c) => new RegExp(`\\btrocar ${c.name}\\b`).test(io.text())).map((c) => c.name)
  assert.deepEqual(named, [], io.text())
  assert.ok(io.text().includes('~/.trocar/raw'), io.text())
})

test('D58: a PATH item that was gone before uninstall is not said to be taken out', async () => {
  const s = scriptLinux()
  assert.equal(await runInstallCli(['--yes'], s.ctx(fakeIo())), 0)
  fs.writeFileSync(s.rc, 'alias ll="ls -l"\n') // the user took the line out by hand
  const io = fakeIo()
  assert.equal(await runUninstallCli(['--yes', '--json'], s.ctx(io)), 0, io.text())
  const r = JSON.parse(io.text())
  assert.deepEqual(r.changed.filter((c) => c.path === s.rc), [], JSON.stringify(r.changed))
})

// 1.6 §3.6 / C.2 `scheduled`: on Windows the code and the launcher go only once this process has exited, so the receipt lists them as scheduled, never
// as removed (D58); the command that removes them is handed exactly those paths, the pointer it checks (NO_POINTER when app\current was absent) and the
// failure line it leaves in flows/ when app\ is still there once its time is up (D38). There is no install record here: the receipt says the program
// goes, never that nothing was installed. `cmd.exe` is a stub on PATH that records what it was handed.
for (const current of ['9.9.9 node-x\n', null]) {
  test(`V113 (Windows): a script uninstall with no install record schedules app\\ and trocar.cmd for after it exits (app\\current ${current ? 'read' : 'absent'})`, async () => {
    const { runUninstall, NO_POINTER } = await import('../../src/cli/uninstall.mjs')
    const { recordingExec } = await import('../cli/fixtures/on-ctx.mjs')
    const home = tmpDir('trocar-win-script-')
    const root = path.join(appDir(home), '9.9.9')
    fs.mkdirSync(path.join(root, 'bin'), { recursive: true })
    fs.writeFileSync(path.join(root, 'package.json'), '{"name":"trocar-cli","version":"9.9.9"}\n')
    fs.writeFileSync(path.join(root, 'bin', 'trocar.mjs'), '')
    if (current) fs.writeFileSync(path.join(appDir(home), 'current'), current)
    const launcher = launcherPath(home, 'win32')
    fs.mkdirSync(path.dirname(launcher), { recursive: true }); fs.writeFileSync(launcher, '@echo off\r\n')
    const bin = path.join(home, 'stub-bin'); fs.mkdirSync(bin)
    const seen = path.join(home, 'cmd-saw.json')
    fs.writeFileSync(path.join(bin, 'cmd.exe'), `#!/bin/sh\nexec "${process.execPath}" -e 'require("fs").writeFileSync(process.argv[1], JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("TROCAR_RM_")))))' "${seen}"\n`, { mode: 0o755 })
    const { exit, receipt } = await runUninstall({ home, env: { HOME: home, PATH: bin }, yes: true, deps: { platform: 'win32', root, exec: recordingExec().run, procs: async () => [], sleep: async () => {}, drainMs: 0, getuid: () => 1000 } })
    assert.equal(exit, 0, JSON.stringify(receipt.problems))
    assert.deepEqual(receipt.removed.filter((p) => p === appDir(home) || p === launcher), [], 'not removed yet when the receipt is made')
    assert.deepEqual(receipt.scheduled, [appDir(home), launcher])
    assert.ok(!receipt.notes.some((n) => /nothing is installed/i.test(n)), `the program is scheduled, so something was installed: ${JSON.stringify(receipt.notes)}`)
    for (let i = 0; i < 50 && !fs.existsSync(seen); i++) await new Promise((r) => setTimeout(r, 20))
    const got = JSON.parse(fs.readFileSync(seen, 'utf8'))
    assert.deepEqual([got.TROCAR_RM_APP, got.TROCAR_RM_LAUNCHER, got.TROCAR_RM_POINTER], [appDir(home), launcher, current ? '9.9.9 node-x' : NO_POINTER], 'handed the paths it removes and the pointer it checks')
    const line = JSON.parse(got.TROCAR_RM_FAILED)
    assert.deepEqual([path.dirname(got.TROCAR_RM_FLOW), line.event, line.code, line.path], [path.join(home, '.trocar', 'collector', 'flows'), 'failure', 'residue-not-removed', appDir(home)], 'what it leaves where status reads failures')
  })
}

// how the deferred removal waits (src/off/exec.mjs spawnDetached): the child's stdin ends only when the process that started it has exited
test('spawnDetached: the child reads the end of its stdin only once its parent has exited', async () => {
  const dir = tmpDir('trocar-detached-')
  const stub = path.join(dir, 'waiter'), marks = path.join(dir, 'marks')
  fs.writeFileSync(stub, `#!/bin/sh\n/bin/cat >/dev/null\n"${process.execPath}" -e 'require("fs").appendFileSync(process.argv[1], "eof " + Date.now() + "\\n")' "${marks}"\n`, { mode: 0o755 })
  const parent = [`import fs from 'node:fs'`, `import { spawnDetached } from ${JSON.stringify(new URL('../../src/off/exec.mjs', import.meta.url).href)}`,
    `spawnDetached(${JSON.stringify(stub)}, [])`, `setTimeout(() => fs.appendFileSync(${JSON.stringify(marks)}, 'exit ' + Date.now() + '\\n'), 1500)`].join('\n')
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', parent], { encoding: 'utf8', env: { ...process.env, PATH: dir } })
  assert.equal(r.status, 0, r.stderr)
  for (let i = 0; i < 100 && !/eof/.test(fs.existsSync(marks) ? fs.readFileSync(marks, 'utf8') : ''); i++) await new Promise((res) => setTimeout(res, 20))
  const lines = fs.readFileSync(marks, 'utf8').trim().split('\n').map((l) => l.split(' '))
  assert.deepEqual(lines.map((l) => l[0]), ['exit', 'eof'], 'the parent exited first')
})
