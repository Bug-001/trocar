// test/off/fidelity.test.mjs — the user's file, byte for byte, along the shape generator's axes (spec 0.1 G2, 4.6「文件的编码」, plan file-fidelity
// §2.10 I1–I7). Every case is a seeded shape from test/helpers/file-shapes.mjs (a failure names its id and seed); expectations come from that
// generator's own decoder and readers, never from src/. The formats here are the text entries: a dotenv block, a YAML-list row, an rc line.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpDir } from '../helpers/tmp.mjs'
import { shapeCases, decodeBytes, encodeText as shapeEncode, eolOf as shapeEol } from '../helpers/file-shapes.mjs'
import { applyTextEntry, undoEntry, newManifest, readManifest } from '../../src/collector/core/trust/journal.mjs'
import { undoHarnesses } from '../../src/off/undo.mjs'
import { planByMarker, undoByMarker } from '../../src/off/marker.mjs'
import { lineComment } from '../../src/off/text-edit.mjs'

const FORMATS = { dotenv: '.codex/.env', 'yaml-list': '.dsh/cordis.patch.yml', rc: '.zshrc' }
const editFor = (format, home) => format === 'dotenv' ? { format: 'dotenv-block', vars: { SSL_CERT_FILE: `${home}/.asight/collector/ca/combined-codex.pem` }, quote: true }
  : format === 'yaml-list' ? { format: 'yaml-list', line: `- insert: [{ name: "${home}/.asight/collector/plugins/dsh/index.js" }] ${lineComment('dsh plugin')}` }
    : { format: 'line', line: `export PATH="${home}/.asight/collector/bin:$PATH" ${lineComment('kimi shim')}` }
const BUDGET = 60
const cases = (format, keep = () => true) => shapeCases({ format, budget: BUDGET }).filter((c) => c.determinable && keep(c))
const tag = (c) => `${c.id} seed=${c.seed} ${c.describe}`

function sandbox(c) {
  const root = tmpDir('asight-fid-')
  const file = path.join(root, FORMATS[c.format])
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, c.bytes, { mode: 0o600 })
  return { root, dir: path.join(root, '.asight', 'collector'), file }
}
function on(c, b, manifest = newManifest()) {
  const e = applyTextEntry({ phase: 'on', home: b.root, dir: b.dir, manifest, harness: 'h', file: b.file, edit: editFor(c.format, c.home) })
  return { e, manifest }
}

// The file the user saved again after `on`, in a form that proves no encoding: one per `why` of the closed set, built from the text asight left.
const MARKS = { utf8: [0xef, 0xbb, 0xbf], utf16le: [0xff, 0xfe], utf16be: [0xfe, 0xff] }
const utf32le = (t) => { const cps = [...t].map((x) => x.codePointAt(0)); const b = Buffer.alloc(4 * cps.length); cps.forEach((x, i) => b.writeUInt32LE(x, 4 * i)); return b }
const RESAVED = {
  'not-utf8-no-bom': (t) => Buffer.concat([shapeEncode(t, 'utf8', false), Buffer.from([0xd6, 0x41, 0x0a])]),
  'invalid-utf8-after-bom': (t) => Buffer.concat([Buffer.from(MARKS.utf8), shapeEncode(t, 'utf8', false), Buffer.from([0xd6, 0x41])]),
  'nul-in-text': (t) => shapeEncode(t, 'utf16le', false),
  utf32: (t) => Buffer.concat([Buffer.from([0xff, 0xfe, 0, 0]), utf32le(t)]),
  'odd-length': (t) => Buffer.concat([shapeEncode(t, 'utf16le', true), Buffer.from([0x41])]),
  'invalid-utf16': (t) => Buffer.concat([shapeEncode(t, 'utf16be', true), Buffer.from([0xdc, 0x00])]),
}
const textOf = (bytes) => { const d = decodeBytes(bytes); assert.ok(!d.why, `asight left bytes the generator cannot read: ${d.why}`); return d.text }

