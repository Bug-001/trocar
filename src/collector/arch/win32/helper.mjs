// helper.mjs — the client of the Windows collector's resident, READ-ONLY helper (RFC 4.8 §1, §5.3, §10.1): one PowerShell
// process (helper.ps1) that answers a closed set of read verbs over JSON lines, because the collector must not spawn a
// powershell.exe per question (~100 ms each) and Get-NetTCPConnection / CIM are refused under the filtered token it runs with [E6].
//
// Protocol: one JSON object per line each way. helper → us, once, when its native code is compiled: {ready:true, proto, pid, ps,
// native, nativeError?}; then, per request {id, verb, args} → {id, ok:true, data} | {id, ok:false, error}. An unknown verb, and a
// reg-read outside the allow-list below, are refused HERE, before a byte is written; helper.ps1 checks both again (defence in depth;
// the test file keeps the two lists equal). Node built-ins only; this file imports nothing of asight (0.1 §2).
//
// Failures (D38) go to `onFailure(record)` shaped for the collector's recorder, and each is reported once:
//   • the helper cannot start — the spawn fails, it exits or never says ready, it speaks another protocol → {event:'failure',
//     where:'helper', code:'helper-start-failed', reason, errno?, exit?, stderr?};
//   • it dies after it was ready → {event:'helper-down', reason, exit?, stderr?} (the Linux client's shape);
//   • close() is neither: an operator's stop is not a failure.
// Every call pending at that moment rejects with error.code 'helper-down' / 'helper-start-failed'; later calls reject the same way at once.
import { spawn as nodeSpawn } from 'node:child_process'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'

export const HELPER_PROTO = 1
export const HELPER_PS1 = fileURLToPath(new URL('./helper.ps1', import.meta.url))
/** The closed verb set (4.8 §1). Every one only reads: no registry write, no process control, no file write, no network. */
export const HELPER_VERBS = Object.freeze(['ps', 'tcp-table', 'reg-read', 'net-if', 'route', 'token', 'roots', 'pipe-server', 'version'])
/** What reg-read may read: the Internet Settings proxy values (4.7 §3), the user PATH (the Kimi shim's entry, 4.8 §6.3) and the Smart App
 *  Control policy state (4.8 §6.3, §8). Hive and key compare case-insensitively with `/` taken as `\` and no trailing `\`; names compare
 *  case-insensitively. helper.ps1 carries the same list as one JSON literal. */
export const REG_READ_ALLOW = Object.freeze([
  { hive: 'HKCU', key: 'Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', names: Object.freeze(['ProxyEnable', 'ProxyServer', 'ProxyOverride', 'AutoConfigURL']) },
  { hive: 'HKCU', key: 'Environment', names: Object.freeze(['Path']) },
  { hive: 'HKLM', key: 'SYSTEM\\CurrentControlSet\\Control\\CI\\Policy', names: Object.freeze(['VerifiedAndReputablePolicyState']) },
].map(Object.freeze))

const STDERR_TAIL = 20 // the last lines of its stderr that helper-down carries (4.6 §记录: 20, as the Linux helper)
const normKey = (k) => String(k).replaceAll('/', '\\').replace(/\\+$/, '').toLowerCase()

/** The allow-list entry a reg-read request falls under, or null. A request with no names asks for everything: refused. */
export function regReadAllowed(args) {
  if (!args || typeof args !== 'object' || !Array.isArray(args.names) || args.names.length === 0) return null
  const rule = REG_READ_ALLOW.find((r) => r.hive.toLowerCase() === String(args.hive).toLowerCase() && normKey(r.key) === normKey(args.key))
  if (!rule) return null
  const ok = new Set(rule.names.map((n) => n.toLowerCase()))
  return args.names.every((n) => typeof n === 'string' && ok.has(n.toLowerCase())) ? rule : null
}

const err = (message, code, extra = {}) => Object.assign(new Error(message), { code }, extra)

/** startHelper({ spawn, exe, args, env, onExit, onFailure, readyTimeoutMs }) → { call(verb, args, { timeoutMs = 2000 }), close(), pid, ready }
 *  `ready` resolves with the helper's ready line, or rejects when it never starts. `onExit({ reason, exit?, stderr?, ready, closed })` is
 *  told once when the helper is gone, however it went. */
