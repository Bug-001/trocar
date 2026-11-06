// entries-not-routed.test.mjs — a route `on` does not write this time (not-routed, spec 4.11 P5) leaves no door of an earlier `on` behind: the manifest's
// records of that route are undone (the prior back, what trocar made gone), so neither this `on` nor the next `off` leaves a door in the entry. Generated
// over every PAC route × OS × ruling ③ reason, and every descriptor × OS × blocker; a door value no record holds is left, with the not-routed reason.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { loadHarnesses } from '../../../../src/collector/harness/index.mjs'
import { routeEntry, writeRoutes, planRoutes } from '../../../../src/collector/core/proxymode/entries.mjs'
import { resolveLoc } from '../../../../src/collector/core/proxymode/sources.mjs'
import { undoEntry } from '../../../../src/off/journal.mjs'
import { world, put } from './fixtures/entries-ctx.mjs'

const harnesses = await loadHarnesses()
const OSES = ['darwin', 'win32']
const pacRoutes = harnesses.flatMap((h) => Object.entries(h.proxyMode.routes).filter(([, r]) => r.value === 'pac-url').map(([id, r]) => ({ h, id, r })))
const door = (port) => `http://127.0.0.1:${port}` // no credentials: the PAC door takes none, and a door URL is all a test needs
const files = (root) => fs.readdirSync(root, { recursive: true }).map((n) => path.join(root, n)).filter((p) => fs.statSync(p).isFile())
const holding = (root, port) => files(root).filter((p) => !p.includes(`${path.sep}.trocar${path.sep}`) && fs.readFileSync(p, 'latin1').replace(/\0/g, '').includes(`:${port}`))
const ingress = (w, ports) => put(path.join(w.dir, 'ingress.json'), JSON.stringify({ groupPorts: Object.fromEntries(ports.map((p, i) => [`g:${i}`, p])) }))
// what `off` does with the manifest: every on record undone, entry by entry (src/off/journal.mjs)
const off = (w) => { for (const e of w.ctx.manifest.entries.filter((x) => x.phase === 'on')) undoEntry(e, { fs }) }

test('the descriptors carry a PAC route and blockers (the axes below run over them)', () => {
  assert.ok(pacRoutes.length >= 1 && harnesses.some((h) => (h.proxyMode.blockers || []).length))
})

for (const { h, id, r } of pacRoutes) for (const os of OSES) {
  const own = (r.ownKeys || []).filter((k) => !(r.proxyKeys || []).some((p) => p.join('.') === k.join('.')))
  const reasons = [['system-pac', (w) => { w.ctx.systemProxy = { pac: true } }], ['credentialed-own-leg', (w) => { w.ctx.systemProxy = { url: 'http://alice:pw@corp.example:8080', bypass: [] } }]]
  if (own.length && r.select) reasons.push(['own-egress', (w, entry) => { const d = JSON.parse(fs.readFileSync(entry, 'utf8')); d[own[0].join('.')] = 'http://corp.example:8080'; fs.writeFileSync(entry, JSON.stringify(d)) }])
  for (const [reason, turn] of reasons) {
    test(`P5 ${h.name}.${id} · ${os} · not-routed ${reason} after an on that wrote the door: on takes the recorded door out, off leaves none`, () => {
      const w = world({ os })
      ingress(w, [18002])
      const ctx = { ...w.ctx, harness: h.name, route: r, routeId: id }
      let entry
      if (r.select) {
        const dir = resolveLoc(r.select.dir, ctx)[0]
        put(path.join(dir, r.select.meta), JSON.stringify({ [r.select.idKey]: 'u1' }))
        entry = path.join(dir, 'u1.json')
      } else entry = resolveLoc(r.file, ctx)[0]
      put(entry, JSON.stringify({ inferenceProvider: 'gateway' }))
      assert.equal(routeEntry(r.kind).write(ctx, door(18002)).ok, true)
      assert.ok(holding(w.root, 18002).length, 'the first on wrote the door')
      turn(w, entry)
      const res = routeEntry(r.kind).write({ ...ctx, systemProxy: w.ctx.systemProxy }, door(18002))
      assert.deepEqual([res.code, res.reason], ['not-routed', reason])
      const want = { inferenceProvider: 'gateway', ...(reason === 'own-egress' ? { [own[0].join('.')]: 'http://corp.example:8080' } : {}) }
      assert.deepEqual(JSON.parse(fs.readFileSync(entry, 'utf8')), want, 'the entry is back at the user\'s values')
      assert.deepEqual(holding(w.root, 18002), [], 'no file holds the door')
      assert.deepEqual(w.ctx.manifest.entries.filter((x) => x.route === id), [], 'no record of the route is left')
      off(w)
      assert.deepEqual(JSON.parse(fs.readFileSync(entry, 'utf8')), want)
      assert.deepEqual(holding(w.root, 18002), [])
    })
  }

  test(`P5 ${h.name}.${id} · ${os} · a door value no record holds (its port not in ingress.json) stays under not-routed, the reason said`, () => {
    const w = world({ os, systemProxy: { pac: true } })
    ingress(w, [18002])
    const ctx = { ...w.ctx, harness: h.name, route: r, routeId: id }
    let entry
    if (r.select) {
      const dir = resolveLoc(r.select.dir, ctx)[0]
      put(path.join(dir, r.select.meta), JSON.stringify({ [r.select.idKey]: 'u1' }))
      entry = path.join(dir, 'u1.json')
    } else entry = resolveLoc(r.file, ctx)[0]
    const before = JSON.stringify({ [r.proxyKeys[0].join('.')]: 'http://127.0.0.1:18999/trocar.pac' })
    put(entry, before)
    const res = routeEntry(r.kind).write(ctx, door(18002))
    assert.deepEqual([res.code, res.reason], ['not-routed', 'system-pac'])
    assert.equal(fs.readFileSync(entry, 'utf8'), before)
  })
}

