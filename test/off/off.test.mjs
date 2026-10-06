// test/off/off.test.mjs — what `asight off` does to the user's machine, from a real install of all seven harnesses (RFC 1.6 V15 · V25; the
// parts of V1 · V5 · V8 · V21 · V24 · V27 · V34 that the orchestration of Task 7 adds are in this file later). Every case installs through the
// real installCollector into a sandbox HOME and undoes through undoHarnesses with the process table handed in; nothing runs a real OS tool.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { installCollector } from '../../src/collector/install.mjs'
import { loadHarnesses } from '../../src/collector/harness/index.mjs'
import { createCa } from '../../src/collector/core/tls/ca.mjs'
import { readManifest } from '../../src/off/manifest.mjs'
import { undoHarnesses } from '../../src/off/undo.mjs'
import { certBlocks } from '../../src/off/pem.mjs'
import { HARNESS_IDS } from '../../src/cli/harness-names.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { sevenHomes, USER_CA } from './fixtures/seven-homes.mjs'

const ROOT = createCa({ commonName: 'off root' })
const roots = { node: [ROOT.certPem], osText: '' }
const walk = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])) : [])
// every file under `home` (skipping `skip`, relative) → sha256; directories count by their files, so a directory asight made and left is a difference too
const snapshot = (home, skip = []) => Object.fromEntries(walk(home).map((f) => [path.relative(home, f), crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')]).filter(([rel]) => !skip.some((s) => rel === s || rel.startsWith(s + path.sep))))
const dirsOf = (home, skip = []) => walk(home).map((f) => path.relative(home, path.dirname(f))).filter((d) => !skip.some((s) => d === s || d.startsWith(s + path.sep)))
const proc = (pid, exe, argv, { startedAt = Date.now() + 5000, env = {} } = {}) => ({ pid, exe, argv, startedAt, env: () => new Map(Object.entries(env)) })

async function sevenInstalled() {
  const home = tmpDir('asight-off-')
  const sh = sevenHomes(home)
  const before = snapshot(home)
  const beforeDirs = new Set(dirsOf(home))
  await installCollector({ home, env: sh.env, osName: 'linux', harnesses: await loadHarnesses(), freePort: async () => 47011, scan: async () => [], roots })
  const dir = path.join(home, '.asight', 'collector')
  const ca = (n) => path.join(dir, 'ca', n)
  const run = (o = {}) => undoHarnesses({ dir, home, manifest: readManifest(dir), ids: null, procs: async () => [], roots, ...o })
  return { home, sh, before, beforeDirs, dir, ca, run }
}

test('V15: seven harnesses have an entry after install, and off undoes each by 4.6: the user files byte for byte; a bundle a live process loaded is kept without the CA, a missing one a rereading process uses is rebuilt, an unused one is removed; extra files; plugins, shims and rc lines are gone', async () => {
  const s = await sevenInstalled()
  const m = readManifest(s.dir)
  assert.deepEqual([...new Set([...m.entries, ...m.files].map((e) => e.harness).filter(Boolean))].sort(), [...HARNESS_IDS].sort(), 'every harness has an entry — OpenCode\'s is its plugin file, a file asight owns')
  assert.deepEqual(Object.keys(m.liveness).sort(), [...HARNESS_IDS].sort(), 'and a liveness record')
  assert.deepEqual(m.files.filter((f) => f.role === 'bundle').map((f) => path.basename(f.path)).sort(), ['combined-codex.pem', 'combined-hermes.pem', 'combined-z-code.pem'])
  assert.deepEqual(m.files.filter((f) => f.role === 'trust-file').map((f) => path.basename(f.path)).sort(), ['extra-cc.pem', 'extra-kimi.pem'])
  const plugin = path.join(s.home, '.config', 'opencode', 'plugins', 'asight-ca.js')
  assert.ok(fs.existsSync(plugin) && fs.existsSync(path.join(s.dir, 'bin', 'kimi')) && fs.existsSync(path.join(s.dir, 'plugins', 'dsh', 'index.js')), 'plugins and the shim are in')
  assert.match(fs.readFileSync(path.join(s.home, '.bashrc'), 'utf8'), /asight collector/, 'the rc line is in')
  // a codex that started after install may have loaded combined-codex.pem; z-code's bundle was deleted by hand while a Z-Code that re-reads is running;
  // nothing holds combined-hermes.pem; a child of Claude Code inherited extra-cc.pem
  fs.rmSync(s.ca('combined-z-code.pem'))
  const live = [
    proc(4242, '/home/u/.local/bin/codex', ['codex']),
    proc(4343, '/opt/ZCode/zcode', ['/opt/ZCode/zcode', '/opt/ZCode/resources/glm/zcode.cjs', 'app-server', '--stdio'], { startedAt: 0, env: { ELECTRON_RUN_AS_NODE: '1' } }),
    proc(4444, '/usr/bin/node', ['node', '/x/tool.js'], { env: { NODE_EXTRA_CA_CERTS: s.ca('extra-cc.pem') } }),
    proc(4545, '/home/u/.kimi-code/bin/kimi', ['kimi-code'], { env: { NODE_EXTRA_CA_CERTS: s.ca('extra-kimi.pem') } }), // started through asight's shim
    proc(4546, '/home/u/.kimi-code/bin/kimi', ['kimi-code']), // by its absolute path: it never read asight's file
  ]
  const r = await s.run({ procs: async () => live })
  assert.deepEqual(r.left, [])
  assert.deepEqual(snapshot(s.home, ['.asight']), s.before, 'every user file byte for byte as before — the files asight created are gone')
  assert.deepEqual(new Set(dirsOf(s.home, ['.asight'])), s.beforeDirs, 'and so are the directories it made (.config/opencode/plugins, …)')
  const kept = Object.fromEntries(r.kept_bundles.map((k) => [path.basename(k.path), k]))
  assert.deepEqual(Object.keys(kept).sort(), ['combined-codex.pem', 'combined-z-code.pem', 'extra-cc.pem', 'extra-kimi.pem'], 'every file a live process holds; combined-hermes.pem is the one nobody does')
  const asightFp = certBlocks(fs.readFileSync(s.ca('asight-ca.pem'), 'utf8'))[0].fp
  const fps = (n) => certBlocks(fs.readFileSync(s.ca(n), 'utf8')).map((c) => c.fp)
  assert.deepEqual([kept['combined-codex.pem'].pids, fps('combined-codex.pem').includes(asightFp), fps('combined-codex.pem').length > 0], [[4242], false, true], 'kept for the codex that may have loaded it, the same file without the asight CA')
  assert.deepEqual([kept['combined-z-code.pem'].pids, kept['combined-z-code.pem'].rebuilt, fps('combined-z-code.pem').includes(asightFp), fps('combined-z-code.pem').includes(certBlocks(USER_CA.certPem)[0].fp)], [[4343], true, false, true], 'gone while a rereading Z-Code runs: rebuilt without the CA, with the user CA from the recorded source')
  assert.deepEqual([kept['extra-cc.pem'].pids, fps('extra-cc.pem').includes(asightFp), fps('extra-cc.pem').includes(certBlocks(USER_CA.certPem)[0].fp)], [[4444], false, true], 'a child inherited extra-cc.pem: kept without the asight CA, the user CA stays')
  assert.ok(!fs.existsSync(s.ca('combined-hermes.pem')), 'nobody holds combined-hermes.pem, so it is removed')
  assert.deepEqual([kept['extra-kimi.pem'].pids, fps('extra-kimi.pem').includes(asightFp)], [[4545], false], 'a kimi the shim started holds extra-kimi.pem')
  for (const p of [plugin, path.join(s.dir, 'bin'), path.join(s.dir, 'plugins')]) assert.ok(!fs.existsSync(p), `${p} is gone`)
  assert.ok(!/asight collector/.test(fs.readFileSync(path.join(s.home, '.bashrc'), 'utf8')) && !fs.readFileSync(path.join(s.home, '.dsh', 'cordis.patch.yml'), 'utf8').includes('asight'))
  assert.deepEqual(r.results.map((x) => x.result).filter((x) => x !== 'restored'), [], 'every entry came back byte for byte')
  assert.ok(fs.existsSync(s.ca('asight-ca.pem')) && fs.existsSync(s.ca('ca.key')), 'off keeps the CA')
  assert.deepEqual(r.still_trusting.map((x) => [x.pid, x.harness, x.until]).sort(), [[4242, 'codex', 'next-connection'], [4343, 'z-code', 'session-end'], [4545, 'kimi-code', 'restart']], 'a kimi by its absolute path (4546) never trusted asight: not reported')
})

test('V25: off codex undoes ~/.codex/.env and its bundle and nothing else — asight-ca.pem, every other entry and bundle byte for byte; a live codex keeps combined-codex.pem, without the CA', async () => {
  const s = await sevenInstalled()
  const everything = () => snapshot(s.home, ['.asight/collector/install-manifest.json', '.asight/collector/flows']) // the manifest is rewritten by design
  const before = everything()
  const r = await s.run({ ids: ['codex'] })
  assert.deepEqual(r.results.map((x) => [x.harness, path.relative(s.home, x.path), x.result]), [['codex', '.codex/.env', 'restored']])
  assert.equal(fs.readFileSync(s.sh.files.codex[0], 'utf8'), 'OPENAI_API_KEY=sk-test\n')
  const after = everything()
  const changed = Object.keys({ ...before, ...after }).filter((k) => before[k] !== after[k])
  assert.deepEqual(changed.map((k) => k.replace(/^\.asight\/backup\/.*$/, '.asight/backup/<codex .env>')).sort(), ['.asight/backup/<codex .env>', '.asight/collector/ca/combined-codex.pem', '.codex/.env'], 'its .env, its bundle and the backup of its .env — asight-ca.pem, the key, the other bundles and the other six harnesses\' files are byte for byte')
  assert.deepEqual(changed.filter((k) => after[k] === undefined).length, 2, 'the bundle and the backup are gone, not changed')
  assert.deepEqual([...new Set(readManifest(s.dir).entries.map((e) => e.harness))].sort(), HARNESS_IDS.filter((h) => h !== 'codex' && h !== 'opencode').sort(), 'the other harnesses are still installed (opencode has no entry, only a plugin file)')
  // with a live codex: the bundle stays, without the CA, and the other bundles still do not move
  const t = await sevenInstalled()
  const others = (n) => fs.readFileSync(t.ca(n), 'utf8')
  const hermesBefore = others('combined-hermes.pem')
  const k = await t.run({ ids: ['codex'], procs: async () => [proc(4242, '/home/u/.local/bin/codex', ['codex'])] })
  assert.deepEqual(k.kept_bundles.map((x) => [path.basename(x.path), x.pids]), [['combined-codex.pem', [4242]]])
  assert.deepEqual([others('combined-hermes.pem') === hermesBefore, certBlocks(others('combined-codex.pem')).length > 0], [true, true])
  assert.ok(!certBlocks(others('combined-codex.pem')).some((c) => c.fp === certBlocks(others('asight-ca.pem'))[0].fp))
  assert.deepEqual(k.still_trusting, [{ pid: 4242, harness: 'codex', until: 'next-connection' }])
})
