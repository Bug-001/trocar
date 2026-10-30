// test/cli/own-table.test.mjs — CM39 (spec 4.11 §3 ㉓ · §5 CM39; 4.6 安装清单与卸载): every walk starts from this copy's own harness table. Two
// identical worlds, A and B, are installed and turned on for every harness that has a form on the OS; B alone also carries records of ids its
// table does not hold — X = `<h>-next`, written as a newer trocar would write them (manifest items whose files lie under HOME/.other, liveness,
// install.harnesses, state.json, door-seen.json rows, ingress.json groups). Then the steps run in lockstep on both, and after each: B exits as A
// does (I1); B's document never names an X (I2); it names the same table ids as A's (I3); X's records and files are as they were (I4); B
// changes the same HOME paths as A (I5). Expectations come from world A and the seeded bytes. The steps are a list, run in order.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpDir } from '../helpers/tmp.mjs'
import { contractWorld, daemonFor, placesOf } from '../helpers/contract-world.mjs'

const STEPS = [
  { name: 'off', carriers: 'all', run: async (w) => { const r = await w.cmd.off(['--json']); return { exit: r.exit, doc: JSON.parse(r.text) } } },
  { name: 'uninstall', carriers: 'manifest', run: async (w) => { const r = await w.cmd.uninstall(); return { exit: r.exit, doc: r.receipt } } },
]

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null } }
const writeJson = (p, v) => fs.writeFileSync(p, `${JSON.stringify(v, null, 2)}\n`)
const files = (root) => {
  const out = {}
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.isFile()) out[path.relative(root, p)] = fs.readFileSync(p).toString('base64') } }
  if (fs.existsSync(root)) walk(root)
  return out
}
// names drawn at random are not the worlds' to agree on: a backup's (its file's hash and the time it was taken) and a UUID-named file's
const changed = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((p) => a[p] !== b[p]).map((p) => p.replace(/^(\.trocar[\\/]backup[\\/]).+$/, '$1*').replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '*')).sort()
const idsIn = (doc, table) => { const s = new Set(); (function walk(v) { if (typeof v === 'string') { if (table.includes(v)) s.add(v) } else if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x) })(doc); return [...s].sort() }

async function world(os) {
  const w = await contractWorld({ os })
  const on = []
  for (const h of w.harnesses) {
    const forms = h.proxyMode.forms.filter((f) => f.os.includes(os) && placesOf(f, w.ctx).length)
    for (const f of forms) for (const pl of placesOf(f, w.ctx)) w.place(pl)
    if (forms.length) on.push(h.name)
  }
  await w.cmd.install() // A and B are built alike; what install could not place (a win32 wrapper target this world lacks) is the same in both
  w.daemon = await daemonFor(w)
  await w.cmd.on(on)
  // the door's durable rows, as a daemon writes them: one per harness that is on (both worlds hold them; uninstall takes the file)
  writeJson(path.join(w.dir, 'door-seen.json'), { version: 1, rows: on.map((h, i) => ({ harness: h, group: h, pid: 900 + i, start: '1', kind: 'accept', at: 1, n: 1 })) })
  return w
}

