// test/off/liveness-identity.test.mjs — the liveness snapshot is the name list (RFC 4.6 「判活快照」, D50, D51; 4.6 R10, S6's manifest half).
// `on` writes `liveness.<harness>.identity` — the preset names with agents.json's items, compiled, the same on every OS — united with the one already
// recorded, and drops the older key `signature`; `off` judges by it plus the names agents.json holds when it runs, reading only the manifest, the list
// and the process table. A manifest from before the next `on` (a Linux path signature, the macOS / Windows form tables folded, PR #65) is judged by its
// `signature` still. The mac / win process tables of test/off/liveness-os.test.mjs (retired with the form signatures) are here, their expectations unchanged.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { installCollector, turnOn } from '../../src/collector/install.mjs'
import { loadArch } from '../../src/collector/arch/index.mjs'
import { loadHarnesses } from '../../src/collector/harness/index.mjs'
import { createRegistry, livenessOf } from '../../src/collector/core/registry.mjs'
import { createCa } from '../../src/collector/core/tls/ca.mjs'
import { readManifest, saveManifest, PHASES } from '../../src/off/manifest.mjs'
import { undoHarnesses } from '../../src/off/undo.mjs'
import { listProcs } from '../../src/off/proc.mjs'
import { certBlocks } from '../../src/off/pem.mjs'
import { hasIdentity, serializeSignature } from '../../src/off/signature.mjs'
import { matchHarness } from '../helpers/one-harness.mjs'
import { SEEDS } from '../helpers/proc-seeds.mjs'
import { variantsOf } from '../helpers/proc-variants.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { darwinTools } from './fixtures/darwin-tools.mjs'
import { fakeSystem } from '../cli/fixtures/on-ctx.mjs'

const ROOT = createCa({ commonName: 'liveness-identity root' })
const roots = { node: [ROOT.certPem], osText: '' }
const HARNESSES = await loadHarnesses()
const json = (v) => JSON.parse(JSON.stringify(v)) // the manifest is JSON: what `off` reads is what survived it

// G2 / G8: the registry (the daemon, the doors, status) and off's snapshot judge every seed and every install variant of it alike
test('differential: for every process seed and its variants, matchHarness over the JSON round-tripped snapshot names what registry.match names', () => {
  const reg = createRegistry(HARNESSES)
  const liveness = json(Object.fromEntries(HARNESSES.map((d) => [d.name, livenessOf(d)])))
  let n = 0
  for (const seed of SEEDS) {
    for (const f of [seed, ...variantsOf(seed)]) {
      if (f.cmdlineState === 'pending' || f.cmdlineState === 'cim-backoff') continue // off reads a whole table: it has no command line still to come
      assert.equal(matchHarness(liveness, f), reg.match(f).agent, `${f.variant || 'seed'}: ${f.exe} ${JSON.stringify(f.argv)} (${f.source})`)
      n++
    }
  }
  assert.ok(n > SEEDS.length, 'the variants ran')
})

// ── on: the snapshot written ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
async function codexBox(osName = 'darwin') {
  const home = tmpDir('asight-liveness-identity-')
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true })
  fs.writeFileSync(path.join(home, '.codex', '.env'), 'OPENAI_API_KEY=sk-test\n')
  const dir = path.join(home, '.asight', 'collector')
  const arch = await loadArch(osName)
  const install = () => installCollector({ home, env: { HOME: home }, ids: ['codex'], osName, arch, harnesses: HARNESSES, freePort: async () => 47011, scan: async () => [], roots })
  const sys = fakeSystem()
  const on = async () => { const r = await turnOn({ home, env: { HOME: home }, ids: ['codex'], osName, arch, harnesses: HARNESSES, freePort: async () => 47011, roots, confirm: async () => true, unit: null, autostart: false, request: sys.daemon.request, socketPath: path.join(home, 'collector.sock'), sleep: async () => {} }); assert.equal(r.exit, 0, JSON.stringify(r.problems)); return r }
  const manifestFile = path.join(dir, 'install-manifest.json')
  const agents = (list) => { fs.mkdirSync(path.join(home, '.asight'), { recursive: true }); fs.writeFileSync(path.join(home, '.asight', 'agents.json'), typeof list === 'string' ? list : JSON.stringify({ version: 1, agents: list })) }
  return { home, dir, arch, install, on, manifestFile, agents, bundle: path.join(dir, 'ca', 'combined-codex.pem'), caFp: () => certBlocks(fs.readFileSync(path.join(dir, 'ca', 'asight-ca.pem'), 'utf8'))[0].fp }
}

