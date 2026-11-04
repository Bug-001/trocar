// `trocar install` on macOS / Windows (RFC 4.11 §1 install, P1–P4; plan T20): CM9 (Z-Code's bundle), CM10 (bundled Claude Code), CM25 (no admin
// step, nothing root-owned under HOME), CM26 (no login-environment write, through a recording fs), CM1's fingerprint from install to re-install, D54
// (install; install changes no byte, makes no second key, raises no prompt) and the OS prompt's declined / pending (exit 1, the rest still done).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import tls from 'node:tls'
import { modelWorld, sharedCertFileWorld } from '../helpers/model-world.mjs'
import { planInstall, ruleUFiles } from '../../src/collector/model-install.mjs'
import { renderWrapper } from '../../src/collector/arch/darwin/wrapper.mjs'
import { readManifest } from '../../src/off/manifest.mjs'
import { codeId } from '../../src/version.mjs'
import { certBlocks } from '../../src/off/pem.mjs'
import { loadHarnesses } from '../../src/collector/harness/index.mjs'
import { runUninstall } from '../../src/cli/uninstall.mjs'
import { recordingExec } from '../cli/fixtures/on-ctx.mjs'

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

// V85 (install): every file install changes outside ~/.trocar is named by its plan — rule U's block in the file the user's NODE_EXTRA_CA_CERTS names
// included (a Windows test machine 2026-11-04: the plan said only "reads your user trust store" for the two harnesses that read it)
for (const shape of ['shared file', 'every harness']) {
  test(`V85: the install plan names every file install then changes outside ~/.trocar (${shape})`, async () => {
    const w = shape === 'shared file' ? await sharedCertFileWorld({ userPem: USER_PEM }) : await everything()
    const rows = planInstall({ os: 'darwin', harnesses: w.harnesses, ctx: w.ctx, home: w.home, owns: w.owns })
    const paths = rows.flatMap((r) => r.paths)
    const mine = () => Object.fromEntries(Object.entries(snapshot(w.home)).filter(([k]) => !k.startsWith(path.join(w.home, '.trocar') + path.sep)).map(([k, v]) => [k, v.split(':').at(-1)]))
    const before = mine()
    await w.install({ wrapperKit: { renderWrapper } })
    const after = mine()
    const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => before[k] !== after[k])
    assert.ok(changed.length > 0)
    assert.deepEqual(changed.filter((f) => !paths.some((p) => f === p || f.startsWith(p + path.sep))), [], `changed but not in the plan: ${JSON.stringify(rows)}`)
  })
}

test('CM9: Z-Code\'s caCertFile → a bundle of Node\'s own roots plus the trocar root, no system roots — written only while the key is unset; set, the user\'s file gets the block', async () => {
  const w = await everything()
  const r = await w.install({ wrapperKit: { renderWrapper } })
  const cfg = path.join(w.home, '.zcode', 'cli', 'config.json')
  const bundle = json(cfg).network.caCertFile
  const fps = certBlocks(fs.readFileSync(bundle, 'utf8')).map((b) => b.fp)
  const node = tls.rootCertificates.flatMap((p) => certBlocks(p).map((b) => b.fp))
  assert.deepEqual(fps.slice(0, -1), node, 'Node\'s roots, in order, nothing else')
  assert.equal(fps.at(-1), r.fp256, 'and the trocar root last')
  // the key already set by the user: config.json is not touched, the user's file takes the block
  const w2 = await everything()
  const mine = path.join(w2.home, 'certs', 'z.pem'); put(mine, USER_PEM)
  put(path.join(w2.home, '.zcode', 'cli', 'config.json'), JSON.stringify({ network: { caCertFile: mine } }))
  const before = fs.readFileSync(path.join(w2.home, '.zcode', 'cli', 'config.json'))
  const r2 = await w2.install({ wrapperKit: { renderWrapper } })
  assert.deepEqual(fs.readFileSync(path.join(w2.home, '.zcode', 'cli', 'config.json')), before)
  assert.equal(r2.carriers.find((c) => c.harness === 'z-code' && c.carrier === 'pem-block').state, 'placed')
})

