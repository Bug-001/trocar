// test/helpers/standin.mjs — processes a test starts to stand in for something long-lived (a daemon, an agent, a mock server), which must not outlive the test.
//
//   import { spawnStandin, WITH_PARENT } from '../helpers/standin.mjs'
//   const daemon = spawnStandin()                                          // stays up until killed; ends by itself when this process is gone
//   spawn(process.execPath, [...WITH_PARENT, 'server.mjs'], { env: watchEnv(), … })   // any node process: the same watch, from the preload
//   `import ${JSON.stringify(EXIT_WITH_PARENT)}` at the top of a `node -e` / fixture script   // …or inside it
//
// Why: see exit-with-parent.mjs. A kill -9 of the test process cannot run a `finally`, so the child has to notice by itself.
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** Path of the preload that ends a process when its parent is gone. */
export const EXIT_WITH_PARENT = fileURLToPath(new URL('./exit-with-parent.mjs', import.meta.url))
/** The node arguments that load it: `spawn(process.execPath, [...WITH_PARENT, script, …])`. */
export const WITH_PARENT = Object.freeze(['--import', EXIT_WITH_PARENT])

/** `env` plus the pid the watch is to follow: this process. Without it the watch follows the parent it finds at start (a child that is orphaned before it got that far is not caught). */
export const watchEnv = (env = process.env) => ({ ...env, TROCAR_WATCH_PID: String(process.pid) })

/** A process that does nothing but stay alive until it is killed or this process is gone (`stdio: 'ignore'` unless the caller says otherwise). */
export const spawnStandin = ({ env, ...opts } = {}) => spawn(process.execPath, [...WITH_PARENT, '-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', env: watchEnv(env), ...opts })
