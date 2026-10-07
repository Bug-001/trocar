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
//   • the helper cannot start — the spawn fails, it exits or never says ready, it speaks another protocol, or its native code did not compile
//     (it then stays up for the verbs that need none) → {event:'failure',
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
/** What reg-read may read, besides the keys a harness file declares (below): the Internet Settings proxy values (4.7 §3, 4.8 §2.2), the user's Path and the proxy variables of the login environment
 *  (`HKCU\Environment`: the agent's own proxy when no file names one, 4.8 §2.2; asight reads them and never writes one, D43), the machine PATH (the Kimi and OpenCode shims, 4.8 §6.3)
 *  and the Smart App Control policy state (4.8 §8). Hive and key compare case-insensitively with `/` taken as `\` and no trailing `\`; names compare case-insensitively (a registry value name is
 *  not case-sensitive, so `https_proxy` is read as `HTTPS_PROXY`). helper.ps1 carries the same list as one JSON literal. */
export const REG_READ_ALLOW = Object.freeze([
  { hive: 'HKCU', key: 'Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', names: Object.freeze(['ProxyEnable', 'ProxyServer', 'ProxyOverride', 'AutoConfigURL']) },
  { hive: 'HKCU', key: 'Environment', names: Object.freeze(['Path', 'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY']) },
  { hive: 'HKLM', key: 'SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', names: Object.freeze(['Path']) },
  { hive: 'HKLM', key: 'SYSTEM\\CurrentControlSet\\Control\\CI\\Policy', names: Object.freeze(['VerifiedAndReputablePolicyState']) },
].map(Object.freeze))

/** The shape of a key a harness file may declare (a policy value is the one proxy door that is a registry value, 4.8 §2.4: Claude Desktop's `egressProxyUrl`): under `Software\Policies`, every
 *  segment starting with a letter or digit (so no `..`). helper.ps1 applies the same two texts to what it is handed, with `-match`. */
export const POLICY_KEY_PATTERN = '^Software\\\\Policies(\\\\[A-Za-z0-9][A-Za-z0-9 _.-]*)+$'
export const POLICY_NAME_PATTERN = '^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$'
const MAX_DECLARED = 16
const trimKey = (k) => String(k).replaceAll('/', '\\').replace(/\\+$/, '')

/** The declared keys, checked: `[{ hive: 'HKCU'|'HKLM', key, names }]` → the same, hive upper-cased and the key with backslashes and none at the end. Anything that is not a key under `Software\Policies`
 *  with plain value names is a TypeError: a declaration cannot widen what the helper reads beyond the policy keys (W1). `undefined` is no declaration. */
export function declaredRegAllow(list) {
  if (list == null) return []
  if (!Array.isArray(list)) throw new TypeError('regAllow is a list of { hive, key, names }')
  if (list.length > MAX_DECLARED) throw new TypeError(`regAllow has at most ${MAX_DECLARED} entries`)
  const keyRe = new RegExp(POLICY_KEY_PATTERN, 'i')
  const nameRe = new RegExp(POLICY_NAME_PATTERN)
  return Object.freeze(list.map((e) => {
    if (!e || typeof e !== 'object') throw new TypeError('a regAllow entry is { hive, key, names }')
    const hive = typeof e.hive === 'string' ? e.hive.toUpperCase() : ''
    if (hive !== 'HKCU' && hive !== 'HKLM') throw new TypeError(`a declared registry key is in HKCU or HKLM, got ${JSON.stringify(e.hive)}`)
    const key = typeof e.key === 'string' ? trimKey(e.key) : ''
    if (!keyRe.test(key)) throw new TypeError(`a declared registry key is under Software\\Policies, got ${JSON.stringify(e.key)}`)
    if (!Array.isArray(e.names) || e.names.length === 0 || e.names.length > MAX_DECLARED || e.names.some((n) => typeof n !== 'string' || !nameRe.test(n))) throw new TypeError(`the value names of ${key} are 1 to ${MAX_DECLARED} plain names`)
    return Object.freeze({ hive, key, names: Object.freeze([...e.names]) })
  }))
}

