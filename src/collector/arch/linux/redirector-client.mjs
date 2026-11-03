// Linux redirector client — the platform half of the collector's `Redirector` contract
// (spec/01-trocar-rfc/4.6-process-collector.md §Linux 机制, §结构; the engine consumes it through
// src/collector/arch/linux/redirector.mjs).
//
// It spawns the privileged C loader (src/collector/arch/linux/redirector/redirector.c),
// which owns the eBPF bpf_links and the kernel maps, and talks to it over a newline-JSON
// line protocol on the loader's stdin/stdout. The engine (src/collector/core/engine/)
// consumes only `lookup(peer)`; the platform methods below drive the switch and the watch
// set. Node built-ins only (D18): child_process, readline, events, net.
//
// D36: the loader is the shared capability helper, installed once per machine by `sudo trocar
// setup-helper` at /usr/local/libexec/trocar/trocar-redirector and spawned as a child of this
// (operator) engine.
// The client passes `--parent-pid` so the loader can bind its self-exclusion to this engine and
// die with it; it never sends an engine uid (the loader bakes owner_uid from getuid() itself).
//
// Contract (what the engine relies on):
//   FlowMeta = { dst:{address,port,family:4|6}, pid:number|null, agent:string|null, decrypt:boolean }
//   lookup(peer:{address,port}) -> Promise<FlowMeta|null>
//     The only method the engine calls. Joins the kernel's by_port row (original dst, pid,
//     decrypt verdict) with the JS-side pid->agent label recorded at watch(). The peer's address
//     family is sent along so a v4 and a v6 connection sharing a source port are never mis-joined.
//     Waits up to lookupWaitMs for a missing row to appear, then resolves null; rejects if the helper cannot be asked.
//   attach()/detach()/status() -> toggle/read the three cgroup links; status is derived from
//     the kernel (bpf_link info), never from a cached flag.
//   watch(pid, verdict={decrypt,agent})/unwatch(pid) -> maintain the kernel watch set and the
//     JS pid->label map. Refuses to watch this engine's own pid (the loader also refuses a tgid
//     not owned by this uid).
//   heartbeat() -> refresh the kernel freshness timestamp; attach() sends one before attaching, and the
//     client auto-heartbeats every autoHeartbeatMs while attached (set 0 to disable, e.g. in tests).
//   setBeatGate(fn) / the `beforeBeat` option -> before EACH automatic beat the client awaits `fn()`; false sends none that tick, a throw is
//     a heartbeat-error and no beat (the steering lapses, fail open). The daemon re-reads state.json here (4.6 §开关语义): a loop that was
//     stalled past the kernel's 2 s window must not beat again until it has taken away what the operator turned off. attach()'s own beat
//     and an explicit heartbeat() are not gated; a gate still answering is not asked again (the ticks inside it are skipped).
//   EventEmitter: 'exec'({tgid,pid,comm,filename,tsNs}), 'exit'({tgid,tsNs}),
//     'flow-meta'({pid,dst,tsNs}) for a watched no-decrypt flow, 'down'({reason}), 'ready'
//     ({pid,proto,build}), 'version-mismatch'({got,expected}).

