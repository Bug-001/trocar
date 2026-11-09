// entries-select.test.mjs — the json-key route's two data fields (spec 4.11 P5, CM18): `select` (the entry a meta file names: Claude Desktop's config
// library) on every axis — an applied entry / none / an applied id naming no file / the user switching appliedId during on / the user editing the created
// entry / the user's own egress in the entry — with the meta file restored byte for byte; ruling ③'s PAC not-routed checks; `arrayItems` with the array
// present / absent / already holding the item / the item removed by the user during on; and P6 mergeNoProxy.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { loadHarnesses } from '../../../../src/collector/harness/index.mjs'
import { routeEntry, mergeNoProxy, pacPath } from '../../../../src/collector/core/proxymode/entries.mjs'
import { resolveLoc } from '../../../../src/collector/core/proxymode/sources.mjs'
import { encodeText, decodeBytes } from '../../../helpers/file-shapes.mjs'
import { world, put, bytesOf } from './fixtures/entries-ctx.mjs'
import { applyJsonKey } from '../../../../src/collector/core/trust/journal.mjs'

const harnesses = await loadHarnesses()
const withSelect = harnesses.flatMap((h) => Object.entries(h.proxyMode.routes).filter(([, r]) => r.select).map(([id, r]) => ({ h, id, r })))
const withArray = harnesses.flatMap((h) => Object.entries(h.proxyMode.routes).filter(([, r]) => r.arrayItems).map(([id, r]) => ({ h, id, r })))
const DOOR = 'http://127.0.0.1:18002' // a PAC door takes no credentials
const KEY = 'ab'.repeat(16)
const PAC = `${DOOR}${pacPath(KEY)}` // the PAC address carries the install's key (P10)
const SHAPES = [['utf8', false, '\n'], ['utf8', true, '\r\n'], ['utf16le', true, '\n']]
const json = (o, eol) => JSON.stringify(o, null, 2).replace(/\n/g, eol) + eol
const read = (f) => JSON.parse(decodeBytes(fs.readFileSync(f)).text)

function lib(os, { meta = undefined, entries = {}, shape = SHAPES[0], ...opts } = {}) {
  const w = world({ os, ...opts })
  const { h, id, r } = withSelect[0]
  const ctx = { ...w.ctx, harness: h.name, route: r, routeId: id, pacToken: KEY }
  const dir = resolveLoc(r.select.dir, ctx)[0]
  const enc = (o) => encodeText(json(o, shape[2]), shape[0], shape[1])
  if (meta !== undefined) put(path.join(dir, r.select.meta), enc(meta))
  for (const [eid, doc] of Object.entries(entries)) put(path.join(dir, `${eid}.json`), enc(doc))
  const snap = () => Object.fromEntries((fs.existsSync(dir) ? fs.readdirSync(dir) : []).map((n) => [n, fs.readFileSync(path.join(dir, n)).toString('hex')]))
  return { w, ctx, r, dir, key: r.proxyKeys[0].join('.'), idKey: r.select.idKey, metaFile: path.join(dir, r.select.meta), snap, before: snap(), dirExisted: fs.existsSync(dir) }
}

test('the descriptors carry a select route and an arrayItems route (the axes below run over them)', () => {
  assert.ok(withSelect.length >= 1 && withArray.length >= 1)
})