test('D54: a second `asight on` with the same inputs leaves the manifest byte for byte (same sha256) and does not write it', async () => {
  const s = await codexBox()
  await s.on()
  const sha = () => crypto.createHash('sha256').update(fs.readFileSync(s.manifestFile)).digest('hex')
  const first = sha(), st = fs.statSync(s.manifestFile, { bigint: true })
  await s.on()
  const st2 = fs.statSync(s.manifestFile, { bigint: true })
  assert.equal(sha(), first)
  assert.deepEqual([st2.ino, st2.mtimeNs], [st.ino, st.mtimeNs], 'not written again (an atomic save would change the inode)')
  assert.ok(readManifest(s.dir).liveness.codex.identity.match.length > 0)
})

test('union: a name already in the recorded identity that the list no longer holds stays after the next on; the older `signature` key is gone; a new name is added', async () => {
  const s = await codexBox()
  s.agents([{ harness: 'codex', name: 'codex-old' }])
  await s.on()
  const m = readManifest(s.dir)
  assert.equal(matchHarness(m.liveness, { exe: '/x/codex-old', argv: ['codex-old'] }), 'codex', 'the name agents.json held at on is in the snapshot')
  m.liveness.codex.signature = { match: [{ exe: { re: 'never', flags: '' } }] } // what an older asight left beside it
  saveManifest(s.dir, m)
  s.agents([{ harness: 'codex', name: 'codex-new' }]) // codex-old taken off the list; a codex-old started before may still hold the bundle
  await s.on()
  const l = readManifest(s.dir).liveness.codex
  assert.equal('signature' in l, false, 'the older key is dropped')
  for (const name of ['codex', 'codex-old', 'codex-new']) assert.equal(matchHarness({ codex: l }, { exe: `/x/${name}`, argv: [name] }), 'codex', name)
  const texts = l.identity.match.map((p) => JSON.stringify(p))
  assert.deepEqual(texts, [...new Set(texts)].sort(), 'each pattern once, sorted by its JSON text')
  assert.equal(matchHarness({ codex: l }, { exe: '/x/codex', argv: ['codex', '--codex-run-as-apply-patch'] }), null, 'exclude is the new one, and holds')
})

test('an old asight-off (OFF_VERSION 9) reads only `signature`: after on rewrites a record it has `identity` and no `signature`, so that copy judges "not known" (D50②: kept, exit 1) — the safe direction', async () => {
  const s = await codexBox()
  await s.on()
  const m = readManifest(s.dir)
  m.liveness.codex = { signature: { match: [{ exe: { re: 'codex$', flags: 'i' } }] }, rereads: true, until: 'next-connection' } // what a 9 wrote
  saveManifest(s.dir, m)
  await s.on()
  const l = json(readManifest(s.dir).liveness.codex)
  assert.deepEqual([hasIdentity(l), 'signature' in l, hasIdentity({ ...l, identity: undefined })], [true, false, false], 'an old copy, finding no `signature`, has nothing to tell processes apart with')
  assert.ok(l.identity.match.some((p) => p.exe && p.exe.re === 'codex$'), 'the old `signature` patterns are united into the new identity (4.6 判活快照): a process started under them still holds')
  assert.equal(matchHarness({ codex: l }, { exe: '/opt/elsewhere/my-codex', argv: ['my-codex'] }), 'codex', 'judged by the united patterns')
})

