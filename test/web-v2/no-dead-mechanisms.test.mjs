// test/web-v2/no-dead-mechanisms.test.mjs — the board's code names no mechanism the RFC removed: ETL / DuckDB and their
// commands (D59③), the retention grid and its write (D60), the routes the named queries replaced and the reveal parameter
// (P7: one data entrance, 1.6 §4.1), the old capture (1.9 §旧采集) and any install / uninstall control (D65③ · D66④).
// Comments may keep a design pointer; code and strings may not.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { findIn } from '../helpers/code-text.mjs'

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const V2 = path.join(REPO, 'src', 'web', 'v2')
const DEAD = [
  /\betl\b/gi, // D59③
  /duckdb/gi, // D59③
  /asight (?:etl|keep|shard)\b/g, // D59③
  /--db\b/g, // D59③
  /\/api\/(?:projects|retention|capture-health|traffic\/)/g, // P7
  /\/control\/retention/g, // D60
  /[?&]reveal=/g, // P7
  /retention\.json/g, // D60
  /\bmitm\b/gi, // 1.9
  /data-act=["'`]?(?:install|uninstall)\b/g, // D65③
]

// an .html file has no // comments; its <!-- --> comments are blanked here, its script/text kept
const codeOf = (file, src) => (file.endsWith('.html') ? src.replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, ' ')) : src)
const scan = (file, src) => DEAD.flatMap((re) => (file.endsWith('.html')
  ? codeOf(file, src).split('\n').flatMap((l, k) => [...l.matchAll(re)].map((m) => ({ line: k + 1, text: m[0] })))
  : findIn(src, re)).map((h) => `${path.relative(REPO, file)}:${h.line}: ${h.text}`))

test('the scanner is not vacuous: a dead name in code is reported, the same name in a comment is not', () => {
  const f = path.join(V2, 'x.mjs')
  assert.equal(scan(f, "const u = '/api/projects'\nconst k = 'asight keep'\n").length, 2)
  assert.deepEqual(scan(f, "// the ETL and /api/retention are gone (D59③)\nconst keep = 'full'\n"), [])
  assert.equal(scan(path.join(V2, 'x.html'), '<!-- DuckDB --><button data-act="uninstall">').length, 1)
})

test('no code or string in src/web/v2 names a removed mechanism', () => {
  const files = fs.readdirSync(V2, { recursive: true }).filter((p) => /\.(mjs|html)$/.test(p)).map((p) => path.join(V2, p))
  assert.ok(files.length > 10)
  assert.deepEqual(files.flatMap((f) => scan(f, fs.readFileSync(f, 'utf8'))), [])
})
