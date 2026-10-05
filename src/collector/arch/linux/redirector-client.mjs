// Linux redirector client — the platform half of the collector's `Redirector` contract
// (spec/01-asight-rfc/4.6-process-collector.md §Linux 机制, §结构; contract defined by the
// the collector engine design).
//
// It spawns the privileged C loader (src/collector/arch/linux/redirector/redirector.c),
// which owns the eBPF bpf_links and the kernel maps, and talks to it over a newline-JSON
// line protocol on the loader's stdin/stdout. The engine (core, built on another branch)
// consumes only `lookup(peer)`; the platform methods below drive the switch and the watch
// set. Node built-ins only (D18): child_process, readline, events, net.
//
// D36: the loader is the shared capability helper, installed today by `sudo node install.mjs
// setup-helper` (the operator-facing `asight setup-helper` CLI is not built yet) at
// /usr/local/libexec/asight/asight-redirector and spawned as a child of this (operator) engine.
// The client passes `--parent-pid` so the loader can bind its self-exclusion to this engine and
// die with it; it never sends an engine uid (the loader bakes owner_uid from getuid() itself).
//
// Contract (what the engine relies on):
//   FlowMeta = { dst:{address,port,family:4|6}, pid:number|null, agent:string|null, decrypt:boolean }
//   lookup(peer:{address,port}) -> Promise<FlowMeta|null>
//     The only method the engine calls. Joins the kernel's by_port row (original dst, pid,
//     decrypt verdict) with the JS-side pid->agent label recorded at watch(). The peer's address
//     family is sent along so a v4 and a v6 connection sharing a source port are never mis-joined.
//     Waits up to lookupWaitMs for a missing row to appear, then resolves null.
//   attach()/detach()/status() -> toggle/read the three cgroup links; status is derived from
//     the kernel (bpf_link info), never from a cached flag.
//   watch(pid, verdict={decrypt,agent})/unwatch(pid) -> maintain the kernel watch set and the
//     JS pid->label map. Refuses to watch this engine's own pid (the loader also refuses a tgid
//     not owned by this uid).
//   heartbeat() -> refresh the kernel freshness timestamp; attach() sends one before attaching, and the
//     client auto-heartbeats every autoHeartbeatMs while attached (set 0 to disable, e.g. in tests).
//   EventEmitter: 'exec'({tgid,pid,comm,filename,tsNs}), 'exit'({tgid,tsNs}),
//     'flow-meta'({pid,dst,tsNs}) for a watched no-decrypt flow, 'down'({reason}), 'ready'
//     ({pid,proto,build}), 'version-mismatch'({got,expected}).

