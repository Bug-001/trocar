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
import { fakeIo, onCtx, seedClaude } from '../cli/fixtures/on-ctx.mjs'
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
  const ctx = (io) => { const c = onCtx(home, io); return { ...c, platform: 'linux', env: { ...c.env, SHELL: '/bin/bash' }, deps: { ...c.deps, root } } }

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
  const withHelper = { ...fs, existsSync: (p) => p === DEFAULT_REDIRECTOR_BIN || fs.existsSync(p) }
  const ctx = (io, h = helper) => { const c = onCtx(home, io); return { ...c, platform: 'linux', env: { ...c.env, SHELL: '/bin/bash' }, deps: { ...c.deps, root, ...(h ? { fs: withHelper } : {}) } } }
  return { home, rc, raw, ctx }
}

test('1.6 §3.6: a helper still installed keeps the code, the PATH item and every record, even with --purge-data; it is a left row in flows/; once it is gone the next run removes the rest', async () => {
  const s = scriptLinux({ helper: true })
  assert.equal(await runInstallCli(['--yes'], s.ctx(fakeIo(), false)), 0)
  const placed = fs.readFileSync(s.rc, 'utf8')
  // plan = act: the dry run names the helper row and does not plan the code, the launcher or the PATH item away
  const dry = fakeIo()
  assert.equal(await runUninstallCli(['--dry-run', '--json'], s.ctx(dry)), 0, dry.text())
  const plan = JSON.parse(dry.text())
  assert.ok((plan.left || []).some((l) => l.path === DEFAULT_REDIRECTOR_BIN && typeof l.command === 'string'), JSON.stringify(plan.left))
  assert.deepEqual(plan.planned.filter((p) => [appDir(s.home), launcherPath(s.home, 'linux'), s.rc].includes(p.path)), [], 'the plan keeps what the run keeps')
  const io = fakeIo()
  assert.equal(await runUninstallCli(['--purge-data', '--yes', '--json'], s.ctx(io)), 1, io.text())
  const r = JSON.parse(io.text())
  assert.equal(r.purge_data, false)
  assert.ok(r.left.some((l) => l.path === DEFAULT_REDIRECTOR_BIN && typeof l.command === 'string'), 'the helper row, with its command')
  assert.deepEqual(r.problems, [], 'a left row with its own command is the next step, not also a problem (1.6 §3.6)')
  assert.deepEqual([fs.readFileSync(s.raw, 'utf8'), fs.readFileSync(s.rc, 'utf8'), fs.existsSync(appDir(s.home)), fs.existsSync(launcherPath(s.home, 'linux'))], ['{"keep":1}\n', placed, true, true], 'records, PATH item, code and launcher all stay')
  const ev = flowEvents(path.join(s.home, '.trocar', 'collector')).filter((e) => e.event === 'uninstall-note' || e.where === 'uninstall')
  assert.ok(ev.some((e) => e.event === 'failure' && e.code === 'entry-not-undone' && e.path === DEFAULT_REDIRECTOR_BIN), 'D38: the left row is in flows/')
  assert.equal(ev.filter((e) => e.kind === 'result').at(-1).outcome, 'left')

  const again = fakeIo()
  assert.equal(await runUninstallCli(['--yes', '--json'], s.ctx(again, false)), 0, again.text())
  assert.deepEqual([fs.readFileSync(s.rc, 'utf8'), fs.existsSync(appDir(s.home)), fs.readFileSync(s.raw, 'utf8')], ['alias ll="ls -l"\n', false, '{"keep":1}\n'], 'the second run takes out the PATH item and the code')
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