for (const os of ['darwin', 'win32']) for (const shape of SHAPES) {
  const tag = `${os} · ${shape[0]}${shape[1] ? '+BOM' : ''} · ${shape[2] === '\n' ? 'LF' : 'CRLF'}`
  test(`CM18 ${tag} — an applied entry: only the key is added, the prior recorded; off restores the entry and _meta.json byte for byte`, () => {
    const L = lib(os, { shape, meta: { appliedId: 'u1', entries: [{ id: 'u1', name: 'mine' }] }, entries: { u1: { inferenceProvider: 'gateway' } } })
    const res = routeEntry('json-key').write(L.ctx, DOOR)
    assert.equal(res.ok, true)
    assert.deepEqual(read(path.join(L.dir, 'u1.json')), { [L.key]: PAC, inferenceProvider: 'gateway' })
    assert.deepEqual(res.records.map((x) => x.kind), ['json-key'], 'nothing created, the meta file untouched')
    routeEntry('json-key').undo(L.ctx, res.records)
    assert.deepEqual(L.snap(), L.before)
  })

  for (const [why, meta, entries] of [['no meta file', undefined, {}], ['a meta file with no applied id', { entries: [] }, {}], ['an applied id naming no file', { appliedId: 'gone', entries: [] }, {}]]) {
    test(`CM18 ${tag} — ${why}: an entry holding only the key is created and set applied; off deletes it and restores _meta.json byte for byte`, () => {
      const L = lib(os, { shape, meta, entries })
      const res = routeEntry('json-key').write(L.ctx, DOOR)
      assert.equal(res.ok, true)
      assert.deepEqual(read(path.join(L.dir, 'trocar-1.json')), { [L.key]: PAC })
      assert.equal(read(L.metaFile)[L.idKey], 'trocar-1')
      assert.deepEqual(res.records.map((x) => [x.kind, x.role || x.keys.join('.')]), [['json-key', L.key], ['json-key', L.idKey]], 'one record per file: the created entry is its own json-key (4.11 §4), never a second owned-file')
      assert.equal(routeEntry('json-key').check(L.ctx, res.records).ok, true)
      routeEntry('json-key').undo(L.ctx, res.records)
      assert.deepEqual(L.snap(), L.before)
      assert.equal(fs.existsSync(L.dir), L.dirExisted, 'a library directory trocar made is gone')
    })
  }
}

test('CM18 — the user edited _meta.json (a file that was there before on) during on: off keeps that edit, takes trocar\'s key out, and leaves every other byte as it was', () => {
  const L = lib('darwin', { meta: { appliedId: '', entries: [{ id: 'u1', name: 'mine' }] }, entries: { u1: { inferenceProvider: 'gateway' } } })
  const recs = routeEntry('json-key').write(L.ctx, DOOR).records
  const created = path.join(L.dir, 'trocar-1.json')
  fs.writeFileSync(L.metaFile, JSON.stringify({ ...read(L.metaFile), windowBounds: { w: 900 } }, null, 2) + '\n')
  assert.equal(routeEntry('json-key').undo(L.ctx, recs).ok, true)
  assert.deepEqual(read(L.metaFile), { appliedId: '', entries: [{ id: 'u1', name: 'mine' }], windowBounds: { w: 900 } }, 'the edit stays, the applied id is back at the user\'s value, trocar\'s id is gone')
  assert.ok(!fs.existsSync(created), 'the entry file trocar created is gone')
  assert.deepEqual(read(path.join(L.dir, 'u1.json')), { inferenceProvider: 'gateway' }, 'the user\'s own entry, byte for byte')
})

test('CM18 — the user switched appliedId during on: their choice stays, the created entry (unchanged) goes', () => {
  const L = lib('darwin', { meta: { entries: [] }, entries: { u2: { inferenceProvider: 'gateway' } } })
  const recs = routeEntry('json-key').write(L.ctx, DOOR).records
  const m = read(L.metaFile); m[L.idKey] = 'u2'; fs.writeFileSync(L.metaFile, JSON.stringify(m))
  routeEntry('json-key').undo(L.ctx, recs)
  assert.equal(read(L.metaFile)[L.idKey], 'u2')
  assert.ok(!fs.existsSync(path.join(L.dir, 'trocar-1.json')))
  assert.deepEqual(read(path.join(L.dir, 'u2.json')), { inferenceProvider: 'gateway' })
})

