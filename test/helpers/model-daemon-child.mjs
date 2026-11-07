// test/helpers/model-daemon-child.mjs — the REAL model daemon (startDaemon, its real control endpoint and lock) in a process of its own, so a test
// can stop it with a signal (SIGSTOP: alive, not answering). argv[2] is JSON { platform, home, dir, env, dirs }; the parent forks it with no-real-os.cjs
// preloaded (forkModelDaemon). Only the world outside trocar is a stand-in, as in liveUnit: no key custody (doors forward only), no process is
// anybody's, an empty process table, a fixed lock identity. Sends { ready: pid } once the daemon serves.
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'

export const CHILD_IDENTITY = { start_time: '111', boot_id: 'boot-1' }

/** → the forked child, resolved once its daemon serves. The caller kills it. */
export async function forkModelDaemon({ platform, w }) {
  const child = fork(fileURLToPath(import.meta.url), [JSON.stringify({ platform, home: w.home, dir: w.dir, env: w.env, dirs: w.ctx.dirs })], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'], execArgv: ['--require', fileURLToPath(new URL('./no-real-os.cjs', import.meta.url))] })
  const [msg] = await Promise.race([once(child, 'message'), once(child, 'exit').then(([c]) => { throw new Error(`the daemon child exited (${c}) before it served`) })])
  if (!msg || msg.ready !== child.pid) throw new Error(`the daemon child said ${JSON.stringify(msg)}`)
  return child
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] && process.send) { // forked by forkModelDaemon; `node --test` also loads every file under test/ and must find nothing to run
  const { platform, home, dir, env, dirs } = JSON.parse(process.argv[2])
  const { startDaemon } = await import('../../src/collector/daemon.mjs')
  const { controlEndpoint } = await import(`../../src/collector/arch/${platform}/control-path.mjs`)
  const helper = { close: async () => {}, call: async (verb) => { if (verb === 'ps') return { procs: [] }; throw Object.assign(new Error(`not in this stand-in: ${verb}`), { code: 'helper-verb-error' }) } }
  const parts = { ownerOf: async () => null, factsOf: async () => null, proc: {}, proxyOf: () => null, systemProxy: () => null, procTable: async () => [], close: () => {}, helper }
  await startDaemon({ dir, env, home, arch: { os: platform, controlEndpoint }, getuid: () => 501, identity: () => CHILD_IDENTITY, model: { backends: { custody: 'unavailable', dirs }, parts } })
  process.send({ ready: process.pid })
}
