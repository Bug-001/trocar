// watchdog.mjs (src/rules) — the thread that kills its rule process (RFC 5.1 §规则进程「看门狗」). It reads nothing from the main thread but one shared deadline, so a main
// thread stuck in a regex, a loop or an allocation does not stop it. The parent's event loop is not involved either.
import { workerData } from 'node:worker_threads'
import { die } from './slot.mjs'

const RUNNING_MS = 20
const IDLE_MS = 1000

const { shared, fd, capBytes, ppid } = workerData
const deadline = new BigInt64Array(shared, 0, 1)
const wake = new Int32Array(shared, 8, 1)

// Windows keeps a dead parent's pid in process.ppid.
function parentGone() {
  if (process.platform !== 'win32') return process.ppid !== ppid
  try { process.kill(ppid, 0); return false } catch (e) { return e.code === 'ESRCH' }
}

for (;;) {
  const tick = Atomics.load(wake, 0), until = Atomics.load(deadline, 0)
  if (until && process.hrtime.bigint() > until) die(fd, 'timeout')
  if (process.memoryUsage.rss() > capBytes) die(fd, 'memory')
  if (parentGone()) die(fd, 'parent')
  Atomics.wait(wake, 0, tick, until ? RUNNING_MS : IDLE_MS)
}
