// redirector.mjs (arch/linux) — the Linux implementation of the Redirector contract in
// core/redirector.mjs (RFC 4.6 §Linux 机制, §开关语义, §特权助手与按用户运行 D36). It wraps the capability
// helper's client and adds what core needs and the client lacks:
//   - exec events become OS-neutral ProcFacts read from /proc at once (argv must be taken at exec time:
//     some agents rewrite their title later), only for this instance's uid (other users' processes are
//     not ours, and their environ is unreadable anyway);
//   - scan() lists this uid's live processes (startup and every `on`, §身份与信任);
//   - directCount(pid): the agent's connections still going direct (§开关语义「为什么开了还没采到」);
//   - setBeatGate(fn): the gate every automatic heartbeat asks first (the daemon re-reads state.json there), kept across the client being made.
// No harness names, no policy: the daemon wires this to core.
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { REDIRECTOR_PROTO } from './redirector-client.mjs'
import { readFacts, listPids, readStatus, directConnections } from './procinfo.mjs'

/** Whether logind keeps `user`'s daemon after their last logout (4.6 OPEN 登出后, 1.6 §1.1): `/var/lib/systemd/linger/<user>` is there or not → `{ state: true | false }`; a file that cannot be told (EACCES, ENOTDIR …)
 *  is `{ state: null, error }` with the file and the errno — never "off". Read-only, and never `loginctl` (R8: trocar does not enable linger, it says how). The daemon's `daemon-start` event reads it the same way. */
/** systemd's per-user linger flags: a file named after the user means their manager outlives their last session. */
const LINGER_DIR = '/var/lib/systemd/linger'
export function lingerRead({ user = null, dir = LINGER_DIR, fs: fsx = fs } = {}) {
  let name = user
  if (!name) { try { name = os.userInfo().username } catch (e) { return { state: null, error: `the user name could not be read (${(e && e.message) || e})` } } }
  const file = path.join(dir, name)
  try { fsx.statSync(file); return { state: true } } catch (e) { return e && e.code === 'ENOENT' ? { state: false } : { state: null, error: `${file}: ${(e && e.code) || (e && e.message) || e}` } }
}
/** `lingerRead` as true | false | null (null = could not be read; the errno is in `lingerRead`'s `error`). */
export const lingerState = (o) => lingerRead(o).state

export function createLinuxRedirector({ makeClient, procRoot = '/proc', uid = process.getuid(), lingerDir = LINGER_DIR, userName = () => os.userInfo().username }) {
  const ev = new EventEmitter()
  let client = null
  let enginePort = null
  let gate = null

  function wire(c) {
    c.on('exec', ({ tgid, comm }) => {
      const f = readFacts(tgid, { root: procRoot, source: 'exec', onExeError: (x) => factsError(x, comm) })
      if (f && f.uid === uid) ev.emit('exec', f)
    })
    c.on('exit', ({ tgid }) => { unreadable.delete(tgid); ev.emit('exit', { pid: tgid }) })
    c.on('flow-meta', (m) => ev.emit('flow-meta', m))
    c.on('down', (d) => { if (client === c) ev.emit('down', d) })
    c.on('version-mismatch', (m) => ev.emit('version-mismatch', m))
    c.on('loader-error', (m) => ev.emit('helper-error', m))
    c.on('heartbeat-error', (m) => ev.emit('heartbeat-error', m))
  }
  const need = () => { if (!client) throw new Error('capability helper is not running'); return client }
  // a process of this uid whose exe cannot be read is never judged: say so (D-30) instead of dropping its exec. The event
  // carries what is still readable (comm, the command line) so the daemon can tell a process that could be an agent from one
  // that is merely not dumpable (4.6 exe-unreadable); the helper's own pid is ours, never a finding. unreadable() lists the
  // ones seen since the last scan that are still there: what status counts as "unjudged" (review B-1)
  const unreadable = new Map()
  const factsError = (x, comm) => {
    if (x.uid !== uid || (client && client.loaderInfo && x.pid === client.loaderInfo.pid)) return
    const name = comm || x.comm || null
    unreadable.set(x.pid, { pid: x.pid, comm: name, errno: x.code || null, argv: x.argv || [] })
    ev.emit('facts-error', { os: 'linux', pid: x.pid, code: x.code, comm: name, argv: x.argv || [], reason: `/proc/${x.pid}/exe of ${name || 'a process'} is unreadable (${x.message}); it is never judged, its connections go direct` })
  }

  return Object.assign(ev, {
    async start() { client = makeClient(); wire(client); if (gate && client.setBeatGate) client.setBeatGate(gate); await client.start(); return client.loaderInfo },
    setBeatGate(fn) { gate = typeof fn === 'function' ? fn : null; if (client && client.setBeatGate) client.setBeatGate(gate) },
    async close() { const c = client; client = null; if (c) await c.close() },
    configure(port) { enginePort = port; return need().configure(port) },
    attach: () => need().attach(),
    detach: () => need().detach(),
    status: () => need().status(),
    heartbeat: () => need().heartbeat(),
    lookup: (peer) => (client ? client.lookup(peer) : Promise.reject(Object.assign(new Error('capability helper is not running'), { code: 'loader-down' }))), // never a miss (D-13)
    watch: (pid, verdict) => need().watch(pid, verdict),
    unwatch: (pid) => need().unwatch(pid),
    unreadable: () => [...unreadable.values()],
    async scan() {
      const out = []
      unreadable.clear() // this scan names every one that is there now
      for (const pid of listPids({ root: procRoot })) {
        const st = readStatus(pid, { root: procRoot })
        if (!st || st.uid !== uid) continue
        const f = readFacts(pid, { root: procRoot, source: 'scan', onExeError: (x) => factsError(x, null) })
        if (f) out.push(f)
      }
      return out
    },
    directCount: (pid) => directConnections(pid, { root: procRoot, enginePort }), // {count, error}: unknown is never 0 (D-17)
    helperInfo: () => (client ? { ...client.loaderInfo, ...(client.counters || {}) } : { pid: null, proto: null, build: null }), // + unparsable lines, timed-out requests (D-13)
    // Whether logind keeps this user's daemon after the last logout (4.6 OPEN 登出后): true / false, null = unknown (`lingerRead()` says why).
    linger() { return this.lingerRead().state },
    lingerRead() { try { return lingerRead({ user: userName(), dir: lingerDir }) } catch (e) { return { state: null, error: `the user name could not be read (${(e && e.message) || e})` } } },
    expectedProto: REDIRECTOR_PROTO,
  })
}
