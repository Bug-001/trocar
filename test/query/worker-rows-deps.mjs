// test/query/worker-rows-deps.mjs — the query worker's deps (src/query/worker.mjs argv[3]) for test/query/worker-rows.test.mjs: an empty machine
// for `status`, `beforeRows`, which holds the worker's first pass over the rows until the file named by TROCAR_TEST_ROWS_GATE appears (or fails
// it, TROCAR_TEST_ROWS_FAIL), and `beforeTitles`, which holds the title pass behind it the same way (TROCAR_TEST_TITLES_GATE), so a test forces
// what is answered before each ends instead of timing it. From the title pass on, a raw file named by TROCAR_TEST_RAW_LOST cannot be opened and
// each open under raw/ takes TROCAR_TEST_RAW_SLOW_MS. The sweep's first look for a head file says `<gate>.held` and stops the worker until the file
// named by TROCAR_TEST_SWEEP_GATE appears; from then on no raw file opens. node --test loads every .mjs on its own, with no worker's home in argv: then it exports nothing and does
// nothing.
import fs from 'node:fs'
import path from 'node:path'
import { boardDeps } from '../helpers/board-world.mjs'
import { headFile } from '../../src/query/ctx-files.mjs'

const { TROCAR_TEST_ROWS_GATE: gate, TROCAR_TEST_ROWS_FAIL: fails, TROCAR_TEST_TITLES_GATE: titlesGate, TROCAR_TEST_RAW_SLOW_MS: slow, TROCAR_TEST_SWEEP_GATE: sweepGate } = process.env
const home = process.argv[2] && path.dirname(process.argv[2])
let lost = process.env.TROCAR_TEST_RAW_LOST
const held = async (file) => { while (file && !fs.existsSync(file)) await new Promise((r) => setTimeout(r, 10)) }
function spoilRaw() {
  const open = fs.openSync, raw = path.join(process.argv[2], 'raw'), wait = new Int32Array(new SharedArrayBuffer(4))
  fs.openSync = (f, ...a) => {
    if (lost && String(f).includes(lost)) throw Object.assign(new Error('injected: this record cannot be read'), { code: 'EIO' })
    if (slow && String(f).startsWith(raw)) Atomics.wait(wait, 0, 0, Number(slow))
    return open(f, ...a)
  }
}
function holdSweep() {
  const exists = fs.existsSync, head = path.basename(headFile('', 'x')), sleep = new Int32Array(new SharedArrayBuffer(4))
  fs.existsSync = (p) => {
    if (path.basename(String(p)) === head && !exists(sweepGate)) {
      fs.writeFileSync(`${sweepGate}.held`, '')
      while (!exists(sweepGate)) Atomics.wait(sleep, 0, 0, 10)
      lost = path.join(process.argv[2], 'raw')
    }
    return exists(p)
  }
}
if (home && sweepGate) holdSweep()

export default home ? {
  ...await boardDeps({ platform: process.platform, home, env: { HOME: home, USERPROFILE: home }, dirs: null }),
  beforeRows: async () => { if (fails) throw new Error('injected: the row pass failed'); await held(gate) },
  beforeTitles: async () => { spoilRaw(); await held(titlesGate) },
} : {}
