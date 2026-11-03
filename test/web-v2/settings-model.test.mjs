// settings-model.test.mjs — 1.11 §验收 for the settings screens' pure models (storage-model.mjs, theme.mjs, prices.mjs): the 磁盘
// card and the 保存什么 card as data, the theme preference, the unpriced models and the paste template. Documents are constructed
// C.5 `classes` / `segments` shapes (the ones src/query/named/{segments,classes}.mjs write); expected values come from the
// documents themselves and the shared catalogs.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import * as M from '../../web/src/screens/settings/storage-model.mjs'
import { setTheme, themeChoice } from '../../web/src/screens/settings/theme.mjs'
import { THEME_KEY } from '../../web/legacy/core/ui.mjs'
import { CLASS_IDS, CLASS_DESC, FALLBACK_CLASS } from '../../web/legacy/core/classes.mjs'
import { unpricedModels, templateText } from '../../web/legacy/settings/prices.mjs'
import { priceMatch } from '../../web/legacy/core/metrics.mjs'
import { loadPricing } from '../../src/view/pricing.mjs'
import { tmpDir } from '../helpers/tmp.mjs'

const SEG = '20260719T100000Z'
const WINDOWS = ['24h', '7d', 'all']
const KEYS = { '24h': 'h24', '7d': 'd7', all: 'all' }
// seven classes, `other` without rules; counts(id, i, key) per window key (undefined = the class has no counts for it)
const classesDoc = (counts = (id, i, k) => ({ calls: i + (k === 'all' ? 10 : 0), bytes: (i + 1) * (k === 'h24' ? 100 : 300) }), extra = {}) => ({
  disk: { trocar_bytes: 1e6 }, as_of: null, file: null, errors: [],
  classes: CLASS_IDS.map((id, i) => ({ class: id, keep: i % 2 ? 'log' : 'full', builtin: true,
    rules: id === FALLBACK_CLASS ? [] : [{ host: `h${i}.example.test`, ...(i % 2 ? { path: `/p${i}` } : {}), ...(i === 2 ? { harness: 'codex' } : {}) }],
    counts: Object.fromEntries(Object.values(KEYS).map((k) => [k, counts(id, i, k)]).filter(([, v]) => v)) })),
  ...extra })
const probDocs = (probs) => {
  const errors = probs.map((p) => ({ where: `segments/${SEG}`, code: p.code, ...(p.level ? { level: p.level } : {}), reason: p.reason }))
  return { segments: { segments: [{ segment: SEG, problems: probs }], errors }, classes: classesDoc(undefined, { errors }) }
}
const codes = (m) => m.card.notes.map((n) => n.code)
const CONTROL = { ok: true, data: { control: true } }
const NOTE_CODES = ['later', 'as-of', 'no-calls', 'partial', 'read-only', 'file-bad', 'file-some']

test('#1 #15 each window: one row per classes[] entry with that window\'s counts, the total is their sum, the level does not move; changes apply later', () => {
  const docs = { classes: classesDoc(), segments: null }
  const keeps = new Map()
  for (const w of WINDOWS) {
    const m = M.storageModel(docs, w, { control: CONTROL })
    assert.deepEqual(m.card.rows.map((r) => r.id).sort(), [...CLASS_IDS].sort(), w)
    for (const c of docs.classes.classes) {
      const r = m.card.rows.find((x) => x.id === c.class)
      assert.equal(r.calls, c.counts[KEYS[w]].calls); assert.equal(r.bytes, c.counts[KEYS[w]].bytes)
      if (keeps.has(c.class)) assert.equal(r.keep, keeps.get(c.class), `${c.class} ${w}`)
      keeps.set(c.class, r.keep)
    }
    const k = KEYS[w], cs = docs.classes.classes
    assert.deepEqual(m.card.total, { calls: cs.reduce((s, c) => s + c.counts[k].calls, 0), bytes: cs.reduce((s, c) => s + c.counts[k].bytes, 0) })
    assert.ok(codes(m).every((c) => NOTE_CODES.includes(c)), codes(m).join())
  }
  const fatal = classesDoc(undefined, { errors: [{ where: 'classes.json', reason: 'not JSON', fatal: true }] })
  const partial = probDocs([{ code: 'record-unparseable', reason: 'line 3 is not JSON' }])
  for (const d of [docs, { classes: fatal, segments: null }, partial]) assert.ok(codes(M.storageModel(d, '24h', { control: CONTROL })).includes('later'))
  assert.equal(M.winOf({ window: 'bogus' }), '24h')
  assert.equal(M.winOf({}), '24h')
  for (const w of WINDOWS) assert.equal(M.winOf({ window: w }), w)
})