for (const format of Object.keys(FORMATS)) {
  test(`fidelity ${format}: I3 on keeps the file's form (charset, mark) and writes its line ending; I7 on twice is on once; I1 off of an untouched file is byte for byte`, () => {
    for (const c of cases(format)) {
      const b = sandbox(c)
      const { e, manifest } = on(c, b)
      const after = fs.readFileSync(b.file)
      const d = decodeBytes(after)
      assert.ok(!d.why, `${tag(c)}: asight left bytes that prove no form (${d.why})`)
      assert.deepEqual([d.charset, d.bom], [c.charset, c.bom], `I3 the form stays: ${tag(c)}`)
      assert.equal(e.charset, c.charset === 'utf8' ? undefined : c.charset, `the entry records a charset only when it is not utf8: ${tag(c)}`)
      const eol = shapeEol(c.text)
      for (const op of e.ops) for (const m of op.inserted.matchAll(/\r?\n/g)) assert.equal(m[0], eol, `I3 asight's lines end as the file's do (${JSON.stringify(eol)}): ${tag(c)}`)
      assert.equal(on(c, b, manifest).e, null, `I7 a second on writes nothing: ${tag(c)}`)
      assert.ok(fs.readFileSync(b.file).equals(after), `I7 on; on is on: ${tag(c)}`)
      assert.equal(undoEntry(e).result, 'restored', `I1: ${tag(c)}`)
      assert.ok(fs.readFileSync(b.file).equals(c.bytes), `I1 byte for byte: ${tag(c)}`)
    }
  })

  test(`fidelity ${format}: I4 a file whose bytes prove no encoding is refused before anything is written (entry-refused, its why, its path); no manifest, no backup`, () => {
    for (const c of shapeCases({ format, budget: BUDGET }).filter((x) => !x.determinable)) {
      const b = sandbox(c)
      assert.throws(() => on(c, b), (err) => err.code === 'entry-refused' && err.why === decodeBytes(c.bytes).why && err.path === b.file && err.message.includes(err.why), tag(c))
      assert.ok(fs.readFileSync(b.file).equals(c.bytes), `not a byte written: ${tag(c)}`)
      assert.equal(readManifest(b.dir), null, `nothing recorded: ${tag(c)}`)
      assert.equal(fs.existsSync(path.join(b.root, '.asight', 'backup')), false, tag(c))
    }
  })

  test(`fidelity ${format}: the user saves the file in a form that proves no encoding after on → a second on is refused (entry-refused, that why, the path), not a byte written, the manifest as it was`, () => {
    const whys = Object.keys(RESAVED)
    for (const [i, c] of cases(format).entries()) {
      const b = sandbox(c)
      const { manifest } = on(c, b)
      const resaved = RESAVED[whys[i % whys.length]](textOf(fs.readFileSync(b.file)))
      fs.writeFileSync(b.file, resaved)
      const kept = JSON.stringify(readManifest(b.dir))
      assert.throws(() => on(c, b, manifest), (err) => err.code === 'entry-refused' && err.why === decodeBytes(resaved).why && err.path === b.file && err.message.includes(err.why), tag(c))
      assert.ok(fs.readFileSync(b.file).equals(resaved), `not a byte written: ${tag(c)}`)
      assert.equal(JSON.stringify(readManifest(b.dir)), kept, `the manifest is as it was: ${tag(c)}`)
    }
  })

  test(`fidelity ${format}: the user saves the file in a form that proves no encoding after on → off leaves it (left-unreadable, why from the closed set), not a byte changes, the entry stays in the manifest`, async () => {
    const whys = Object.keys(RESAVED)
    for (const [i, c] of cases(format).entries()) {
      const b = sandbox(c)
      const { e } = on(c, b)
      const resaved = RESAVED[whys[i % whys.length]](textOf(fs.readFileSync(b.file)))
      fs.writeFileSync(b.file, resaved)
      const r = undoEntry(e)
      assert.equal(r.result, 'left-unreadable', tag(c))
      assert.equal(r.why, decodeBytes(resaved).why, tag(c))
      assert.ok(r.reason.includes(b.file) && r.reason.includes(r.why), `the reason names the file and why: ${r.reason}`)
      assert.ok(fs.readFileSync(b.file).equals(resaved), `not a byte written: ${tag(c)}`)
      if (i % 5 === 0) { // through `off`'s undo of the whole manifest: the entry is left in it, with a failure the receipt shows
        const out = await undoHarnesses({ dir: b.dir, home: b.root, manifest: readManifest(b.dir), procs: async () => [] })
        assert.ok(out.left.some((l) => l.result === 'left-unreadable' && l.path === b.file), tag(c))
        assert.equal(readManifest(b.dir).entries.length, 1, `the entry stays: ${tag(c)}`)
        assert.ok(fs.readFileSync(b.file).equals(resaved), tag(c))
      }
    }
  })
}

test('fidelity marker: with no manifest, a marked file whose bytes prove no encoding is left (left-unreadable) and named; a clean one is not planned', () => {
  const c = cases('dotenv', (x) => x.charset === 'utf16be')[0]
  const b = sandbox(c)
  on(c, b)
  const resaved = RESAVED['nul-in-text'](textOf(fs.readFileSync(b.file)))
  fs.writeFileSync(b.file, resaved)
  const plan = planByMarker({ home: b.root, ids: ['codex'] })
  assert.equal(plan.length, 1, 'the mark is found in the bytes even though they are not text asight may write')
  const [r] = undoByMarker(plan, { home: b.root })
  assert.equal(r.result, 'left-unreadable')
  assert.ok(fs.readFileSync(b.file).equals(resaved))
  fs.writeFileSync(b.file, Buffer.from([0xd6, 0x41, 0x0a]))
  assert.deepEqual(planByMarker({ home: b.root, ids: ['codex'] }), [], 'no mark in it: nothing to undo')
})

// The undo now decodes by the entry's `charset` (above): a copy of asight-off written before that would write a UTF-16 file back as UTF-8, so the
// version doctor compares moves past it (plan §E.5 #1: T10 bumps OFF_VERSION once; the manifest's own version stays HEAD's v3).
test('fidelity: OFF_VERSION is 12 — the copy that undoes by `charset` is told apart from 11, which decoded every file as UTF-8; the manifest stays version 3', async () => {
  const { OFF_VERSION, MANIFEST_VERSION } = await import('../../src/off/manifest.mjs')
  assert.equal(OFF_VERSION, 12); assert.equal(MANIFEST_VERSION, 3)
})
