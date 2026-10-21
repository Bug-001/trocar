// daemon-child.mjs — a real `trocar daemon` process for test/cli/daemon-signals.test.mjs: the real runDaemonCli with its real signal wait;
// only the daemon module is a stub whose stop() takes a second and records `daemon-stop` at its very end. HOME is the test's temp dir.
// It runs only when started with `run` (the test does, with the exit-with-parent watch): `node --test` also loads this file, with no argument and the real HOME.
import fs from 'node:fs'
import path from 'node:path'
import { runDaemonCli } from '../../../src/cli/daemon.mjs'
import { appendEvent } from '../../../src/collector/core/events.mjs'

const daemon = {
  startDaemon: async ({ dir }) => {
    const lock = path.join(dir, 'lock')
    fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(lock, JSON.stringify({ pid: process.pid }))
    const timer = setInterval(() => {}, 1000) // a running daemon keeps the loop alive, as the real one does
    return {
      port: 47999,
      stop: async ({ signal } = {}) => {
        await new Promise((resolve) => setTimeout(resolve, 1000))
        appendEvent(dir, { event: 'daemon-stop', signal })
        fs.rmSync(lock, { force: true }); clearInterval(timer)
        return { failed: [] }
      },
    }
  },
}
if (process.argv[2] !== 'run') process.exit(0)
const io = { out: (s) => process.stdout.write(`${s}\n`), err: (s) => process.stderr.write(`${s}\n`) }
runDaemonCli([], { io, home: process.env.HOME, deps: { daemon } }).then((code) => { process.exitCode = code }, (e) => { console.error(e); process.exit(1) })
