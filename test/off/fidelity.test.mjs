// test/off/fidelity.test.mjs — the user's file, byte for byte, along the shape generator's axes (spec 0.1 G2, 4.6「文件的编码」, plan file-fidelity
// §2.10 I1–I7). Every case is a seeded shape from test/helpers/file-shapes.mjs (a failure names its id and seed); expectations come from that
// generator's own decoder and readers, never from src/. The formats here are the text entries: a dotenv block, a YAML-list row, an rc line.
import { PHASES } from '../../src/off/manifest.mjs' // install's items are phase install, which off spares (D55①): these cases drive the undo rules over both phases, as uninstall runs them
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpDir } from '../helpers/tmp.mjs'
import { shapeCases, decodeBytes, encodeText as shapeEncode, eolOf as shapeEol, readJsonc, readDotenv, userEdits, seeds } from '../helpers/file-shapes.mjs'
import { applyTextEntry, applyJsonKey, undoEntry, newManifest, readManifest } from '../../src/collector/core/trust/journal.mjs'
import { undoHarnesses } from '../../src/off/undo.mjs'
import { planByMarker, undoByMarker } from '../../src/off/marker.mjs'
import { lineComment, OFF_PREFIX } from '../../src/off/text-edit.mjs'
import { formatOffReceipt } from '../../src/off/receipt.mjs'
import { installedHome } from './fixtures/off-ctx.mjs'

const FORMATS = { dotenv: '.codex/.env', 'yaml-list': '.dsh/cordis.patch.yml', rc: '.zshrc' }
const editFor = (format, home) => format === 'dotenv' ? { format: 'dotenv-block', vars: { SSL_CERT_FILE: `${home}/.trocar/collector/ca/combined-codex.pem` }, quote: true }
  : format === 'yaml-list' ? { format: 'yaml-list', line: `- insert: [{ name: "${home}/.trocar/collector/plugins/dsh/index.js" }] ${lineComment('dsh plugin')}` }
    : { format: 'line', line: `export PATH="${home}/.trocar/collector/bin:$PATH" ${lineComment('kimi shim')}` }
const BUDGET = 60
const cases = (format, keep = () => true) => shapeCases({ format, budget: BUDGET }).filter((c) => c.determinable && keep(c))
const tag = (c) => `${c.id} seed=${c.seed} ${c.describe}`

function sandbox(c) {
  const root = tmpDir('trocar-fid-')
  const file = path.join(root, FORMATS[c.format])
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, c.bytes, { mode: 0o600 })
  return { root, dir: path.join(root, '.trocar', 'collector'), file }
}
function on(c, b, manifest = newManifest()) {
  const e = applyTextEntry({ phase: 'on', home: b.root, dir: b.dir, manifest, harness: 'h', file: b.file, edit: editFor(c.format, c.home) })
  return { e, manifest }
}

// The file the user saved again after `on`, in a form that proves no encoding: one per `why` of the closed set, built from the text trocar left.
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
const textOf = (bytes) => { const d = decodeBytes(bytes); assert.ok(!d.why, `trocar left bytes the generator cannot read: ${d.why}`); return d.text }

