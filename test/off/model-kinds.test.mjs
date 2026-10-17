// test/off/model-kinds.test.mjs — the manifest kinds the collector model adds (4.11 P13): `text` / `pem-block` (rule U: a marked PEM block at the end
// of a user's certificate file) and `json-array-item` (one element asight added to a JSON array) are undone byte for byte while the file is untouched,
// and by their own marks / element when the user edited it — the user's bytes before and after stay. Cases are generated over the file's form
// (LF / CRLF, a byte-order mark, a last line without a line ending) × what the user did during on.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpDir } from '../helpers/tmp.mjs'
import { applyTextEntry, undoEntry, newManifest } from '../../src/collector/core/trust/journal.mjs'
import { sha256 } from '../../src/off/fsutil.mjs'
import { createCa } from '../../src/collector/core/tls/ca.mjs'

const CA = createCa({ commonName: 'model kinds root' }).certPem
const USER = createCa({ commonName: 'model kinds user ca' }).certPem
const box = () => { const root = tmpDir('asight-kinds-'); return { root, dir: path.join(root, '.asight', 'collector') } }

// ── pem-block ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const FORMS = [
  { name: 'LF', eol: '\n', bom: '', final: true },
  { name: 'CRLF', eol: '\r\n', bom: '', final: true },
  { name: 'BOM', eol: '\n', bom: '﻿', final: true },
  { name: 'BOM+CRLF', eol: '\r\n', bom: '﻿', final: true },
  { name: 'no final EOL', eol: '\n', bom: '', final: false },
  { name: 'CRLF, no final EOL', eol: '\r\n', bom: '', final: false },
]
const userFile = (f) => f.bom + USER.trim().split('\n').join(f.eol) + (f.final ? f.eol : '')
// what the user did during on → [the file after it, the file the undo must leave]
const EDITS = {
  untouched: (now, before) => [now, before],
  'appended after': (now, before, f) => [`${now}# mine${f.eol}`, null], // expected: the user's file + a line ending where it lacked one + the user's line
  'inserted before': (now, before, f) => [`${f.bom}# top${f.eol}${now.slice(f.bom.length)}`, `${f.bom}# top${f.eol}${before.slice(f.bom.length)}`],
}

for (const f of FORMS) {
  for (const [edit, apply] of Object.entries(EDITS)) {
    test(`pem-block: ${f.name} × ${edit} — only asight's marked block goes, the user's bytes stay`, () => {
      const b = box(), file = path.join(b.root, 'my-ca.pem'), before = userFile(f)
      fs.writeFileSync(file, before)
      const e = applyTextEntry({ phase: 'install', home: b.root, dir: b.dir, manifest: newManifest(), harness: 'kimi-code', file, edit: { format: 'pem-block', pem: CA } })
      const now = fs.readFileSync(file, 'utf8')
      assert.ok(now.startsWith(before) || now.startsWith(before + f.eol), 'the user\'s bytes come first, unchanged')
      assert.ok(now.includes(CA.trim().split('\n').join(f.eol)), 'the block is written with the file\'s own line ending')
      const [edited, want] = apply(now, before, f)
      fs.writeFileSync(file, edited)
      const r = undoEntry(e)
      const expect = want ?? `${before}${f.final ? '' : f.eol}# mine${f.eol}`
      assert.equal(fs.readFileSync(file, 'utf8'), expect, `${f.name} × ${edit}: ${r.result}`)
      assert.equal(r.result, edit === 'untouched' ? 'restored' : 'reverted-not-identical')
    })
  }
}

