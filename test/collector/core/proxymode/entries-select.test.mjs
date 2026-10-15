// entries-select.test.mjs — the json-key route's two data fields (spec 4.11 P5, CM18): `select` (the entry a meta file names: Claude Desktop's config
// library) on every axis — an applied entry / none / an applied id naming no file / the user switching appliedId during on / the user editing the created
// entry / the user's own egress in the entry — with the meta file restored byte for byte; ruling ③'s PAC not-routed checks; `arrayItems` with the array
// present / absent / already holding the item / the item removed by the user during on; and P6 mergeNoProxy.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { loadHarnesses } from '../../../../src/collector/harness/index.mjs'
import { routeEntry, mergeNoProxy } from '../../../../src/collector/core/proxymode/entries.mjs'
import { resolveLoc } from '../../../../src/collector/core/proxymode/sources.mjs'
import { encodeText, decodeBytes } from '../../../helpers/file-shapes.mjs'
import { world, put, bytesOf } from './fixtures/entries-ctx.mjs'

const harnesses = await loadHarnesses()
const withSelect = harnesses.flatMap((h) => Object.entries(h.proxyMode.routes).filter(([, r]) => r.select).map(([id, r]) => ({ h, id, r })))
const withArray = harnesses.flatMap((h) => Object.entries(h.proxyMode.routes).filter(([, r]) => r.arrayItems).map(([id, r]) => ({ h, id, r })))
const DOOR = 'http://127.0.0.1:18002' // a PAC door takes no credentials
const PAC = `${DOOR}/asight.pac`
const SHAPES = [['utf8', false, '\n'], ['utf8', true, '\r\n'], ['utf16le', true, '\n']]
const json = (o, eol) => JSON.stringify(o, null, 2).replace(/\n/g, eol) + eol
const read = (f) => JSON.parse(decodeBytes(fs.readFileSync(f)).text)

function lib(os, { meta = undefined, entries = {}, shape = SHAPES[0], ...opts } = {}) {
  const w = world({ os, ...opts })
  const { h, id, r } = withSelect[0]
  const ctx = { ...w.ctx, harness: h.name, route: r, routeId: id }
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
      assert.deepEqual(read(path.join(L.dir, 'asight-1.json')), { [L.key]: PAC })
      assert.equal(read(L.metaFile)[L.idKey], 'asight-1')
      assert.deepEqual(res.records.map((x) => [x.kind, x.role || x.keys.join('.')]), [['json-key', L.key], ['json-key', L.idKey], ['owned-file', 'config-entry']])
      assert.equal(routeEntry('json-key').check(L.ctx, res.records).ok, true)
      routeEntry('json-key').undo(L.ctx, res.records)
      assert.deepEqual(L.snap(), L.before)
      assert.equal(fs.existsSync(L.dir), L.dirExisted, 'a library directory asight made is gone')
    })
  }
}

test('CM18 — the user switched appliedId during on: their choice stays, the created entry (unchanged) goes', () => {
  const L = lib('darwin', { meta: { entries: [] }, entries: { u2: { inferenceProvider: 'gateway' } } })
  const recs = routeEntry('json-key').write(L.ctx, DOOR).records
  const m = read(L.metaFile); m[L.idKey] = 'u2'; fs.writeFileSync(L.metaFile, JSON.stringify(m))
  routeEntry('json-key').undo(L.ctx, recs)
  assert.equal(read(L.metaFile)[L.idKey], 'u2')
  assert.ok(!fs.existsSync(path.join(L.dir, 'asight-1.json')))
  assert.deepEqual(read(path.join(L.dir, 'u2.json')), { inferenceProvider: 'gateway' })
})

test('CM18 — the user edited the created entry during on: it stays theirs, only asight\'s key leaves it; the applied id goes back', () => {
  const L = lib('win32', { meta: { entries: [] } })
  const recs = routeEntry('json-key').write(L.ctx, DOOR).records
  const f = path.join(L.dir, 'asight-1.json')
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

test('arrayItems — the user removed asight\'s element during on: off leaves the array as the user left it and still restores the proxy key', () => {
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
