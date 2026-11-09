// test/query/worker-early-deps.mjs — the query worker's deps (src/query/worker.mjs argv[3]) for test/query/worker-early.test.mjs: from load on,
// every open of a capture file under raw/ whose name does not hold TROCAR_TEST_RAW_FAST sleeps TROCAR_TEST_RAW_SLOW_MS, so the boot pass's
// rebuild of the older segments takes long while the newest one stays quick. The sleep blocks the event loop only inside an open: between two
// segments the pass yields and a request is served. node --test loads every .mjs on its own, with no worker's home in argv: then it exports
// nothing and does nothing.
import fs from 'node:fs'
import path from 'node:path'

const home = process.argv[2]
const { TROCAR_TEST_RAW_FAST: fast, TROCAR_TEST_RAW_SLOW_MS: slow } = process.env
if (home && slow) {
  const open = fs.openSync, raw = path.join(home, 'raw'), wait = new Int32Array(new SharedArrayBuffer(4))
  fs.openSync = (f, ...a) => {
    if (String(f).startsWith(raw) && !String(f).includes(fast)) Atomics.wait(wait, 0, 0, Number(slow))
    return open(f, ...a)
  }
}
export default {}
