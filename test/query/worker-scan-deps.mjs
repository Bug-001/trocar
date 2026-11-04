// test/query/worker-scan-deps.mjs — the `deps` module (worker.mjs argv[3]) of test/query/reread.test.mjs. The upgrade scan's look at the flat
// fold log of the session TROCAR_TEST_SCAN_AT says `<gate>.held` and stops the worker until the file named by TROCAR_TEST_SCAN_GATE appears, so
// what the test sends lands in the scan, past the sessions before that one. The first remove or cut of a file whose name starts with
// TROCAR_TEST_KILL_AT kills the worker where it stands. node --test loads every .mjs on its own, with neither: then it does nothing.
import fs from 'node:fs'
import path from 'node:path'

const gate = process.env.TROCAR_TEST_SCAN_GATE, at = process.env.TROCAR_TEST_SCAN_AT, killAt = process.env.TROCAR_TEST_KILL_AT, exists = fs.existsSync, sleep = new Int32Array(new SharedArrayBuffer(4))
if (gate) fs.existsSync = (p) => {
  if (String(p).endsWith(`${at}.fold.ndjson`) && !exists(gate)) {
    fs.writeFileSync(`${gate}.held`, '')
    while (!exists(gate)) Atomics.wait(sleep, 0, 0, 10)
  }
  return exists(p)
}
if (killAt) {
  for (const verb of ['rmSync', 'truncateSync']) {
    const real = fs[verb]
    fs[verb] = (p, ...a) => { if (path.basename(String(p)).startsWith(killAt)) process.kill(process.pid, 'SIGKILL'); return real(p, ...a) }
  }
}
export default {}
