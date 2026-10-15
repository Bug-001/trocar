// `asight install` on macOS / Windows (RFC 4.11 §1 install, P1–P4; plan T20): CM9 (Z-Code's bundle), CM10 (bundled Claude Code), CM25 (no admin
// step, nothing root-owned under HOME), CM26 (no login-environment write, through a recording fs), CM1's fingerprint from install to re-install, D54
// (install; install changes no byte, makes no second key, raises no prompt) and the OS prompt's declined / pending (exit 1, the rest still done).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import tls from 'node:tls'
import { modelWorld } from '../helpers/model-world.mjs'
import { renderWrapper } from '../../src/collector/arch/darwin/wrapper.mjs'
import { readManifest } from '../../src/off/manifest.mjs'
import { certBlocks } from '../../src/off/pem.mjs'

const MACHO = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0])
const put = (f, data) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, data) }
const json = (f) => JSON.parse(fs.readFileSync(f, 'utf8'))
const snapshot = (root) => { const out = {}; const walk = (d) => { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); const st = fs.lstatSync(p); if (st.isDirectory()) walk(p); else out[p] = `${st.mtimeMs}:${st.ino}:${fs.readFileSync(p).toString('base64')}` } }; walk(root); return out }
const USER_PEM = `${tls.rootCertificates[1].trim()}\n`

/** Every harness present: the commands on PATH, Kimi's native program, Z-Code's folder, the Claude Code bundled store. */
async function everything(env = {}) {
  const w = await modelWorld({ commands: ['claude', 'codex', 'dsh', 'kimi'], env: { CLAUDE_CODE_CERT_STORE: 'bundled', ...env } })
  put(path.join(w.home, '.kimi-code', 'bin', 'kimi'), MACHO)
  fs.mkdirSync(path.join(w.home, '.zcode'), { recursive: true })
  fs.mkdirSync(path.join(w.home, '.dsh'), { recursive: true })
  return w
}

test('CM9: Z-Code\'s caCertFile → a bundle of Node\'s own roots plus the asight root, no system roots — written only while the key is unset; set, the user\'s file gets the block', async () => {
  const w = await everything()
  const r = await w.install({ wrapperKit: { renderWrapper } })
  const cfg = path.join(w.home, '.zcode', 'cli', 'config.json')
  const bundle = json(cfg).network.caCertFile
  const fps = certBlocks(fs.readFileSync(bundle, 'utf8')).map((b) => b.fp)
  const node = tls.rootCertificates.flatMap((p) => certBlocks(p).map((b) => b.fp))
  assert.deepEqual(fps.slice(0, -1), node, 'Node\'s roots, in order, nothing else')
  assert.equal(fps.at(-1), r.fp256, 'and the asight root last')
  // the key already set by the user: config.json is not touched, the user's file takes the block
  const w2 = await everything()
  const mine = path.join(w2.home, 'certs', 'z.pem'); put(mine, USER_PEM)
  put(path.join(w2.home, '.zcode', 'cli', 'config.json'), JSON.stringify({ network: { caCertFile: mine } }))
  const before = fs.readFileSync(path.join(w2.home, '.zcode', 'cli', 'config.json'))
  const r2 = await w2.install({ wrapperKit: { renderWrapper } })
  assert.deepEqual(fs.readFileSync(path.join(w2.home, '.zcode', 'cli', 'config.json')), before)
  assert.equal(r2.carriers.find((c) => c.harness === 'z-code' && c.carrier === 'pem-block').state, 'placed')
})

