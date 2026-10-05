#!/usr/bin/env node
// Fake Linux redirector loader — speaks the exact newline-JSON line protocol of the
// real C loader (src/collector/arch/linux/redirector/redirector.c), with an in-memory
// model of the kernel state instead of eBPF. Used by redirector-client.test.mjs so the
// Node client's protocol handling is exercised end-to-end with a real spawned process,
// no root and no eBPF. Test-only ops are prefixed `__`; the real loader rejects them.
import readline from 'node:readline'

// node --test discovers every file under test/ as a test file and runs it; this fixture is
// not a test and would otherwise hang the runner on stdin. Exit immediately unless spawned by
// its driver (redirector-client.test.mjs sets ASIGHT_FAKE_LOADER=1).
if (process.env.ASIGHT_FAKE_LOADER !== '1') process.exit(0)

const PROTO = process.env.ASIGHT_FAKE_PROTO ? Number(process.env.ASIGHT_FAKE_PROTO) : 1
const state = {
  attached: false,
  enginePort: 0,
  hbNs: 0,
  watch: new Map(), // tgid -> decrypt(0|1)
  byPort: new Map(), // `${port}/${family}` -> { dst, pid, decrypt }
  links: [], // [{name,id,prog_id}]
}
const portKey = (port, family) => `${port}/${family || 4}`
const CGROUP_LINKS = [
  { name: 'connect4', id: 101, prog_id: 201 },
  { name: 'connect6', id: 102, prog_id: 202 },
  { name: 'sockops', id: 103, prog_id: 203 },
]
const nowNs = () => {
  const [s, n] = process.hrtime()
  return s * 1_000_000_000 + n
}
function out(obj) { process.stdout.write(JSON.stringify(obj) + '\n') }

out({ ev: 'ready', pid: process.pid, proto: PROTO, build: 'fake' })

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  line = line.trim()
  if (!line) return
  let msg
  try { msg = JSON.parse(line) } catch { return }
  const { id, op } = msg
  const reply = (extra) => { if (id != null) out({ id, ok: true, ...extra }) }
  const fail = (error) => { if (id != null) out({ id, ok: false, error }) }
  switch (op) {
    case 'ping': return reply()
    case 'config': state.enginePort = msg.engine_port | 0; return reply()
    case 'attach': state.attached = true; state.links = CGROUP_LINKS; return reply()
    case 'detach': state.attached = false; state.links = []; return reply()
    case 'heartbeat': state.hbNs = nowNs(); return reply()
    case 'watch': state.watch.set(msg.tgid, msg.decrypt ? 1 : 0); return reply()
    case 'unwatch': state.watch.delete(msg.tgid); return reply()
    case 'status': {
      const hbAgeMs = state.hbNs ? Math.round((nowNs() - state.hbNs) / 1e6) : -1
      return reply({ attached: state.attached, engine_port: state.enginePort, hb_age_ms: hbAgeMs, links: state.links })
    }
    case 'lookup': {
      const k = portKey(msg.port, msg.family)
      const row = state.byPort.get(k)
      if (!row) return reply({ found: false, dst: null, pid: null, decrypt: 0 })
      state.byPort.delete(k) // lookup-and-delete, like the real loader
      return reply({ found: true, dst: row.dst, pid: row.pid, decrypt: row.decrypt })
    }
    // ---- test-only injection ops (real loader rejects unknown ops) ----
    case '__inject_port': {
      const family = msg.family != null ? msg.family : (msg.dst && msg.dst.family) || 4
      const put = () => state.byPort.set(portKey(msg.port, family), { dst: msg.dst, pid: msg.pid, decrypt: msg.decrypt ? 1 : 0 })
      if (msg.after) setTimeout(put, msg.after)
      else put()
      return reply()
    }
    case '__emit': { const { op: _o, id: _i, ...ev } = msg; out(ev); return reply() }
    case '__watched': return reply({ watch: Object.fromEntries(state.watch) }) // tgid → decrypt (1) or observe (0)
    default: return fail('unknown op: ' + op)
  }
})
rl.on('close', () => process.exit(0)) // stdin EOF -> loader exits (links would auto-detach)