// CM9: a CA the user added through a setting the descriptor merges (the install shell's NODE_EXTRA_CA_CERTS, which caCertFile makes ineffective;
// ZCODE_AGENT_CA_CERT and the desktop CA setting, which override it while set) is in the bundle too: without it Z-Code — and the door, which
// verifies upstream with Z-Code's own trust — cannot reach a private-CA host. The bundle's manifest item names the files and fingerprints it
// merged, as the Linux bundles do: `off` / `uninstall` rebuild a bundle that is gone while a process holds it from those, or name what was lost (4.6)
for (const via of ['NODE_EXTRA_CA_CERTS', 'ZCODE_AGENT_CA_CERT', 'desktop setting']) {
  test(`CM9: a private CA named by ${via} → its certificate is in Z-Code's bundle, beside Node's roots and the trocar root; a non-certificate block is not`, async () => {
    const other = await modelWorld(); await other.install() // another machine's root: a CA no Node root store holds
    const priv = fs.readFileSync(path.join(other.dir, 'ca', 'trocar-ca.pem'), 'utf8')
    const w0 = await modelWorld(); const mine = path.join(w0.home, 'company.pem')
    const w = await everything(via === 'desktop setting' ? {} : { [via]: mine })
    put(mine, `${priv.trim()}\n-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n`)
    if (via === 'desktop setting') put(path.join(w.home, '.zcode', 'v2', 'setting.json'), JSON.stringify({ httpProxyCaCertPath: mine }))
    const r = await w.install({ wrapperKit: { renderWrapper } })
    const text = fs.readFileSync(json(path.join(w.home, '.zcode', 'cli', 'config.json')).network.caCertFile, 'utf8')
    const fps = certBlocks(text).map((b) => b.fp)
    for (const fp of [...certBlocks(priv).map((b) => b.fp), r.fp256, ...certBlocks(tls.rootCertificates[0]).map((b) => b.fp)]) assert.ok(fps.includes(fp), fp)
    assert.equal(new Set(fps).size, fps.length, 'each certificate once')
    assert.ok(!text.includes('PRIVATE KEY'), 'only certificate blocks are carried over')
    const item = readManifest(w.dir).files.find((f) => f.role === 'bundle' && f.harness === 'z-code')
    assert.deepEqual(item.sources, [mine], 'the merged file is the rebuild\'s source')
    assert.deepEqual(item.user_fps, certBlocks(priv).map((b) => b.fp), 'and its certificates are the user CAs a rebuild must keep')
  })
}

// rule U, one file named by two harnesses' settings (Windows test machine 2026-10-17: Claude Code and Kimi Code both read NODE_EXTRA_CA_CERTS; the second
// was refused "already holds trocar's text from an install this manifest does not list" and install exited 1): one block, one entry, both carriers in place
for (const [variable, harnesses] of [['NODE_EXTRA_CA_CERTS', ['claude-code', 'kimi-code']]]) { // (Codex and Hermes share SSL_CERT_FILE the same way; this world has no Hermes)
  test(`rule U: ${variable} names one user file for ${harnesses.join(' and ')} → one marked block, one entry, install exits 0; a second install changes nothing`, async () => {
    const w0 = await modelWorld()
    const mine = path.join(w0.home, 'mine.pem')
    const w = await everything({ [variable]: mine })
    put(mine, USER_PEM)
    const r = await w.install({ wrapperKit: { renderWrapper } })
    const rows = r.carriers.filter((c) => c.carrier === 'pem-block' && c.path === mine)
    for (const h of harnesses.filter((x) => rows.some((c) => c.harness === x))) assert.ok(['placed', 'intact'].includes(rows.find((c) => c.harness === h).state), JSON.stringify(rows))
    assert.ok(rows.length >= 2, `both harnesses route through the file: ${JSON.stringify(rows)}`)
    assert.equal(r.exit, 0, JSON.stringify(r.problems))
    const text = fs.readFileSync(mine, 'utf8')
    assert.equal(certBlocks(text).filter((b) => b.fp === r.fp256).length, 1, 'one block')
    assert.ok(text.startsWith(USER_PEM), 'the user\'s bytes first, as they were')
    assert.equal(readManifest(w.dir).entries.filter((e) => e.format === 'pem-block' && e.path === mine).length, 1)
    const again = await w.install({ wrapperKit: { renderWrapper } })
    assert.equal(again.exit, 0)
    assert.equal(fs.readFileSync(mine, 'utf8'), text)
  })
}