test('#3 a class without counts for the window → its calls / bytes, the total and the shares are unknown; a missing h24 → no per-day figure (never 0)', () => {
  const d = classesDoc((id, i, k) => (id === 'files' && k === 'd7' ? undefined : { calls: i, bytes: i * 100 }))
  const m = M.storageModel({ classes: d, segments: null }, '7d', {})
  const files = m.card.rows.find((r) => r.id === 'files')
  assert.equal(files.calls, null); assert.equal(files.bytes, null)
  assert.deepEqual(m.card.total, { calls: null, bytes: null })
  assert.ok(m.card.rows.every((r) => r.share === null))
  const noDay = classesDoc((id, i, k) => (id === 'llm' && k === 'h24' ? undefined : { calls: 1, bytes: 1 }))
  assert.equal(M.storageModel({ classes: noDay, segments: null }, '24h', {}).disk.perDay, null)
  assert.equal(M.storageModel({ classes: classesDoc(), segments: null }, '24h', {}).disk.perDay,
    classesDoc().classes.reduce((s, c) => s + c.counts.h24.bytes, 0))
})

test('#7 #11 a level can be edited only when the control plane is mounted and the settings file reads as a whole; each in-table row carries its one command', () => {
  const d = classesDoc()
  const at = (control, doc = d) => M.storageModel({ classes: doc, segments: null }, '24h', { control })
  assert.equal(at(CONTROL).card.editable, true)
  const root = at({ ok: true, data: { control: false, root: true } })
  assert.equal(root.card.editable, false); assert.ok(codes(root).includes('read-only'))
  assert.equal(at({ ok: true, data: { control: false } }).card.editable, false)
  assert.equal(at({ ok: false, status: 0 }).card.editable, false)
  assert.equal(at(null).card.editable, false)
  const fatal = at(CONTROL, classesDoc(undefined, { errors: [{ where: 'classes.json', reason: 'not JSON', fatal: true }] }))
  assert.equal(fatal.card.editable, false); assert.ok(codes(fatal).includes('file-bad')); assert.ok(!codes(fatal).includes('file-some'))
  const some = at(CONTROL, classesDoc(undefined, { errors: [{ where: 'classes.json', reason: 'unknown class "x"' }] }))
  assert.equal(some.card.editable, true); assert.ok(codes(some).includes('file-some')); assert.ok(!codes(some).includes('file-bad'))
  const m = at(CONTROL)
  for (const r of m.card.rows.filter((x) => x.inTable)) {
    const cmd = M.cmdFor(r.id, M.other(r.keep))
    assert.equal(r.cmd, cmd)
    assert.equal(m.card.tech.filter(([, v]) => v === cmd).length, 1, r.id)
  }
})

test('#13 note-level problems are no read problem but make the page slow; a real one counts once; each segment problem is listed once, in the disk files only', () => {
  const note = (k) => ({ code: 'index-cold', reason: `built the index while reading ${k}`, level: 'note' })
  const real = { code: 'record-unparseable', reason: 'line 3 is not JSON' }
  const allNote = M.storageModel(probDocs([note(1), note(2)]), '24h', {})
  assert.equal(allNote.disk.bad, 0); assert.ok(!codes(allNote).includes('partial')); assert.equal(allNote.disk.slow, true)
  const mixed = M.storageModel(probDocs([note(1), real]), '24h', {})
  assert.equal(mixed.disk.bad, 1); assert.ok(codes(mixed).includes('partial'))
  assert.equal(M.storageModel(probDocs([real]), '24h', {}).disk.slow, false)
  const probs = [note(1), real, { ...real, reason: 'line 9 is not JSON' }]
  const m = M.storageModel(probDocs(probs), '24h', {})
  for (const p of probs) {
    const said = (pairs) => pairs.filter(([, v]) => String(v).includes(p.reason)).length
    assert.equal(said(m.disk.files), 1, p.reason)
    assert.equal(said(m.card.tech), 0, p.reason)
  }
  const fail = M.storageModel({ ...probDocs([]), segments: null, segmentsFail: { status: 0, error: 'ECONNRESET' } }, '24h', {})
  assert.deepEqual(fail.disk.segFail.pairs, [['status', '0'], ['error', 'ECONNRESET']])
  assert.equal(M.storageModel(probDocs([]), '24h', {}).disk.segFail, null)
})

test('#14 the last change carries the document\'s class, level and source; none → null', () => {
  const lc = { ts: '2026-10-20T09:00:00Z', class: 'telemetry', from: { keep: 'full' }, to: { keep: 'log' }, source: 'cli' }
  const last = M.storageModel({ classes: classesDoc(undefined, { last_change: lc }), segments: null }, '24h', {}).card.last
  assert.equal(last.cls, lc.class); assert.equal(last.keep, lc.to.keep); assert.equal(last.source, lc.source); assert.equal(last.ts, lc.ts)
  assert.equal(M.storageModel({ classes: classesDoc(), segments: null }, '24h', {}).card.last, null)
})

