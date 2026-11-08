// test/helpers/real-home.mjs — a side home over a real trocar home, for the local-only real-data tests: its raw/ is a link to the real
// one and its index/ a copy of the real segment index without the context projections (index/ctx), every link followed, so the query
// worker extracts and folds from scratch and whatever it writes lands in a temp dir. The real home is only read.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpDir } from './tmp.mjs'

/** sideHome(real) → the side home's path (a `.trocar` under a fresh temp dir). */
export function sideHome(real) {
  const home = path.join(tmpDir('trocar-real-'), '.trocar')
  fs.mkdirSync(home, { recursive: true, mode: 0o700 })
  fs.symlinkSync(path.join(path.resolve(real), 'raw'), path.join(home, 'raw'))
  const index = path.join(real, 'index')
  if (fs.existsSync(index)) fs.cpSync(index, path.join(home, 'index'), { recursive: true, dereference: true, filter: (p) => path.relative(index, p).split(path.sep)[0] !== 'ctx' })
  // A link left in the copy would let the worker write into the real home (a second writer beside the real one, 4.3 §4).
  const links = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isSymbolicLink() ? [path.join(d, e.name)] : e.isDirectory() ? links(path.join(d, e.name)) : [])
  if (fs.existsSync(path.join(home, 'index'))) {
    assert.ok(!fs.lstatSync(path.join(home, 'index')).isSymbolicLink(), 'the side index is a copy, not a link to the real one')
    assert.deepEqual(links(path.join(home, 'index')), [], 'the side index holds no link')
  }
  return home
}