import { spawn as defaultSpawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import readline from 'node:readline'
import net from 'node:net'
import { setupHelperCommand } from '../../../version.mjs'

/** @typedef {{address:string,port:number,family:4|6}} Dst */
/** @typedef {{dst:Dst,pid:number|null,agent:string|null,decrypt:boolean}} FlowMeta */

/** Line-protocol version. Must equal TROCAR_PROTO in redirector.c. */
// trocar.h TROCAR_HEARTBEAT_STALE_NS: past this age the kernel stops rewriting connects.
export const HEARTBEAT_STALE_MS = 2000
export const REDIRECTOR_PROTO = 3 // 3 (4.6 §pid 命名空间): pids in the engine's pid namespace; watch refuses a tgid outside the hooks' cgroup tree

/** Where `sudo trocar setup-helper` installs the capped loader; override with TROCAR_REDIRECTOR_BIN. */
export const DEFAULT_REDIRECTOR_BIN = '/usr/local/libexec/trocar/trocar-redirector'

/** The helper's exit codes (redirector.c main) by name, for helper-down (D38 D-14). */
export const HELPER_EXIT = { 1: 'load-failed', 2: 'usage', 3: 'parent-mismatch', 4: 'environment', 5: 'lockdown-failed', 6: 'namespace' }
const STDERR_TAIL = 20

export function createRedirectorClient({
  binary,
  args = [],
  spawn = defaultSpawn,
  parentPid = process.pid,
  autoHeartbeatMs = 500,
  lookupWaitMs = 200,
  env = process.env,
  requestTimeoutMs = 2000, // a helper that does not answer: loader-timeout, never a lookup that hangs the agent's connection (D-13)
  clock = () => performance.now(), // monotonic: a wall-clock jump never fakes or hides a heartbeat gap, never cuts a lookup short
  exitGraceMs = 500, // a broken stdin waits this long for the helper's 'exit', which says how it ended (D-14)
  beforeBeat = null, // async () => boolean, asked before every automatic beat (see the contract above); null: no gate
} = {}) {
  const resolvedBinary = binary || (env && env.TROCAR_REDIRECTOR_BIN) || DEFAULT_REDIRECTOR_BIN

  const emitter = new EventEmitter()
  const pending = new Map() // id -> {resolve,reject}
  const labels = new Map() // pid -> {agent,decrypt}
  let nextId = 1
  let child = null
  let hbTimer = null
  let down = false
  let closing = false // close() ended the helper's stdin: what follows is how an orderly stop ends, not the helper going down (D38)
  let readyResolve = null
  let readyReject = null
  let gate = beforeBeat
  let gating = false // the gate is answering: the ticks inside its question are skipped
  let loaderInfo = { proto: null, build: null, pid: null }
  const stderrTail = [] // the helper's last stderr lines: why it would not start or attach (D-14)
  const counters = { unparsable: 0, timeouts: 0 }

  function send(op, extra = {}) {
    if (down || !child || child.exitCode != null || child.signalCode != null) {
      return Promise.reject(Object.assign(new Error('the capability helper is not running'), { code: 'loader-down' }))
    }
    const id = nextId++
    const line = JSON.stringify({ id, op, ...extra }) + '\n'
    return new Promise((resolve, reject) => {
      const timer = requestTimeoutMs > 0 ? setTimeout(() => {
        if (!pending.delete(id)) return
        counters.timeouts++
        reject(Object.assign(new Error(`the helper did not answer ${op} within ${requestTimeoutMs} ms`), { code: 'loader-timeout' }))
      }, requestTimeoutMs) : null
      if (timer && timer.unref) timer.unref()
      const done = (fn) => (v) => { if (timer) clearTimeout(timer); fn(v) }
      pending.set(id, { resolve: done(resolve), reject: done(reject) })
      child.stdin.write(line, (err) => { if (err && pending.delete(id)) { if (timer) clearTimeout(timer); reject(Object.assign(err, { code: err.code || 'loader-down' })) } })
    })
  }

  function onLine(line) {
    line = line.trim()
    if (!line) return
    let msg
    try { msg = JSON.parse(line) } catch { counters.unparsable++; emitter.emit('loader-error', { reason: `unparsable line from the helper, ignored: ${line.slice(0, 200)}` }); return }
    if (msg.id != null && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.ok === false) reject(Object.assign(new Error(msg.error || 'loader error'), { code: 'loader-down' })) // the helper's own error, in the reason
      else resolve(msg)
      return
    }
    switch (msg.ev) {
      case 'ready':
        loaderInfo = { proto: msg.proto ?? null, build: msg.build ?? null, pid: msg.pid ?? null }
        // Fail open on a protocol-version mismatch: the loader is already loaded and attaching,
        // so refusing here would only turn a benign skew into a hard capture outage. Surface a
        // warning and keep running (D36).
        if (msg.proto != null && msg.proto !== REDIRECTOR_PROTO) {
          emitter.emit('version-mismatch', { got: msg.proto, expected: REDIRECTOR_PROTO })
        }
        emitter.emit('ready', { pid: msg.pid, proto: msg.proto ?? null, build: msg.build ?? null })
        if (readyResolve) { readyResolve({ pid: msg.pid, proto: msg.proto ?? null, build: msg.build ?? null }); readyResolve = readyReject = null }
        return
      case 'exec':
        emitter.emit('exec', { tgid: msg.tgid, pid: msg.pid, comm: msg.comm, filename: msg.filename, tsNs: msg.ts_ns })
        return
      case 'exit':
        emitter.emit('exit', { tgid: msg.tgid, tsNs: msg.ts_ns })
        return
      case 'flow':
        emitter.emit('flow-meta', { pid: msg.pid, dst: msg.dst, tsNs: msg.ts_ns })
        return
      case 'error':
        emitter.emit('loader-error', { reason: msg.reason })
        return
      case 'down':
        // the helper's own word when its stdin closes ("loader exiting", redirector.c) is, during close(), the stop the daemon asked for: its exit says the rest
        if (closing) return
        fail(msg.reason || 'loader reported down')
        return
      default:
        if (msg.ev != null) emitter.emit('loader-error', { reason: `unknown helper event ${JSON.stringify(msg.ev)}, ignored (a helper newer than this daemon?)` })
        return
    }
  }

  // `code`: what start() rejects with — ENOENT when there is no helper at its path (the daemon then runs without one, 4.6 「助手还没装」)
  function fail(reason, extra = {}, { quiet = false, code = 'loader-down' } = {}) {
    if (down) return
    down = true
    stopHeartbeat()
    for (const { reject } of pending.values()) reject(Object.assign(new Error('the capability helper stopped: ' + reason), { code: 'loader-down' }))
    pending.clear()
    if (readyReject) { readyReject(Object.assign(new Error('the capability helper stopped: ' + reason), { code })); readyResolve = readyReject = null }
    if (quiet) return // an orderly close: no `down`, so no helper-down failure (the daemon's own daemon-stop records the stop)
    emitter.emit('down', { reason, ...extra, ...(stderrTail.length ? { stderr: [...stderrTail] } : {}) })
  }

  function startHeartbeat() {
    if (autoHeartbeatMs > 0 && !hbTimer) {
      // A failed beat, or beats more than the kernel's 2 s freshness apart (a stalled event loop), let steering lapse
      // (fail-open: those connections went direct). Never silent (D38).
      let lastOk = clock()
      const beat = () => heartbeat().then(() => {
        const gap = Math.round(clock() - lastOk); lastOk = clock()
        if (gap > HEARTBEAT_STALE_MS) emitter.emit('heartbeat-error', { code: 'heartbeat-gap', reason: `no heartbeat for ${gap} ms (the kernel stops steering after ${HEARTBEAT_STALE_MS} ms); connections in that window went direct` })
      }, (e) => { if (!down) emitter.emit('heartbeat-error', { code: 'heartbeat-failed', reason: String((e && e.message) || e) }) })
      hbTimer = setInterval(() => {
        if (!gate) { beat(); return }
        if (gating) return
        gating = true
        Promise.resolve().then(() => gate()).then(
          (go) => { gating = false; if (go !== false && hbTimer) beat() }, // hbTimer: the gate itself may have detached
          (e) => { gating = false; if (!down) emitter.emit('heartbeat-error', { code: 'heartbeat-failed', reason: `the beat gate failed (${String((e && e.message) || e)}); no heartbeat this tick` }) })
      }, autoHeartbeatMs)
      if (hbTimer.unref) hbTimer.unref()
    }
  }
  function stopHeartbeat() { if (hbTimer) { clearInterval(hbTimer); hbTimer = null } }

  async function start() {
    if (child) throw new Error('already started')
    // --parent-pid goes AFTER args so the real loader (binary=the helper, args=[]) sees it as its
    // own flag, while a test harness (binary=node, args=[script]) still runs the script first.
    const spawnArgs = [...args, '--parent-pid', String(parentPid)]
    child = spawn(resolvedBinary, spawnArgs, { stdio: ['pipe', 'pipe', 'pipe'], env })
    const rl = readline.createInterface({ input: child.stdout })
    rl.on('line', onLine)
    // its stderr still reaches ours, and its last lines go into helper-down (why it could not start, load or attach)
    if (child.stderr) readline.createInterface({ input: child.stderr }).on('line', (l) => { process.stderr.write(`[helper] ${l}\n`); stderrTail.push(l.slice(0, 500)); if (stderrTail.length > STDERR_TAIL) stderrTail.shift() })
    // A helper that died between our check and the write makes stdin emit EPIPE. Without a listener that is an
    // uncaught exception that takes the whole daemon down; it is the helper going down, reported as such. A killed
    // helper's broken pipe usually comes before its 'exit': that exit (its name, the stderr tail) is what helper-down
    // carries (D-14), so the pipe error is the reason only when no exit follows within exitGraceMs.
    child.stdin.on('error', (err) => {
      const c = child
      const t = setTimeout(() => fail(`loader stdin: ${err.code || err.message}`), exitGraceMs)
      c.once('exit', () => clearTimeout(t))
    })
    child.on('exit', (code, signal) => {
      stopHeartbeat()
      const exit = signal || HELPER_EXIT[code] || `code ${code}`
      // after its stderr is drained, so the tail is complete. Asked to close and gone with code 0: that is the close, said by nobody; any other end
      // (a non-zero code, a signal — close()'s own SIGKILL after its wait included) is still the helper going down, with its exit (D38)
      const quiet = closing && code === 0 && !signal
      setImmediate(() => fail(signal ? `loader killed by ${signal}` : `loader exited with code ${code}${HELPER_EXIT[code] ? ` (${HELPER_EXIT[code]})` : ''}`, { exit }, { quiet }))
    })
    child.on('error', (err) => {
      if (err && err.code === 'ENOENT') {
        fail(`capability helper not found at ${resolvedBinary}; install it once per machine with \`${setupHelperCommand()}\``, {}, { code: 'ENOENT' })
      } else {
        fail('spawn error: ' + (err && err.message ? err.message : String(err)))
      }
    })
    return new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject })
  }

  async function configure(enginePort) {
    return send('config', { engine_port: enginePort | 0 })
  }

  // A heartbeat first: the kernel steers only while the heartbeat is fresh (trocar.bpf.c heartbeat_fresh), and the
  // first periodic one comes autoHeartbeatMs later, so without it every connection in that window after `on` went
  // direct (on a test machine, a `claude -p` started right after `on` was never captured).
  async function attach() { await heartbeat(); const r = await send('attach'); startHeartbeat(); return r }
  async function detach() { stopHeartbeat(); return send('detach') }
  async function heartbeat() { return send('heartbeat') }
  async function status() { return send('status') }

  async function watch(pid, verdict = {}) {
    if (pid === process.pid) throw new Error('refusing to watch this engine process (self)')
    const decrypt = !!verdict.decrypt
    labels.set(pid, { agent: verdict.agent ?? null, decrypt })
    return send('watch', { tgid: pid, decrypt: decrypt ? 1 : 0 })
  }
  async function unwatch(pid) { labels.delete(pid); return send('unwatch', { tgid: pid }) }

  /** @returns {Promise<FlowMeta|null>} */
  async function lookup(peer) {
    const port = peer && peer.port
    if (port == null) return null
    const family = peer.address && net.isIPv6(peer.address) ? 6 : 4
    const deadline = clock() + lookupWaitMs
    for (;;) {
      let r
      r = await send('lookup', { port, family }) // a transport error is thrown, never read as a miss (D38)
      if (r.found) {
        const label = r.pid != null ? labels.get(r.pid) : null
        return { dst: r.dst, pid: r.pid ?? null, agent: label ? label.agent : null, decrypt: !!r.decrypt }
      }
      if (clock() >= deadline) return null
      await new Promise((res) => setTimeout(res, 20))
    }
  }

  // Escape hatch for tests / diagnostics: send a raw op line and await its reply.
  async function raw(obj) {
    const { op, ...extra } = obj
    return send(op, extra)
  }

  async function close() {
    stopHeartbeat()
    if (!child) return
    closing = true
    try { child.stdin.end() } catch { /* already closed */ }
    if (child.exitCode == null && child.signalCode == null) {
      await new Promise((resolve) => {
        const t = setTimeout(() => { try { child.kill('SIGKILL') } catch {} ; resolve() }, 1000)
        if (t.unref) t.unref()
        child.once('exit', () => { clearTimeout(t); resolve() })
      })
    }
  }

  function setBeatGate(fn) { gate = typeof fn === 'function' ? fn : null }

  Object.assign(emitter, { start, close, configure, attach, detach, status, watch, unwatch, heartbeat, lookup, raw, setBeatGate })
  Object.defineProperty(emitter, '_child', { get() { return child } })
  Object.defineProperty(emitter, '_binary', { get() { return resolvedBinary } })
  Object.defineProperty(emitter, 'loaderInfo', { get() { return loaderInfo } })
  Object.defineProperty(emitter, 'counters', { get() { return { ...counters } } }) // unparsable lines, timed-out requests (status)
  return emitter
}
