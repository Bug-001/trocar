// test/ci/evidence-ids.test.mjs — a spec sentence or a code comment states the behaviour; it does not cite a test machine's run record, whose
// ids resolve to nothing a reader of this repository has. Ids a spec unit defines for itself (acceptance items, 4.8's §0 table) stay.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const TEXT = /\.(md|mjs|cjs|sh|ps1|cs|c|swift|tmpl)$/

const files = (dir) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true, recursive: true })
  .filter((e) => e.isFile() && TEXT.test(e.name))
  .map((e) => path.join(e.parentPath, e.name))

test('no run-record id in spec, src or scripts', () => {
  const hits = ['spec', 'src', 'scripts'].flatMap(files).flatMap((f) =>
    fs.readFileSync(f, 'utf8').split('\n').flatMap((line, i) =>
      /\bR\d+-[A-Z]\d*\b|\blab [MW]\d+\b/.test(line) ? [`${path.relative(ROOT, f)}:${i + 1}`] : []))
  assert.deepEqual(hits, [])
})

test('4.11 defines no M or W ids of its own, so it carries none', () => {
  const unit = fs.readFileSync(path.join(ROOT, 'spec/01-trocar-rfc/4.11-collector-model.md'), 'utf8')
  assert.deepEqual(unit.match(/(?<!4\.[0-9] )\b[MW]\d+\b/g) ?? [], [])
})
