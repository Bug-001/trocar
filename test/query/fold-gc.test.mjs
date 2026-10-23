// 3.5 §内存有界: the measured heap bound looks at the live heap (a forced full collection) by the stored bytes folded since the last
// look, never once per slice: a session folded in many background slices forces about as many collections as one folded at once.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import v8 from 'node:v8'
import vm from 'node:vm'
import { tmpDir } from '../helpers/tmp.mjs'
import { bigSession } from './big-session.mjs'
import { runQuery } from '../../src/query/named/index.mjs'
import { extendSession } from '../../src/query/named/session.mjs'

// liveHeap() takes globalThis.gc when there is one: count what it forces
v8.setFlagsFromString('--expose-gc')
const real = vm.runInNewContext('gc')
let forced = 0
globalThis.gc = () => { forced++; real() }

const grown = (p) => { const home = path.join(tmpDir(p), '.trocar'), s = bigSession({ home, growth: 2_000, subEvery: 3, subLanes: 2 }); s.append(120); return { home, s } }

test('forced collections do not scale with the number of background slices (3.5 §内存有界)', async () => {
  const a = grown('trocar-foldgc-once-')
  forced = 0
  await runQuery('session', { id: a.s.id }, { home: a.home, fs })
  const once = forced
  const b = grown('trocar-foldgc-bg-')
  forced = 0
  let slices = 0
  while (await extendSession({ home: b.home, fs, writer: true }, b.s.id, 5)) slices++
  assert.ok(slices > 20, `many slices (${slices})`)
  // one state each way, made at the same heap base
  assert.ok(forced <= once + 1, `background ${forced} forced collections over ${slices} slices; one request ${once}`)
})
