// watchdog.mjs (src/rules) — the thread that kills its rule process (RFC 5.1 §规则进程「看门狗」). It reads nothing from the main thread but one shared deadline, so a main
// thread stuck in a regex, a loop or an allocation does not stop it. The parent's event loop is not involved either.
import fs from 'node:fs'
import { parentPort, workerData } from 'node:worker_threads'
import { LIMITS } from './closed.mjs'
import { DEATHS, die, HEAD_BYTES } from './slot.mjs'

const RUNNING_MS = 20
const IDLE_MS = 1000
const STUCK_NS = 5_000_000_000n
const IDLE_CPU_SHARE = 0.25
const US_PER_NS = 0.001
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
let lastBeat = 0, beatAt = process.hrtime.bigint()
let lastCpu = 0, lastNow = beatAt, lastUntil = 1n, idleCpu = 0, idleNs = 0n
parentPort.postMessage('watching')
try {
  for (;;) {
    const tick = Atomics.load(wake, 0), until = Atomics.load(deadline, 0), now = process.hrtime.bigint(), beats = Atomics.load(beat, 0)
    if (until && now > until) die(fd, 'timeout')
    if (until || beats !== lastBeat) { lastBeat = beats; beatAt = now }
    if (now - beatAt > STUCK_NS) die(fd, 'timeout') // no task and no clock: nothing else ends a main thread stuck in a script's timer
    const { user, system } = process.cpuUsage(), cpu = user + system
    if (!until && !lastUntil) { // both ends idle: a task that came and went between two looks is not idle time
      idleCpu += cpu - lastCpu
      idleNs += now - lastNow
    }
    [lastCpu, lastNow, lastUntil] = [cpu, now, until]
    if (idleNs > STUCK_NS) {
      if (idleCpu > Number(idleNs) * US_PER_NS * IDLE_CPU_SHARE) die(fd, 'timeout') // a timer of the script's, or the thread pool: the beat goes on and no clock runs
      idleCpu = 0
      idleNs = 0n
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
    if (parentGone()) die(fd, 'parent')
    Atomics.wait(wake, 0, tick, until ? RUNNING_MS : IDLE_MS)
  }
} finally {
  process.kill(process.pid, 'SIGKILL') // this thread's `exit` goes to a main thread that may be in a script's loop for good, and then nothing is watching
}
