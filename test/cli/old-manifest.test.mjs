// test/cli/old-manifest.test.mjs — V69 (1.6 §V69, 4.11 ⑰) through the command line itself: with an install record of an earlier version
// (version 1 / 2, written before the collector model) in ~/.trocar/collector, each of `install`, `on`, `off` and `uninstall` exits 1 before writing
// anything — the HOME stays identical in bytes AND in modes, the standalone copy ~/.trocar/bin/trocar-off is not overwritten — and the document names
// the program that undoes it first. The command half of on / off / uninstall is covered per platform in test/off/v2-refusal.test.mjs; what is here is
// the whole dispatch (runCli), `install` included, and the `--json` document. Nothing reaches the machine: injected fs, no OS tool, no socket.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { runCli } from '../../src/cli/main.mjs'
import { EXIT } from '../../src/off/schema.mjs'
import { standalonePath } from '../../src/off/paths.mjs'
import { tilde } from '../../src/cli/receipt.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { fakeIo } from './fixtures/on-ctx.mjs'
import { assertEnglish } from '../helpers/english.mjs'

const OLD_COPY = '#!/usr/bin/env node\n// the copy the trocar that wrote this manifest left\n'
const noOs = () => { throw Object.assign(new Error('no OS tool may run on a refusal that happens before any write'), { code: 'ESANDBOX' }) }
const noSock = () => { throw Object.assign(new Error('no control socket on a refusal'), { code: 'ESANDBOX' }) }

/** A HOME holding an install record of `version` (before the collector model), the state file beside it and the standalone copy the old build left. */
function oldHome(version) {
  const home = tmpDir('trocar-old-manifest-')
  const dir = path.join(home, '.trocar', 'collector')
  fs.mkdirSync(dir, { recursive: true })
  const settings = path.join(home, '.claude', 'settings.json')
  fs.mkdirSync(path.dirname(settings), { recursive: true })
  fs.writeFileSync(settings, '{"env":{"NODE_EXTRA_CA_CERTS":"/old/ca.pem"}}\n')
  fs.writeFileSync(path.join(dir, 'install-manifest.json'), JSON.stringify({ version, complete: true, entries: [{ kind: 'json-key', harness: 'claude-code', path: settings, keys: ['env', 'NODE_EXTRA_CA_CERTS'], value: '/old/ca.pem', backup: null }], files: [] }))
  fs.mkdirSync(path.dirname(standalonePath(home)), { recursive: true })
  fs.writeFileSync(standalonePath(home), OLD_COPY, { mode: 0o700 })
  return home
}
/** Every path under `home` → its bytes (base64) or 'dir', and its mode: a write of any kind shows here. */
function snapshot(root) {
  const out = {}
  const walk = (d) => { for (const n of fs.readdirSync(d).sort()) { const p = path.join(d, n), st = fs.lstatSync(p); out[p] = [st.isDirectory() ? 'dir' : fs.readFileSync(p).toString('base64'), st.mode]; if (st.isDirectory()) walk(p) } }
  walk(root)
  return out
}

const ARGV = { install: ['install', '--yes'], on: ['on', '--yes'], off: ['off'], uninstall: ['uninstall', '--yes'] }

for (const version of [1, 2]) {
  test(`V69 · an install record of version ${version}: install / on / off / uninstall each exit 1 before any write, the HOME and the standalone copy untouched, the program to undo it named`, async () => {
    for (const [cmd, argv] of Object.entries(ARGV)) {
      const home = oldHome(version)
      const copy = standalonePath(home)
      const before = snapshot(home)
      const io = fakeIo()
      const exit = await runCli([...argv, '--json'], {
        io, home, platform: 'darwin', uid: 501, env: { HOME: home },
        deps: { getuid: () => 501, exec: noOs, procs: async () => [], parts: null, request: noSock, socketPath: path.join(home, 'nope.sock') },
      })
      assert.equal(exit, EXIT.incomplete, `${cmd}: exit 1 — ${io.text()}`)
      assert.deepEqual(snapshot(home), before, `${cmd}: the HOME is identical in bytes and modes`)
      assert.equal(fs.readFileSync(copy, 'utf8'), OLD_COPY, `${cmd}: the standalone copy is not overwritten`)
      const doc = io.json()
      assert.equal(doc.ok, false, `${cmd}: the document says it did not happen`)
      const text = JSON.stringify(doc)
      assert.ok(text.includes(JSON.stringify(copy).slice(1, -1)), `${cmd}: the document names the program that undoes the older install — ${text}`)
      assert.equal(io.stderrText(), '', `${cmd}: with --json stderr stays empty (R5)`)
    }
  })
}

test('V69 · 1.6 §1.1⑤⑥ the refusal as text: install, on, off and uninstall fit 80 columns, each command whole on its own line, HOME as ~', async () => {
  for (const cmd of ['install', 'on', 'off', 'uninstall']) {
    const home = oldHome(2)
    const io = fakeIo()
    const exit = await runCli(ARGV[cmd], {
      io, home, platform: 'darwin', uid: 501, env: { HOME: home },
      deps: { getuid: () => 501, exec: noOs, procs: async () => [], parts: null, request: noSock, socketPath: path.join(home, 'nope.sock') },
    })
    assert.equal(exit, EXIT.incomplete, `${cmd}: exit 1 — ${io.text()}`)
    assertEnglish(io.text(), `trocar ${cmd} (older install)`)
    const lines = io.text().split('\n').filter((l) => l.trim()), commands = ['trocar off', 'trocar uninstall', tilde(standalonePath(home), home)]
    assert.ok(lines.some((l) => l.trim() === commands[2]), `${cmd}: the standalone copy as a command of its own, under ~\n${io.text()}`)
    const indent = (l) => l.length - l.trimStart().length, isCommand = (l) => commands.includes(l.trim())
    assert.ok(Math.min(...lines.filter(isCommand).map(indent)) > Math.max(...lines.filter((l) => !isCommand(l)).map(indent)), `${cmd}: every command sits deeper than the prose around it, a folded prose line never at a command's indent (§1.1⑥)\n${io.text()}`)
  }
})