test('pem-block: a block the user already removed is "already-removed" and the file is not written; two blocks — only the one with the entry\'s lines goes', () => {
  const b = box(), file = path.join(b.root, 'my-ca.pem')
  fs.writeFileSync(file, USER)
  const e = applyTextEntry({ phase: 'install', home: b.root, dir: b.dir, manifest: newManifest(), harness: 'h', file, edit: { format: 'pem-block', pem: CA } })
  fs.writeFileSync(file, USER + '# edited\n')
  assert.equal(undoEntry(e).result, 'already-removed')
  assert.equal(fs.readFileSync(file, 'utf8'), USER + '# edited\n')
  // another asight block (another root) in the same file, before ours: it is not ours to take
  fs.writeFileSync(file, USER)
  const e2 = applyTextEntry({ phase: 'install', home: b.root, dir: b.dir, manifest: newManifest(), harness: 'h', file, edit: { format: 'pem-block', pem: CA } })
  const other = fs.readFileSync(file, 'utf8').slice(USER.length).replace(CA.trim(), USER.trim())
  fs.writeFileSync(file, USER + other + fs.readFileSync(file, 'utf8').slice(USER.length))
  assert.equal(undoEntry(e2).result, 'reverted-not-identical')
  assert.equal(fs.readFileSync(file, 'utf8'), USER + other)
})

// ── json-array-item ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// The entry as a writer records it: one splice (the common prefix / suffix of the text before and after), pre / post sha256.
const splice = (a, b) => { let i = 0; while (i < a.length && a[i] === b[i]) i++; let j = 0; while (j < a.length - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++; return { offset: i, removed: a.slice(i, a.length - j), inserted: b.slice(i, b.length - j) } }
function arrayEntry(b, before, after, { created_array }) {
  const file = path.join(b.root, 'settings.json')
  fs.writeFileSync(file, after)
  return { kind: 'json-array-item', harness: 'claude-code', phase: 'on', path: file, keys: ['settingsSync.ignoredSettings'], item: 'http.proxy', created_array, existed_before: true, mode: 0o644, pre_sha256: sha256(Buffer.from(before)), post_sha256: sha256(Buffer.from(after)), ops: [splice(before, after)], backup: null }
}
const ARRAYS = {
  existing: { created_array: false, before: '{\n  // mine\n  "settingsSync.ignoredSettings": [\n    "a"\n  ],\n  "x": 1\n}\n', after: '{\n  // mine\n  "settingsSync.ignoredSettings": [\n    "a",\n    "http.proxy"\n  ],\n  "x": 1\n}\n' },
  created: { created_array: true, before: '{\n  // mine\n  "x": 1\n}\n', after: '{\n  "settingsSync.ignoredSettings": ["http.proxy"],\n  // mine\n  "x": 1\n}\n' },
}
const USER_EDITS = {
  untouched: (t) => t,
  'user added a key': (t) => t.replace('"x": 1', '"x": 1,\n  "y": 2'),
  'user added an element after asight\'s': (t) => t.replace('"http.proxy"', '"http.proxy", "mine"'),
}
for (const [shape, a] of Object.entries(ARRAYS)) {
  for (const [edit, user] of Object.entries(USER_EDITS)) {
    test(`json-array-item: ${shape} array × ${edit} — asight's element goes; the list goes only when asight made it and it is empty`, () => {
      const b = box(), e = arrayEntry(b, a.before, a.after, a)
      fs.writeFileSync(e.path, user(a.after))
      const r = undoEntry(e)
      const doc = (t) => JSON.parse(t.replace(/\/\/.*$/gm, ''))
      const got = fs.readFileSync(e.path, 'utf8')
      if (edit === 'untouched') { assert.equal(r.result, 'restored'); assert.equal(got, a.before); return }
      assert.equal(r.result, 'reverted-not-identical')
      const want = doc(user(a.after)), list = want['settingsSync.ignoredSettings'].filter((x) => x !== 'http.proxy')
      if (a.created_array && !list.length) delete want['settingsSync.ignoredSettings']; else want['settingsSync.ignoredSettings'] = list
      assert.deepEqual(doc(got), want)
      assert.ok(got.includes('// mine'), 'the user\'s comment stays')
    })
  }
  test(`json-array-item: ${shape} array — the user removed asight's element during on: nothing is written (D48②)`, () => {
    const b = box(), e = arrayEntry(b, a.before, a.after, a)
    const theirs = a.after.replace(/,\n    "http.proxy"|"http.proxy"/, '').replace('"x": 1', '"x": 2')
    fs.writeFileSync(e.path, theirs)
    assert.equal(undoEntry(e).result, 'already-removed')
    assert.equal(fs.readFileSync(e.path, 'utf8'), theirs)
  })
}
