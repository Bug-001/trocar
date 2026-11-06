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
import { renderWrapper } from '../../src/collector/arch/darwin/wrapper.mjs'
import { runUninstall } from '../../src/cli/uninstall.mjs'
import { manifestPath } from '../../src/off/manifest.mjs'
import { recordingExec } from './fixtures/on-ctx.mjs'

const MACHO = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 1, 2, 3, 4])
const USER_PEM = `${tls.rootCertificates[2].trim()}\n`
const USER_ROW = '- insert: [{ name: "/opt/mine/plugin.mjs" }]\n'
// every file under HOME outside ~/.trocar: its bytes and mode
const files = (home) => {
  const out = {}
  const walk = (d) => { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); if (p === path.join(home, '.trocar')) continue; const st = fs.lstatSync(p); if (st.isDirectory()) walk(p); else out[path.relative(home, p)] = `${(st.mode & 0o777).toString(8)} ${fs.readFileSync(p).toString('base64')}` } }
  walk(home)
  return out
}

async function world(os) {
  const w = await modelWorld({ os, commands: ['codex', 'dsh', 'pi'], env: (home) => ({ SSL_CERT_FILE: path.join(home, 'certs', 'mine.pem') }) })
  fs.mkdirSync(path.join(w.home, 'certs'), { recursive: true }); fs.writeFileSync(w.env.SSL_CERT_FILE, USER_PEM)
  const exe = os === 'win32' ? '.exe' : '' // the program's file name as the OS names it (the arch's platform facts)
  const kimi = path.join(w.home, '.kimi-code', 'bin', `kimi${exe}`)
  fs.mkdirSync(path.dirname(kimi), { recursive: true }); fs.writeFileSync(kimi, MACHO, { mode: 0o751 })
  fs.mkdirSync(path.join(w.home, '.dsh'), { recursive: true }); fs.writeFileSync(path.join(w.home, '.dsh', 'cordis.patch.yml'), USER_ROW) // the user's own row stays
  fs.mkdirSync(path.join(w.home, '.pi', 'agent', 'extensions'), { recursive: true })
  fs.mkdirSync(path.join(w.home, '.zcode'), { recursive: true })
  const before = files(w.home)
  const r = await w.install({ wrapperKit: { renderWrapper }, facts: { exeSuffix: exe } })
  assert.equal(r.exit, 0, JSON.stringify(r.carriers))
  const changed = Object.keys(files(w.home)).filter((p) => files(w.home)[p] !== before[p])
  for (const k of ['wrapper', 'plugin', 'pem-block']) assert.ok(r.carriers.some((c) => c.carrier === k && c.state === 'placed'), `install placed a ${k}: ${JSON.stringify(r.carriers)}`)
  assert.ok(changed.length >= 5, `install changed the user's files: ${changed}`)
  fs.rmSync(manifestPath(w.dir)) // the record is lost
  const uninstall = () => runUninstall({ home: w.home, env: w.env, yes: true, deps: { platform: os, exec: recordingExec().run, custody: w.custody, rootStore: w.store, procs: async () => [], sleep: async () => {}, drainMs: 0, getuid: () => 501, harnesses: w.harnesses } })
  return { ...w, kimi, before, uninstall }
}

for (const os of ['darwin', 'win32']) {
  test(`${os}: install, the record deleted, uninstall → every carrier out: the user's files as before install, the real kimi back, exit 0`, async () => {
    const w = await world(os)
    const { receipt, exit } = await w.uninstall()
    assert.deepEqual(files(w.home), w.before, JSON.stringify({ left: receipt.left, problems: receipt.problems }))
    assert.deepEqual([exit, receipt.left], [0, []])
    const out = [...receipt.changed.map((c) => c.path), ...receipt.removed]
    for (const p of [w.kimi, w.env.SSL_CERT_FILE, path.join(w.home, '.dsh', 'cordis.patch.yml')]) assert.ok(out.includes(p), `the receipt names ${p}: ${JSON.stringify(out)}`)
  })

  test(`${os}: the plan of an uninstall with no record names the carriers it would take out`, async () => {
    const w = await world(os)
    const before = files(w.home)
    const { receipt, exit } = await runUninstall({ home: w.home, env: w.env, dryRun: true, deps: { platform: os, exec: recordingExec().run, custody: w.custody, rootStore: w.store, procs: async () => [], getuid: () => 501, harnesses: w.harnesses } })
    assert.equal(exit, 0)
    const planned = receipt.planned.map((p) => p.path)
    for (const p of [w.kimi, w.env.SSL_CERT_FILE, path.join(w.home, '.dsh', 'cordis.patch.yml')]) assert.ok(planned.includes(p), `the plan names ${p}: ${JSON.stringify(planned)}`)
    assert.deepEqual(files(w.home), before, 'a plan writes nothing')
  })

  // what trocar cannot tell as its own, or cannot undo as it is, stays — with a left row naming it — and the rest still goes
  const BROKEN = {
    'the real program in .trocar-real is gone': (w) => fs.rmSync(path.join(path.dirname(w.kimi), '.trocar-real'), { recursive: true }),
    'the plug-in was edited after install': (w) => { const d = path.join(w.home, '.pi', 'agent', 'extensions'); const f = path.join(d, fs.readdirSync(d)[0]); fs.appendFileSync(f, '// mine\n'); return f },
  }
  for (const [what, breakIt] of Object.entries(BROKEN)) {
    test(`${os}: ${what} → left, named with its reason, exit 1; the user's certificate file still comes back`, async () => {
      const w = await world(os)
      const at = breakIt(w) || w.kimi
      const kept = fs.readFileSync(at)
      const { receipt, exit } = await w.uninstall()
      assert.equal(exit, 1)
      const row = receipt.left.find((l) => l.path === at)
      assert.ok(row && row.reason, `left names ${at}: ${JSON.stringify(receipt.left)}`)
      assert.deepEqual(fs.readFileSync(at), kept, 'left as it is')
      assert.equal(fs.readFileSync(w.env.SSL_CERT_FILE, 'utf8'), USER_PEM)
    })
  }
}
