// test/web-v2/harness-icons.test.mjs — the harness icon files (1.2 §agent chip, guard named there), generated over the registry (D76):
// every row has its file in src/off/harness-icons/, of the type its extension says (by the leading bytes), square, pairwise different,
// none the unknown glyph, no currentColor (an <img> does not inherit it); the folder holds nothing the registry does not name; SOURCES.md
// records every file; the built board serves each one at harnessIconUrl() byte for byte.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { HARNESS_REGISTRY, readIdOf } from '../../src/off/harness-names.mjs'
import { harnessIconUrl, UNKNOWN_ICON } from '../../web/legacy/core/chips.mjs'

const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const ICONS = path.join(REPO, 'src', 'off', 'harness-icons')
const BOARD = path.join(REPO, 'src', 'web', 'board')
const SOURCES = 'SOURCES.md'
const bytesOf = (r) => fs.readFileSync(path.join(ICONS, r.icon))
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
// the root element of an SVG: after an optional <?xml …?> prologue and whitespace (and comments / a doctype), the first tag is <svg
const svgRoot = (t) => t.replace(/^﻿?(?:\s|<\?xml[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>]*>)*/i, '')

test('the folder is not vacuous: it holds at least one file per registry row', () => {
  const files = fs.readdirSync(ICONS).filter((f) => f !== SOURCES)
  assert.ok(HARNESS_REGISTRY.length >= 1)
  assert.ok(files.length >= HARNESS_REGISTRY.length, `${files.length} files for ${HARNESS_REGISTRY.length} rows`)
})

test('every registry row has its icon file, of the type its extension names, and square', () => {
  for (const r of HARNESS_REGISTRY) {
    assert.ok(fs.existsSync(path.join(ICONS, r.icon)), `${r.id}: ${r.icon}`)
    const b = bytesOf(r), ext = path.extname(r.icon).toLowerCase()
    if (ext === '.png') {
      assert.ok(b.subarray(0, 8).equals(PNG_SIG), `${r.icon}: the PNG signature`)
      assert.equal(b.readUInt32BE(16), b.readUInt32BE(20), `${r.icon}: IHDR width = height`)
    } else if (ext === '.svg') {
      const root = svgRoot(b.toString('utf8'))
      assert.match(root, /^<svg[\s>]/, `${r.icon}: the root element is <svg`)
      // the root's view box, or without one its own width and height (the user units it is drawn in)
      const tag = root.slice(0, root.indexOf('>') + 1), attr = (n) => (tag.match(new RegExp(`\\s${n}\\s*=\\s*["']([^"']*)["']`)) || [])[1]
      const vb = attr('viewBox')?.trim().split(/[\s,]+/).map(Number)
      const [w, h] = vb ? vb.slice(2) : [attr('width'), attr('height')].map((x) => x && /^[\d.]+(?:px)?$/.test(x) ? parseFloat(x) : NaN)
      assert.ok(w > 0 && w === h, `${r.icon}: a square view box (or width = height), found ${w} × ${h}`)
    } else assert.fail(`${r.icon}: an extension the board serves as an image (.png or .svg)`)
  }
})

test('the files are pairwise different, none is the unknown glyph, and no SVG says currentColor', () => {
  const rows = HARNESS_REGISTRY
  for (let i = 0; i < rows.length; i++) {
    const b = bytesOf(rows[i])
    for (let j = i + 1; j < rows.length; j++) assert.ok(!b.equals(bytesOf(rows[j])), `${rows[i].icon} and ${rows[j].icon} are the same bytes`)
    assert.ok(!b.equals(Buffer.from(UNKNOWN_ICON)), `${rows[i].icon} is the unknown glyph`)
    if (/\.svg$/i.test(rows[i].icon)) assert.ok(!/currentColor/i.test(b.toString('utf8')), `${rows[i].icon}: currentColor does not reach an <img>`)
  }
})

test('every file in the folder is some row\'s icon, and SOURCES.md records each of them', () => {
  const named = new Set(HARNESS_REGISTRY.map((r) => r.icon))
  const md = fs.readFileSync(path.join(ICONS, SOURCES), 'utf8')
  for (const f of fs.readdirSync(ICONS)) {
    if (f === SOURCES) continue
    assert.ok(named.has(f), `${f}: no registry row names it`)
    assert.ok(md.includes(f), `${f}: not recorded in ${SOURCES}`)
  }
})

test('the built board serves each row\'s icon at harnessIconUrl(), byte for byte', (t) => {
  if (!fs.existsSync(path.join(BOARD, 'index.html'))) return t.skip('src/web/board/index.html is absent: the board is not built in this checkout')
  for (const r of HARNESS_REGISTRY) {
    const p = path.join(BOARD, harnessIconUrl(readIdOf(r)))
    assert.ok(fs.existsSync(p), `${r.icon}: not in the build at ${harnessIconUrl(readIdOf(r))}`)
    assert.ok(fs.readFileSync(p).equals(bytesOf(r)), `${r.icon}: the built copy differs from the source`)
  }
})
