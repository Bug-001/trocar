// 1.6 R3 · 4.11 §1 uninstall: with the install record lost, uninstall still takes out every certificate carrier install placed on macOS / Windows —
// found where the harness descriptors put them, by trocar's marks or by the bytes trocar writes there: the install-folder wrapper (the real program
// back from .trocar-real, byte for byte, its name and mode), the plug-ins and the row that loads one, the marked block in the user's certificate
// file, the config keys. The user's own lines and blocks stay; a carrier trocar can no longer tell as its own, or one in a state it cannot undo, stays,
// with a left row and its reason, and uninstall exits 1. The injected store and custody, never an OS tool.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import tls from 'node:tls'
import { modelWorld } from '../helpers/model-world.mjs'
import * as darwinWrapper from '../../src/collector/arch/darwin/wrapper.mjs'
import * as win32Wrapper from '../../src/collector/arch/win32/wrapper.mjs'
import { runUninstall } from '../../src/cli/uninstall.mjs'
import { manifestPath } from '../../src/off/manifest.mjs'
import { recordingExec } from './fixtures/on-ctx.mjs'
import { formatUninstallReceipt } from '../../src/cli/receipt.mjs'
import { turnOnModel } from '../../src/collector/model-on.mjs'
import { renderHook } from '../../src/collector/harness/templates/index.mjs'
import { startControlServer } from '../../src/collector/core/control.mjs'

