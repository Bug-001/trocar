// The door password at rest (RFC 4.6「日志」, 1.6 :40 R2 · §3.3 · V106): over every route of the host OS, in one world, through install → on → on again
// → a crash inside on's write, then on → an update from a clear version 3 manifest, then on → off → on and the standalone copy's off, no file trocar keeps
// under ~/.trocar holds the door password but ingress.json and the switch files (0600), and no backup ever does; the agent files end as the user's bytes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { modelWorld } from '../helpers/model-world.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { renderWrapper as darwinWrapper } from '../../src/collector/arch/darwin/wrapper.mjs'
import { renderWrapper as win32Wrapper } from '../../src/collector/arch/win32/wrapper.mjs'
import { renderHook } from '../../src/collector/harness/templates/index.mjs'
import { turnOnModel } from '../../src/collector/model-on.mjs'
import { startControlServer } from '../../src/collector/core/control.mjs'
import { readIngressConfig } from '../../src/collector/core/ingress-config.mjs'
import { resolveLoc } from '../../src/collector/core/proxymode/sources.mjs'
import { readManifest } from '../../src/off/manifest.mjs'
import { undoHarnesses } from '../../src/off/undo.mjs'
import { sha256 } from '../../src/off/fsutil.mjs'
import { writeStandalone } from '../../src/off/standalone.mjs'
import { loadHarnesses } from '../../src/collector/harness/index.mjs'

const OS = process.platform === 'win32' ? 'win32' : 'darwin'
const POSIX = process.platform !== 'win32'
const CONTROL_TOKEN = 'c'.repeat(32)
const MACHO = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0])

const walk = (d, out = {}) => {
  if (!fs.existsSync(d)) return out
  for (const n of fs.readdirSync(d)) { const p = path.join(d, n); const st = fs.lstatSync(p); if (st.isDirectory()) walk(p, out); else if (st.isFile()) out[p] = fs.readFileSync(p) }
  return out
}