for (const format of Object.keys(FORMATS)) {
  test(`fidelity ${format}: I3 on keeps the file's form (charset, mark) and writes its line ending; I7 on twice is on once; I1 off of an untouched file is byte for byte`, () => {
    for (const c of cases(format)) {
      const b = sandbox(c)
      const { e, manifest } = on(c, b)
      const after = fs.readFileSync(b.file)
      const d = decodeBytes(after)
      assert.ok(!d.why, `${tag(c)}: trocar left bytes that prove no form (${d.why})`)
      assert.deepEqual([d.charset, d.bom], [c.charset, c.bom], `I3 the form stays: ${tag(c)}`)
      assert.equal(e.charset, c.charset === 'utf8' ? undefined : c.charset, `the entry records a charset only when it is not utf8: ${tag(c)}`)
      const eol = shapeEol(c.text)
      for (const op of e.ops) for (const m of op.inserted.matchAll(/\r?\n/g)) assert.equal(m[0], eol, `I3 trocar's lines end as the file's do (${JSON.stringify(eol)}): ${tag(c)}`)
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
      assert.equal(fs.existsSync(path.join(b.root, '.trocar', 'backup')), false, tag(c))
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
        const out = await undoHarnesses({ dir: b.dir, home: b.root, phases: PHASES, manifest: readManifest(b.dir), procs: async () => [] })
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
  assert.equal(plan.length, 1, 'the mark is found in the bytes even though they are not text trocar may write')
  const [r] = undoByMarker(plan, { home: b.root })
  assert.equal(r.result, 'left-unreadable')
  assert.ok(fs.readFileSync(b.file).equals(resaved))
  fs.writeFileSync(b.file, Buffer.from([0xd6, 0x41, 0x0a]))
  assert.deepEqual(planByMarker({ home: b.root, ids: ['codex'] }), [], 'no mark in it: nothing to undo')
})
// ---- JSON (4.6「标记与安装」: JSON 按 JSONC 读写): Claude Code's two keys in its settings.json, the gate address and the CA ---------------------
const GATE = 'http://127.0.0.1:9'
// the comments of a JSONC text in order, outside strings
const commentsOf = (t) => {
  const out = []
  for (let i = 0; i < t.length;) {
    if (t[i] === '"') { i++; while (i < t.length && t[i] !== '"') i += t[i] === '\\' ? 2 : 1; i++ } else if (t.startsWith('//', i)) { let e = i; while (e < t.length && t[e] !== '\n' && t[e] !== '\r') e++; out.push(t.slice(i, e)); i = e } else if (t.startsWith('/*', i)) { const e = t.indexOf('*/', i + 2) + 2; out.push(t.slice(i, e)); i = e } else i++
  }
  return out
}
const jsonSandbox = (bytes) => { const root = tmpDir('trocar-fid-'), file = path.join(root, '.claude', 'settings.json'); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes, { mode: 0o600 }); return { root, dir: path.join(root, '.trocar', 'collector'), file } }
const JSON_KEYS = (b) => [[['env', 'HTTPS_PROXY'], GATE], [['env', 'NODE_EXTRA_CA_CERTS'], path.join(b.root, '.trocar', 'collector', 'ca', 'trocar-ca.pem')]]
const onJson = (b, manifest = newManifest()) => JSON_KEYS(b).map(([keys, value]) => applyJsonKey({ phase: 'on', home: b.root, dir: b.dir, manifest, harness: 'claude-code', file: b.file, keys, value }))
const offJson = (es) => [...es].reverse().map((e) => (e ? undoEntry(e).result : null))
const jsonCases = () => shapeCases({ format: 'json', budget: BUDGET }).filter((c) => c.determinable)
const refusedShape = (c) => c.content === 'env-null' || c.content === 'env-string'
// what off leaves of a document: trocar's keys that still hold trocar's value go back to what the file had at `on` (or away), and an env that only
// trocar's keys made goes when it is empty; everything the user did stays
function afterOff(edited, original, b) {
  const v = structuredClone(readJsonc(edited) ?? {}), o = readJsonc(original) ?? {}
  for (const [[, name], ours] of JSON_KEYS(b)) {
    if (v.env?.[name] !== ours) continue
    if (o.env && typeof o.env === 'object' && name in o.env) v.env[name] = o.env[name]; else delete v.env[name]
  }
  if (!o.env && v.env && !Object.keys(v.env).length) delete v.env
  return v
}

test('fidelity json: on keeps the file\'s form and every comment; on twice is on once; off of an untouched file is byte for byte; a null or string env is refused (entry-refused, not-object, its path) before a byte is written', () => {
  for (const c of jsonCases()) {
    const b = jsonSandbox(c.bytes)
    if (refusedShape(c)) {
      assert.throws(() => onJson(b), (e) => e.code === 'entry-refused' && e.why === 'not-object' && e.path === b.file && /delete that member or make it \{\}/.test(e.message), tag(c))
      assert.ok(fs.readFileSync(b.file).equals(c.bytes), `not a byte written: ${tag(c)}`)
      assert.equal(readManifest(b.dir), null, tag(c))
      continue
    }
    const manifest = newManifest()
    const es = onJson(b, manifest)
    const after = fs.readFileSync(b.file), d = decodeBytes(after)
    assert.deepEqual([d.why, d.charset, d.bom], [undefined, c.charset, c.bom], `the form stays: ${tag(c)}`)
    const was = readJsonc(c.text) ?? {}
    assert.deepEqual(readJsonc(after), { ...was, env: { ...was.env, ...Object.fromEntries(JSON_KEYS(b).map(([k, v]) => [k[1], v])) } }, `only trocar's two keys changed: ${tag(c)}`)
    assert.deepEqual(commentsOf(d.text), commentsOf(c.text), `every comment kept, none written: ${tag(c)}`)
    assert.deepEqual(onJson(b, manifest), [null, null], `on; on is on: ${tag(c)}`)
    assert.ok(fs.readFileSync(b.file).equals(after), tag(c))
    assert.deepEqual(offJson(es), ['restored', 'restored'], tag(c))
    assert.ok(fs.readFileSync(b.file).equals(c.bytes), `byte for byte: ${tag(c)}`)
  }
})

test('fidelity json: the user edits the file after on (a key, trocar\'s own keys, a mark, line endings) → off takes back only what is still trocar\'s; the user\'s values, comments and form stay', () => {
  let n = 0
  for (const c of jsonCases().filter((x) => !refusedShape(x))) {
    for (const edit of userEdits('json', { home: c.home })) {
      const b = jsonSandbox(c.bytes)
      const es = onJson(b)
      const edited = edit.apply(fs.readFileSync(b.file), { before: c.bytes })
      if (!edited) continue
      n++
      fs.writeFileSync(b.file, edited)
      const results = offJson(es)
      for (const r of results) assert.ok(['restored', 'reverted-not-identical', 'left-user-value', 'already-restored'].includes(r), `${edit.id} → ${r}: ${tag(c)}`)
      const out = fs.readFileSync(b.file), d = decodeBytes(out), e = decodeBytes(edited)
      assert.deepEqual([d.why, d.charset, d.bom], [undefined, e.charset, e.bom], `${edit.id}: the form the user left stays: ${tag(c)}`)
      assert.deepEqual(readJsonc(out) ?? {}, afterOff(edited, c.bytes, b), `${edit.id}: only trocar's part goes: ${tag(c)}`)
      assert.deepEqual(commentsOf(d.text), commentsOf(e.text), `${edit.id}: every comment stays: ${tag(c)}`)
    }
  }
  assert.ok(n > 100, `edits applied: ${n}`)
})

test('fidelity json X4 (seed): on, then the file gains a UTF-8 mark → off takes back both keys of the file (the gate address and the CA), reverted-not-identical, and the mark stays first', () => {
  const s = seeds.find((x) => x.id === 'seed-X4')
  const plain = shapeEncode(s.text, 'utf8', false), MARK = Buffer.from([0xef, 0xbb, 0xbf])
  const b = jsonSandbox(plain)
  const es = onJson(b)
  fs.writeFileSync(b.file, Buffer.concat([MARK, fs.readFileSync(b.file)]))
  assert.deepEqual(offJson(es), ['reverted-not-identical', 'reverted-not-identical'])
  const out = fs.readFileSync(b.file)
  assert.ok(out.subarray(0, 3).equals(MARK), 'the mark stays first')
  assert.deepEqual(readJsonc(out).env, { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9', HTTPS_PROXY: s.userValues.HTTPS_PROXY }, 'the user\'s proxy is back, trocar\'s CA is gone')
  assert.ok(out.equals(Buffer.concat([MARK, plain])), 'every other byte is the user\'s')
})

// ---- D48② (X8, I5): the user changes a key trocar set while it is on → after off the user's new value is the one in effect ------------------------------------------
// Codex's .env as `on` leaves it: the trust block (SSL_CERT_FILE) and the gate address joined into it (HTTPS_PROXY, 4.8 §2.3). Expectations come from the generator's
// own reader (readDotenv), never from src/.
const PROXY_GATE = 'http://127.0.0.1:47011'
const caFor = (home) => `${home}/.trocar/collector/ca/combined-codex.pem`
function onDotenv(bytes, { home } = {}) {
  const b = sandbox({ format: 'dotenv', bytes })
  const manifest = newManifest()
  const es = [
    applyTextEntry({ phase: 'on', home: b.root, dir: b.dir, manifest, harness: 'codex', file: b.file, edit: { format: 'dotenv-block', vars: { SSL_CERT_FILE: caFor(home ?? b.root) }, quote: true } }),
    applyTextEntry({ phase: 'on', home: b.root, dir: b.dir, manifest, harness: 'codex', file: b.file, edit: { format: 'dotenv-block', vars: { HTTPS_PROXY: PROXY_GATE }, quote: true, joinBlock: true } }),
  ]
  return { b, es, ours: { SSL_CERT_FILE: caFor(home ?? b.root), HTTPS_PROXY: PROXY_GATE } }
}

test('fidelity X8 (seed): CRLF and LF Codex .env, the user sets HTTPS_PROXY to their own value inside trocar\'s block while on → off: the new value is in effect, the old line stays out of effect and is reported by line, reverted-not-identical', async () => {
  const s = seeds.find((x) => x.id === 'seed-X8')
  for (const eol of ['\r\n', '\n']) {
    const text = s.text.replace(/\r\n/g, eol)
    const { b, es } = onDotenv(Buffer.from(text))
    const on = fs.readFileSync(b.file, 'utf8')
    assert.ok(on.includes(`HTTPS_PROXY=${PROXY_GATE}${eol}`) && on.includes(`${OFF_PREFIX}HTTPS_PROXY=http://corp.example:8080`), JSON.stringify(on))
    fs.writeFileSync(b.file, on.replace(`HTTPS_PROXY=${PROXY_GATE}`, 'HTTPS_PROXY=http://newcorp:3128'))
    assert.equal(es.filter(Boolean).length, 2)
    const rs = (await undoHarnesses({ dir: b.dir, home: b.root, phases: PHASES, manifest: readManifest(b.dir), procs: async () => [] })).results // off's undo of the whole manifest: the join first, then the block
    assert.deepEqual(rs.map((r) => r.result), ['reverted-not-identical', 'reverted-not-identical'], JSON.stringify(rs))
    const out = fs.readFileSync(b.file)
    const read = readDotenv(out)
    assert.equal(read.HTTPS_PROXY, 'http://newcorp:3128', 'the user\'s new value is in effect')
    assert.equal(read.OPENAI_API_KEY, 'sk-x')
    assert.equal(read.SSL_CERT_FILE, undefined, 'trocar\'s CA is gone')
    const lines = out.toString('utf8').split(eol)
    assert.deepEqual(rs[0].prior_left, [{ key: 'HTTPS_PROXY', line: lines.indexOf(`${OFF_PREFIX}HTTPS_PROXY=http://corp.example:8080`) + 1 }], 'the line the receipt names is the old line, still out of effect')
    assert.ok(rs[0].prior_left[0].line > 0)
    assert.equal(out.toString('utf8'), `HTTPS_PROXY=http://newcorp:3128${eol}${text.replace('HTTPS_PROXY=', `${OFF_PREFIX}HTTPS_PROXY=`)}`, 'every other byte is the user\'s, in the file\'s line ending')
  }
})

test('fidelity dotenv I5: along the user-edit axis (proxy / CA key in the block or outside it, unrelated lines added, changed, deleted, a mark, line endings) → off keeps every edit of the user; a key the user set reads as the user\'s value, any other key as it was before on', async () => {
  let n = 0, bytewise = 0, kept = 0
  for (const c of cases('dotenv')) {
    for (const edit of userEdits('dotenv', { proxyName: 'HTTPS_PROXY', caName: 'SSL_CERT_FILE', home: c.home })) {
      const { b, es, ours } = onDotenv(c.bytes, { home: c.home })
      const s1 = fs.readFileSync(b.file)
      const edited = edit.apply(s1, { before: c.bytes })
      if (!edited) continue
      n++
      fs.writeFileSync(b.file, edited)
      assert.equal(es.filter(Boolean).length, 2, tag(c))
      const rs = (await undoHarnesses({ dir: b.dir, home: b.root, phases: PHASES, manifest: readManifest(b.dir), procs: async () => [] })).results
      assert.equal(rs.length, 2, tag(c))
      for (const r of rs) assert.ok(['reverted-not-identical', 'already-removed'].includes(r.result), `${edit.id} → ${r.result} ${r.reason || ''}: ${tag(c)}`)
      const out = fs.readFileSync(b.file), d = decodeBytes(out), e = decodeBytes(edited)
      assert.deepEqual([d.why, d.charset, d.bom], [undefined, e.charset, e.bom], `${edit.id}: the form the user left stays: ${tag(c)}`)
      const was = readDotenv(c.bytes), now = readDotenv(edited), want = { ...now }
      for (const [k, v] of Object.entries(ours)) {
        if (now[k] !== v) continue // the user's own value: it stays
        if (k in was) want[k] = was[k]; else delete want[k]
      }
      assert.deepEqual(readDotenv(out), want, `${edit.id}: ${tag(c)}`)
      for (const [k, v] of Object.entries(ours)) {
        const set = now[k] !== v && k in was // the user set K while on, and trocar had put their old K out of effect
        const left = rs.flatMap((r) => r.prior_left || []).filter((p) => p.key === k)
        assert.equal(left.length > 0, set, `${edit.id}: ${k} reported as left out of effect iff the user set it: ${tag(c)}`)
        const oldLine = new RegExp(`^\uFEFF?[ \t]*${OFF_PREFIX}[ \t]*(?:export[ \t]+)?${k}[ \t]*=`)
        for (const p of left) assert.match(d.text.split('\n')[p.line - 1] ?? '', oldLine, `${edit.id}: line ${p.line} is ${k}'s old line: ${tag(c)}`)
        if (set) kept++
      }
      // an edit of nothing trocar set: the result is that edit made to the file as it was before on, byte for byte (when the edit finds the same place in both)
      const plain = edit.plan(c.bytes, { before: c.bytes }), onIt = edit.plan(s1, { before: c.bytes })
      if (!/^set-/.test(edit.id) && plain && onIt && plain.anchor === onIt.anchor) {
        bytewise++
        assert.ok(out.equals(edit.apply(c.bytes, { before: c.bytes })), `${edit.id}: byte for byte the user's edit of the file before on: ${tag(c)}\n${JSON.stringify(d.text)}`)
      }
    }
  }
  assert.ok(n > 300 && bytewise > 100 && kept > 10, `edits applied ${n}, compared byte for byte ${bytewise}, keys the user set over an old line ${kept}`)
})

test('fidelity X8 through trocar uninstall: the receipt names the line left out of effect and how to have the old value back; --json carries it', async () => {
  const s = await installedHome({ names: ['codex'], seed: (home) => { fs.mkdirSync(path.join(home, '.codex'), { recursive: true }); fs.writeFileSync(path.join(home, '.codex', '.env'), 'OPENAI_API_KEY=sk-test\r\nSSL_CERT_FILE=/corp/ca.pem\r\n') } })
  const file = s.manifest().entries.find((e) => e.kind === 'text').path
  const on = fs.readFileSync(file, 'utf8')
  fs.writeFileSync(file, on.replace(/^SSL_CERT_FILE=[^\r\n]*/m, 'SSL_CERT_FILE=/mine/ca.pem'))
  const off = await s.uninstall({ yes: true }) // the certificate entry is install's: uninstall undoes it, off spares it (D55①)
  assert.equal(off.exit, 0, JSON.stringify(off.receipt.left))
  const after = fs.readFileSync(file, 'utf8')
  assert.equal(readDotenv(Buffer.from(after)).SSL_CERT_FILE, '/mine/ca.pem')
  const line = after.split('\r\n').indexOf(`${OFF_PREFIX}SSL_CERT_FILE=/corp/ca.pem`) + 1
  assert.ok(line > 0, JSON.stringify(after))
  const row = off.receipt.changed.find((c) => c.path === file)
  assert.deepEqual(row.prior_left, [{ key: 'SSL_CERT_FILE', line }])
  const text = formatOffReceipt(off.receipt, { home: s.home })
  const flat = text.replace(/\s+/g, ' ') // the receipt wraps at 80 columns (§1.1 版式 6): the sentence is read without its line breaks
  assert.ok(flat.includes(`the old line (line ${line}) is still commented out`) && flat.includes(`delete the leading ${OFF_PREFIX}`), text)
})