for (const inSettings of [false, true]) for (const inEnv of [false, true]) {
  test(`CM10: bundled Claude Code, NODE_EXTRA_CA_CERTS ${inSettings ? 'in' : 'not in'} the settings and ${inEnv ? 'in' : 'not in'} the install env → ${!inSettings && !inEnv ? 'settings env points at trocar-ca.pem' : 'settings untouched, the block appended to the named file'}`, async () => {
    const w0 = await modelWorld()
    const mine = path.join(w0.home, 'mine.pem')
    const w = await everything(inEnv ? { NODE_EXTRA_CA_CERTS: mine } : {})
    const named = inEnv ? mine : path.join(w.home, 'settings-ca.pem')
    put(named, USER_PEM)
    const settings = path.join(w.home, '.claude', 'settings.json')
    if (inSettings) put(settings, JSON.stringify({ env: { NODE_EXTRA_CA_CERTS: named } }))
    const before = inSettings ? fs.readFileSync(settings) : null
    await w.install({ wrapperKit: { renderWrapper } })
    if (!inSettings && !inEnv) assert.equal(json(settings).env.NODE_EXTRA_CA_CERTS, path.join(w.dir, 'ca', 'trocar-ca.pem'))
    else {
      if (inSettings) assert.deepEqual(fs.readFileSync(settings), before)
      else assert.equal(fs.existsSync(settings), false, 'no settings file made')
      assert.equal(certBlocks(fs.readFileSync(named, 'utf8')).length, 2, 'the user\'s file holds its own certificate and trocar\'s')
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
  assert.equal(readManifest(w.dir).install.code, codeId(), 'the record names the code that ran install (1.6 §5.5: what update compares)')
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
  const at = new Date(Date.now() + 3600e3)
  const again = await w.install({ wrapperKit: { renderWrapper }, now: () => at })
  assert.equal(again.exit, 0)
  assert.equal(readManifest(w.dir).install.state, 'complete')
  assert.deepEqual(readManifest(w.dir).entries.filter((e) => e.kind === 'system-root').map((e) => e.installed_at), [at.toISOString()], 'one record; its time is when the trust took (P11 ③)')
})

// CM35 (4.11 §3 ㉒): the lost-key install. The custody's key gone behind trocar's back (exists() false, the manifest records the old root) → the old
// root leaves the store by its recorded fingerprint, one new key and root are made and added, and every carrier holding root bytes holds only the new
// root: trocar-ca.pem, Z-Code's bundle, the pem-block in the user's file (the user's bytes outside the marks as they were); their installed_at moves.
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
  assert.deepEqual(fpsIn(path.join(w.dir, 'ca', 'trocar-ca.pem')), [r2.fp256])
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
  assert.match(r2.problems.join('\n'), new RegExp(`orphan: the old trocar root ${r1.fp256}.*User canceled.*by hand`))
  assert.deepEqual(r2.items.find((i) => i.item === 'old-root'), { item: 'old-root', state: 'orphan', fp256: r1.fp256 })
  assert.ok(readManifest(w.dir).entries.some((e) => e.kind === 'system-root' && e.fp256 === r1.fp256 && e.orphan), 'kept on record: uninstall removes it')
  assertOnlyNewRoot(w, r1, r2, at1)
})