export function startHelper({ spawn = nodeSpawn, exe = 'powershell.exe', args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', HELPER_PS1], env = process.env, onExit = () => {}, onFailure = () => {}, readyTimeoutMs = 15000 } = {}) {
  let child = null
  let readyInfo = null
  let down = null // { code, reason } once the helper is gone
  let closing = false
  let seq = 0
  let readyTimer = null
  let exitTimer = null
  let closed = null
  const stderrTail = []
  const pending = new Map() // id → { resolve, reject, timer, verb }
  let resolveReady
  let rejectReady
  const ready = new Promise((res, rej) => { resolveReady = res; rejectReady = rej })
  ready.catch(() => {}) // a caller that never awaits `ready` must not see an unhandled rejection

  function fail(reason, extra = {}) {
    if (down) return
    const wasReady = readyInfo !== null
    down = { code: wasReady ? 'helper-down' : 'helper-start-failed', reason }
    clearTimeout(readyTimer)
    clearTimeout(exitTimer)
    const tail = stderrTail.length ? { stderr: [...stderrTail] } : {}
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(err(`helper ${wasReady ? 'down' : 'did not start'}: ${reason}`, down.code)) }
    pending.clear()
    rejectReady(err(`helper did not start: ${reason}`, 'helper-start-failed'))
    if (child && child.exitCode == null && child.signalCode == null) { try { child.kill() } catch { /* already gone */ } } // a helper we gave up on does not linger
    if (!closing) onFailure(wasReady ? { event: 'helper-down', reason, ...extra, ...tail } : { event: 'failure', where: 'helper', code: 'helper-start-failed', reason, ...extra, ...tail })
    onExit({ reason, ...extra, ...tail, ready: wasReady, closed: closing })
  }

  function onLine(line) {
    let msg
    try { msg = JSON.parse(line) } catch { return } // not ours: a warning a shell printed
    if (!msg || typeof msg !== 'object') return
    if (msg.ready === true) {
      if (readyInfo) return
      clearTimeout(readyTimer)
      if (msg.proto !== HELPER_PROTO) return fail(`the helper speaks protocol ${msg.proto}, this build expects ${HELPER_PROTO}`)
      readyInfo = msg
      return resolveReady(msg)
    }
    const p = pending.get(msg.id)
    if (!p) return // a late answer to a call that already timed out
    pending.delete(msg.id)
    clearTimeout(p.timer)
    if (msg.ok === true) p.resolve(msg.data)
    else p.reject(err(String(msg.error ?? 'the helper reported an error'), 'helper-verb-error', { verb: p.verb }))
  }

  try {
    child = spawn(exe, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env })
  } catch (e) {
    queueMicrotask(() => fail(`cannot start ${exe}: ${e.message}`, { errno: e.code ?? null }))
  }
  if (child) {
    readline.createInterface({ input: child.stdout }).on('line', onLine)
    if (child.stderr) readline.createInterface({ input: child.stderr }).on('line', (l) => { stderrTail.push(l.slice(0, 500)); if (stderrTail.length > STDERR_TAIL) stderrTail.shift() })
    // a helper that died between our check and the write makes stdin emit EPIPE; with no listener that is an uncaught exception that
    // takes the whole daemon down. The exit that follows says why: this is the reason only when none comes
    child.stdin.on('error', (e) => { const t = setTimeout(() => fail(`helper stdin: ${e.code || e.message}`), 100); t.unref?.(); child.once('exit', () => clearTimeout(t)) })
    child.on('error', (e) => fail(e && e.code === 'ENOENT' ? `${exe} was not found: ${e.message}` : `cannot start ${exe}: ${(e && e.message) || e}`, { errno: (e && e.code) || null }))
    const finish = (code, signal) => fail(signal ? `helper killed by ${signal}` : `helper exited with code ${code}`, { exit: signal || `code ${code}` })
    child.on('exit', (code, signal) => { exitTimer = setTimeout(() => finish(code, signal), 250); exitTimer.unref?.() }) // 'close' comes first when the streams drained: stderr is then complete
    child.on('close', (code, signal) => finish(code, signal))
    readyTimer = setTimeout(() => fail(`the helper was not ready within ${readyTimeoutMs} ms`), readyTimeoutMs)
    readyTimer.unref?.()
  }

  /** call(verb, args, { timeoutMs }) → the verb's data. Rejects with error.code: helper-unknown-verb · helper-forbidden-key · helper-closed ·
   *  helper-down · helper-start-failed (nothing written) · helper-timeout · helper-verb-error (the helper answered ok:false). The timeout
   *  counts from the write, after the helper is ready. */
  async function call(verb, callArgs = {}, { timeoutMs = 2000 } = {}) {
    if (typeof verb !== 'string' || !HELPER_VERBS.includes(verb)) throw err(`not a helper verb: ${JSON.stringify(verb)}`, 'helper-unknown-verb')
    if (verb === 'reg-read' && !regReadAllowed(callArgs)) throw err(`reg-read outside the allow-list: ${JSON.stringify(callArgs)}`, 'helper-forbidden-key')
    if (closing) throw err('the helper was closed', 'helper-closed')
    if (down) throw err(`helper ${down.code === 'helper-down' ? 'is down' : 'did not start'}: ${down.reason}`, down.code)
    try { await ready } catch (e) { throw closing ? err('the helper was closed', 'helper-closed') : e }
    if (closing) throw err('the helper was closed', 'helper-closed')
    if (down) throw err(`helper is down: ${down.reason}`, down.code)
    return new Promise((resolve, reject) => {
      const id = ++seq
      const timer = setTimeout(() => { pending.delete(id); reject(err(`helper ${verb} timed out after ${timeoutMs} ms`, 'helper-timeout', { verb })) }, timeoutMs)
      timer.unref?.()
      pending.set(id, { resolve, reject, timer, verb })
      child.stdin.write(JSON.stringify({ id, verb, args: callArgs }) + '\n')
    })
  }

  /** Stops the helper: EOF on its stdin ends its loop; a helper still there after a second is killed. Not a failure; idempotent. */
  function close() {
    if (closed) return closed
    closing = true
    closed = new Promise((resolve) => {
      for (const p of pending.values()) { clearTimeout(p.timer); p.reject(err('the helper was closed', 'helper-closed')) }
      pending.clear()
      if (!child || down) { fail('closed'); return resolve() }
      let gone = false
      child.once('close', () => { gone = true; resolve() })
      try { child.stdin.end() } catch { /* already closed */ }
      const t = setTimeout(() => { if (!gone) { try { child.kill() } catch { /* gone */ } } }, 1000)
      t.unref?.()
    })
    return closed
  }

  return { call, close, ready, get pid() { return child ? child.pid : undefined } }
}