// ── off: the older keys, and agents.json read when it runs ──────────────────────────────────────────────────────────────────────────────────
// PR #65's codex form signatures, as an `on` before this change wrote them on macOS and Windows (serializeSignature(formSignature(codex.<os>.forms)))
const FORM_SIG = {
  darwin: { match: [{ exe: { re: '^(?=[\\s\\S]*(?:(?:\\/node_modules\\/@openai\\/.*\\/bin\\/codex)|(?:\\/app-server-daemon\\/releases\\/.*\\/bin\\/codex)|(?:\\/opt\\/homebrew\\/bin\\/codex)|(?:\\/usr\\/local\\/bin\\/codex)))(?:[\\s\\S]*\\/)?(?:codex)(?:\\.exe)?$', flags: 'i' } }, { exe: { re: '^(?=[\\s\\S]*(?:(?:\\/\\.vscode\\/extensions\\/openai\\.chatgpt-[^/]*\\/bin\\/[^/]*\\/codex)))(?:[\\s\\S]*\\/)?(?:codex)(?:\\.exe)?$', flags: 'i' } }] },
  win32: { match: [{ exe: { re: '^(?=[\\s\\S]*(?:(?:\\\\node_modules\\\\@openai\\\\.*\\\\codex\\.exe)))(?:[\\s\\S]*[\\\\/])?codex\\.exe$', flags: 'i' } }, { exe: { re: '^(?=[\\s\\S]*(?:(?:\\\\\\.vscode\\\\extensions\\\\openai\\.chatgpt-[^\\\\]*\\\\bin\\\\[^\\\\]*\\\\codex\\.exe)))(?:[\\s\\S]*[\\\\/])?codex\\.exe$', flags: 'i' } }, { exe: { re: '^(?=[\\s\\S]*(?:(?:\\\\OpenAI\\\\Codex\\\\bin\\\\[^\\\\]*\\\\codex\\.exe)))(?:[\\s\\S]*[\\\\/])?codex\\.exe$', flags: 'i' } }] },
}
// a Linux path signature, as `signatures.linux` compiled before D51
const LINUX_SIG = serializeSignature({ match: [{ exe: /\/\.local\/share\/claude\/versions\/[^/]+$/ }], exclude: [{ 'argv.0': /^(rg|apply-seccomp)$/ }] })

test('compat: a manifest with only an older `signature` — a Linux path signature, or PR #65\'s folded form table — still names its own processes', () => {
  const lin = json({ 'claude-code': { signature: LINUX_SIG, rereads: false, until: 'restart' } })
  assert.equal(hasIdentity(lin['claude-code']), true)
  assert.equal(matchHarness(lin, { exe: '/home/u/.local/share/claude/versions/2.1.296', argv: ['claude'] }), 'claude-code')
  assert.equal(matchHarness(lin, { exe: '/home/u/.local/share/claude/versions/2.1.296', argv: ['rg', '--files'] }), null, 'its exclude holds')
  const mac = { codex: { signature: FORM_SIG.darwin } }
  assert.equal(matchHarness(mac, { exe: '/Users/u/.nvm/versions/node/v22.20.0/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex', cmdline: null }), 'codex')
  assert.equal(matchHarness(mac, { exe: '/Users/u/.nvm/versions/node/v22.20.0/bin/node', cmdline: 'node /Users/u/.nvm/versions/node/v22.20.0/bin/codex' }), null)
  const win = { codex: { signature: FORM_SIG.win32 } }
  assert.equal(matchHarness(win, { exe: 'C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe', cmdline: null }), 'codex')
  assert.equal(hasIdentity({ rereads: true }), false, 'neither key: not known (D50②)')
})

