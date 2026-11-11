// linux-daemon-child.mjs — a REAL daemon process on Linux's entry (runDaemon), for test/collector/op-lock-e2e.test.mjs: its own event loop and its own control socket. The helper
// (the fake loader) and /proc are stand-ins, as in daemon.test.mjs; `bundleMs` is what brings the once-a-day round to now. It runs only when started with `run`: `node --test`
// also loads this file, with no argument and the real HOME.
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { HOST_UID } from '../../helpers/platform-shape.mjs'
if (process.argv[2] !== 'run') process.exit(0)

const { startDaemon } = await import('../../../src/collector/daemon.mjs')
const { installCollector } = await import('../../../src/collector/install.mjs')
const { createRedirectorClient } = await import('../../../src/collector/arch/linux/redirector-client.mjs')
const { createLinuxRedirector } = await import('../../../src/collector/arch/linux/redirector.mjs')
const { default: cc } = await import('../../../src/collector/harness/claude-code.mjs')
const { fakeProc } = await import('../arch/linux/fixtures/fake-proc.mjs')

const FAKE = fileURLToPath(new URL('../arch/linux/fixtures/fake-loader.mjs', import.meta.url))
const [home, socketPath, bundleMs] = process.argv.slice(3)
const p = fakeProc(path.join(path.dirname(home), 'proc')) // in the test's own temp directory: this process ends by SIGKILL, so nothing of its own would remove it
await installCollector({ home, env: { HOME: home }, osName: 'none', harnesses: [cc], freePort: async () => 0 })
const makeClient = () => createRedirectorClient({ binary: process.execPath, args: [FAKE], env: { ...process.env, TROCAR_FAKE_LOADER: '1' }, autoHeartbeatMs: 0 })
const arch = { os: 'linux', createRedirector: () => createLinuxRedirector({ makeClient, procRoot: p.root, uid: HOST_UID }) }
await startDaemon({ dir: path.join(home, '.trocar', 'collector'), socketPath, arch, harnesses: [cc], bundleMs: Number(bundleMs) })
console.log('ready')
