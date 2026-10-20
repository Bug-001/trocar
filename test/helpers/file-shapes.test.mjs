// test/helpers/file-shapes.test.mjs — the shape generator's own proof that its axis labels are true (plan 2.10, spec 0.1 G2/G4).
// Every expectation here comes from Node's own decoders (TextDecoder fatal + ignoreBOM, Buffer) or from the encoding table
// in spec 4.6 「文件的编码」, never from the generator's decoder: a shape labelled determinable that Node cannot round-trip,
// or one labelled undeterminable that a strict read accepts without NUL, is a red test naming the case id and seed.
import test from 'node:test'
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { shapeCases, axes, seeds, readDotenv, readJsonc, readYamlList, inFamily, userEdits } from './file-shapes.mjs'

const SEED = Number(process.env.TROCAR_SHAPES_SEED) || 0x5eed
const FORMATS = ['dotenv', 'json', 'yaml-list', 'rc']
const at = (c) => `${c.id} seed=${c.seed} (${c.describe})`
const LABEL = { utf8: 'utf-8', utf16le: 'utf-16le', utf16be: 'utf-16be' }
const BOM_CHAR = String.fromCodePoint(0xfeff)

/** Node's view of a determinable shape: decode with the declared charset, re-encode with Buffer; null when it holds. */
function roundTripProblem(c) {
  let s
  try { s = new TextDecoder(LABEL[c.charset], { fatal: true, ignoreBOM: true }).decode(c.bytes) } catch (e) { return `Node rejects it as ${c.charset}: ${e.code}` }
  if (s !== (c.bom ? BOM_CHAR : '') + c.text) return 'decoded text differs from the declared text'
  if (s.includes('\0')) return 'decoded text holds NUL'
  const le = Buffer.from(s, 'utf16le')
  const back = c.charset === 'utf8' ? Buffer.from(s, 'utf8') : c.charset === 'utf16le' ? le : Buffer.from(le).swap16()
  return back.equals(c.bytes) ? null : 'Buffer re-encoding is not byte-identical'
}

// spec 4.6 「文件的编码」: the BOM picks the reading, no BOM means strict UTF-8; UTF-32 is recognised and never edited.
const starts = (b, p) => p.every((x, i) => b[i] === x)
function strictReadProblem(bytes) {
  if (starts(bytes, [0xff, 0xfe, 0, 0]) || starts(bytes, [0, 0, 0xfe, 0xff])) return 'utf32'
  const [label, skip] = starts(bytes, [0xef, 0xbb, 0xbf]) ? ['utf-8', 3] : starts(bytes, [0xff, 0xfe]) ? ['utf-16le', 2] : starts(bytes, [0xfe, 0xff]) ? ['utf-16be', 2] : ['utf-8', 0]
  try { return new TextDecoder(label, { fatal: true, ignoreBOM: true }).decode(bytes.subarray(skip)).includes('\0') ? 'nul' : null } catch { return 'rejected' }
}

const all = (seed = SEED) => FORMATS.flatMap((format) => shapeCases({ format, seed }))

test('① every determinable shape round-trips byte for byte through Node\'s strict decoder and Buffer', () => {
  for (const c of [...all(), ...seeds].filter((x) => x.determinable)) assert.equal(roundTripProblem(c), null, at(c))
})

test('① the round-trip check goes red on a mislabelled shape (wrong charset, wrong BOM flag, wrong text)', () => {
  const c = all().find((x) => x.determinable && x.charset === 'utf16le' && x.text.length > 0)
  assert.ok(c, 'a utf16le case with text exists')
  assert.notEqual(roundTripProblem({ ...c, charset: 'utf16be' }), null)
  assert.notEqual(roundTripProblem({ ...c, bom: false }), null)
  assert.notEqual(roundTripProblem({ ...c, text: c.text + 'x' }), null)
})

test('② every undeterminable shape is refused by the spec\'s strict reading (rejected, UTF-32, or NUL in the text)', () => {
  for (const c of [...all(), ...seeds].filter((x) => !x.determinable)) {
    assert.ok(axes.undeterminable.includes(c.why), `${at(c)}: why ${c.why} is in the spec's closed set`)
    assert.notEqual(strictReadProblem(c.bytes), null, at(c))
  }
  for (const c of all().filter((x) => x.determinable)) assert.equal(strictReadProblem(c.bytes), null, at(c))
})

test('② the strict reading goes red on what it must refuse (it is not a check that passes everything)', () => {
  assert.equal(strictReadProblem(Buffer.from([0x41, 0x3d, 0x81, 0x40])), 'rejected')
  assert.equal(strictReadProblem(Buffer.from('A=1', 'utf16le')), 'nul')
  assert.equal(strictReadProblem(Buffer.from([0xff, 0xfe, 0x41, 0, 0x42])), 'rejected')
  assert.equal(strictReadProblem(Buffer.from('A=1')), null)
})