// Each OS: where its codex lives, and that OS's table reader over the injected runner, with that codex in it (pid 4242, a child of its node launcher).
const OS = {
  darwin: {
    codex: '/Users/u/.nvm/versions/node/v22.20.0/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex',
    table: (codex, at) => darwinTools([
      { pid: 4241, at, exe: '/Users/u/.nvm/versions/node/v22.20.0/bin/node', cmdline: 'node /Users/u/.nvm/versions/node/v22.20.0/bin/codex --model x' },
      ...(codex ? [{ pid: 4242, ppid: 4241, at, exe: codex, cmdline: `${codex} --model x` }] : []),
    ]).run,
  },
  win32: {
    codex: 'C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe',
    table: (codex, at) => () => ({ status: 0, stdout: JSON.stringify([{ p: 4241, pp: 1, n: 'node.exe', x: 'C:\\Program Files\\nodejs\\node.exe', s: at.getTime(), c: '"C:\\Program Files\\nodejs\\node.exe" codex.js' }, ...(codex ? [{ p: 4242, pp: 4241, n: 'codex.exe', x: codex, s: at.getTime(), c: `"${codex}" --model x` }] : [])]), stderr: '' }),
  },
}
const offWith = (s, osName, exe) => undoHarnesses({ dir: s.dir, home: s.home, phases: PHASES, manifest: readManifest(s.dir), ids: ['codex'], roots, procs: () => listProcs({ uid: 501, platform: osName, exec: exe }) })

test('off counts a name put on agents.json after on: that live process holds the bundle — kept without the asight CA, its pid in the receipt; an unreadable list adds nothing and says so', async () => {
  const s = await codexBox('darwin')
  await s.install()
  s.agents([{ harness: 'codex', name: 'codex-fork' }]) // added after on: the snapshot does not hold it
  const fork = '/Users/u/src/codex-fork/target/release/codex-fork'
  const table = darwinTools([{ pid: 5353, at: new Date(Date.now() + 60_000), exe: fork, cmdline: `${fork} --model x` }]).run
  const caFp = s.caFp()
  const r = await offWith(s, 'darwin', table)
  assert.deepEqual([r.kept_bundles.map((k) => [path.basename(k.path), k.pids, !!k.unjudged]), r.left, r.still_trusting.map((p) => [p.pid, p.harness])], [[['combined-codex.pem', [5353], false]], [], [[5353, 'codex']]], 'the fork is a codex now')
  const left = certBlocks(fs.readFileSync(s.bundle, 'utf8'))
  assert.ok(left.length > 0 && !left.some((c) => c.fp === caFp), 'the same bundle on disk, without the asight CA')
  assert.equal('codex-fork' in JSON.parse(fs.readFileSync(s.manifestFile, 'utf8')).liveness, false)
  assert.ok(!fs.readFileSync(s.manifestFile, 'utf8').includes('codex-fork'), 'the manifest is not changed by the list: off only judges with it')

  const t = await codexBox('darwin')
  await t.install()
  t.agents('{ not json')
  const u = await offWith(t, 'darwin', table)
  assert.deepEqual([u.kept_bundles, fs.existsSync(t.bundle)], [[], false], 'not on any list it can read: nobody holds the bundle')
  assert.ok(u.notes.some((n) => n.includes('agents.json') && /not counted/.test(n)), `the receipt says the list was not used: ${u.notes.join(' | ')}`)
})