/** What a newer trocar wrote for X, cloned from `h0`'s records with every HOME path moved under HOME/.other. → the list of X ids. */
function seedOthers(w) {
  const table = w.harnesses.map((h) => h.name)
  const mPath = path.join(w.dir, 'install-manifest.json'), m = readJson(mPath)
  const other = path.join(w.home, '.other')
  const move = (v) => typeof v === 'string' && (v === w.home || v.startsWith(w.home + path.sep)) ? path.join(other, path.relative(w.home, v)) : v
  const clone = (v, x) => JSON.parse(JSON.stringify(v), (k, s) => (k === 'harness' && typeof s === 'string' ? x : move(s)))
  const st = readJson(path.join(w.dir, 'state.json')), ds = readJson(path.join(w.dir, 'door-seen.json')), ing = readJson(path.join(w.dir, 'ingress.json'))
  const used = new Set(Object.values(ing.groupPorts))
  let port = 41000
  const xs = []
  for (const h0 of table) {
    const items = [...m.entries, ...m.files].filter((x) => x.harness === h0)
    if (!items.length) continue
    const x = `${h0}-next`
    assert.ok(!table.includes(x), x)
    xs.push(x)
    for (const it of items) for (const v of Object.values(it)) {
      if (typeof v === 'string' && v.startsWith(w.home + path.sep) && fs.existsSync(v)) { fs.mkdirSync(path.dirname(move(v)), { recursive: true }); fs.cpSync(v, move(v), { recursive: true }) }
    }
    m.entries.push(...m.entries.filter((e) => e.harness === h0).map((e) => clone(e, x)))
    m.files.push(...m.files.filter((f) => f.harness === h0).map((f) => clone(f, x)))
    if (m.liveness && m.liveness[h0]) m.liveness[x] = { ...clone(m.liveness[h0], x), on_at: m.liveness[h0].on_at || '2026-10-30T00:00:00.000Z', off_at: null }
    if (m.install) m.install.harnesses = [...(m.install.harnesses || []), x]
    if (st && st.harnesses[h0]) st.harnesses[x] = { ...st.harnesses[h0], desired: 'on' }
    ds.rows.push(...ds.rows.filter((r) => r.harness === h0).map((r) => ({ ...r, harness: x, group: x })))
    for (const g of Object.keys(ing.groupPorts).filter((g) => g === h0 || g.startsWith(`${h0}:`))) { while (used.has(port)) port++; used.add(port); ing.groupPorts[`${x}${g.slice(h0.length)}`] = port }
  }
  writeJson(mPath, m)
  if (st) writeJson(path.join(w.dir, 'state.json'), st)
  writeJson(path.join(w.dir, 'door-seen.json'), ds)
  writeJson(path.join(w.dir, 'ingress.json'), ing)
  return xs
}

/** X's carriers as they are now: `all` (off) = every record kind; `manifest` (uninstall) = its manifest items and the bytes under HOME/.other. */
function carriers(w, xs, which) {
  const m = readJson(path.join(w.dir, 'install-manifest.json')) || { entries: [], files: [] }
  const mine = (x) => xs.includes(x.harness)
  const out = { items: [...m.entries.filter(mine), ...m.files.filter(mine)], bytes: files(path.join(w.home, '.other')) }
  if (which === 'manifest') return out
  const st = readJson(path.join(w.dir, 'state.json')), ds = readJson(path.join(w.dir, 'door-seen.json')), ing = readJson(path.join(w.dir, 'ingress.json'))
  return { ...out,
    liveness: xs.map((x) => (m.liveness || {})[x] ?? null),
    installed: ((m.install && m.install.harnesses) || []).filter((h) => xs.includes(h)),
    state: xs.map((x) => (st && st.harnesses[x]) ?? null),
    door: ((ds && ds.rows) || []).filter(mine),
    groups: Object.entries((ing && ing.groupPorts) || {}).filter(([g]) => xs.some((x) => g === x || g.startsWith(`${x}:`))),
  }
}

process.chdir(tmpDir('trocar-pipes-')) // a win32 control endpoint is a pipe name, served as a socket path relative to the cwd (eighth.test.mjs)
describe('CM39: off and uninstall walk only their own harness table', { concurrency: 1 }, () => {
  for (const os of ['darwin', 'win32']) {
    it(`${os}: a world carrying records of ids outside the table ends as the world without them, and those records stay`, async () => {
      const A = await world(os), B = await world(os)
      try {
        const table = B.harnesses.map((h) => h.name)
        const xs = seedOthers(B)
        assert.ok(xs.length > 0, 'no harness has manifest records to clone')
        for (const step of STEPS) {
          const fa0 = files(A.home), fb0 = files(B.home), x0 = carriers(B, xs, step.carriers)
          const a = await step.run(A), b = await step.run(B)
          const label = `${os} ${step.name}`
          assert.equal(b.exit, a.exit, `${label} I1: ${JSON.stringify(b.doc.problems || b.doc.error)}`)
          const text = JSON.stringify(b.doc)
          assert.deepEqual(xs.filter((x) => text.includes(x)), [], `${label} I2`)
          assert.deepEqual(idsIn(b.doc, table), idsIn(a.doc, table), `${label} I3`)
          assert.deepEqual(carriers(B, xs, step.carriers), x0, `${label} I4`)
          const fb = files(B.home)
          assert.deepEqual(changed(fb0, fb), changed(fa0, files(A.home)), `${label} I5`)
        }
      } finally { A.daemon.close(); B.daemon.close() }
    })
  }
})