test('③ the same seed gives byte-identical cases; another seed gives other cases', () => {
  const a = all(), b = all()
  assert.deepEqual(a.map((c) => [c.id, c.bytes]), b.map((c) => [c.id, c.bytes]))
  assert.ok(all(SEED + 1).some((c, i) => !c.bytes.equals(a[i].bytes)), 'a different seed changes some bytes')
})

test('the default budget covers every axis value, for every format', () => {
  for (const format of FORMATS) {
    const cs = shapeCases({ format, seed: SEED })
    const seen = (f) => new Set(cs.map(f))
    for (const e of axes.encodings) assert.ok(seen((c) => c.encoding).has(e), `${format}: encoding ${e}`)
    for (const w of axes.undeterminable) assert.ok(seen((c) => c.why).has(w), `${format}: undeterminable ${w}`)
    for (const e of axes.eols) assert.ok(seen((c) => c.eol).has(e), `${format}: eol ${e}`)
    assert.ok(seen((c) => c.finalEol).has(false) && seen((c) => c.finalEol).has(true), `${format}: with and without a final line break`)
    for (const k of axes.content[format]) assert.ok(seen((c) => c.content).has(k), `${format}: content ${k}`)
    if (format === 'json') for (const s of [...axes.jsonStyles, ...axes.indents]) assert.ok(seen((c) => c.style).has(s) || seen((c) => c.indent).has(s), `json: ${s}`)
    if (format === 'dotenv') for (const n of axes.names) assert.ok(cs.some((c) => c.userValues && n in c.userValues), `dotenv: name ${n}`)
  }
  assert.ok(all().some((c) => /[^\x00-\x7f]/.test(c.home) && / /.test(c.home)), 'a HOME with non-ASCII and a space')
})

test('budget: TROCAR_SHAPES_BUDGET widens the default; an explicit budget wins', () => {
  const was = process.env.TROCAR_SHAPES_BUDGET
  try {
    const base = shapeCases({ format: 'dotenv', seed: SEED }).length
    process.env.TROCAR_SHAPES_BUDGET = String(base * 2)
    assert.equal(shapeCases({ format: 'dotenv', seed: SEED }).length, base * 2)
    assert.equal(shapeCases({ format: 'dotenv', seed: SEED, budget: 3 }).length, 3)
  } finally { if (was === undefined) delete process.env.TROCAR_SHAPES_BUDGET; else process.env.TROCAR_SHAPES_BUDGET = was }
})

const pick = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => inFamily(k)))
test('readDotenv reads back what the generator wrote: last assignment wins, exact case and folded', () => {
  for (const c of all().filter((x) => x.determinable && (x.format === 'dotenv' || x.format === 'rc'))) {
    assert.deepEqual(pick(readDotenv(c.bytes)), c.userValues, at(c))
    const folded = {}
    for (const [k, v] of c.assignments) if (inFamily(k)) folded[k.toUpperCase()] = v
    assert.deepEqual(pick(readDotenv(c.bytes, { fold: true })), folded, at(c))
  }
  assert.throws(() => readDotenv(Buffer.from([0x41, 0x3d, 0x81, 0x40])), (e) => e.why === 'not-utf8-no-bom')
})

test('readJsonc reads back the generator\'s value; strict shapes are plain JSON', () => {
  for (const c of all().filter((x) => x.determinable && x.format === 'json')) {
    assert.deepEqual(readJsonc(c.bytes), c.value, at(c))
    if (c.style === 'strict' && c.value !== undefined) assert.deepEqual(JSON.parse(c.text), c.value, at(c))
  }
  assert.throws(() => readJsonc(Buffer.from('{"a":}')), (e) => typeof e.offset === 'number')
})

test('readYamlList reads back the list rows', () => {
  for (const c of all().filter((x) => x.determinable && x.format === 'yaml-list')) assert.deepEqual(readYamlList(c.bytes), c.userValues.rows, at(c))
})

test('seeds: each measured shape names its verified finding and reads as declared', () => {
  for (const s of seeds) {
    assert.match(s.from, /^X[3-8]-/, s.id)
    if (!s.determinable) continue
    if (s.format === 'json') assert.deepEqual(pick(readJsonc(s.bytes)?.env || {}), s.userValues, s.id)
    else assert.deepEqual(pick(readDotenv(s.bytes)), s.userValues, s.id)
  }
  assert.deepEqual(new Set(seeds.map((s) => s.from.slice(0, 2))), new Set(['X3', 'X4', 'X5', 'X6', 'X7', 'X8']))
})

