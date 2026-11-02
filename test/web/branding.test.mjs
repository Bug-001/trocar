// test/web/branding.test.mjs — the product is trocar; `atrace` (the v0 prototype's name) is a forbidden
// string in everything the board serves (R14). The board is the build in src/web/board/, served at `/` (1.2 §托管与打开, 4.4
// §静态面); the check reads every text file of the build, so a new screen or label file is covered without touching this test.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'web', 'board')
const files = fs.readdirSync(WEB, { recursive: true }).map((f) => path.join(WEB, f)).filter((f) => fs.statSync(f).isFile() && /\.(html|mjs|css|svg|md)$/.test(f))

test('the board\'s page title names the product', () => {
  const pages = files.filter((f) => f.endsWith('.html'))
  assert.ok(pages.length, 'sanity: the board has a page')
  for (const p of pages) assert.match((fs.readFileSync(p, 'utf8').match(/<title>([^<]*)<\/title>/) || [])[1] || '', /^trocar$/, path.relative(WEB, p))
})

test('the old product name appears in no file the board serves', () => {
  assert.ok(files.length > 10, 'sanity: the board\'s files were found')
  for (const f of files) {
    const hit = /atrace/i.exec(fs.readFileSync(f, 'utf8'))
    assert.equal(hit, null, hit ? `${path.relative(WEB, f)} says "atrace" — the product is trocar` : '')
  }
})