const MACHO = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 1, 2, 3, 4])
const USER_PEM = `${tls.rootCertificates[2].trim()}\n`
const USER_ROW = '- insert: [{ name: "/opt/mine/plugin.mjs" }]\n'
// the wrapper kit each OS's install gets: macOS's dash script as it is; Windows's C# source through a stand-in for csc.exe that, like the real stub,
// holds the strings of the source only as UTF-16 (a .NET assembly's string heap), behind a PE header — never the source's UTF-8 bytes
const KITS = {
  darwin: { renderWrapper: darwinWrapper.renderWrapper },
  win32: { renderWrapper: win32Wrapper.renderWrapper, compile: (cs) => Buffer.concat([Buffer.from('MZ\x90\0', 'latin1'), ...[...cs.matchAll(/=\s*("(?:[^"\\\n]|\\.)*")/g)].map((m) => Buffer.from(JSON.parse(m[1]), 'utf16le'))]) },
}
// every file and folder under HOME outside ~/.trocar: a file's bytes and mode, a folder's mode
const files = (home) => {
  const out = {}
  const walk = (d) => { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); if (p === path.join(home, '.trocar')) continue; const st = fs.lstatSync(p); if (st.isDirectory()) { out[path.relative(home, p)] = `dir ${(st.mode & 0o777).toString(8)}`; walk(p) } else out[path.relative(home, p)] = `${(st.mode & 0o777).toString(8)} ${fs.readFileSync(p).toString('base64')}` } }
  walk(home)
  return out
}

async function world(os, { keepRecord = false } = {}) {
  const w = await modelWorld({ os, commands: ['codex', 'dsh', 'pi'], env: (home) => ({ SSL_CERT_FILE: path.join(home, 'certs', 'mine.pem') }) })
  fs.mkdirSync(path.join(w.home, 'certs'), { recursive: true }); fs.writeFileSync(w.env.SSL_CERT_FILE, USER_PEM)
  const exe = os === 'win32' ? '.exe' : '' // the program's file name as the OS names it (the arch's platform facts)
  const kimi = path.join(w.home, '.kimi-code', 'bin', `kimi${exe}`)
  fs.mkdirSync(path.dirname(kimi), { recursive: true }); fs.writeFileSync(kimi, MACHO, { mode: 0o751 })
  fs.mkdirSync(path.join(w.home, '.dsh'), { recursive: true }); fs.writeFileSync(path.join(w.home, '.dsh', 'cordis.patch.yml'), USER_ROW) // the user's own row stays
  fs.mkdirSync(path.join(w.home, '.pi', 'agent', 'extensions'), { recursive: true })
  fs.mkdirSync(path.join(w.home, '.zcode'), { recursive: true })
  const before = files(w.home)
  const r = await w.install({ wrapperKit: KITS[os], facts: { exeSuffix: exe } })
  assert.equal(r.exit, 0, JSON.stringify(r.carriers))
  for (const k of ['wrapper', 'plugin', 'pem-block']) assert.ok(r.carriers.some((c) => c.carrier === k && c.state === 'placed'), `install placed a ${k}: ${JSON.stringify(r.carriers)}`)
  if (!keepRecord) fs.rmSync(manifestPath(w.dir)) // the record is lost
  const uninstall = ({ env = w.env, exec = recordingExec().run } = {}) => runUninstall({ home: w.home, env, yes: true, deps: { platform: os, exec, custody: w.custody, rootStore: w.store, procs: async () => [], sleep: async () => {}, drainMs: 0, getuid: () => 501, harnesses: w.harnesses } })
  return { ...w, kimi, real: path.join(path.dirname(kimi), '.trocar-real', path.basename(kimi)), before, uninstall }
}

for (const os of ['darwin', 'win32']) {
  test(`${os}: install, the record deleted, uninstall → every carrier out: the user's files as before install, the real kimi back, exit 0`, async () => {
    const w = await world(os)
    const { receipt, exit } = await w.uninstall()
    assert.deepEqual(files(w.home), w.before, JSON.stringify({ left: receipt.left, problems: receipt.problems }))
    assert.deepEqual([exit, receipt.left], [0, []])
    const out = [...receipt.changed.map((c) => c.path), ...receipt.removed]
    for (const p of [w.kimi, w.env.SSL_CERT_FILE, path.join(w.home, '.dsh', 'cordis.patch.yml')]) assert.ok(out.includes(p), `the receipt names ${p}: ${JSON.stringify(out)}`)
    assert.equal(new Set(out).size, out.length, `one row per file (1.6 §3.4): ${JSON.stringify(out)}`)
    assert.deepEqual(receipt.skipped.filter((s) => out.includes(s.what)), [], 'no file is both undone and skipped')
    assert.deepEqual(receipt.notes.filter((n) => out.some((p) => n.startsWith(`${p}:`))), [], 'a file the receipt lists as undone is not said again as a note')
  })

  // a file install created and `on` then wrote into (Z-Code's cli config: install's certificate key, on's proxy key): `on` backed up the file as install
  // left it, so its only backup holds trocar's own value — with no record it is still trocar's file, and goes once both keys are out (measured on Windows:
  // it stayed as {"network":{}}). The undo judges JSON alike on every OS; `on` on win32 asks the daemon over a named pipe, which this host has none of
  // what the user wrote into it after `on` (a comment, a key of their own) is not trocar's: the file stays, with trocar's keys out
  const AFTER = {
    'nothing': { touch: () => {}, gone: true },
    'a comment of the user': { touch: (f) => fs.writeFileSync(f, `// mine\n${fs.readFileSync(f, 'utf8')}`), gone: false },
    'a key of the user': { touch: (f) => { const d = JSON.parse(fs.readFileSync(f, 'utf8')); d.theme = 'dark'; fs.writeFileSync(f, JSON.stringify(d)) }, gone: false },
  }
  if (os === 'darwin') for (const [what, { touch, gone }] of Object.entries(AFTER)) test(`${os}: install created a file, on wrote into it, then ${what}; the record deleted, uninstall → the file ${gone ? 'is gone' : 'stays'}`, async () => {
    const w = await world(os, { keepRecord: true })
    const zc = path.join(w.home, '.zcode', 'cli', 'config.json')
    assert.ok(!w.before[path.relative(w.home, zc)] && fs.existsSync(zc), 'install created it')
    const sock = path.join(w.home, 'c.sock'), token = 'k'.repeat(32)
    fs.writeFileSync(path.join(w.dir, 'control.json'), JSON.stringify({ path: sock, token }))
    const server = await startControlServer({ socketPath: sock, token, routes: {
      'GET /status': async () => ({ doors: {} }),
      'POST /on': async ({ body }) => ({ doors: Object.fromEntries(Object.entries(body.groups).map(([g, port]) => [g, `http://127.0.0.1:${port}`])) }),
    } })
    try { const r = await turnOnModel({ os, home: w.home, env: w.env, harnesses: w.harnesses, ctx: w.ctx, isFree: async () => true, renderHook }); assert.equal(r.exit, 0, JSON.stringify(r.problems || r)) } finally { await server.close() }
    assert.match(fs.readFileSync(zc, 'utf8'), /httpProxy/, 'on wrote its proxy key there')
    touch(zc)
    fs.rmSync(manifestPath(w.dir)) // the record is lost
    const { receipt } = await w.uninstall()
    assert.equal(fs.existsSync(zc), !gone, `${fs.existsSync(zc) ? fs.readFileSync(zc, 'utf8') : ''} ${JSON.stringify(receipt.left)}`)
    if (!gone) assert.doesNotMatch(fs.readFileSync(zc, 'utf8'), /\.trocar|httpProxy/, "trocar's keys are out")
  })

  test(`${os}: the plan of an uninstall with no record names the carriers it would take out`, async () => {
    const w = await world(os)
    const before = files(w.home)
    const { receipt, exit } = await runUninstall({ home: w.home, env: w.env, dryRun: true, deps: { platform: os, exec: recordingExec().run, custody: w.custody, rootStore: w.store, procs: async () => [], getuid: () => 501, harnesses: w.harnesses } })
    assert.equal(exit, 0)
    const planned = receipt.planned.map((p) => p.path)
    for (const p of [w.kimi, w.env.SSL_CERT_FILE, path.join(w.home, '.dsh', 'cordis.patch.yml')]) assert.ok(planned.includes(p), `the plan names ${p}: ${JSON.stringify(planned)}`)
    assert.equal(new Set(planned).size, planned.length, `one row per file (1.6 §3.4): ${JSON.stringify(planned)}`)
    assert.deepEqual(files(w.home), before, 'a plan writes nothing')
  })

  // what trocar cannot tell as its own, or cannot undo as it is, stays — with a left row naming it, its reason and, where one undoes it, the command
  // (1.6 R3) — and the rest still goes. Each case → { at: the left row's path, kept: the files that stay byte for byte, command: whether the row has one }
  const BROKEN = {
    'the real program in .trocar-real is gone': (w) => { fs.rmSync(path.dirname(w.real), { recursive: true }); return { at: w.kimi, kept: [w.kimi], command: false } },
    'the agent update replaced the wrapper': (w) => { fs.writeFileSync(w.kimi, Buffer.concat([MACHO, MACHO])); return { at: w.kimi, kept: [w.kimi, w.real], command: true } },
    'the plug-in was edited after install': (w) => { const d = path.join(w.home, '.pi', 'agent', 'extensions'); const f = path.join(d, fs.readdirSync(d)[0]); fs.appendFileSync(f, '// mine\n'); return { at: f, kept: [f], command: true } },
  }
  for (const [what, breakIt] of Object.entries(BROKEN)) {
    test(`${os}: ${what} → left, named with its reason, exit 1; the user's certificate file still comes back`, async () => {
      const w = await world(os)
      const { at, kept, command } = breakIt(w)
      const bytes = kept.map((f) => fs.readFileSync(f))
      const { receipt, exit } = await w.uninstall()
      assert.equal(exit, 1)
      const row = receipt.left.find((l) => l.path === at)
      assert.ok(row && row.reason, `left names ${at}: ${JSON.stringify(receipt.left)}`)
      assert.equal(typeof row.command === 'string' && row.command !== '', command, `the left row's command: ${JSON.stringify(row)}`)
      assert.deepEqual(kept.map((f) => fs.readFileSync(f)), bytes, 'left as it is')
      assert.equal(fs.readFileSync(w.env.SSL_CERT_FILE, 'utf8'), USER_PEM)
    })
  }
}

// the environment uninstall runs in, without the certificate variable install saw (the user set it in the shell install ran in, not this one)
const without = (env, name) => Object.fromEntries(Object.entries(env).filter(([k]) => k !== name))
// a runner whose `launchctl getenv <name>` answers `vars[name]` (unset: exit 1, as launchctl does) and every other tool exits 0 with nothing
const launchd = (vars) => (file, args) => (file === 'launchctl' && args[0] === 'getenv' ? (vars[args[1]] ? { status: 0, stdout: `${vars[args[1]]}\n`, stderr: '' } : { status: 1, stdout: '', stderr: '' }) : { status: 0, stdout: '', stderr: '' })
const mentions = (notes, name) => notes.some((n) => n.includes(`${name}=`) && n.includes('trocar uninstall'))

test('darwin: the certificate variable is only in launchd now → its file is found there and the marked block comes out; no note about a lost block', async () => {
  const w = await world('darwin')
  const { receipt, exit } = await w.uninstall({ env: without(w.env, 'SSL_CERT_FILE'), exec: launchd({ SSL_CERT_FILE: w.env.SSL_CERT_FILE }) })
  assert.equal(fs.readFileSync(w.env.SSL_CERT_FILE, 'utf8'), USER_PEM)
  assert.deepEqual([exit, mentions(receipt.notes, 'SSL_CERT_FILE')], [0, false])
})

for (const os of ['darwin', 'win32']) {
  test(`${os}: the certificate variable is only in the agent's own config → the marked block comes out`, async () => {
    const w = await world(os)
    const dotenv = path.join(w.home, '.codex', '.env')
    fs.mkdirSync(path.dirname(dotenv), { recursive: true }); fs.writeFileSync(dotenv, `SSL_CERT_FILE=${w.env.SSL_CERT_FILE}\n`)
    const { exit } = await w.uninstall({ env: without(w.env, 'SSL_CERT_FILE'), exec: launchd({}) })
    assert.deepEqual([exit, fs.readFileSync(w.env.SSL_CERT_FILE, 'utf8')], [0, USER_PEM])
  })

  test(`${os}: the certificate variable is nowhere now → the receipt says a block may be left in the user's file, with the command that takes it out`, async () => {
    const w = await world(os)
    const { receipt } = await w.uninstall({ env: without(w.env, 'SSL_CERT_FILE'), exec: launchd({}) })
    assert.ok(mentions(receipt.notes, 'SSL_CERT_FILE'), JSON.stringify(receipt.notes))
  })

  test(`${os}: uninstall with no record: the backups it deletes are not also said to be left in place`, async () => {
    const w = await world(os)
    const { receipt } = await w.uninstall()
    assert.ok(receipt.dropped_backups.length > 0, 'install kept backups, and uninstall deletes them')
    for (const b of receipt.dropped_backups) assert.ok(!fs.existsSync(b))
    assert.deepEqual(receipt.notes.filter((n) => receipt.dropped_backups.some((b) => n.includes(b) || n.includes(path.dirname(b)))), [])
  })

  test(`${os}: with the record, the real program put back in place of the wrapper is a changed row`, async () => {
    const w = await world(os, { keepRecord: true })
    const { receipt, exit } = await w.uninstall()
    assert.equal(exit, 0, JSON.stringify(receipt.problems))
    assert.deepEqual(fs.readFileSync(w.kimi), MACHO)
    assert.ok(receipt.changed.some((c) => c.path === w.kimi && c.change), JSON.stringify(receipt.changed))
  })

  test(`${os}: the receipt text of an uninstall with no record: every line within 80 columns, or one token alone on its line from the item's column (1.6 §1.1)`, async () => {
    const w = await world(os)
    const { receipt } = await w.uninstall()
    const long = formatUninstallReceipt(receipt, { home: w.home, platform: os }).split('\n').filter((l) => l.length > 80 && !/^ {0,2}\S+$/.test(l))
    assert.deepEqual(long, [])
  })
}