/** The registry values the groups' proxy entries of kind `policy` live in, as `startHelper({ regAllow })` takes them (the daemon passes harness data through this; this file knows no harness). Two names of one key are one entry. */
export function policyAllowOf(groups) {
  const byKey = new Map()
  for (const g of groups || []) {
    const e = g && g.proxyEntry
    if (!e || e.kind !== 'policy') continue
    const id = `${String(e.hive).toUpperCase()}\\${trimKey(e.key).toLowerCase()}`
    if (!byKey.has(id)) byKey.set(id, { hive: e.hive, key: e.key, names: [] })
    const entry = byKey.get(id)
    if (!entry.names.includes(e.name)) entry.names.push(e.name)
  }
  return [...byKey.values()]
}

/** The value kinds of a reg-read answer, in the registry's own names. helper.ps1 gives .NET's `RegistryValueKind` (`GetValueKind().ToString()`: `DWord`, `String`, `ExpandString`, ...); 4.8 §1 says `kind` is given as it is
 *  (`REG_EXPAND_SZ` stays that, §6.3) and every reader (a DWORD `ProxyEnable`, §2.2; the Smart App Control state, §8; the PATH type a write must keep, §6.3) is written against these names, as are the fakes of the tests. */
export const REG_KIND_NAMES = Object.freeze({ dword: 'REG_DWORD', qword: 'REG_QWORD', string: 'REG_SZ', expandstring: 'REG_EXPAND_SZ', multistring: 'REG_MULTI_SZ', binary: 'REG_BINARY', none: 'REG_NONE', unknown: 'REG_UNKNOWN' })

/** The answer with each value's `kind` in REG_* names (a spelling that is not one of .NET's, such as one already in REG_* form, stays as it is). An answer that is not a registry read is returned unchanged: judging it is the caller's. */
export function regKindsOf(data) {
  if (!data || typeof data !== 'object' || !data.values || typeof data.values !== 'object') return data
  const values = {}
  for (const [name, v] of Object.entries(data.values)) values[name] = v && typeof v === 'object' && typeof v.kind === 'string' && Object.hasOwn(REG_KIND_NAMES, v.kind.toLowerCase()) ? { ...v, kind: REG_KIND_NAMES[v.kind.toLowerCase()] } : v
  return { ...data, values }
}

const ABANDONED_CAP = 256
const STDERR_TAIL = 20 // the last lines of its stderr that helper-down carries (4.6 §记录: 20, as the Linux client's)
const normKey = (k) => trimKey(k).toLowerCase()

/** The allow-list entry a reg-read request falls under (in the fixed list, or in `extra`, the keys a harness declared), or null. A request with no names asks for everything: refused. */
export function regReadAllowed(args, extra = []) {
  if (!args || typeof args !== 'object' || !Array.isArray(args.names) || args.names.length === 0) return null
  const rule = [...REG_READ_ALLOW, ...extra].find((r) => r.hive.toLowerCase() === String(args.hive).toLowerCase() && normKey(r.key) === normKey(args.key))
  if (!rule) return null
  const ok = new Set(rule.names.map((n) => n.toLowerCase()))
  return args.names.every((n) => typeof n === 'string' && ok.has(n.toLowerCase())) ? rule : null
}

const err = (message, code, extra = {}) => Object.assign(new Error(message), { code }, extra)

/** startHelper({ spawn, exe, args, env, regAllow, onExit, onFailure, readyTimeoutMs }) → { call(verb, args, { timeoutMs = 2000 }), abandoned(verb), close(), pid, ready }
 *  `regAllow`: the registry keys the harness files declare (policyAllowOf), which `reg-read` may read beyond REG_READ_ALLOW. Checked by declaredRegAllow before a process starts (a TypeError for anything that is not a key under
 *  Software\Policies), checked again by every call, and handed to helper.ps1 as `-ExtraRegAllowB64 <base64 of the JSON>`, the last pair of its arguments, which the script checks once more.
 *  `ready` resolves with the helper's ready line, or rejects when it never starts. `onExit({ reason, exit?, stderr?, ready, closed })` is
 *  told once when the helper is gone, however it went. */
