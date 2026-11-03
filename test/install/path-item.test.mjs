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
import { pathItemTarget } from '../../src/off/path-item.mjs'
import { appDir, launcherPath } from '../../src/off/paths.mjs'
import { orphanBackups } from '../../src/off/backup.mjs'
import { fakeIo, onCtx, seedClaude } from '../cli/fixtures/on-ctx.mjs'
import { COMMANDS } from '../../src/cli/commands.mjs'

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
