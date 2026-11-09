// test/query/worker-early-deps.mjs — the query worker's deps (src/query/worker.mjs argv[3]) for test/query/worker-early.test.mjs, loaded by the
// worker and by each of its index threads (index-pool.mjs). While the file TROCAR_TEST_RAW_HOLD exists, every open of a capture file under raw/
// whose name does not hold TROCAR_TEST_RAW_FAST waits: so the boot pass cannot end until the test removes the file, whatever the pool's size or
// the machine's load, while the newest segment stays quick. An index thread waits until the file is gone (at most HOLD_MAX_MS, under the pool's
// stuck timer); the worker's own thread waits at most SLOW_MS an open, so between two segments it yields and a request is served. node --test
// loads every .mjs on its own, with no worker's home: then it does nothing.
import fs from 'node:fs'
import path from 'node:path'
import { isMainThread, workerData } from 'node:worker_threads'

const SLOW_MS = 1000, HOLD_MAX_MS = 30_000, POLL_MS = 20
const home = isMainThread ? process.argv[2] : workerData && workerData.indexPool
const { TROCAR_TEST_RAW_FAST: fast, TROCAR_TEST_RAW_HOLD: hold } = process.env
if (home && hold) {
  const open = fs.openSync, raw = path.join(home, 'raw'), wait = new Int32Array(new SharedArrayBuffer(4))
  const max = isMainThread ? SLOW_MS : HOLD_MAX_MS
  fs.openSync = (f, ...a) => {
    if (String(f).startsWith(raw) && !String(f).includes(fast)) for (let t = 0; t < max && fs.existsSync(hold); t += POLL_MS) Atomics.wait(wait, 0, 0, POLL_MS)
    return open(f, ...a)
  }
}
export default {}