test('CM18 — the user edited the created entry during on: it stays theirs, only trocar\'s key leaves it; the applied id goes back', () => {
  const L = lib('win32', { meta: { entries: [] } })
  const recs = routeEntry('json-key').write(L.ctx, DOOR).records
  const f = path.join(L.dir, 'trocar-1.json')
  fs.writeFileSync(f, JSON.stringify({ ...read(f), chatTabEnabled: true }))
  routeEntry('json-key').undo(L.ctx, recs)
  assert.deepEqual(read(f), { chatTabEnabled: true })
  assert.deepEqual(L.snap()[L.r.select.meta], L.before[L.r.select.meta])
})

test('ruling ③ — the user\'s own egress in the applied entry, a system PAC, a credentialed own leg: not-routed with the reason, nothing written', () => {
  for (const own of ['egressProxyUrl', 'egressProxyPacUrl']) {
    const L = lib('darwin', { meta: { appliedId: 'u1' }, entries: { u1: { [own]: 'http://corp.example:8080' } } })
    const res = routeEntry('json-key').write(L.ctx, DOOR)
    assert.deepEqual([res.code, res.reason, res.at], ['not-routed', 'own-egress', `${path.join(L.dir, 'u1.json')}#${own}`], own)
    assert.deepEqual(L.snap(), L.before, own)
  }
  for (const [systemProxy, reason] of [[{ pac: true }, 'system-pac'], [{ url: 'http://alice:pw@corp.example:8080', bypass: [] }, 'credentialed-own-leg'], [{ url: 'http://corp.example:8080', bypass: [] }, null]]) {
    const L = lib('win32', { systemProxy })
    const res = routeEntry('json-key').write(L.ctx, DOOR)
    if (reason) { assert.deepEqual([res.code, res.reason, fs.existsSync(L.dir)], ['not-routed', reason, false], reason) } else assert.equal(res.ok, true, 'an own leg without credentials is fine')
  }
})

test('P5 · ruling ③ — a door value of trocar\'s in the applied entry (its manifest lost) is not the user\'s egress: on writes, off leaves no door; the user\'s loopback on another port still is', () => {
  for (const own of ['egressProxyUrl', 'egressProxyPacUrl']) for (const [v, isDoor] of [['http://127.0.0.1:18004/trocar.pac', true], ['http://127.0.0.1:18004', true], ['http://127.0.0.1:7890', false]]) {
    const L = lib('darwin', { meta: { appliedId: 'u1' }, entries: { u1: { [own]: v, inferenceProvider: 'gateway' } } })
    put(path.join(L.w.dir, 'ingress.json'), JSON.stringify({ groupPorts: { 'claude-code:a': 18001, 'claude-code:b': 18002, 'claude-code:c': 18004 } }))
    const res = routeEntry('json-key').write(L.ctx, DOOR)
    const label = `${own}=${v}`
    if (!isDoor) { assert.deepEqual([res.code, res.reason], ['not-routed', 'own-egress'], label); continue }
    assert.equal(res.ok, true, label)
    assert.ok(!JSON.stringify(res.records.map((x) => x.prior_value)).includes(':18004'), `${label}: the door is not the prior`)
    routeEntry('json-key').undo(L.ctx, res.records)
    assert.deepEqual(read(path.join(L.dir, 'u1.json')), { inferenceProvider: 'gateway' }, `${label}: off leaves no door`)
  }
})

const KIMI = withArray[0]
for (const [why, start, expectRecord] of [['the array absent', { 'http.proxy': 'http://mine:1' }, true], ['the array present', { 'settingsSync.ignoredSettings': ['editor.fontSize'] }, true], ['the array already holding the item', { 'settingsSync.ignoredSettings': ['http.proxy'] }, false], ['no file', null, true]]) {
  test(`arrayItems — ${why}: the element is added once (recorded as json-array-item${expectRecord ? '' : ': here nothing to add'}); off restores the bytes`, () => {
    const w = world({ os: 'win32' })
    const ctx = { ...w.ctx, harness: KIMI.h.name, route: KIMI.r, routeId: KIMI.id }
    const file = resolveLoc(KIMI.r.file, ctx)[0]
    const before = start ? Buffer.from(json(start, '\r\n')) : null
    if (before) put(file, before)
    const res = routeEntry('json-key').write(ctx, DOOR)
    const a = KIMI.r.arrayItems[0]
    assert.deepEqual(read(file)[a.keys[0]].filter((x) => x === a.value), [a.value])
    assert.equal(res.records.some((x) => x.kind === 'json-array-item'), expectRecord)
    routeEntry('json-key').undo(ctx, res.records)
    assert.deepEqual(bytesOf(file), before)
  })
}

