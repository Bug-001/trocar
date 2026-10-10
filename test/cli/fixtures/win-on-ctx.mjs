// test/cli/fixtures/win-on-ctx.mjs — a Windows `on` sandbox (4.8; plan Task 10(c)): the seven harnesses' Windows files laid out under a temp HOME, the real arch hooks
// (loadArch('win32'): the scheduled-task unit, the opt-in plan, win32Routing), the REAL gatherWin32Facts behind an injected helper (nothing on the machine is asked:
// no powershell, no schtasks, no registry — the runner of OS tools is the recording one), and a fake daemon that answers on the control socket and does the daemon's half
// of an `on` the way wiring.mjs's redirector will once 8(c)'s remainder lands: it writes the entry through the REAL writer (createProxyEntries, the same journal `off`
// undoes by). `on` runs with platform 'linux' and parts.os 'win32': hasNewCollector decides old-vs-new per platform and the win32 flip is 9(b)'s lane, not this one;
// parts is the seam that flip lands on (the same split the W27 prepare-hook tests use).
import fs from 'node:fs'
import path from 'node:path'
import { runOnCli } from '../../../src/cli/on.mjs'
import { loadArch } from '../../../src/collector/arch/index.mjs'
import { loadHarnesses } from '../../../src/collector/harness/index.mjs'
import { createProxyEntries } from '../../../src/collector/arch/win32/entries.mjs'
import { groupsOf } from '../../../src/collector/arch/win32/route-plan.mjs'
import { gatherWin32Facts } from '../../../src/collector/arch/win32/netfacts.mjs'
import { readManifest } from '../../../src/collector/core/trust/journal.mjs'
import { readAdopted } from '../../../src/netenv/adopt.mjs'
import { gatherNetFacts } from '../../../src/netenv/facts.mjs'
import { fakeIo, recordingExec } from './on-ctx.mjs'
import { tmpDir } from '../../helpers/tmp.mjs'

export const descs = await loadHarnesses()
const arch = await loadArch('win32')
export const groups = groupsOf(descs)
/** the kernel's own process: what forwarder.lock names and the helper's snapshot shows (a listener on the group's port). */
const KERNEL_ROW = { pid: 6120, name: 'asight-forwarder.exe', exe: 'C:\\Users\\u\\.asight\\collector\\kernel\\asight-forwarder.exe', startedAt: 1760000000000, sessionId: 1, integrity: 'medium', tokenDenied: false, cmdline: null, cmdlineState: 'not-asked' }

/** A fake resident helper: the read verbs the facts ask, each answer shaped as the real one gives it. `internet` = the Internet Settings values (the system proxy; `ProxyEnable` a REG_DWORD, `ProxyServer` the address), `loginEnv` = HKCU\Environment's. */
export const helperOf = ({ procs = [KERNEL_ROW], listen = [{ pid: 6120, state: 'listen', localAddr: '127.0.0.1', localPort: 17992, remoteAddr: '0.0.0.0', remotePort: 0 }], established = [], ifaces = [{ name: 'Ethernet', description: 'Intel(R) Ethernet', up: true }], internet = { ProxyEnable: { kind: 'REG_DWORD', value: 0 } }, loginEnv = {} } = {}) => ({
  call: async (verb, args = {}) => {
    if (verb === 'ps') return { sessionId: 1, procs }
    if (verb === 'tcp-table') return { rows: [...listen, ...established].filter((r) => !args.states || args.states.includes(r.state)) }
    if (verb === 'net-if') return { interfaces: ifaces }
    if (verb === 'route') return { dest: '1.1.1.1', ifIndex: 12, iface: ifaces[0] || null }
    if (verb === 'reg-read') {
      if (args.key.endsWith('Internet Settings')) return { keyExists: true, values: internet }
      if (args.key === 'Environment') return { keyExists: true, values: loginEnv }
      throw Object.assign(new Error(`forbidden-key: ${args.key}`), { code: 'helper-forbidden-key' })
    }
    throw Object.assign(new Error(`not in the fake: ${verb}`), { code: 'helper-verb-error' })
  },
  close: async () => {},
})

/** The daemon's world: the kernel's lock and the ingress ports a started daemon leaves (the entry the daemon writes points at the group's port). */
const GROUP_PORTS = { 'codex.env': 17992 }
const LISTENER_TOKEN = 's3-listener-token'
/** The address the kernel's listener takes (forms.mjs proxyUrl): credentials of the group, an address on loopback. */
export const kernelUrl = (g) => `http://${g}:${LISTENER_TOKEN}@127.0.0.1:${GROUP_PORTS[g]}`

/** Lay the seven harnesses' Windows files out (kimi has none: both its forms are opt-in items, so it is the one skipped). `codexProxy` is the user's own proxy in codex's .env — the prior an `on` must record and hand the kernel. */
export const seedSeven = (put, { codexProxy = null } = {}) => {
  put('.codex/.env', `OPENAI_API_KEY=sk-test\n${codexProxy ? `HTTPS_PROXY=${codexProxy}\n` : ''}`)
  put('.claude/settings.json', '{\n  "model": "x"\n}\n')
  put('.dsh/cordis.patch.yml', '[]\n')
  put('.zcode/cli/config.json', '{\n  "model": "lab/m"\n}\n')
  put('AppData/Local/hermes/.env', 'OPENAI_API_KEY=sk-hermes\n')
  put('.config/opencode/opencode.json', '{}\n')
  put('.bashrc', '# a shell rc, not any harness\'s\n')
}

