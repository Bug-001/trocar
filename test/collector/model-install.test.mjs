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

// 1.6 §1.6: an add the OS answers with success while the root is not trusted when read back (a box cancelled whose tool still exits 0)
// is not "added": the item is pending, exit 1, the rest done; the next install, whose add takes, completes.
test('1.6 §1.6 · an add that reports success but is not trusted when read back → root-store pending, exit 1; the next install completes', async () => {
  const w = await everything()
  const add = w.store.add
  w.store.add = () => ({ ok: true }) // the tool exits 0, the trust setting never lands
  const r = await w.install({ wrapperKit: { renderWrapper } })
  assert.deepEqual([r.exit, r.pending.map((p) => [p.item, p.state])], [1, [['root-store', 'pending']]])
  assert.match(r.pending[0].reason, /not find it trusted/)
  assert.equal(readManifest(w.dir).install.state, 'partial')
  assert.ok(!r.items.some((i) => i.item === 'root-store' && i.state === 'added'), 'never said added')
  w.store.add = add
  const again = await w.install({ wrapperKit: { renderWrapper } })
  assert.equal(again.exit, 0)
  assert.equal(readManifest(w.dir).install.state, 'complete')
})

// CM35 (4.11 §3 ㉒): the lost-key install. The custody's key gone behind asight's back (exists() false, the manifest records the old root) → the old
// root leaves the store by its recorded fingerprint, one new key and root are made and added, and every carrier holding root bytes holds only the new
// root: asight-ca.pem, Z-Code's bundle, the pem-block in the user's file (the user's bytes outside the marks as they were); their installed_at moves.
async function lostKeyWorld() {
  const w = await modelWorld({ commands: ['codex', 'dsh'], env: (home) => ({ SSL_CERT_FILE: path.join(home, 'certs', 'mine.pem') }) })
  put(w.env.SSL_CERT_FILE, USER_PEM)
  fs.mkdirSync(path.join(w.home, '.zcode'), { recursive: true })
  fs.mkdirSync(path.join(w.home, '.dsh'), { recursive: true })
  const r1 = await w.install({ wrapperKit: { renderWrapper } })
  assert.equal(r1.exit, 0, JSON.stringify({ c: r1.carriers, p: r1.problems }))
  return { w, r1, at1: carrierTimes(w) }
}
const later = () => new Date(Date.now() + 3600e3)
const bundleOf = (w) => json(path.join(w.home, '.zcode', 'cli', 'config.json')).network.caCertFile
const fpsIn = (f) => certBlocks(fs.readFileSync(f, 'utf8')).map((b) => b.fp)
function carrierTimes(w) {
  const m = readManifest(w.dir)
  return { ca: m.files.find((f) => f.role === 'ca-cert').installed_at, bundle: m.files.find((f) => f.role === 'bundle').installed_at, block: m.entries.find((e) => e.format === 'pem-block').installed_at }
}
function assertOnlyNewRoot(w, r1, r2, at1) {
  assert.notEqual(r2.fp256, r1.fp256)
  assert.deepEqual(fpsIn(path.join(w.dir, 'ca', 'asight-ca.pem')), [r2.fp256])
  assert.equal(fpsIn(bundleOf(w)).at(-1), r2.fp256); assert.ok(!fpsIn(bundleOf(w)).includes(r1.fp256), 'the bundle no longer holds the old root')
  const mine = fs.readFileSync(w.env.SSL_CERT_FILE, 'utf8')
  assert.ok(mine.startsWith(USER_PEM), 'the user\'s bytes before the marks as they were')
  assert.deepEqual(fpsIn(w.env.SSL_CERT_FILE), [certBlocks(USER_PEM)[0].fp, r2.fp256], 'one block, the new root\'s')
  const m = readManifest(w.dir)
  assert.equal(m.entries.filter((e) => e.format === 'pem-block').length, 1)
  assert.deepEqual(m.entries.filter((e) => e.kind === 'root-key').map((e) => e.fp256), [r2.fp256])
  const at2 = carrierTimes(w)
  for (const k of Object.keys(at1)) assert.ok(at2[k] > at1[k], `${k}: installed_at moved (${at1[k]} → ${at2[k]})`)
}