import { spawn as defaultSpawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import readline from 'node:readline'
import net from 'node:net'

/** @typedef {{address:string,port:number,family:4|6}} Dst */
/** @typedef {{dst:Dst,pid:number|null,agent:string|null,decrypt:boolean}} FlowMeta */

/** Line-protocol version. Must equal ASIGHT_PROTO in redirector.c. */
export const REDIRECTOR_PROTO = 1

/** Where the setup-helper step installs the capped loader (the `asight setup-helper` CLI is not built
 *  yet; use `sudo node install.mjs setup-helper`); override with ASIGHT_REDIRECTOR_BIN. */
export const DEFAULT_REDIRECTOR_BIN = '/usr/local/libexec/asight/asight-redirector'

export function createRedirectorClient({
  binary,
  args = [],
  spawn = defaultSpawn,
  parentPid = process.pid,
  autoHeartbeatMs = 500,
  lookupWaitMs = 200,
  env = process.env,
} = {}) {
  const resolvedBinary = binary || (env && env.ASIGHT_REDIRECTOR_BIN) || DEFAULT_REDIRECTOR_BIN

  const emitter = new EventEmitter()
  const pending = new Map() // id -> {resolve,reject}
  const labels = new Map() // pid -> {agent,decrypt}
  let nextId = 1
  let child = null
  let hbTimer = null
  let down = false
  let readyResolve = null
  let readyReject = null
  let loaderInfo = { proto: null, build: null, pid: null }

  function send(op, extra = {}) {
    if (down || !child || child.exitCode != null || child.signalCode != null) {
      return Promise.reject(new Error('redirector loader is not running'))
    }
    const id = nextId++
    const line = JSON.stringify({ id, op, ...extra }) + '\n'
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      child.stdin.write(line, (err) => { if (err) { pending.delete(id); reject(err) } })
    })
  }

  function onLine(line) {
    line = line.trim()
    if (!line) return
    let msg
    try { msg = JSON.parse(line) } catch { return }
    if (msg.id != null && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.ok === false) reject(new Error(msg.error || 'loader error'))
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
        fail(msg.reason || 'loader reported down')
        return
      default:
        return
    }
  }

  function fail(reason) {
    if (down) return
    down = true
    stopHeartbeat()
    for (const { reject } of pending.values()) reject(new Error('redirector loader down: ' + reason))
    pending.clear()
    if (readyReject) { readyReject(new Error('redirector loader down: ' + reason)); readyResolve = readyReject = null }
    emitter.emit('down', { reason })
  }

  function startHeartbeat() {
    if (autoHeartbeatMs > 0 && !hbTimer) {
      hbTimer = setInterval(() => { heartbeat().catch(() => {}) }, autoHeartbeatMs)
      if (hbTimer.unref) hbTimer.unref()
    }
  }
  function stopHeartbeat() { if (hbTimer) { clearInterval(hbTimer); hbTimer = null } }

  async function start() {
    if (child) throw new Error('already started')
    // --parent-pid goes AFTER args so the real loader (binary=the helper, args=[]) sees it as its
    // own flag, while a test harness (binary=node, args=[script]) still runs the script first.
    const spawnArgs = [...args, '--parent-pid', String(parentPid)]
    child = spawn(resolvedBinary, spawnArgs, { stdio: ['pipe', 'pipe', 'inherit'], env })
    const rl = readline.createInterface({ input: child.stdout })
    rl.on('line', onLine)
    // A helper that died between our check and the write makes stdin emit EPIPE. Without a listener that is an
    // uncaught exception that takes the whole daemon down; it is the helper going down, reported as such.
    child.stdin.on('error', (err) => fail(`loader stdin: ${err.code || err.message}`))
    child.on('exit', (code, signal) => {
      stopHeartbeat()
      fail(signal ? `loader killed by ${signal}` : `loader exited with code ${code}`)
    })
    child.on('error', (err) => {
      if (err && err.code === 'ENOENT') {
        fail(`redirector helper not found at ${resolvedBinary}; install it once per machine with "sudo asight setup-helper"`)
      } else {
        fail('spawn error: ' + (err && err.message ? err.message : String(err)))
      }
    })
    return new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject })
  }

  async function configure(enginePort) {
    return send('config', { engine_port: enginePort | 0 })
  }

  // A heartbeat first: the kernel steers only while the heartbeat is fresh (asight.bpf.c heartbeat_fresh), and the
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
    const deadline = Date.now() + lookupWaitMs
    for (;;) {
      let r
      try { r = await send('lookup', { port, family }) } catch { return null }
      if (r.found) {
        const label = r.pid != null ? labels.get(r.pid) : null
        return { dst: r.dst, pid: r.pid ?? null, agent: label ? label.agent : null, decrypt: !!r.decrypt }
      }
      if (Date.now() >= deadline) return null
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
    try { child.stdin.end() } catch { /* already closed */ }
    if (child.exitCode == null && child.signalCode == null) {
      await new Promise((resolve) => {
        const t = setTimeout(() => { try { child.kill('SIGKILL') } catch {} ; resolve() }, 1000)
        if (t.unref) t.unref()
        child.once('exit', () => { clearTimeout(t); resolve() })
      })
    }
  }

  Object.assign(emitter, { start, close, configure, attach, detach, status, watch, unwatch, heartbeat, lookup, raw })
  Object.defineProperty(emitter, '_child', { get() { return child } })
  Object.defineProperty(emitter, '_binary', { get() { return resolvedBinary } })
  Object.defineProperty(emitter, 'loaderInfo', { get() { return loaderInfo } })
  return emitter
}