for (const osName of Object.keys(OS)) {
  test(`${osName}: off keeps combined-codex.pem for a codex that started after on — without the asight CA, its pid named — and removes it once that codex is gone`, async () => {
    const s = await codexBox(osName)
    await s.install()
    assert.ok(readManifest(s.dir).liveness.codex.identity, 'on wrote the identity: the name list, compiled')
    const caFp = s.caFp()
    const r = await offWith(s, osName, OS[osName].table(OS[osName].codex, new Date(Date.now() + 60_000)))
    assert.ok(fs.existsSync(s.bundle), `the bundle a running codex re-reads at its next connection is still there (removed: ${r.removed.map((p) => path.basename(p)).join(', ')})`)
    assert.deepEqual(r.kept_bundles.map((k) => [path.basename(k.path), k.pids, !!k.unjudged]), [['combined-codex.pem', [4242], false]], 'kept, and the codex that may hold it is named — its node launcher is not codex')
    const left = certBlocks(fs.readFileSync(s.bundle, 'utf8'))
    assert.ok(left.length > 0 && !left.some((c) => c.fp === caFp), 'the same bundle without the asight CA')
    assert.deepEqual([r.left, r.still_trusting.map((p) => [p.pid, p.harness, p.until])], [[], [[4242, 'codex', 'next-connection']]], 'nothing left undone; the receipt says until when it trusts asight')
    const again = await offWith(s, osName, OS[osName].table(null, new Date(Date.now() + 60_000)))
    assert.deepEqual([fs.existsSync(s.bundle), again.kept_bundles, again.left], [false, [], []], 'the codex is gone: the next off removes the bundle')
  })

  test(`${osName}: a record with no identity (an older asight's on) is not known — the bundle kept without the CA, an item left, step 5 says it cannot tell — and the next on fills it in`, async () => {
    const s = await codexBox(osName)
    const sys = fakeSystem()
    const on = () => turnOn({ home: s.home, env: { HOME: s.home }, ids: ['codex'], osName, arch: s.arch, harnesses: HARNESSES, freePort: async () => 47011, roots, confirm: async () => true, unit: null, autostart: false, request: sys.daemon.request, socketPath: path.join(s.home, 'collector.sock'), sleep: async () => {} })
    assert.equal((await on()).exit, 0)
    const m = readManifest(s.dir)
    const compiled = m.liveness.codex.identity
    delete m.liveness.codex.identity
    saveManifest(s.dir, m)
    const table = OS[osName].table(OS[osName].codex, new Date(Date.now() + 60_000))
    const r = await offWith(s, osName, table)
    assert.deepEqual(r.kept_bundles.map((k) => [path.basename(k.path), k.unjudged, /no process identity for codex/.test(k.error)]), [['combined-codex.pem', true, true]], 'not known is not "nobody": kept')
    assert.ok(!certBlocks(fs.readFileSync(s.bundle, 'utf8')).some((c) => c.fp === s.caFp()), 'without the asight CA')
    assert.deepEqual([r.left.map((l) => path.basename(l.path)), r.trust_unknown.map((x) => [x.harness, /no process identity for codex/.test(x.why)]), r.still_trusting], [['combined-codex.pem'], [['codex', true]], []], 'an item left (exit 1); who still trusts asight is said to be unknown, not none, and why')
    assert.equal((await on()).exit, 0)
    assert.deepEqual(readManifest(s.dir).liveness.codex.identity, compiled, 'the next on records the identity')
    const judged = await offWith(s, osName, table)
    assert.deepEqual([judged.kept_bundles.map((k) => k.pids), judged.left, judged.trust_unknown], [[[4242]], [], []], 'and off judges by it again')
  })
}

// a Claude Code started after on (and a shell it started) on each OS's table; a shell it did not start, beside them
const CLAUDE = {
  darwin: (home, at) => darwinTools([{ pid: 5151, at, exe: `${home}/.local/share/claude/versions/2.1.296`, cmdline: 'claude' }, { pid: 5152, ppid: 5151, at, exe: '/bin/zsh', cmdline: '/bin/zsh -c npm test' }, { pid: 5160, at, exe: '/bin/zsh', cmdline: '-zsh' }]).run,
  win32: (home, at) => () => ({ status: 0, stdout: JSON.stringify([{ p: 5151, pp: 1, n: 'claude.exe', x: 'C:\\Users\\u\\.local\\bin\\claude.exe', s: at.getTime(), c: 'claude' }, { p: 5152, pp: 5151, n: 'cmd.exe', x: 'C:\\Windows\\System32\\cmd.exe', s: at.getTime(), c: 'cmd.exe /c npm test' }, { p: 5160, pp: 1, n: 'cmd.exe', x: 'C:\\Windows\\System32\\cmd.exe', s: at.getTime(), c: 'cmd.exe' }]), stderr: '' }),
}
for (const osName of Object.keys(CLAUDE)) {
  test(`${osName}: an extra trust file is held by a Claude Code process started after on, whose environment the OS never shows — kept without the CA, its pid named, not "not known" (4.6 「判活快照」)`, async () => {
    const home = tmpDir('asight-liveness-identity-')
    const corp = createCa({ commonName: 'liveness-identity relay CA' })
    fs.writeFileSync(path.join(home, 'relay-ca.pem'), corp.certPem)
    fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{\n  "model": "x"\n}\n')
    const env = { HOME: home, USERPROFILE: home, NODE_EXTRA_CA_CERTS: path.join(home, 'relay-ca.pem') } // the user's own CA: Claude Code gets an extra-cc.pem
    await installCollector({ home, env, ids: ['claude-code'], osName, arch: await loadArch(osName), harnesses: HARNESSES, freePort: async () => 47011, scan: async () => [], roots })
    const dir = path.join(home, '.asight', 'collector'), extra = path.join(dir, 'ca', 'extra-cc.pem')
    assert.ok(fs.existsSync(extra), 'the user\'s own CA made an extra-cc.pem')
    const table = CLAUDE[osName](home, new Date(Date.now() + 60_000))
    const r = await undoHarnesses({ dir, home, phases: PHASES, manifest: readManifest(dir), ids: ['claude-code'], roots, procs: () => listProcs({ uid: 501, platform: osName, exec: table }) })
    assert.deepEqual(r.kept_bundles.map((k) => [path.basename(k.path), k.pids, !!k.unjudged]), [['extra-cc.pem', [5151, 5152], false]], 'Claude Code and the shell it started may hold it; a shell it did not start does not')
    assert.deepEqual([fs.existsSync(extra), r.left], [true, []], 'kept, nothing left undone (exit 0)')
  })
}