test('arrayItems — the user removed trocar\'s element during on: off leaves the array as the user left it and still restores the proxy key', () => {
  const w = world({ os: 'darwin' })
  const ctx = { ...w.ctx, harness: KIMI.h.name, route: KIMI.r, routeId: KIMI.id }
  const file = resolveLoc(KIMI.r.file, ctx)[0]
  put(file, json({ 'settingsSync.ignoredSettings': ['a'] }, '\n'))
  const recs = routeEntry('json-key').write(ctx, DOOR).records
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(',\n    "http.proxy"', ''))
  assert.equal(routeEntry('json-key').undo(ctx, recs).ok, true)
  assert.deepEqual(read(file), { 'settingsSync.ignoredSettings': ['a'] })
})

test('P6 mergeNoProxy: loopback first, then the user\'s values (both spellings), then the persistent env; deduped without case, order kept', () => {
  assert.equal(mergeNoProxy({}), 'localhost,127.0.0.1,::1')
  assert.equal(mergeNoProxy({ userValues: ['*.corp, LOCALHOST', undefined, '.corp.example,*.CORP'], persistent: { NO_PROXY: '.internal,::1' } }), 'localhost,127.0.0.1,::1,*.corp,.corp.example,.internal')
  assert.equal(mergeNoProxy({ userValues: [], persistent: ['10.0.0.0/8'] }), 'localhost,127.0.0.1,::1,10.0.0.0/8')
})

// a record's tag, held clear or as its fingerprint
const tagOf = (r) => r.door_sha256 ?? sha256(r.door)
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex')