test('#27 #6 each row says what its class is and its share of the window total (total 0 → none); rules as host path (harness); `other` falls back; technical keys are unique', () => {
  const d = classesDoc()
  const m = M.storageModel({ classes: d, segments: null }, '7d', {})
  const T = d.classes.reduce((s, c) => s + c.counts.d7.bytes, 0)
  for (const c of d.classes) {
    const r = m.card.rows.find((x) => x.id === c.class)
    assert.equal(r.pop.desc, CLASS_DESC[c.class])
    assert.equal(r.pop.href, `#/traffic?${new URLSearchParams({ class: c.class, window: '7d' })}`)
    assert.equal(r.share, Math.round(c.counts.d7.bytes / T * 100))
    assert.deepEqual(r.rules, c.rules.map((x) => (x.path ? `${x.host} ${x.path}` : x.host) + (x.harness ? ` (${x.harness})` : '')))
  }
  assert.equal(m.card.rows.find((r) => r.id === FALLBACK_CLASS).fallback, true)
  assert.ok(m.card.rows.filter((r) => r.id !== FALLBACK_CLASS).every((r) => !r.fallback))
  const keys = m.card.tech.map(([k]) => k).filter(Boolean)
  assert.equal(new Set(keys).size, keys.length, keys.join(' | '))
  const zero = M.storageModel({ classes: classesDoc(() => ({ calls: 0, bytes: 0 })), segments: null }, '24h', {})
  assert.ok(zero.card.rows.every((r) => r.share === null))
  const none = M.storageModel({ classes: { ...d, classes: [...d.classes, { class: null, keep: 'full', counts: { h24: { calls: 1, bytes: 1 } } }] }, segments: null }, '24h', {})
  const nul = none.card.rows.find((r) => r.id == null)
  assert.equal(nul.pop, null); assert.equal(nul.inTable, false)
  assert.equal(new Set(none.card.rows.map((r) => r.key)).size, none.card.rows.length)
})

test('#19 setTheme pins light / dark and stores the key, system removes both; a throwing store still switches the page; themeChoice reads the attribute', () => {
  const fakeDoc = (store) => {
    const attrs = new Map()
    return { attrs, localStorage: store, documentElement: {
      setAttribute: (k, v) => attrs.set(k, v), removeAttribute: (k) => attrs.delete(k), getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null) } }
  }
  const mapStore = () => { const m = new Map(); return { m, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k), getItem: (k) => m.get(k) ?? null } }
  for (const t of ['light', 'dark']) {
    const s = mapStore(), doc = fakeDoc(s)
    assert.deepEqual(setTheme(t, doc), { stored: true })
    assert.equal(doc.attrs.get('data-theme'), t); assert.equal(s.m.get(THEME_KEY), t)
    assert.equal(themeChoice(doc), t)
    assert.deepEqual(setTheme('system', doc), { stored: true })
    assert.equal(doc.attrs.has('data-theme'), false); assert.equal(s.m.has(THEME_KEY), false)
    assert.equal(themeChoice(doc), 'system')
  }
  const boom = () => { throw new Error('blocked') }
  const doc = fakeDoc({ setItem: boom, removeItem: boom, getItem: boom })
  assert.deepEqual(setTheme('dark', doc), { stored: false })
  assert.equal(doc.attrs.get('data-theme'), 'dark')
  doc.attrs.set('data-theme', 'sepia')
  assert.equal(themeChoice(doc), 'system')
})

test('#17 unpriced models: priceMatch null with usable calls; at least N = the max sessions over that model\'s rows', () => {
  const table = { opus: [1, 2, 3, 4] }
  const got = unpricedModels([
    { model: 'glm-x', calls: 5, failed: 0, no_usage: 0, sessions: 2 },
    { model: 'glm-x', calls: 3, failed: 0, no_usage: 0, sessions: 4 },
    { model: 'zz-dead', calls: 2, failed: 1, no_usage: 1, sessions: 9 },
    { model: 'claude-opus-4', calls: 9, failed: 0, no_usage: 0, sessions: 7 },
  ], table)
  assert.deepEqual(got, [{ model: 'glm-x', sessions: 4 }])
})

test('#18 the template: a member of the file when it exists, a whole file when not; pasted verbatim the model stays unpriced (no $0)', () => {
  const model = 'glm-4.6'
  const member = templateText(model, '/somewhere/pricing.json')
  assert.ok(!/,\s*$/.test(member))
  assert.deepEqual(JSON.parse(`{${member}}`), { [model]: [null, null, null, null] })
  const whole = templateText(model, 'default')
  assert.deepEqual(JSON.parse(whole), { [model]: [null, null, null, null] })
  const f = path.join(tmpDir('trocar-price-'), 'pricing.json')
  fs.writeFileSync(f, whole)
  const t = loadPricing(f)
  assert.equal(Object.prototype.hasOwnProperty.call(t, model), false)
  assert.equal(priceMatch(t, model), null)
})