/** A Windows `on` world. `internet` / `loginEnv` feed the fake helper (the system proxy, HKCU\Environment); `envSeed` lays the agent files out (the default gives every
 *  harness a file to change, codex's holding the user's own proxy). `prep` is what the arch prepare hook answers (the default: the kernel found and verified, SAC off).
 *  → { home, dir, envFile, put, helper, run, facts, writeEntry } — `run(argv, over)` runs the real `on` CLI in it, `facts(over)` gathers the real netFacts over what
 *  the world holds now, `writeEntry(g)` is the daemon's half of an `on` (the real writer). */
export function winWorld({ internet = { ProxyEnable: { kind: 'REG_DWORD', value: 0 } }, loginEnv = {}, envSeed = null, prep = { notes: ['the kernel line'], kernel: { version: 'v1.19.32', package: 'asight-kernel-win32-x64', exe: 'asight-forwarder.exe', sha256: 'a'.repeat(64) }, sac: 'off' } } = {}) {
  const home = tmpDir('asight-win-ctx-')
  const dir = path.join(home, '.asight', 'collector')
  const put = (rel, text) => { const f = path.join(home, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); return f }
  if (envSeed) envSeed(put); else seedSeven(put)
  const envFile = path.join(home, '.codex', '.env')
  put('.asight/collector/forwarder.lock', `${JSON.stringify({ pid: KERNEL_ROW.pid, startedAt: KERNEL_ROW.startedAt, endpoint: 'tcp:127.0.0.1:19001', config: path.join(dir, 'forwarder', 'config.json') })}\n`)
  put('.asight/collector/ingress.json', `${JSON.stringify({ enginePort: 17990, groupPorts: GROUP_PORTS, ingressToken: 'a'.repeat(32), listenerToken: LISTENER_TOKEN })}\n`)
  const helper = helperOf({ internet, loginEnv })
  const winCtx = () => ({ os: 'win32', home, env: new Map(), running: [], readText: (f) => { try { return fs.readFileSync(f, 'utf8') } catch { return null } },
    readTextOrError: (f) => { try { return { text: fs.readFileSync(f, 'utf8'), error: null } } catch (e) { return { text: null, error: { code: e.code } } } },
    listDir: (d) => { try { return fs.readdirSync(d) } catch { return [] } }, collectorDir: dir, caPem: null })
  const writeEntry = (g) => createProxyEntries({ dir, home, groups, ctx: winCtx(), ingress: () => JSON.parse(fs.readFileSync(path.join(dir, 'ingress.json'), 'utf8')), manifest: () => readManifest(dir, fs), fs }).write([{ g, harness: (groups.find((x) => x.g === g) || {}).harness, entry: 'auto' }])
  const parts = { os: 'win32', osRootsFile: null, harnesses: descs, scan: async () => [], match: () => ({ agent: null }), arch: { ...arch, prepare: async () => prep } }
  const deps = (over = {}) => ({
    parts, request: async (q) => { // the fake daemon: /on does the daemon's half (the real writer, the groups this world routes), the rest answers like a daemon at rest
      if (q.method === 'POST' && q.path === '/on') {
        for (const g of over.onWrites || ['codex.env']) writeEntry(g)
        return { desired: 'on', actual: 'on', recording: true, agents: [], helper: { ok: true } }
      }
      return {}
    },
    socketPath: path.join(home, 'run', 'asight.sock'), exec: recordingExec().run,
    netFactsDeps: async () => ({ harnesses: descs, archFacts: gatherWin32Facts, deps: { helper: over.helper || helper } }),
    netenv: async () => ({ at: '2026-10-10T00:00:00.000Z', products: [], unknown: [{ reason: 'a test: no VPN probe runs here' }] }),
    helperState: () => ({ ok: true }), linger: () => true, roots: { node: [], osText: '' }, freePort: async () => 47011,
    script: '/repo/bin/asight.mjs', sleep: async () => {}, user: 'alice', getuid: () => 1000, fs, ...over,
  })
  const run = async (argv, over = {}) => {
    const io = fakeIo()
    const exit = await runOnCli(argv, { io, env: { HOME: home, USERPROFILE: home, XDG_RUNTIME_DIR: path.join(home, 'run'), ...(over.env || {}) }, home, platform: 'linux', deps: deps(over.deps) })
    return { exit, io, text: io.text(), stdout: () => io.stdoutText(), stderr: () => io.stderrText(), json: () => JSON.parse(io.stdoutText()) }
  }
  const statusOf = (ids = descs.map((d) => d.name)) => ({ daemon: { state: 'running', pid: 4121, reply: { engine: { port: 17990 }, links: [], negatives: [], agents: [] }, lock: { engine_port: 17990 } },
    link: { attached: true, helper: 'ok', ids: [] }, harnesses: ids.map((id) => ({ id, installed: true, desired: 'on', entry: { state: 'intact' }, installedAt: '2026-10-10T09:47:00.000Z', procs: [] })) })
  const facts = (over = {}) => gatherNetFacts({ platform: 'win32', home, env: { USERPROFILE: home }, harnesses: descs, status: over.status || statusOf(over.ids),
    netenv: { result: { products: [], unknown: [] } }, archFacts: gatherWin32Facts, adopted: 'adopted' in over ? over.adopted : readAdopted(home, { fs }), deps: { helper: over.helper || helper } })
  return { home, dir, envFile, put, helper, run, facts, writeEntry, groups }
}
