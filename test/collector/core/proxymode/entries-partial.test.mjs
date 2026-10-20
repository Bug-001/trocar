// entries-partial.test.mjs — a route write is all or nothing (invariant 5 / D48: off removes everything on wrote). Generated over every json-key route:
// the LAST edit the route makes is made to refuse by a shape only that edit touches (its parent or array holding a string; for `select`, the meta file's
// applied id holding an object or the meta file undecodable). The write refuses; the user's files are back byte for byte and no on-phase record is left
// in the manifest without a route tag (so nothing of trocar's stays where recordsOf cannot find it).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { loadHarnesses } from '../../../../src/collector/harness/index.mjs'
import { routeEntry } from '../../../../src/collector/core/proxymode/entries.mjs'
import { resolveLoc } from '../../../../src/collector/core/proxymode/sources.mjs'
import { world, put, bytesOf } from './fixtures/entries-ctx.mjs'

const harnesses = await loadHarnesses()
const DOOR = 'http://127.0.0.1:18002'
const json = (o) => JSON.stringify(o, null, 2) + '\n'
const nest = (keys, v) => keys.reduceRight((inner, k) => ({ [k]: inner }), v)
const snap = (dir) => (fs.existsSync(dir) ? Object.fromEntries(fs.readdirSync(dir).map((n) => [n, fs.readFileSync(path.join(dir, n)).toString('hex')])) : null)
const leftOver = (m) => [...m.entries, ...m.files].filter((x) => x.phase === 'on')

// the edits a non-select json-key route makes, in write order: [keys, isArray]
const editsOf = (r) => [...(r.proxyKeys || []), ...(r.noProxyKeys || [])].map((k) => [k, false]).concat((r.arrayItems || []).map((a) => [a.keys, true]))
const prefix = (a, b) => a.length <= b.length && a.every((k, i) => k === b[i])

const cases = []
for (const h of harnesses) for (const [id, r] of Object.entries(h.proxyMode.routes)) {
  if (r.kind !== 'json-key' || r.select) continue
  const edits = editsOf(r)
  const [last, isArray] = edits.at(-1)
  const at = isArray ? last : last.slice(0, -1) // a string here refuses the last edit
  if (!at.length || edits.length < 2 || edits.slice(0, -1).some(([k]) => prefix(at, k))) continue // no shape refuses the last edit alone
  cases.push({ h, id, r, at })
}

test('the generator found a json-key route whose last edit can refuse alone (the partial-write axis runs)', () => assert.ok(cases.length >= 1))

for (const { h, id, r, at } of cases) for (const os of ['darwin', 'win32']) {
  test(`${h.name}/${id} ${os} — the last edit refuses (${at.join('.')} holds a string): the earlier edits are taken back, the file is the user's bytes, no record left`, () => {
    const w = world({ os })
    const ctx = { ...w.ctx, harness: h.name, route: r, routeId: id }
    const file = resolveLoc(r.file, ctx)[0]
    const before = Buffer.from(json(nest(at, 'mine')))
    put(file, before)
    assert.throws(() => routeEntry('json-key').write(ctx, DOOR), (e) => e.code === 'entry-refused')
    assert.deepEqual(bytesOf(file), before)
    assert.deepEqual(leftOver(ctx.manifest), [])
  })
}

for (const h of harnesses) for (const [id, r] of Object.entries(h.proxyMode.routes)) {
  if (r.kind !== 'json-key' || !r.select || !r.select.createIfNone) continue
  for (const os of ['darwin', 'win32']) for (const [why, metaBytes] of [
    ['the applied id holds an object', Buffer.from(json({ [r.select.idKey]: { not: 'an id' } }))],
    ['the meta file is undecodable', Buffer.from([0xff, 0xfe, 0x00, 0xd8, 0x41])],
  ]) {
    test(`${h.name}/${id} ${os} — select create, ${why}: no created entry, no key, the library as the user left it, no record left`, () => {
      const w = world({ os })
      const ctx = { ...w.ctx, harness: h.name, route: r, routeId: id }
      const dir = resolveLoc(r.select.dir, ctx)[0]
      put(path.join(dir, r.select.meta), metaBytes)
      const before = snap(dir)
      let res
      try { res = routeEntry('json-key').write(ctx, DOOR) } catch (e) { res = { ok: false, code: e.code } }
      assert.notEqual(res.ok, true)
      assert.deepEqual(snap(dir), before)
      assert.deepEqual(leftOver(ctx.manifest), [])
    })
  }
}
