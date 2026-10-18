// test/off/v2-refusal.test.mjs — CM29 (4.11 ruling ⑰, plan decision #11): a manifest of version 1 or 2 (written before the collector model) is never
// migrated in-tree. Every command that can write — on, off, uninstall, the standalone asight-off — refuses it BEFORE ANY write (the standalone copy
// ~/.asight/bin/asight-off is not overwritten either), exits 1, and names the tools that undo it in order: the asight from main before the collector
// model (`asight off`, then `asight uninstall`), then the standalone copy, printed on Windows as `node "<path>"`. Cases are generated over
// command × platform × manifest version; every write call of the injected fs is recorded and the sandbox HOME is compared byte for byte.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpDir } from '../helpers/tmp.mjs'
import { runOnCli } from '../../src/cli/on.mjs'
import { runUninstallCli } from '../../src/cli/uninstall.mjs'
import { runOffCli } from '../../src/off/main.mjs'
import { parseManifest, refuseOldManifest } from '../../src/off/manifest.mjs'
import { standalonePath } from '../../src/off/paths.mjs'

const WRITES = ['writeFileSync', 'appendFileSync', 'renameSync', 'mkdirSync', 'unlinkSync', 'rmSync', 'rmdirSync', 'copyFileSync', 'chmodSync', 'symlinkSync', 'truncateSync', 'utimesSync']
// node:fs with every write recorded (and still done: a write that slipped through shows in the HOME snapshot too); openSync with a write flag counts
function recordingFs() {
  const calls = []
  const rec = { ...fs }
  for (const name of WRITES) rec[name] = (...a) => { calls.push([name, String(a[0])]); return fs[name](...a) }
  const writes = (flags) => (typeof flags === 'number' ? (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR)) !== 0 : /[wa+]/.test(String(flags)))
  rec.openSync = (p, flags = 'r', ...rest) => { if (writes(flags)) calls.push(['openSync', String(p), flags]); return fs.openSync(p, flags, ...rest) }
  return { fs: rec, calls }
}
// every file under `root` → its bytes (base64), every directory → 'dir'
function snapshot(root) {
  const out = {}
  const walk = (d) => { for (const n of fs.readdirSync(d)) { const p = path.join(d, n), st = fs.lstatSync(p); if (st.isDirectory()) { out[p] = 'dir'; walk(p) } else out[p] = fs.readFileSync(p).toString('base64') } }
  walk(root)
  return out
}
const fakeIo = () => { const lines = []; return { out: (s) => lines.push(String(s)), err: (s) => lines.push(String(s)), stdin: { isTTY: false }, stdout: { isTTY: false, write: () => true }, stderr: { isTTY: false, write: () => true }, text: () => lines.join('\n') } }

const OLD_COPY = '#!/usr/bin/env node\n// asight-off version 10 (the copy the asight that wrote this manifest made)\n'
function v2Home(version) {
  const home = tmpDir('asight-v2-')
  const dir = path.join(home, '.asight', 'collector')
  fs.mkdirSync(dir, { recursive: true })
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
  const settings = path.join(home, '.claude', 'settings.json')
  fs.writeFileSync(settings, '{"env":{"NODE_EXTRA_CA_CERTS":"/h/.asight/collector/ca/asight-ca.pem"}}\n')
  const doc = { ...(version === 1 ? {} : { version }), complete: true, entries: [{ kind: 'json-key', harness: 'claude-code', path: settings, keys: ['env', 'NODE_EXTRA_CA_CERTS'], value: '/h/.asight/collector/ca/asight-ca.pem', backup: null }], files: [] }
  fs.writeFileSync(path.join(dir, 'install-manifest.json'), JSON.stringify(doc))
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ version: 2, updated_at: 'T0', harnesses: { 'claude-code': { desired: 'on', updated_at: 'T0' } } }))
  fs.mkdirSync(path.dirname(standalonePath(home)), { recursive: true })
  fs.writeFileSync(standalonePath(home), OLD_COPY, { mode: 0o700 })
  return home
}

const noOs = () => { throw Object.assign(new Error('no OS tool may run on a v2 refusal'), { code: 'ESANDBOX' }) }
const COMMANDS = {
  on: (o) => runOnCli(['--yes'], o),
  off: (o) => runOffCli([], o),
  uninstall: (o) => runUninstallCli(['--yes'], o),
  'standalone off': (o) => runOffCli([], { ...o, standalone: true }),
}
const whoami = (file) => (file === 'whoami' || /whoami/i.test(String(file)) ? { status: 0, stdout: '"x","S-1-16-8192"\n', stderr: '' } : noOs())

for (const [cmd, run] of Object.entries(COMMANDS)) {
  for (const platform of ['linux', 'darwin', 'win32']) {
    for (const version of [1, 2]) {
      test(`CM29 ${cmd} · ${platform} · manifest version ${version}: refused before any write, exit 1, the old build then the standalone copy named`, async () => {
        const home = v2Home(version)
        const before = snapshot(home)
        const { fs: rec, calls } = recordingFs()
        const io = fakeIo()
        const exit = await run({ io, home, env: { HOME: home }, platform, deps: { fs: rec, getuid: () => 1000, exec: whoami, procs: async () => [], parts: null, request: noOs } })
        assert.deepEqual(calls, [], `${cmd} wrote nothing through fs`)
        assert.deepEqual(snapshot(home), before, `${cmd}: the HOME is byte-identical, the standalone copy included`)
        assert.equal(exit, 1, io.text())
        const text = io.text(), copy = standalonePath(home)
        const main = text.indexOf('asight off'), un = text.indexOf('asight uninstall'), named = text.indexOf(copy) // the path keeps a line of its own, however the line is wrapped (§1.1 版式 6)
        assert.ok(main >= 0 && un > main && named > un, `the old build's off, then its uninstall, then the copy — in that order:\n${text}`)
        assert.match(text, new RegExp(`version ${version}`))
      })
    }
  }
}

test('CM29 parseManifest of a version below 3 is { unsupported: "v2", version, tools }, never a manifest; above 3 stays flagged unsupported as before', () => {
  for (const [doc, v] of [[{ entries: [], files: [] }, 1], [{ version: 1, entries: [] }, 1], [{ version: 2, entries: [], files: [] }, 2]]) {
    assert.deepEqual(parseManifest(JSON.stringify(doc)), { unsupported: 'v2', version: v, tools: ['main-before-model', 'standalone'] })
  }
  const later = parseManifest(JSON.stringify({ version: 4, entries: [], files: [] }))
  assert.deepEqual([later.unsupported, later.version], [true, 4])
  const home = v2Home(2)
  const r = refuseOldManifest({ home, platform: 'win32' })
  assert.equal(r.version, 2)
  assert.equal(refuseOldManifest({ home: tmpDir('asight-v2-none-'), platform: 'linux' }), null, 'no manifest: nothing to refuse')
})