// P10 · invariant 5: a PAC address trocar wrote before (an earlier key, or the address an earlier version wrote, with no key) is trocar's own stale
// value, not the user's egress: on writes the current address over it. An address of the user's own still stops it (own-egress)
for (const os of ['darwin', 'win32']) test(`P10 ${os} — on over trocar's own earlier PAC address (another key, or none) writes the keyed one; over the user's own it stops`, () => {
  const L = lib(os, { meta: { appliedId: 'u1', entries: [{ id: 'u1', name: 'mine' }] }, entries: { u1: { inferenceProvider: 'gateway' } } })
  const f = path.join(L.dir, 'u1.json')
  assert.equal(routeEntry('json-key').write(L.ctx, DOOR).ok, true)
  const KEY2 = 'cd'.repeat(16), PAC2 = `${DOOR}${pacPath(KEY2)}`
  const again = routeEntry('json-key').write({ ...L.ctx, pacToken: KEY2 }, DOOR)
  assert.equal(again.ok, true, `a new key over trocar's recorded address: ${JSON.stringify(again)}`)
  assert.equal(read(f)[L.key], PAC2)
  assert.ok(L.w.ctx.manifest.entries.some((e) => tagOf(e) === sha256(PAC2)), 'the record names the address it wrote, so the next key change is seen')
  routeEntry('json-key').undo(L.ctx, L.w.ctx.manifest.entries.filter((e) => e.harness === L.ctx.harness))
  assert.equal(read(f)[L.key], undefined)
  // the record an earlier version wrote: the address with no key in it, tagged with the door (what its on wrote). Its tag is not the address on
  // writes now: undone (the entry still holds that value), and the keyed address written
  const old = applyJsonKey({ dir: L.w.ctx.dir, manifest: L.w.ctx.manifest, harness: L.ctx.harness, phase: 'on', home: L.w.ctx.home, fs, file: f, keys: L.r.proxyKeys[0], value: `${DOOR}/trocar.pac` })
  Object.assign(old, { route: L.ctx.routeId, door: DOOR })
  assert.equal(routeEntry('json-key').write({ ...L.ctx, pacToken: KEY2 }, DOOR).ok, true)
  assert.equal(read(f)[L.key], PAC2)
  assert.deepEqual(L.w.ctx.manifest.entries.filter((e) => e.harness === L.ctx.harness).map(tagOf), [sha256(PAC2)], 'one record, naming the keyed address')
  // a value put there by hand, whatever it looks like (an address of trocar's door, or another): it differs from what the record says was written, so it
  // is the user's change — kept and refused with that reason, never taken for the user's egress
  for (const hand of [`${DOOR}/trocar.pac`, 'http://proxy.corp.example/proxy.pac']) {
    fs.writeFileSync(f, JSON.stringify({ ...read(f), [L.key]: hand }, null, 2) + '\n')
    let refused = null
    try { const r = routeEntry('json-key').write({ ...L.ctx, pacToken: KEY2 }, DOOR); refused = r.ok ? null : r } catch (e) { refused = e }
    assert.ok(refused && !/own-egress/.test(JSON.stringify(refused.reason ?? refused.message)), `${hand}: kept, with the reason a changed value gets: ${refused && (refused.reason || refused.message)}`)
    assert.equal(read(f)[L.key], hand, 'kept')
  }
  // the user's own PAC address in an entry trocar holds no record of: their egress, nothing written
  const U = lib(os, { meta: { appliedId: 'u1', entries: [{ id: 'u1', name: 'mine' }] }, entries: { u1: { [L.key]: 'http://proxy.corp.example/proxy.pac' } } })
  const r = routeEntry('json-key').write(U.ctx, DOOR)
  assert.deepEqual([r.code, r.reason], ['not-routed', 'own-egress'])
  assert.deepEqual(U.snap(), U.before)
})

// invariant 5 · the ruling: a record whose tag is not the address on writes now is trocar's stale value only while the entry still holds what it wrote.
// A value the user put there after trocar did is kept and refused with that reason, whether trocar created the entry or found it applied — never
// undone with the rest, never answered with a new entry made applied over it, never called the user's egress
for (const os of ['darwin', 'win32']) for (const [kind, meta, entries] of [['an entry trocar created', undefined, {}], ['an applied entry', { appliedId: 'u1', entries: [{ id: 'u1', name: 'mine' }] }, { u1: { inferenceProvider: 'gateway' } }]]) {
  test(`P10 ${os} — ${kind}, its value changed by hand, then a new key: kept, refused as the user's change, nothing else moved`, () => {
    const L = lib(os, { meta, entries })
    assert.equal(routeEntry('json-key').write(L.ctx, DOOR).ok, true)
    const rec = L.w.ctx.manifest.entries.find((e) => e.harness === L.ctx.harness && e.keys.join('.') === L.key)
    const f = rec.path, hand = 'http://proxy.corp.example/proxy.pac'
    fs.writeFileSync(f, JSON.stringify({ ...read(f), [L.key]: hand }, null, 2) + '\n')
    const before = L.snap()
    let refused = null
    try { const r = routeEntry('json-key').write({ ...L.ctx, pacToken: 'cd'.repeat(16) }, DOOR); refused = r.ok ? null : r } catch (e) { refused = e }
    assert.ok(refused && !/own-egress/.test(JSON.stringify(refused.reason ?? refused.message)), `refused as the user's change: ${refused && (refused.reason || refused.message)}`)
    assert.deepEqual(L.snap(), before, 'the entry, _meta.json and the directory as they were: no entry made applied over the user\'s')
  })
}