for (const h of harnesses) for (const os of OSES) {
  const forms = h.proxyMode.forms.filter((f) => f.os.includes(os))
  for (const [i, b] of (h.proxyMode.blockers || []).entries()) {
    test(`P5 ${h.name} · ${os} · blocker ${i} set after an on: the routes only blocked forms use keep no door of that on, and off leaves none`, (t) => {
      const w = world({ os })
      for (const f of forms) w.present(f)
      const ids = Object.keys(h.proxyMode.routes), portOf = (rid) => 18100 + ids.indexOf(rid)
      ingress(w, ids.map(portOf))
      const first = writeRoutes(h, w.ctx, (rid) => door(portOf(rid)))
      if (!w.plant(b.at)) { t.skip(`the blocker names nothing on ${os}`); return }
      const second = writeRoutes(h, w.ctx, (rid) => door(portOf(rid)))
      const blocked = first.results.filter((x) => x.ok && !second.results.some((y) => y.route === x.route)).map((x) => x.route)
      if (!blocked.length) { t.skip('the blocker leaves every written route a form'); return }
      for (const rid of blocked) {
        assert.deepEqual(w.ctx.manifest.entries.concat(w.ctx.manifest.files).filter((x) => x.harness === h.name && x.route === rid), [], `${rid}: no record left`)
        assert.deepEqual(holding(w.root, portOf(rid)), [], `${rid}: no file holds its door`)
      }
      off(w)
      for (const rid of blocked) assert.deepEqual(holding(w.root, portOf(rid)), [], `${rid}: after off`)
    })
  }
}

// a door the take-back cannot undo (the file and its folder read-only): on goes on, the route's result says entry-not-undone where, and the record stays
// for off to try again (invariant 4, D38) — on the not-routed path of a written route and on the path of a route no planned form uses
const lock = (t, list) => {
  const dirs = [...new Set(list.map((p) => path.dirname(p)))]
  for (const p of list) fs.chmodSync(p, 0o444)
  for (const d of dirs) fs.chmodSync(d, 0o555)
  t.after(() => { for (const d of dirs) fs.chmodSync(d, 0o755); for (const p of list) fs.chmodSync(p, 0o644) })
}
const notUndone = (res, rid) => res.results.filter((x) => x.route === rid && x.ok === false && x.code === 'entry-not-undone')
const recordsLeft = (w, h, rid) => w.ctx.manifest.entries.concat(w.ctx.manifest.files).filter((x) => x.harness === h.name && x.route === rid)

for (const { h, id, r } of pacRoutes) for (const os of OSES) {
  test(`P5 ${h.name}.${id} · ${os} · not-routed system-pac with the door's file unwritable: on returns, the route says entry-not-undone, the record stays`, (t) => {
    const w = world({ os })
    for (const f of h.proxyMode.forms.filter((x) => x.os.includes(os) && x.route === id)) w.present(f)
    ingress(w, [18002])
    const ctx = { ...w.ctx, harness: h.name, route: r, routeId: id }
    if (r.select) put(path.join(resolveLoc(r.select.dir, ctx)[0], r.select.meta), JSON.stringify({ [r.select.idKey]: 'u1' }))
    const first = writeRoutes(h, w.ctx, () => door(18002))
    if (!first.results.some((x) => x.route === id && x.ok)) { t.skip(`no form of ${id} on ${os}`); return }
    const held = holding(w.root, 18002)
    lock(t, held)
    w.ctx.systemProxy = { pac: true }
    const second = writeRoutes(h, w.ctx, () => door(18002))
    assert.ok(second.results.some((x) => x.route === id && x.code === 'not-routed'), 'the not-routed reason is still said')
    const left = notUndone(second, id)
    assert.ok(left.length && left.every((x) => typeof x.reason === 'string' && x.reason && typeof x.at === 'string'), 'entry-not-undone, with a reason and where')
    assert.ok(recordsLeft(w, h, id).length, 'the record stays for off')
  })
}

for (const h of harnesses) for (const os of OSES) {
  const forms = h.proxyMode.forms.filter((f) => f.os.includes(os))
  for (const [i, b] of (h.proxyMode.blockers || []).entries()) {
    test(`P5 ${h.name} · ${os} · blocker ${i} set after an on, the door's file unwritable: on returns, the blocked route says entry-not-undone, the record stays`, (t) => {
      const w = world({ os })
      for (const f of forms) w.present(f)
      const ids = Object.keys(h.proxyMode.routes), portOf = (rid) => 18100 + ids.indexOf(rid)
      ingress(w, ids.map(portOf))
      const first = writeRoutes(h, w.ctx, (rid) => door(portOf(rid)))
      if (!w.plant(b.at)) { t.skip(`the blocker names nothing on ${os}`); return }
      const blocked = first.results.filter((x) => x.ok && !planRoutes(h, w.ctx).routes.some((y) => y.id === x.route)).map((x) => x.route)
      if (!blocked.length) { t.skip('the blocker leaves every written route a form'); return }
      lock(t, blocked.flatMap((rid) => holding(w.root, portOf(rid))))
      const second = writeRoutes(h, w.ctx, (rid) => door(portOf(rid)))
      for (const rid of blocked) {
        const left = notUndone(second, rid)
        assert.ok(left.length && left.every((x) => typeof x.reason === 'string' && x.reason && typeof x.at === 'string'), `${rid}: entry-not-undone, with a reason and where`)
        assert.ok(recordsLeft(w, h, rid).length, `${rid}: the record stays for off`)
      }
    })
  }
}