// ④ userEdits: an edit a user makes while trocar is on. Read with the independent readers, the file differs from before only in
// what the operator declares; every line it did not declare survives; its anchor is still there; the charset stays, the BOM
// stays (a resave-as-<form> puts the text in that form); line breaks it inserts follow the file. Run on S0 itself and on an S1 = a foreign block on top of S0.
const flatJson = (v) => {
  if (v === undefined) return {}
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return { '': JSON.stringify(v) }
  const o = {}
  for (const [k, x] of Object.entries(v)) if (k === 'env' && x && typeof x === 'object' && !Array.isArray(x)) for (const [e, y] of Object.entries(x)) o[`env.${e}`] = y; else o[k] = JSON.stringify(x)
  return o
}
const READ = { dotenv: (b) => readDotenv(b), rc: (b) => readDotenv(b), json: (b) => flatJson(readJsonc(b)), 'yaml-list': (b) => ({ rows: JSON.stringify(readYamlList(b)) }) }
const bodies = (t) => t.split('\n').map((l) => l.replace(/\r$/, ''))
const breaks = (t) => { const crlf = (t.match(/\r\n/g) || []).length; return { crlf, lf: (t.match(/\n/g) || []).length - crlf } }

function editProblem(format, op, c, cur, before) {
  const p = op.plan(cur, { before })
  if (!p) return null
  const after = op.apply(cur, { before })
  if (after.equals(cur)) return 'the edit changed nothing'
  let s
  try { s = new TextDecoder(LABEL[p.charset], { fatal: true, ignoreBOM: true }).decode(after) } catch { return `not the ${p.charset} it says` }
  if (p.charset !== c.charset && !/^resave-as-/.test(op.id)) return `the charset changed (${c.charset} → ${p.charset})`
  if (s.startsWith(BOM_CHAR) !== p.bom || (p.bom !== c.bom && !/^resave-as-/.test(op.id))) return 'the BOM changed'
  const was = new TextDecoder(LABEL[c.charset], { ignoreBOM: true }).decode(cur).replace(/^\uFEFF/, ''), now = s.replace(/^\uFEFF/, '')
  if (p.anchor != null && !(was.includes(p.anchor) && now.includes(p.anchor))) return `anchor ${JSON.stringify(p.anchor)} is not in both`
  const a = READ[format](cur), b = READ[format](after)
  const changed = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k] && !p.keys.includes(k))
  if (changed.length) return `undeclared change to ${changed.join(', ')}`
  const left = bodies(now)
  for (const l of bodies(was)) { if (p.removed.includes(l)) continue; const i = left.indexOf(l); if (i < 0) return `line ${JSON.stringify(l)} lost`; left.splice(i, 1) }
  if (!op.id.startsWith('eol-')) { const x = breaks(was), y = breaks(now), lf = (x.crlf > x.lf) ? 'lf' : 'crlf'; if (y[lf] > x[lf]) return `inserted a ${lf} break into a file that uses the other` }
  return null
}

test('④ every userEdits operator keeps its anchor and changes only what it declares, on S0 and on S1', () => {
  for (const format of FORMATS) {
    const ops = userEdits(format), used = new Set()
    for (const c of [...shapeCases({ format, seed: SEED }), ...seeds.filter((x) => x.format === format)]) {
      if (!c.determinable) { for (const op of ops) assert.equal(op.apply(c.bytes), null, `${op.id} writes nothing to ${at(c)}`); continue }
      const runs = [[c.bytes, c.bytes]]
      if (format === 'dotenv' || format === 'rc') runs.push([s1Of(c), c.bytes])
      for (const [cur, before] of runs) for (const op of ops) {
        if (op.plan(cur, { before })) used.add(op.id)
        assert.equal(editProblem(format, op, c, cur, before), null, `${op.id} on ${at(c)}${cur === before ? '' : ' (S1)'}`)
      }
    }
    for (const op of ops) assert.ok(used.has(op.id), `${format}: ${op.id} applies to some case`)
    for (const form of axes.encodings) assert.ok(used.has(`resave-as-${form}`), `${format}: the user may save the file again in every determinable form (${form}), a mark added or dropped among them`)
  }
})
// S1 for line formats: a foreign block (HTTPS_PROXY to a loopback door, an unrelated key) on top of S0, in S0's encoding.
function s1Of(c) {
  const eol = c.eol === 'crlf' ? '\r\n' : '\n'
  const t = (c.bom ? BOM_CHAR : '') + ['# >>> block >>>', 'HTTPS_PROXY=http://127.0.0.1:1', 'SSL_CERT_FILE=/tmp/x.pem', '# <<< block <<<', ''].join(eol) + c.text
  const le = Buffer.from(t, 'utf16le')
  return c.charset === 'utf8' ? Buffer.from(t) : c.charset === 'utf16le' ? le : le.swap16()
}

test('④ the edit check goes red on an operator that touches more than it declares', () => {
  const c = seeds.find((s) => s.id === 'seed-X8')
  const liar = { id: 'liar', plan: () => ({ charset: 'utf8', bom: false, keys: [], removed: [], anchor: null }), apply: () => Buffer.from('OPENAI_API_KEY=sk-x\r\n') }
  assert.match(editProblem('dotenv', liar, c, c.bytes, c.bytes), /undeclared change to HTTPS_PROXY/)
})
