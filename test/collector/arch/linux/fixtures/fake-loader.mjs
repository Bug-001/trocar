#!/usr/bin/env node
// Fake Linux redirector loader — speaks the exact newline-JSON line protocol of the
// real C loader (src/collector/arch/linux/redirector/redirector.c), with an in-memory
// model of the kernel state instead of eBPF. Used by redirector-client.test.mjs so the
// Node client's protocol handling is exercised end-to-end with a real spawned process,
// no root and no eBPF. Test-only ops are prefixed `__`; the real loader rejects them.
import readline from 'node:readline'

// node --test discovers every file under test/ as a test file and runs it; this fixture is
// not a test and would otherwise hang the runner on stdin. Exit immediately unless spawned by
// its driver (redirector-client.test.mjs sets TROCAR_FAKE_LOADER=1).
if (process.env.TROCAR_FAKE_LOADER !== '1') process.exit(0)

const PROTO = process.env.TROCAR_FAKE_PROTO ? Number(process.env.TROCAR_FAKE_PROTO) : 2 // = REDIRECTOR_PROTO
const state = {
  attached: false,
  enginePort: 0,
  hbNs: 0,
  watch: new Map(), // tgid -> decrypt(0|1)
  byPort: new Map(), // `${port}/${family}` -> { dst, pid, decrypt }
  links: [], // [{name,id,prog_id}]
  drops: { 'no-config': 0, 'hb-stale': 0, 'no-listener': 0, 'orig-write': 0, 'byport-write': 0, 'ringbuf-full': 0 }, // protocol 2
}
const oplog = [] // the state-changing ops in the order they arrived (`__oplog`): a test asserts what the daemon did and in which order
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
  if (op === 'attach' || op === 'detach' || op === 'heartbeat') oplog.push(op)
  else if (op === 'watch' || op === 'unwatch') oplog.push(`${op} ${msg.tgid}`)
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
      return reply({ attached: state.attached, engine_port: state.enginePort, hb_age_ms: hbAgeMs, links: state.links, ...(PROTO >= 2 ? { drops: state.drops } : {}) })
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
    case '__drops': for (const [k, n] of Object.entries(msg.counts || {})) state.drops[k] = (state.drops[k] || 0) + n; return reply() // the kernel let connections go
    case '__yank': state.attached = false; state.links = []; return reply() // someone else detached this instance's links
    case '__oplog': return reply({ log: [...oplog] }) // attach / detach / heartbeat / watch <tgid> / unwatch <tgid> / mark <name>
    case '__mark': oplog.push(`mark ${msg.name || ''}`); return reply() // a point in the log: what comes after it came after the caller's last step
    case '__watched': return reply({ watch: Object.fromEntries(state.watch) }) // tgid → decrypt (1) or observe (0)
    default: return fail('unknown op: ' + op)
  }
})
rl.on('close', () => process.exit(0)) // stdin EOF -> loader exits (links would auto-detach)