test('4.6「日志」· 1.6 V106: the door password is in ingress.json and the switch files only, through on, a crash, an update, off and the standalone off', async (t) => {
  const descs = (await loadHarnesses()).filter((d) => d.proxyMode && d.proxyMode.forms.some((f) => f.os.includes(OS)))
  const forms = descs.flatMap((d) => d.proxyMode.forms.filter((f) => f.os.includes(OS)))
  // every form present: a command `which` finds, else the first place in the tmp HOME (the hermetic ctx never sees /Applications)
  const commands = [...new Set(forms.map((f) => f.present.find((p) => p && 'command' in p)).filter(Boolean).map((p) => p.command))]
  const w = await modelWorld({ os: OS, commands })
  // each json-key / dotenv route file named by a fixed place holds the user's own bytes before install (so backups are made); a selected file stays absent
  for (const d of descs) for (const r of Object.values(d.proxyMode.routes || {})) {
    if (!r.file || !['json-key', 'dotenv-block'].includes(r.kind)) continue
    const f = resolveLoc(r.file, w.ctx)[0]
    if (!f || fs.existsSync(f)) continue
    fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, r.kind === 'json-key' ? '{"mine":1}\n' : 'MINE=1\n')
  }
  for (const f of forms) {
    if (f.present.some((p) => p && 'command' in p)) continue
    const p = f.present.find((x) => x && x.base !== 'abs' && (() => { try { return resolveLoc({ ...x, glob: undefined }, w.ctx).length } catch { return false } })())
    if (!p) continue
    const at = resolveLoc({ ...p, glob: undefined }, w.ctx)[0]
    if (p.glob) { fs.mkdirSync(path.join(at, p.glob.replace(/\*/g, '0')), { recursive: true }); continue }
    if (fs.existsSync(at)) continue
    // a place is a folder, but the program an install-folder wrapper wraps, which must be one native program (a Mach-O header)
    if (f.cert === 'wrapper') { fs.mkdirSync(path.dirname(at), { recursive: true }); fs.writeFileSync(at, MACHO) } else fs.mkdirSync(at, { recursive: true })
  }
  const ins = await w.install({ wrapperKit: { renderWrapper: OS === "win32" ? win32Wrapper : darwinWrapper } })
  assert.equal(ins.exit, 0, JSON.stringify(ins))
  const trocarDir = path.join(w.home, '.trocar')
  const outside = () => Object.fromEntries(Object.entries(walk(w.home)).filter(([p]) => !p.startsWith(trocarDir + path.sep)))
  const user = outside() // the user's bytes before any on (install's own carriers included: off leaves them)

  // the daemon's control socket, answering POST /on with each group's door as the real daemon builds it (collector.mjs): the listener token as password
  const byName = new Map(descs.map((d) => [d.name, d]))
  const T = () => readIngressConfig({ dir: w.dir }).listenerToken
  const doorOf = (g, port) => {
    const [h, route] = [g.slice(0, g.indexOf(':')), g.slice(g.indexOf(':') + 1)]
    return byName.get(h).proxyMode.routes[route].auth !== false ? `http://${encodeURIComponent(g)}:${T()}@127.0.0.1:${port}` : `http://127.0.0.1:${port}`
  }
  const sock = path.join(w.home, 'c.sock')
  fs.writeFileSync(path.join(w.dir, 'control.json'), JSON.stringify({ path: sock, token: CONTROL_TOKEN }))
  const server = await startControlServer({ socketPath: sock, token: CONTROL_TOKEN, routes: {
    'GET /status': async () => ({ doors: {} }),
    'POST /on': async ({ body }) => ({ doors: Object.fromEntries(Object.entries(body.groups).map(([g, port]) => [g, doorOf(g, port)])) }),
  } })
  const on = (over = {}) => turnOnModel({ os: OS, home: w.home, env: w.env, harnesses: w.harnesses, ctx: w.ctx, isFree: async () => true, renderHook, ...over })

  const scan = (step) => {
    const t = T()
    assert.ok(t, `${step}: ingress.json holds the listener token`)
    for (const [p, b] of Object.entries(walk(trocarDir))) {
      const rel = path.relative(w.dir, p).split(path.sep).join('/')
      if (rel === 'ingress.json' || rel.startsWith('switch/')) { if (POSIX) assert.equal(fs.statSync(p).mode & 0o777, 0o600, `${step}: ${p} is 0600`); continue }
      assert.equal(b.includes(t), false, `${step}: ${p} holds the door password`)
    }
  }
  const agentFiles = () => [...new Set([...readManifest(w.dir).entries, ...readManifest(w.dir).files].filter((x) => x.phase === 'on' && x.path && !x.path.startsWith(trocarDir + path.sep)).map((x) => x.path))]
  const bytesOf = (files) => Object.fromEntries(files.map((f) => [f, fs.existsSync(f) ? fs.readFileSync(f).toString('base64') : null]))
  const asUser = (files) => Object.fromEntries(files.map((f) => [f, user[f] ? user[f].toString('base64') : null]))

  try {
    // 1 install → on
    assert.equal((await on()).exit, 0)
    scan('on')
    const files = agentFiles()
    assert.ok(files.length > 0)
    const afterOn = bytesOf(files)

    // 2 on again: nothing moves
    assert.equal((await on()).exit, 0)
    scan('on again')
    assert.deepEqual(bytesOf(files), afterOn)

    // 3 a crash while on moves the door of the first agent file (its group's port taken, so it undoes the old entry first), then on; a crash at a write's intent: entries-sealed, entries-once
    const first = readManifest(w.dir).entries.find((e) => e.phase === 'on' && e.path === files[0]) || readManifest(w.dir).files.find((e) => e.phase === 'on' && e.path === files[0])
    const g = `${first.harness}:${first.route}`
    const taken = readIngressConfig({ dir: w.dir }).groupPorts[g]
    let thrown = false
    const crashy = new Proxy(fs, { get: (t, k) => (k !== 'renameSync' ? t[k] : (a, b) => { if (!thrown && b === files[0]) { thrown = true; throw Object.assign(new Error('EIO: crash'), { code: 'EIO' }) } return t.renameSync(a, b) }) })
    try { await on({ fs: crashy, isFree: async (p) => p !== taken }) } catch { /* the crash: its intent is on disk */ }
    assert.equal(thrown, true, 'the write of the first agent file was reached')
    scan('crash')
    await on({ isFree: async (p) => p !== taken })
    scan('crash then on')

    // 4 an update from a clear version 3 manifest (the shape an older build wrote): the next on leaves it sealed
    const mf = path.join(w.dir, 'install-manifest.json')
    const m = JSON.parse(fs.readFileSync(mf, 'utf8'))
    const ports = readIngressConfig({ dir: w.dir }).groupPorts
    for (const x of [...m.entries, ...m.files].filter((y) => y.door_sha256)) {
      x.door = doorOf(`${x.harness}:${x.route}`, ports[`${x.harness}:${x.route}`])
      assert.equal(sha256(x.door), x.door_sha256, 'the clear door rebuilt is the one on record')
      for (const p of (x.secret && x.secret.fields) || []) { const o = p.slice(0, -1).reduce((a, k) => a[k], x); o[p.at(-1)] = o[p.at(-1)].split('***').join(T()) }
      delete x.door_sha256; delete x.secret
    }
    m.version = 3
    fs.writeFileSync(mf, JSON.stringify(m, null, 2) + '\n', { mode: 0o600 })
    assert.equal((await on()).exit, 0)
    scan('update')

    // 5 off: every agent file is the user's bytes again, or absent when there were none
    const off = await undoHarnesses({ dir: w.dir, home: w.home, manifest: readManifest(w.dir), ids: null, procs: async () => [] })
    assert.deepEqual(off.left, [])
    assert.deepEqual(bytesOf(files), asUser(files))
    scan('off')

    // 6 on, then the standalone copy's off (the daemon gone)
    assert.equal((await on()).exit, 0)
    scan('on after off')
  } finally { await server.close() }
  // the copy's process-table question goes to powershell on win32, which the sandbox refuses; this step has not run on Windows yet
  await t.test('6 the standalone copy\'s off', { skip: OS === 'win32' && 'the copy asks powershell for the process table; no Windows run yet' }, async () => {
    const files = agentFiles()
    const copy = writeStandalone({ home: w.home }).path
    const stubs = tmpDir('trocar-stub-')
    for (const n of ['ps', 'launchctl']) fs.writeFileSync(path.join(stubs, n), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    // every per-user folder resolves inside the sandbox (USERPROFILE is what os.homedir() reads on Windows)
    const env = { ...w.env, HOME: w.home, USERPROFILE: w.home, PATH: stubs, NODE_PATH: '', TROCAR_TEST_SANDBOX: '1', TMPDIR: os.tmpdir() }
    const status = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [copy], { cwd: w.home, env, stdio: ['ignore', 'pipe', 'pipe'] })
      const out = []; child.stdout.on('data', (d) => out.push(d)); child.stderr.on('data', (d) => out.push(d))
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('trocar-off did not exit in 30 s')) }, 30_000)
      child.on('close', (code) => { clearTimeout(timer); resolve({ code, out: Buffer.concat(out).toString('utf8') }) })
    })
    assert.equal(status.code, 0, status.out)
    assert.deepEqual(bytesOf(files), asUser(files))
    scan('standalone off')
  })
})