export function startHelper({ spawn = nodeSpawn, exe = 'powershell.exe', args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', HELPER_PS1], env = process.env, regAllow, onExit = () => {}, onFailure = () => {}, readyTimeoutMs = 15000 } = {}) {
  const declared = declaredRegAllow(regAllow)
  if (declared.length > 0) args = [...args, '-ExtraRegAllowB64', Buffer.from(JSON.stringify(declared), 'utf8').toString('base64')]
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
  const abandoned = new Map() // id → verb of the calls that timed out and whose late answer has not come yet (capped: a helper that hangs for good must not grow it)
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
    abandoned.clear()
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
      resolveReady(msg)
      // the native code (Add-Type: the process list, the TCP table, the token) did not compile — a policy, a blocked compiler, an unwritable temp dir.
      // The helper is up and answers the verbs that need none (registry, interfaces, roots), but the collector cannot see processes: that is a
      // helper that did not start properly, and never silent (4.8 §12)
      if (msg.native === false && !closing) onFailure({ event: 'failure', where: 'helper', code: 'helper-start-failed', reason: `the helper's native code did not compile (${msg.nativeError || 'no reason given'}): the process list, the TCP table and the token are unavailable; the registry, interface and root reads still work`, nativeError: msg.nativeError ?? null })
      return
    }
    const p = pending.get(msg.id)
    if (!p) { abandoned.delete(msg.id); return } // a late answer to a call that already timed out: the helper is free of it now
    pending.delete(msg.id)
    clearTimeout(p.timer)
    if (msg.ok === true) p.resolve(p.verb === 'reg-read' ? regKindsOf(msg.data) : msg.data)
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
    if (verb === 'reg-read' && !regReadAllowed(callArgs, declared)) throw err(`reg-read outside the allow-list: ${JSON.stringify(callArgs)}`, 'helper-forbidden-key')
    if (closing) throw err('the helper was closed', 'helper-closed')
    if (down) throw err(`helper ${down.code === 'helper-down' ? 'is down' : 'did not start'}: ${down.reason}`, down.code)
    try { await ready } catch (e) { throw closing ? err('the helper was closed', 'helper-closed') : e }
    if (closing) throw err('the helper was closed', 'helper-closed')
    if (down) throw err(`helper is down: ${down.reason}`, down.code)
    return new Promise((resolve, reject) => {
      const id = ++seq
      const timer = setTimeout(() => {
        pending.delete(id)
        abandoned.set(id, verb)
        if (abandoned.size > ABANDONED_CAP) abandoned.delete(abandoned.keys().next().value)
        reject(err(`helper ${verb} timed out after ${timeoutMs} ms`, 'helper-timeout', { verb }))
      }, timeoutMs)
      timer.unref?.()
      pending.set(id, { resolve, reject, timer, verb })
      child.stdin.write(JSON.stringify({ id, verb, args: callArgs }) + '\n')
    })
  }

  /** How many calls of this verb timed out and are still being worked on: the helper is single-threaded, so a request sent now waits behind them (and
   *  their late answers are dropped). 0 when the helper is gone. A caller that polls (procinfo's `ps`) does not send another while this is above 0. */
  function abandonedCount(verb) {
    let n = 0
    for (const v of abandoned.values()) if (v === verb) n++
    return n
  }

  /** Stops the helper: EOF on its stdin ends its loop; a helper still there after a second is killed. Not a failure; idempotent. */
  function close() {
    if (closed) return closed
    closing = true
    abandoned.clear()
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

  return { call, close, ready, abandoned: abandonedCount, get pid() { return child ? child.pid : undefined } }
}
