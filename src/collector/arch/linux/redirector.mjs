// redirector.mjs (arch/linux) — the Linux implementation of the Redirector contract in
// core/redirector.mjs (RFC 4.6 §Linux 机制, §开关语义, §特权助手与按用户运行 D36). It wraps the capability
// helper's client and adds what core needs and the client lacks:
//   - exec events become OS-neutral ProcFacts read from /proc at once (argv must be taken at exec time:
//     some agents rewrite their title later), only for this instance's uid (other users' processes are
//     not ours, and their environ is unreadable anyway);
//   - scan() lists this uid's live processes (startup and every `on`, §身份与信任);
//   - directCount(pid): the agent's connections still going direct (§开关语义「为什么开了还没采到」).
// No harness names, no policy: the daemon wires this to core.
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { REDIRECTOR_PROTO } from './redirector-client.mjs'
import { readFacts, listPids, readStatus, directConnections } from './procinfo.mjs'

export function createLinuxRedirector({ makeClient, procRoot = '/proc', uid = process.getuid(), lingerDir = '/var/lib/systemd/linger', userName = () => os.userInfo().username }) {
  const ev = new EventEmitter()
  let client = null
  let enginePort = null

  function wire(c) {
    c.on('exec', ({ tgid, comm }) => {
      const f = readFacts(tgid, { root: procRoot, source: 'exec', onExeError: (x) => factsError(x, comm) })
      if (f && f.uid === uid) ev.emit('exec', f)
    })
    c.on('exit', ({ tgid }) => ev.emit('exit', { pid: tgid }))
    c.on('flow-meta', (m) => ev.emit('flow-meta', m))
    c.on('down', (d) => { if (client === c) ev.emit('down', d) })
    c.on('version-mismatch', (m) => ev.emit('version-mismatch', m))
    c.on('loader-error', (m) => ev.emit('helper-error', m))
    c.on('heartbeat-error', (m) => ev.emit('heartbeat-error', m))
  }
  const need = () => { if (!client) throw new Error('redirector helper is not running'); return client }
  // a process of this uid whose exe cannot be read is never judged: say so (D-30) instead of dropping its exec
  const factsError = (x, comm) => { if (x.uid === uid) ev.emit('facts-error', { pid: x.pid, code: x.code, reason: `/proc/${x.pid}/exe of ${comm || 'a process'} is unreadable (${x.message}); it is never judged, its connections go direct` }) }

  return Object.assign(ev, {
    async start() { client = makeClient(); wire(client); await client.start(); return client.loaderInfo },
    async close() { const c = client; client = null; if (c) await c.close() },
    configure(port) { enginePort = port; return need().configure(port) },
    attach: () => need().attach(),
    detach: () => need().detach(),
    status: () => need().status(),
    heartbeat: () => need().heartbeat(),
    lookup: (peer) => (client ? client.lookup(peer) : Promise.reject(Object.assign(new Error('redirector helper is not running'), { code: 'loader-down' }))), // never a miss (D-13)
    watch: (pid, verdict) => need().watch(pid, verdict),
    unwatch: (pid) => need().unwatch(pid),
    async scan() {
      const out = []
      for (const pid of listPids({ root: procRoot })) {
        const st = readStatus(pid, { root: procRoot })
        if (!st || st.uid !== uid) continue
        const f = readFacts(pid, { root: procRoot, source: 'scan', onExeError: (x) => factsError(x, null) })
        if (f) out.push(f)
      }
      return out
    },
    directCount: (pid) => directConnections(pid, { root: procRoot, enginePort }), // {count, error}: unknown is never 0 (D-17)
    helperInfo: () => (client ? client.loaderInfo : { pid: null, proto: null, build: null }),
    // Whether logind keeps this user's daemon after the last logout (4.6 OPEN 登出后): true / false, null = unknown.
    linger() { try { fs.statSync(path.join(lingerDir, userName())); return true } catch (e) { return e && e.code === 'ENOENT' ? false : null } },
    expectedProto: REDIRECTOR_PROTO,
  })
}
