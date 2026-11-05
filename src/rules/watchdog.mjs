// watchdog.mjs (src/rules) — the thread that kills its rule process (RFC 5.1 §规则进程「看门狗」). It reads nothing from the main thread but one shared deadline, so a main
// thread stuck in a regex, a loop or an allocation does not stop it. The parent's event loop is not involved either.
import fs from 'node:fs'
import { parentPort, workerData } from 'node:worker_threads'
import { LIMITS } from './closed.mjs'
import { DEATHS, die, HEAD_BYTES } from './slot.mjs'

const RUNNING_MS = 20
const IDLE_MS = 1000
const STUCK_WAITS = 5
const IDLE_WINDOW_NS = 5_000_000_000n
const IDLE_CPU_US = 1_250_000 // a quarter of a core over the window
const IDLE_WINDOWS = 2
const SLOT_BYTES = HEAD_BYTES + 4 * LIMITS.bodyBytes

const { shared, fd, slotPath, capBytes, ppid } = workerData
const deadline = new BigInt64Array(shared, 0, 1)
const wake = new Int32Array(shared, 8, 1)
const over = new Int32Array(shared, 12, 1)
const beat = new Int32Array(shared, 16, 1)

// Windows keeps a dead parent's pid in process.ppid.
function parentGone() {
  if (process.platform !== 'win32') return process.ppid !== ppid
  try { process.kill(ppid, 0); return false } catch (e) { return e.code === 'ESRCH' }
}

const { ino } = fs.statSync(slotPath)
const fdInUse = (n) => { try { fs.fstatSync(n); return true } catch { return false } }
let lastBeat = 0, quiet = 0, waited = 'ok'
let windowAt = process.hrtime.bigint(), windowCpu = process.cpuUsage(), windowTick = -1, burning = 0
parentPort.postMessage('watching')
try {
  for (;;) {
    const tick = Atomics.load(wake, 0), until = Atomics.load(deadline, 0), now = process.hrtime.bigint(), beats = Atomics.load(beat, 0)
    if (until && now > until) die(fd, 'timeout')
    // No task and no clock: nothing else ends a main thread stuck in a script's timer. Quiet waits and not time, because a process stopped from outside or a sleeping machine stops this thread too.
    if (until || beats !== lastBeat || waited !== 'timed-out') { lastBeat = beats; quiet = 0 } else if (++quiet > STUCK_WAITS) die(fd, 'timeout')
    if (now - windowAt > IDLE_WINDOW_NS) { // a timer of the script's, or the thread pool: the beat goes on and no clock runs. A window a task touched says nothing.
      const { user, system } = process.cpuUsage(windowCpu)
      burning = !until && tick === windowTick && user + system > IDLE_CPU_US ? burning + 1 : 0
      if (burning >= IDLE_WINDOWS) die(fd, 'timeout')
      windowAt = now
      windowCpu = process.cpuUsage()
      windowTick = tick
    }
    const told = DEATHS[Atomics.load(over, 0) - 1]
    if (told) die(fd, told)
    if (process.memoryUsage.rss() > capBytes) die(fd, 'memory')
    const seen = fs.statSync(slotPath, { throwIfNoEntry: false }) // by path: a script can close the fd
    if (seen?.ino !== ino) die(fd, 'memory') // it can unlink the file too, and what it writes then is on the disk where this cannot see it
    if (seen.size > SLOT_BYTES) {
      fs.truncateSync(slotPath, HEAD_BYTES) // one call fills a disk on NTFS, and the disk is not this process's to keep
      die(fd, 'memory')
    }
    if (fdInUse(LIMITS.scriptFds)) die(fd, 'handles') // the lowest free number comes first, so a leak gets here
    if (parentGone()) die(fd, 'parent')
    waited = Atomics.wait(wake, 0, tick, until ? RUNNING_MS : IDLE_MS)
  }
} finally {
  process.kill(process.pid, 'SIGKILL') // this thread's `exit` goes to a main thread that may be in a script's loop for good, and then nothing is watching
}
