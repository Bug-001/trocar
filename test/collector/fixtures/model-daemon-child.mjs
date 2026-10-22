// model-daemon-child.mjs — a REAL model daemon process for test/collector/model-stop-barrier-e2e.test.mjs: the real runDaemonCli (its real
// signal wait and exit code) over the real daemon module. The only wrapping is startDaemon's `model` seam, as test/helpers/model-daemon.mjs
// uses it: the key custody (an in-Node stub, so this process runs the install itself first, over HOME) and the OS readers under the door parts
// (test/helpers/model-io.mjs), which read the agent's facts from the JSON file the test rewrites (TROCAR_E2E_AGENT; win32: the fake helper's
// fixture TROCAR_E2E_FX). It runs only when started with `run`: `node --test` also loads this file, with no argument and the real HOME.
import fs from 'node:fs'
import path from 'node:path'
if (process.argv[2] !== 'run') process.exit(0)

const { runDaemonCli } = await import('../../../src/cli/daemon.mjs')
const D = await import('../../../src/collector/daemon.mjs')
const { runInstall } = await import('../../../src/collector/model-install.mjs')
const { sourcesCtx } = await import('../../../src/collector/arch/model-backends.mjs')
const { loadHarnesses } = await import('../../../src/collector/harness/index.mjs')
const { renderHook } = await import('../../../src/collector/harness/templates/index.mjs')
const { renderWrapper } = await import('../../../src/collector/arch/darwin/wrapper.mjs')
const { custodyStub } = await import('../../helpers/custody-stub.mjs')
const { rootStoreStub } = await import('../../helpers/model-world.mjs')
const { darwinExec, win32Io } = await import('../../helpers/model-io.mjs')

const os = process.env.TROCAR_E2E_OS
const home = process.env.HOME
const env = { ...process.env }
const dirs = { appSupport: path.join(home, 'Library', 'Application Support'), localAppData: path.join(home, 'AppData', 'Local') }
const ctx = sourcesCtx({ os, home, env, cwd: home, dirs })
ctx.exists = (p) => (p === home || p.startsWith(`${home}${path.sep}`)) && fs.existsSync(p)
const harnesses = await loadHarnesses()
const custody = custodyStub()
const owns = (p) => { try { return fs.statSync(p).uid === process.getuid() } catch { return null } }
const inst = await runInstall({ os, home, env, harnesses, custody, rootStore: rootStoreStub(), ctx, owns, renderHook, wrapperKit: { renderWrapper } })
if (inst.exit !== 0) { console.error(`install: ${JSON.stringify(inst)}`); process.exit(3) }

// the agent as the test last wrote it: every read takes the file again, so the door sees the ports the agent opened since
const fresh = () => { const a = JSON.parse(fs.readFileSync(process.env.TROCAR_E2E_AGENT, 'utf8')); return { ...a, ports: new Set(a.ports) } }
const a = new Proxy({}, { get: (_, k) => fresh()[k] })
const io = os === 'win32' ? win32Io(a, { fx: process.env.TROCAR_E2E_FX }).io : { exec: darwinExec(a) }
const { controlEndpoint } = await import(`../../../src/collector/arch/${os}/control-path.mjs`)
const startDaemon = (o) => D.startDaemon({ ...o, arch: { os, controlEndpoint }, harnesses, getuid: () => 501, identity: () => ({ start_time: '111', boot_id: 'boot-1' }),
  model: { backends: { custody, dirs }, io } })
const cli = { out: (s) => process.stdout.write(`${s}\n`), err: (s) => process.stderr.write(`${s}\n`) }
process.exitCode = await runDaemonCli([], { io: cli, env, home, deps: { startDaemon } })
