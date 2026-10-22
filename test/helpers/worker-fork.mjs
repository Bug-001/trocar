// test/helpers/worker-fork.mjs — a `fork` for createQueryService (src/query/service.mjs) that starts the real query worker as the
// service does (its heap, heapFlags() and heapEnv()) with test/helpers/no-real-os.cjs preloaded, so a worker a test forks can never run a
// real OS tool (0.1 §3 「不碰真实机器」).
// `argv` is passed on after the home, as the service's own fork would.
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { heapFlags, heapEnv } from '../../src/query/warm.mjs'

const WORKER = fileURLToPath(new URL('../../src/query/worker.mjs', import.meta.url))
const NO_REAL_OS = fileURLToPath(new URL('./no-real-os.cjs', import.meta.url))

export const workerFork = (home, ...argv) =>
  fork(WORKER, [home, ...argv], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'], execArgv: ['--require', NO_REAL_OS, ...heapFlags()], env: heapEnv() })