test('CM35: the key lost → remove the old root once by its fingerprint, create once, add once; every carrier holds only the new root; exit 0', async () => {
  const { w, r1, at1 } = await lostKeyWorld()
  w.custody.switches.keyLost = true
  const calls = w.store.calls.length, creates = w.custody.calls.filter((c) => c.verb === 'create').length
  const r2 = await w.install({ wrapperKit: { renderWrapper }, now: later })
  assert.equal(r2.exit, 0, JSON.stringify({ c: r2.carriers, p: r2.problems, pe: r2.pending }))
  assert.deepEqual(w.store.calls.slice(calls), ['remove', 'has', 'add', 'has'], 'the add is read back')
  assert.equal(w.custody.calls.filter((c) => c.verb === 'create').length - creates, 1)
  assert.ok(!w.store.held.has(r1.fp256) && w.store.held.has(r2.fp256))
  assert.deepEqual(readManifest(w.dir).entries.filter((e) => e.kind === 'system-root').map((e) => e.fp256), [r2.fp256])
  assertOnlyNewRoot(w, r1, r2, at1)
})

test('CM35: the old root\'s removal refused → the new root is installed all the same, the old one reported as an orphan with its removal, exit 1', async () => {
  const { w, r1, at1 } = await lostKeyWorld()
  w.custody.switches.keyLost = true
  w.store.remove = () => ({ ok: false, reason: 'User canceled' })
  const r2 = await w.install({ wrapperKit: { renderWrapper }, now: later })
  assert.equal(r2.exit, 1)
  assert.match(r2.problems.join('\n'), new RegExp(`orphan: the old asight root ${r1.fp256}.*User canceled.*by hand`))
  assert.deepEqual(r2.items.find((i) => i.item === 'old-root'), { item: 'old-root', state: 'orphan', fp256: r1.fp256 })
  assert.ok(readManifest(w.dir).entries.some((e) => e.kind === 'system-root' && e.fp256 === r1.fp256 && e.orphan), 'kept on record: uninstall removes it')
  assertOnlyNewRoot(w, r1, r2, at1)
})

// the reverse: the key is there but asight cannot read its root back — asight-ca.pem gone, or the manifest's record gone — install must not crash on
// the custody's 'exists'; it takes ㉒'s path (the custody has no verb that returns the root)
for (const [what, lose] of [['asight-ca.pem gone', (w) => fs.rmSync(path.join(w.dir, 'ca', 'asight-ca.pem'))], ['the root-key record gone', (w) => { const m = readManifest(w.dir); m.entries = m.entries.filter((e) => e.kind !== 'root-key'); fs.writeFileSync(path.join(w.dir, 'install-manifest.json'), JSON.stringify(m)) }]]) {
  test(`CM35 reverse: the key present, ${what} → no crash; the stray key goes, a new root is made and carried`, async () => {
    const { w, r1 } = await lostKeyWorld()
    lose(w)
    const r2 = await w.install({ wrapperKit: { renderWrapper }, now: later })
    assert.ok(w.custody.calls.some((c) => c.verb === 'remove'))
    assert.notEqual(r2.fp256, r1.fp256)
    assert.deepEqual(fpsIn(path.join(w.dir, 'ca', 'asight-ca.pem')), [r2.fp256])
    assert.equal(fpsIn(bundleOf(w)).at(-1), r2.fp256)
    assert.deepEqual(readManifest(w.dir).entries.filter((e) => e.kind === 'root-key').map((e) => e.fp256), [r2.fp256])
    assert.ok(!w.store.held.has(r1.fp256), 'the old root left the store by the fingerprint its store record holds')
    assert.deepEqual(readManifest(w.dir).entries.filter((e) => e.kind === 'system-root').map((e) => e.fp256), [r2.fp256])
  })
}

test('CM35 · 1.6 V67: the key present and readable → install calls create zero times', async () => {
  const { w } = await lostKeyWorld()
  const creates = w.custody.calls.filter((c) => c.verb === 'create').length
  await w.install({ wrapperKit: { renderWrapper }, now: later })
  assert.equal(w.custody.calls.filter((c) => c.verb === 'create').length, creates)
})
