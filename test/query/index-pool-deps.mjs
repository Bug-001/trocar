// test/query/index-pool-deps.mjs — a deps module for test/query/index-pool.test.mjs, loaded by each index thread (index-pool.mjs): in a worker
// thread, TROCAR_TEST_THREAD_DIES=open ends the thread as it opens a capture file, =write as it renames a finished index file into place (the
// temp file written, the index not yet). The worker's own thread is never touched. Exports nothing.
import fs from 'node:fs'
import { isMainThread } from 'node:worker_threads'

const how = process.env.TROCAR_TEST_THREAD_DIES
if (!isMainThread && how) {
  const open = fs.openSync, rename = fs.renameSync
  fs.openSync = (f, ...a) => { if (how === 'open' && /\.sealed$/.test(String(f))) process.exit(1); return open(f, ...a) }
  fs.renameSync = (a, b) => { if (how === 'write' && /\.json$/.test(String(b))) process.exit(1); return rename(a, b) }
}
export default {}