for (const inSettings of [false, true]) for (const inEnv of [false, true]) {
  test(`CM10: bundled Claude Code, NODE_EXTRA_CA_CERTS ${inSettings ? 'in' : 'not in'} the settings and ${inEnv ? 'in' : 'not in'} the install env → ${!inSettings && !inEnv ? 'settings env points at asight-ca.pem' : 'settings untouched, the block appended to the named file'}`, async () => {
    const w0 = await modelWorld()
    const mine = path.join(w0.home, 'mine.pem')
    const w = await everything(inEnv ? { NODE_EXTRA_CA_CERTS: mine } : {})
    const named = inEnv ? mine : path.join(w.home, 'settings-ca.pem')
    put(named, USER_PEM)
    const settings = path.join(w.home, '.claude', 'settings.json')
    if (inSettings) put(settings, JSON.stringify({ env: { NODE_EXTRA_CA_CERTS: named } }))
    const before = inSettings ? fs.readFileSync(settings) : null
    await w.install({ wrapperKit: { renderWrapper } })
    if (!inSettings && !inEnv) assert.equal(json(settings).env.NODE_EXTRA_CA_CERTS, path.join(w.dir, 'ca', 'asight-ca.pem'))
    else {
      if (inSettings) assert.deepEqual(fs.readFileSync(settings), before)
      else assert.equal(fs.existsSync(settings), false, 'no settings file made')
      assert.equal(certBlocks(fs.readFileSync(named, 'utf8')).length, 2, 'the user\'s file holds its own certificate and asight\'s')
    }
  })
}

test('D54 · CM1: install; install changes no byte, makes no second key, raises no prompt — the fingerprint stays', async () => {
  const w = await everything()
  const r1 = await w.install({ wrapperKit: { renderWrapper } })
  assert.equal(r1.exit, 0, JSON.stringify({ c: r1.carriers, p: r1.problems, pend: r1.pending }))
  const snap = snapshot(w.home)
  const calls = w.store.calls.length
  const r2 = await w.install({ wrapperKit: { renderWrapper } })
  assert.deepEqual(snapshot(w.home), snap, 'not one byte, mtime or inode changed')
  assert.equal(w.custody.calls.filter((c) => c.verb === 'create').length, 1, 'one key')
  assert.deepEqual(w.store.calls.slice(calls), ['has'], 'read back by fingerprint, no add, no prompt')
  assert.equal(r2.fp256, r1.fp256)
  assert.equal(readManifest(w.dir).install.state, 'complete')
})

test('CM25 · CM26: no admin item, nothing root-owned under HOME, and no write to a login environment (rc / profile / environment.d) — a recording fs over every harness present', async () => {
  const w = await everything()
  const wrote = []
  const rec = (name, i) => (...a) => { wrote.push(String(a[i])); return fs[name](...a) }
  const recFs = new Proxy(fs, { get: (t, k) => ({ writeFileSync: rec('writeFileSync', 0), appendFileSync: rec('appendFileSync', 0), renameSync: rec('renameSync', 1), copyFileSync: rec('copyFileSync', 1), openSync: (f, flags, ...rest) => { if (/[wa+]/.test(String(flags || 'r'))) wrote.push(String(f)); return fs.openSync(f, flags, ...rest) } }[k] || t[k]) })
  const r = await w.install({ wrapperKit: { renderWrapper }, fs: recFs })
  assert.equal(r.exit, 0, JSON.stringify(r.carriers))
  assert.ok(wrote.length > 0, 'the recording fs saw the writes')
  assert.deepEqual(wrote.filter((f) => /(^|[\\/])\.(zshrc|zshenv|zprofile|bashrc|bash_profile|profile|login)$|environment\.d|LaunchAgents[\\/].*setenv/.test(f)), [], 'no login-environment file')
  const m = readManifest(w.dir)
  assert.deepEqual([...m.entries, ...m.files].filter((x) => x.scope === 'machine' || x.phase !== 'install'), [], 'every item is the user\'s and phase install')
  const rootOwned = Object.keys(snapshot(w.home)).filter((f) => fs.statSync(f).uid === 0)
  assert.deepEqual(rootOwned, [])
})

for (const answer of ['declined', 'pending']) {
  test(`1.6 §1.6: the root store prompt ${answer} → that item is ${answer}, the carriers are still placed, exit 1; the next install adds it`, async () => {
    const w = await everything()
    w.store.answer = answer
    const r = await w.install({ wrapperKit: { renderWrapper } })
    assert.deepEqual([r.exit, r.pending.map((p) => [p.item, p.state])], [1, [['root-store', answer]]])
    assert.ok(r.carriers.some((c) => c.carrier === 'wrapper' && c.state === 'placed'))
    assert.equal(readManifest(w.dir).install.state, 'partial')
    w.store.answer = 'ok'
    const again = await w.install({ wrapperKit: { renderWrapper } })
    assert.equal(again.exit, 0)
    assert.equal(readManifest(w.dir).install.state, 'complete')
  })
}