// the reverse: the key is there but trocar cannot read its root back — trocar-ca.pem gone, or the manifest's record gone — install must not crash on
// the custody's 'exists'; it takes ㉒'s path (the custody has no verb that returns the root)
for (const [what, lose] of [['trocar-ca.pem gone', (w) => fs.rmSync(path.join(w.dir, 'ca', 'trocar-ca.pem'))], ['the root-key record gone', (w) => { const m = readManifest(w.dir); m.entries = m.entries.filter((e) => e.kind !== 'root-key'); fs.writeFileSync(path.join(w.dir, 'install-manifest.json'), JSON.stringify(m)) }]]) {
  test(`CM35 reverse: the key present, ${what} → no crash; the stray key goes, a new root is made and carried`, async () => {
    const { w, r1 } = await lostKeyWorld()
    lose(w)
    const r2 = await w.install({ wrapperKit: { renderWrapper }, now: later })
    assert.ok(w.custody.calls.some((c) => c.verb === 'remove'))
    assert.notEqual(r2.fp256, r1.fp256)
    assert.deepEqual(fpsIn(path.join(w.dir, 'ca', 'trocar-ca.pem')), [r2.fp256])
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

// CM37: a plugin cert with no loader (the host finds files in its folder) → install writes the hook file alone, no loader row; uninstall takes it out
test('CM37: a loaderless plugin cert → one owned plugin file in its folder, no text entry there, uninstall leaves the folder as it was', async () => {
  const [eighth] = await loadHarnesses(new URL('./harness/fixtures/', import.meta.url))
  const w = await modelWorld()
  const ext = path.join(w.home, '.eighth', 'extensions')
  fs.mkdirSync(ext, { recursive: true })
  const before = snapshot(ext)
  await w.install({ harnesses: [eighth] })
  const m = readManifest(w.dir)
  const mine = [...m.entries, ...m.files].filter((e) => e.harness === 'eighth' && e.phase === 'install')
  const file = path.join(ext, 'trocar-pi-extension.js')
  const under = mine.filter((e) => e.path.startsWith(`${ext}${path.sep}`))
  assert.deepEqual(under.map((e) => [e.kind, e.role, e.path]), [['owned-file', 'plugin', file]])
  assert.ok(fs.existsSync(file))
  const texts = mine.filter((e) => e.kind === 'text')
  assert.deepEqual(texts.filter((e) => e.path.startsWith(`${ext}${path.sep}`) || e.format === 'yaml-list'), [])
  const exec = recordingExec()
  const { exit, receipt } = await runUninstall({ home: w.home, env: w.env, yes: true, deps: { platform: 'darwin', exec: exec.run, custody: w.custody, procs: async () => [], sleep: async () => {}, drainMs: 0, getuid: () => 501 } })
  assert.equal(exit, 0, JSON.stringify({ p: receipt.problems, l: receipt.left }))
  assert.deepEqual(snapshot(ext), before)
})

// 4.11 rule U: a setting that names trocar's own tree is never the user's file; on the OSes whose file names ignore case, a setting spelled in
// another case names the same file (a Windows test machine: trocar's own bundle, spelled in another case, took a rule U block)
for (const os of ['win32', 'darwin']) {
  test(`rule U (${os}): a setting naming trocar's own tree in another letter case is trocar's, not the user's file`, async () => {
    const own = (home) => path.join(home, '.TROCAR', 'Collector', 'ca', 'trocar-ca.pem')
    const w = await modelWorld({ os, env: (home) => ({ NODE_EXTRA_CA_CERTS: own(home), SSL_CERT_FILE: own(home) }) })
    const named = w.harnesses.filter((d) => d.proxyMode).flatMap((d) => ruleUFiles(d, w.ctx, { home: w.home, owns: w.owns }).map((x) => `${d.name}: ${x.file}`))
    assert.deepEqual(named, [])
  })
}

// 1.6 §3.2 / V85: plan and act come from one list — every carrier install records for a form or a file (a key that stays the user's, a rule U file
// it leaves alone, as well as what it places) has its row in the plan, with the same state when it changes nothing
for (const shape of ['the key is the user\'s', 'the file is not this user\'s']) {
  test(`V85: every carrier install records is a row of its plan (${shape})`, async () => {
    let w, owns
    if (shape === 'the key is the user\'s') {
      w = await everything()
      const mine = path.join(w.home, 'certs', 'z.pem'); put(mine, USER_PEM)
      put(path.join(w.home, '.zcode', 'cli', 'config.json'), JSON.stringify({ network: { caCertFile: mine } }))
      owns = w.owns
    } else {
      w = await sharedCertFileWorld({ userPem: USER_PEM })
      const real = fs.realpathSync(w.file)
      owns = (p) => (p === real ? false : w.owns(p))
    }
    const rows = planInstall({ os: 'darwin', harnesses: w.harnesses, ctx: w.ctx, home: w.home, owns })
    const r = await w.install({ wrapperKit: { renderWrapper }, owns })
    const acted = r.carriers.filter((c) => c.carrier !== 'root' && (c.state === 'rule-u' || c.code === 'not-users-file'))
    assert.ok(acted.length > 0, JSON.stringify(r.carriers))
    for (const c of r.carriers.filter((x) => x.carrier !== 'root')) {
      const row = rows.find((x) => x.harness === c.harness && (c.form ? x.form === c.form : x.paths.includes(c.path)))
      assert.ok(row, `${c.harness} ${c.form || c.path} (${c.state}) is in the plan: ${JSON.stringify(rows)}`)
      if (c.state === 'rule-u' || c.code === 'not-users-file') assert.equal(row.state, c.state, `${c.harness}: the plan says it changes nothing, as the act does`)
    }
  })
}

// 1.6 §3.6: Removed says what was taken out of every file of yours, a file trocar made by writing its key or line into it (and so deletes) included
test('1.6 §3.6: an uninstall that deletes a file trocar made for its key or line says what it took out there, not the bare path', async () => {
  const { formatUninstallReceipt, tilde } = await import('../../src/cli/receipt.mjs')
  const w = await everything()
  await w.install({ wrapperKit: { renderWrapper } })
  const exec = recordingExec()
  const { receipt } = await runUninstall({ home: w.home, env: w.env, yes: true, deps: { platform: 'darwin', exec: exec.run, custody: w.custody, procs: async () => [], sleep: async () => {}, drainMs: 0, getuid: () => 501 } })
  const held = new Set(receipt.entries.map((e) => e.path)) // a file trocar wrote a key or a line into
  const yours = receipt.removed.filter((p) => held.has(p))
  assert.ok(yours.length > 0, JSON.stringify(receipt.removed))
  const rows = formatUninstallReceipt(receipt, { home: w.home, platform: 'darwin' }).split('\n')
  for (const p of yours) assert.ok(rows.some((l) => l.trim().startsWith(`${tilde(p, w.home)}: `)), `${p}: what was taken out is said: ${rows.join('\n')}`)
})