// ── a name two harnesses claim, and an ignored preset name: both still holders (D50: one more holder, never one less) ─────────────────────
const OPENCODE = HARNESSES.find((d) => d.name === 'opencode')
test('a codex that two harnesses claim (agents.json put "codex" under opencode after on, or the union kept a name moved between harnesses) still holds combined-codex.pem: kept without the CA, its pid named', async () => {
  for (const how of ['agents.json after on', 'the union kept a moved name']) {
    const s = await codexBox('darwin')
    await s.install()
    const m = readManifest(s.dir)
    m.liveness.opencode = json(livenessOf(OPENCODE, how === 'agents.json after on' ? {} : { agentList: [{ harness: 'opencode', name: 'codex' }] }))
    saveManifest(s.dir, m)
    if (how === 'agents.json after on') s.agents([{ harness: 'opencode', name: 'codex' }])
    const caFp = s.caFp()
    const r = await offWith(s, 'darwin', OS.darwin.table(OS.darwin.codex, new Date(Date.now() + 60_000)))
    assert.deepEqual([r.kept_bundles.map((k) => [path.basename(k.path), k.pids, !!k.unjudged]), r.left, r.still_trusting.filter((p) => p.harness === 'codex').map((p) => p.pid)], [[['combined-codex.pem', [4242], false]], [], [4242]], `${how}: a process of codex and of opencode is a holder of codex's bundle`)
    const left = certBlocks(fs.readFileSync(s.bundle, 'utf8'))
    assert.ok(left.length > 0 && !left.some((c) => c.fp === caFp), `${how}: the same bundle, without the asight CA`)
  }
})

test('ignoring codex\'s only preset name before on stops capture, not trust: the identity still names codex, so off keeps the bundle a running codex holds; an empty `match` is "not known"', async () => {
  const s = await codexBox('darwin')
  s.agents([{ harness: 'codex', name: 'codex', ignore: true }])
  await s.install()
  const l = readManifest(s.dir).liveness.codex
  assert.ok(l.identity.match.length > 0 && hasIdentity(l), 'ignore is not applied to the liveness identity')
  const r = await offWith(s, 'darwin', OS.darwin.table(OS.darwin.codex, new Date(Date.now() + 60_000)))
  assert.deepEqual([r.kept_bundles.map((k) => [path.basename(k.path), k.pids, !!k.unjudged]), r.left], [[['combined-codex.pem', [4242], false]], []], 'the running codex holds it')
  assert.equal(hasIdentity({ identity: { match: [], exclude: [] }, rereads: true, until: 'restart' }), false, 'a record whose match is empty tells no process apart: D50② not known, never "nobody holds it"')
})
