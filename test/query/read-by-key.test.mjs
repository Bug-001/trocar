// test/query/read-by-key.test.mjs — 4.3 §4 分片 (acceptance 4.3 #8): a line read back by its key is that key's line. A handle whose files
// now hold, at an offset it indexed, a whole line of another key (the same kind or another: another generation written over the same
// boundaries) throws ELINEPART, the error the session rereads on in the same request; it never answers the other line, and never a
// TypeError (an un-retried 500).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpDir } from '../helpers/tmp.mjs'
import { openProjection, sessionDir } from '../../src/query/projection.mjs'
import { openFoldLog } from '../../src/query/fold-log.mjs'

const KEY = 'read-by-key'
// the one plain tail of `name` in the session's directory, its lines with their offsets
function tailOf(home, name) {
  const dir = sessionDir(home, KEY), file = path.join(dir, fs.readdirSync(dir).find((n) => new RegExp(`^${name}\\.\\d+\\.ndjson$`).test(n)))
  const text = fs.readFileSync(file, 'utf8'), out = []
  for (let off = 0; off < text.length;) { const nl = text.indexOf('\n', off); out.push({ off, text: text.slice(off, nl) }); off = nl + 1 }
  return { file, lines: out }
}
// the bytes of `file` with the line at `a` and the one at `b` (the same length) changed places: the same boundaries, other lines
function swap(file, a, b) {
  const buf = fs.readFileSync(file), x = Buffer.from(a.text), y = Buffer.from(b.text)
  assert.equal(x.length, y.length, 'lines of one length')
  y.copy(buf, a.off); x.copy(buf, b.off)
  fs.writeFileSync(file, buf)
}
const pad = (o, n) => { const j = JSON.stringify(o); return j.slice(0, -2) + `,"z":"${'z'.repeat(n - j.length - 6)}"}}` }

test('4.3 #8: a projection line read by its key that is another key\'s whole line: ELINEPART, never the other line or a TypeError', () => {
  for (const what of ['def of another bid', 'row of another rid', 'def where a row was']) {
    const home = path.join(tmpDir('trocar-key-'), '.trocar')
    const w = openProjection({ home, fs, key: KEY, errors: [] })
    w.append({ defs: [{ bid: 'b1', text: 'one' }, { bid: 'b2', text: 'two' }], rows: [{ rid: 'r1', n: 1 }, { rid: 'r2', n: 2 }] })
    w.close()
    const a = openProjection({ home, fs, key: KEY, errors: [] }) // every line indexed, none read yet
    const { file, lines } = tailOf(home, 'extract'), find = (re) => lines.find((l) => re.test(l.text))
    const d1 = find(/"bid":"b1"/), d2 = find(/"bid":"b2"/), c1 = find(/"rid":"r1"/), c2 = find(/"rid":"r2"/)
    if (what === 'def of another bid') swap(file, d1, d2)
    else if (what === 'row of another rid') swap(file, c1, c2)
    else { const buf = fs.readFileSync(file); Buffer.from(pad({ d: { bid: 'b1', text: 'one' } }, c1.text.length)).copy(buf, c1.off); fs.writeFileSync(file, buf) }
    const read = what === 'def of another bid' ? () => a.readDef('b1') : () => a.rows.get('r1')
    assert.throws(read, { code: 'ELINEPART' }, what)
    a.close()
  }
})

test('4.3 #8: a fold log call line read along its chain that is another rid\'s whole line: ELINEPART', () => {
  const home = path.join(tmpDir('trocar-key-fold-'), '.trocar'), PROJ = { id: 'proj-key', bytes: 1e9 }
  const open = () => openFoldLog({ home, fs, key: KEY, projection: PROJ, errors: [] })
  const w = open()
  w.append([{ c: 'r1', s: 'aaaa' }, { c: 'r2', s: 'bbbb' }, { f: 'r2', n: 2, pb: 1 }])
  w.close()
  const a = open()
  const { file, lines } = tailOf(home, 'fold')
  swap(file, lines.find((l) => l.text.startsWith('{"c":"r1"')), lines.find((l) => l.text.startsWith('{"c":"r2"')))
  assert.throws(() => a.versionAt('r1', 0), { code: 'ELINEPART' })
  a.close()
})
