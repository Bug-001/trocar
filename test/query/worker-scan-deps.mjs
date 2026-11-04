// test/query/worker-scan-deps.mjs — the `deps` module (worker.mjs argv[3]) of test/query/reread.test.mjs. The upgrade scan's look at the flat
// fold log of the session TROCAR_TEST_SCAN_AT says `<gate>.held` and stops the worker until the file named by TROCAR_TEST_SCAN_GATE appears, so
// what the test sends lands in the scan, past the sessions before that one. node --test loads every .mjs on its own, with no gate: then it does nothing.
import fs from 'node:fs'

const gate = process.env.TROCAR_TEST_SCAN_GATE, at = process.env.TROCAR_TEST_SCAN_AT, exists = fs.existsSync, sleep = new Int32Array(new SharedArrayBuffer(4))
if (gate) fs.existsSync = (p) => {
  if (String(p).endsWith(`${at}.fold.ndjson`) && !exists(gate)) {
    fs.writeFileSync(`${gate}.held`, '')
    while (!exists(gate)) Atomics.wait(sleep, 0, 0, 10)
  }
  return exists(p)
}
export default {}
