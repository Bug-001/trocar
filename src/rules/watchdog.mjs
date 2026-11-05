// watchdog.mjs (src/rules) — the thread that kills its rule process (RFC 5.1 §规则进程「看门狗」). It reads nothing from the main thread but one shared deadline, so a main
// thread stuck in a regex, a loop or an allocation does not stop it. The parent's event loop is not involved either.
import fs from 'node:fs'
import { parentPort, workerData } from 'node:worker_threads'
import { LIMITS } from './closed.mjs'
import { DEATHS, die, HEAD_BYTES } from './slot.mjs'

const RUNNING_MS = 20
const IDLE_MS = 200
const STUCK_WAITS = 5000 / IDLE_MS
const BEAT_NS = 1_000_000_000n
const CPU_WINDOW_NS = 5_000_000_000n
const CPU_WINDOWS = 2
const CPU_SHARE = 0.25 // of a core, with or without tasks
const CPU_PER_TASK_TIME = 4 // the heaviest honest task measured took 2.4: a regex over 16 MiB, with V8's own threads working beside it
const CPU_PER_TASK_US = 1000
const NS_PER_US = 1000
const SLOT_BYTES = HEAD_BYTES + 4 * LIMITS.bodyBytes

const { shared, fd, slotPath, capBytes, ppid } = workerData
const deadline = new BigInt64Array(shared, 0, 1)
const wake = new Int32Array(shared, 8, 1)
const over = new Int32Array(shared, 12, 1)
const beat = new Int32Array(shared, 16, 1)
const working = new BigInt64Array(shared, 24, 2)
const tasks = new Int32Array(shared, 40, 1)

// Windows keeps a dead parent's pid in process.ppid.
function parentGone() {
  if (process.platform !== 'win32') return process.ppid !== ppid
  try { process.kill(ppid, 0); return false } catch (e) { return e.code === 'ESRCH' }
}

const { ino } = fs.statSync(slotPath)
const fdInUse = (n) => { try { fs.fstatSync(n); return true } catch { return false } }
let lastBeat = 0, quiet = 0, waited = 'ok', askedAt = process.hrtime.bigint()
// The time tasks have taken up to `now`, the one running included: a long one must not look like idle burn.
const workedBy = (now) => {
  const since = Atomics.load(working, 1)
  return Atomics.load(working, 0) + (since ? now - since : 0n)
}
let windowAt = process.hrtime.bigint(), windowCpu = process.cpuUsage(), windowWorked = 0n, windowTasks = 0, burning = 0
parentPort.postMessage('watching')
try {
  for (;;) {
    const tick = Atomics.load(wake, 0), until = Atomics.load(deadline, 0), now = process.hrtime.bigint(), beats = Atomics.load(beat, 0)
    if (until && now > until) die(fd, 'timeout')
    // No task and no clock: nothing else ends a main thread stuck in a script's timer. Quiet waits and not time, because a process stopped from outside or a sleeping machine stops this thread too.
    if (until || beats !== lastBeat || waited !== 'timed-out') { lastBeat = beats; quiet = 0 } else if (++quiet > STUCK_WAITS) die(fd, 'timeout')
    if (now - askedAt > BEAT_NS) { // the main thread beats when this reaches it, so one that is stuck does not
      parentPort.postMessage('beat')
      askedAt = now
    }
    if (now - windowAt > CPU_WINDOW_NS) { // a timer of the script's, or the thread pool: the beat goes on, and a clock is only on while a task is
      const { user, system } = process.cpuUsage(windowCpu), worked = workedBy(now), done = Atomics.load(tasks, 0)
      const allowed = CPU_SHARE * Number(now - windowAt) / NS_PER_US + CPU_PER_TASK_TIME * Number(worked - windowWorked) / NS_PER_US + CPU_PER_TASK_US * (done - windowTasks)
      burning = user + system > allowed ? burning + 1 : 0
      if (burning >= CPU_WINDOWS) die(fd, 'timeout')
      windowAt = now
      windowCpu = process.cpuUsage()
      windowWorked = worked
      windowTasks = done
    }
    const told = DEATHS[Atomics.load(over, 0) - 1]
    if (told) die(fd, told)
    if (fdInUse(LIMITS.scriptFds - 1)) die(fd, 'handles') // the last one there is: first, as reading the RSS takes a file on Linux
    if (process.memoryUsage.rss() > capBytes) die(fd, 'memory')
    const seen = fs.statSync(slotPath, { throwIfNoEntry: false }) // by path: a script can close the fd
    if (seen?.ino !== ino) die(fd, 'memory') // it can unlink the file too, and what it writes then is on the disk where this cannot see it
    if (seen.size > SLOT_BYTES) {
      fs.truncateSync(slotPath, HEAD_BYTES) // one call fills a disk on NTFS, and the disk is not this process's to keep
      die(fd, 'memory')
    }
    if (parentGone()) die(fd, 'parent')
    waited = Atomics.wait(wake, 0, tick, until ? RUNNING_MS : IDLE_MS)
  }
} finally {
  process.kill(process.pid, 'SIGKILL') // this thread's `exit` goes to a main thread that may be in a script's loop for good, and then nothing is watching
}
