// entries-sealed.test.mjs — the door password at rest (RFC 4.6「日志」, 1.6 §3.3): every route of every descriptor × darwin / win32 writes its records
// with the door only as `door_sha256` and the password masked, from the intent on; a crash at the intent leaves no password on disk; a clear record of
// the shape an older build wrote is sealed at the next save without the agent's file being written again.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { loadHarnesses } from '../../../../src/collector/harness/index.mjs'
import { routeEntry, recordsOf, pacAddress } from '../../../../src/collector/core/proxymode/entries.mjs'
import { resolveLoc } from '../../../../src/collector/core/proxymode/sources.mjs'
import { readManifest } from '../../../../src/off/manifest.mjs'
import { backupDir } from '../../../../src/off/paths.mjs'
import { sha256 } from '../../../../src/off/fsutil.mjs'
import { world, put, door } from './fixtures/entries-ctx.mjs'

const harnesses = await loadHarnesses()
const ROUTES = harnesses.flatMap((h) => Object.entries(h.proxyMode.routes).map(([id, r]) => ({ h, id, r })))
const PW = new URL(door()).password
const CASES = ROUTES.flatMap((x) => ['darwin', 'win32'].map((os) => ({ ...x, os })))
// what a record is tagged with: the door, or for a PAC route the PAC address on wrote (its key in it, 4.11 P10)
const tag = (c, ctx) => (c.r.value === 'pac-url' ? pacAddress(ctx.pacToken, door()) : door())

function setup({ h, id, r, os }, fsx) {
  const w = world({ os })
  const ctx = { ...w.ctx, harness: h.name, route: r, routeId: id, ...(fsx ? { fs: fsx(w) } : {}) }
  const file = r.file ? resolveLoc(r.file, ctx)[0] : null
  if (file) put(file, r.kind === 'dotenv-block' ? 'A=1\n' : '{"unrelated":"keep"}\n') // present: a route with absent 'not-routed' is written too
  const mf = path.join(w.dir, 'install-manifest.json')
  return { w, ctx, mf, bytes: () => fs.readFileSync(mf, 'utf8'), label: `${h.name}.${id} (${r.kind}) · ${os}` }
}
// an fs whose renameSync onto anything but the manifest or a backup (the agent's file, a switch file) is seen by `onAgent`
const watching = (w, onAgent) => new Proxy(fs, { get: (t, k) => (k !== 'renameSync' ? Reflect.get(t, k) : (from, to) => {
  if (path.basename(to) !== 'install-manifest.json' && !String(to).startsWith(backupDir(w.home) + path.sep)) onAgent(to)
  return t.renameSync(from, to)
}) })

test('S1: after write, the manifest on disk holds no door password; every on record has door_sha256 = sha256(door) and no door', () => {
  for (const c of CASES) {
    const s = setup(c)
    assert.equal(routeEntry(c.r.kind).write(s.ctx, door()).ok, true, s.label)
    assert.ok(!s.bytes().includes(PW), s.label)
    const recs = recordsOf(readManifest(s.w.dir), c.h.name, c.id)
    assert.ok(recs.length > 0 && recs.every((x) => x.door_sha256 === sha256(tag(c, s.ctx)) && !('door' in x)), s.label)
  }
})

test('S2: a crash at the intent (the rename onto the agent\'s file fails) leaves an intent on disk that names its route, and no door password', () => {
  for (const c of CASES) {
    let at = null, snap = null
    const s = setup(c, (w) => watching(w, (to) => {
      if (at) return
      at = to; snap = fs.readFileSync(path.join(w.dir, 'install-manifest.json'), 'utf8')
      throw Object.assign(new Error('crash'), { code: 'EIO' })
    }))
    try { routeEntry(c.r.kind).write(s.ctx, door()) } catch { /* the crash */ }
    assert.ok(at && snap, s.label)
    assert.ok(!snap.includes(PW), s.label)
    const m = JSON.parse(snap)
    assert.ok([...m.entries, ...m.files].some((x) => x.harness === c.h.name && (x.real_path || x.path) === at && x.door_sha256 === sha256(tag(c, s.ctx)) && x.route === c.id), `${s.label}: the intent for ${at}, naming its route`)
  }
})

test('S3: a clear v3 record (the door and the password in clear) is sealed at the next write; the agent\'s file is not written again, installed_at unchanged', () => {
  for (const c of CASES) {
    let renames = 0
    const s = setup(c, (w) => watching(w, () => { renames++ }))
    assert.equal(routeEntry(c.r.kind).write(s.ctx, door()).ok, true, s.label)
    const m = JSON.parse(s.bytes())
    for (const x of [...m.entries, ...m.files].filter((y) => y.door_sha256)) {
      for (const p of (x.secret && x.secret.fields) || []) { const o = p.slice(0, -1).reduce((a, k) => a[k], x); o[p.at(-1)] = o[p.at(-1)].split('***').join(PW) }
      x.door = tag(c, s.ctx); delete x.secret; delete x.door_sha256
    }
    fs.writeFileSync(s.mf, JSON.stringify(m, null, 2) + '\n')
    assert.ok(s.bytes().includes(PW), `${s.label}: the clear shape holds the password`)
    const at = Object.fromEntries([...m.entries, ...m.files].map((x) => [`${x.kind}\0${x.path}\0${JSON.stringify(x.keys)}`, x.installed_at]))
    renames = 0
    s.ctx.manifest = readManifest(s.w.dir)
    assert.equal(routeEntry(c.r.kind).write(s.ctx, door()).ok, true, s.label)
    assert.equal(renames, 0, `${s.label}: the agent's file is not written again`)
    assert.ok(!s.bytes().includes(PW), s.label)
    const after = JSON.parse(s.bytes())
    assert.deepEqual(Object.fromEntries([...after.entries, ...after.files].map((x) => [`${x.kind}\0${x.path}\0${JSON.stringify(x.keys)}`, x.installed_at])), at, s.label)
  }
})
