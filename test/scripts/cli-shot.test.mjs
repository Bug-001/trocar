// test/scripts/cli-shot.test.mjs — the SGR → HTML converter in scripts/cli-shot.mjs.
//
// Only the converter is unit-tested: everything else in that script is a browser and a file write,
// and no-real-os.cjs blocks real OS tools in unit tests on purpose. The renderer is verified by
// looking at the PNG (D58⑥), which is the whole point of the tool.
import test from 'node:test'
import assert from 'node:assert/strict'
import { ansiToHtml, rowsNeeded } from '../../scripts/cli-shot.mjs'

test('plain text is escaped, not interpreted', () => {
  assert.equal(ansiToHtml('a <b> & c'), 'a &lt;b&gt; &amp; c')
})

test('bold, dim and reset open and close one span each', () => {
  assert.equal(ansiToHtml('\x1b[1mB\x1b[0m.'), '<span style="font-weight:700">B</span>.')
  assert.equal(ansiToHtml('\x1b[2md\x1b[0m'), '<span style="opacity:.62">d</span>')
  assert.equal(ansiToHtml('\x1b[1;32mok\x1b[0m'), '<span style="font-weight:700;color:#0dbc79">ok</span>')
})

test('the 8 and 16 colour foregrounds', () => {
  assert.match(ansiToHtml('\x1b[31mx'), /color:#cd3131/)
  assert.match(ansiToHtml('\x1b[91mx'), /color:#f14c4c/)
  assert.match(ansiToHtml('\x1b[37mx'), /color:#e5e5e5/)
  assert.equal(ansiToHtml('\x1b[31mx\x1b[39my'), '<span style="color:#cd3131">x</span>y')
})

test('256 colour: base, cube and greyscale', () => {
  assert.match(ansiToHtml('\x1b[38;5;1mx'), /color:#cd3131/)
  assert.match(ansiToHtml('\x1b[38;5;9mx'), /color:#f14c4c/)
  assert.match(ansiToHtml('\x1b[38;5;196mx'), /color:#ff0000/) // cube corner
  assert.match(ansiToHtml('\x1b[38;5;244mx'), /color:#808080/)
})

test('truecolor', () => {
  assert.match(ansiToHtml('\x1b[38;2;255;170;120mx'), /color:#ffaa78/)
})

test('other escapes are dropped, and an unclosed span is closed', () => {
  assert.equal(ansiToHtml('a\x1b[2Kb\x1b[?25lc\x1b]0;title\x07d'), 'abcd')
  assert.equal(ansiToHtml('\x1b[32mstill open'), '<span style="color:#0dbc79">still open</span>')
})

test('a span survives a newline, so <pre> keeps the layout', () => {
  assert.equal(ansiToHtml('\x1b[1mone\ntwo\x1b[0m'), '<span style="font-weight:700">one\ntwo</span>')
})

test('unknown parameters change nothing (background and italics are not guessed)', () => {
  assert.equal(ansiToHtml('\x1b[41;3mx\x1b[0m'), 'x')
})

test('row count wraps long lines and counts CJK as two cells', () => {
  assert.equal(rowsNeeded('a\nb', 80), 2)
  assert.equal(rowsNeeded('', 80), 1)
  assert.equal(rowsNeeded('x'.repeat(161), 80), 3)
  assert.equal(rowsNeeded('中'.repeat(40), 80), 1) // exactly 80 cells
  assert.equal(rowsNeeded('中'.repeat(41), 80), 2)
  assert.equal(rowsNeeded(`\x1b[32m${'x'.repeat(80)}\x1b[0m`, 80), 1) // escapes take no cell
})
