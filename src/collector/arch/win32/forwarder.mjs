// forwarder.mjs — asight's own kernel on Windows: where it comes from, how it is checked, how it is run (RFC 4.8 §3 · §4 · §8 · §12; acceptance W27 W28 W55 W74).
//
// The kernel is a pinned mihomo, shipped as `asight-forwarder.exe` in a per-platform npm package that comes with asight (4.8 §8: `on` never downloads). This file finds that package,
// checks the exe against the pin, copies it to the user's `kernel\` directory and checks the copy again before EVERY start (the first and each re-spawn of the backoff). Nothing here goes online:
// no http, https, dns or fetch (W27 ⑦ scans this file's source and records every connection a test makes), and the user's proxy software is never read or written (D43).
//
// Every function takes what it touches (`fs`, `hash`, `resolvePackage`, the spawn, the clock, the controller) so a test on any OS runs it against a temp directory and a fake kernel process.

import nodeFs from 'node:fs'
import path from 'node:path'
import { spawn as nodeSpawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { createController } from '../../../netenv/mihomo/controller.mjs'

export const KERNEL_EXE = 'asight-forwarder.exe'
export const KERNEL_LICENSE = 'LICENSE-mihomo.txt'
export const KERNEL_SOURCE = 'SOURCE-mihomo.txt'
const HERE = path.dirname(fileURLToPath(import.meta.url))

/** The pin (mihomo-pin.json): the pinned version and, per architecture, the platform package and the sha256 of the exe in it. Read once, synchronously: it is a few hundred bytes next to this file. */
export function loadPin() {
  return JSON.parse(nodeFs.readFileSync(path.join(HERE, 'mihomo-pin.json'), 'utf8'))
}

/** The main package's name and version, which the reinstall commands name. */
export function mainPackage() {
  const { name, version } = JSON.parse(nodeFs.readFileSync(path.join(HERE, '..', '..', '..', '..', 'package.json'), 'utf8'))
  return { name, version }
}

/**
 * The two ways to put the kernel back, as literals (4.8 §8 ⑤, §10.4): asight cannot tell how it was installed, so both are printed, and it never runs either (1.6 R8). There is no download address in them:
 * the second is the Release's tarballs, installed together (`npm pack` names a tarball <name>-<version>.tgz).
 */
export function reinstallCommands({ main, platformPackage }) {
  return {
    npm: `npm install --global ${main.name}@${main.version} --include=optional`,
    release: `npm install --global ${main.name}-${main.version}.tgz ${platformPackage}-${main.version}.tgz`,
  }
}

/** The sha256 and the size of a file, streamed (the exe is tens of megabytes). */
export function hashFile(file, { fs = nodeFs } = {}) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    let size = 0
    const s = fs.createReadStream(file)
    s.on('data', (d) => { h.update(d); size += d.length })
    s.on('error', reject)
    s.on('end', () => resolve({ size, sha256: h.digest('hex') }))
  })
}

/** The directory of the installed platform package, found from asight's own install location (the package is an optionalDependency, so npm puts it where `require` finds it), or null. */
export function defaultResolvePackage(name) {
  try { return path.dirname(createRequire(import.meta.url).resolve(`${name}/package.json`)) } catch { return null }
}

const isFile = (fs, p) => { try { return fs.statSync(p).isFile() } catch { return false } }
const same = (got, want) => got.sha256 === want.sha256 && (want.size == null || got.size === want.size)

/**
 * Where the kernel is and whether it is the pinned one: read-only, no network, no write, and it never touches the package directory (that is npm's).
 * → `{ found: { packageDir, exe, sha256, size } }` · `{ missing: { reason, commands } }` (reason: `unsupported-arch` the pin has no package for this architecture · `not-pinned` the pin's exe digest is null (the release was
 * built without it) · `package-not-installed` the package is not there, or has no exe: `npm i --omit=optional` does this) · `{ mismatch: { of: 'package', commands } }` (the exe in the package is not the pinned one).
 * `commands` = `reinstallCommands(...)` (null for an architecture the pin does not know: reinstalling cannot help).
 * `resolvePackage(name)` → the package's directory or null; `hash(file)` → `{ size, sha256 }`; `arch` is `x64` or `arm64`.
 */
export async function locateKernel({ pin, arch, resolvePackage = defaultResolvePackage, fs = nodeFs, hash = (f) => hashFile(f, { fs }), main = mainPackage() } = {}) {
  const asset = pin && pin.assets && pin.assets[arch]
  if (!asset) return { missing: { reason: 'unsupported-arch', commands: null } }
  const commands = reinstallCommands({ main, platformPackage: asset.package })
  if (!asset.exe || typeof asset.exe.sha256 !== 'string') return { missing: { reason: 'not-pinned', commands } }
  const packageDir = await resolvePackage(asset.package)
  const exe = packageDir ? path.join(packageDir, asset.exe.name) : null
  if (!exe || !isFile(fs, exe)) return { missing: { reason: 'package-not-installed', commands } }
  const got = await hash(exe)
  if (!same(got, asset.exe)) return { mismatch: { of: 'package', commands } }
  return { found: { packageDir, exe, sha256: got.sha256, size: got.size } }
}

/**
 * Find the kernel (locateKernel), then put it where it runs from: `dir` is `%USERPROFILE%\.asight\collector\kernel\`, the exe and the licence and source files beside it. A copy, not a run from the package: Windows does
 * not let a running exe be replaced or deleted, and a kernel in `node_modules` would block `npm i -g` and `npm uninstall` for as long as it lives (4.8 §8). The copy goes to a temp name, is hashed, and only then takes
 * the name; a target that is already there with the right digest is left alone (its mtime does not move).
 * → `{ path, sha256, copied }` · `{ missing }` · `{ mismatch: { of: 'package' | 'copy', commands } }`. The copy is ledgered as `forwarder-binary` (path and sha256) by the caller (Task 8(c)'s `on`); `uninstall` removes it.
 */
export async function ensureBinary({ pin, arch, dir, resolvePackage, fs = nodeFs, hash = (f) => hashFile(f, { fs }), main = mainPackage() } = {}) {
  const located = await locateKernel({ pin, arch, resolvePackage, fs, hash, main })
  if (!located.found) return located
  const { packageDir, exe } = located.found
  const want = pin.assets[arch].exe
  const target = path.join(dir, KERNEL_EXE)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  let copied = false
  let have = null
  if (isFile(fs, target)) { try { have = await hash(target) } catch { have = null } }
  if (!have || !same(have, want)) {
    const tmp = `${target}.tmp-${process.pid}`
    fs.copyFileSync(exe, tmp)
    try {
      if (!same(await hash(tmp), want)) { fs.rmSync(tmp, { force: true }); return { mismatch: { of: 'copy', commands: reinstallCommands({ main, platformPackage: pin.assets[arch].package }) } } }
      fs.renameSync(tmp, target)
    } catch (e) { fs.rmSync(tmp, { force: true }); throw e }
    copied = true
  }
  for (const name of [KERNEL_LICENSE, KERNEL_SOURCE]) { // the licence text and the source address travel with the exe (GPL-3.0-only)
    const from = path.join(packageDir, name)
    const to = path.join(dir, name)
    if (!isFile(fs, from)) continue
    const text = fs.readFileSync(from)
    if (!isFile(fs, to) || !fs.readFileSync(to).equals(text)) fs.writeFileSync(to, text)
  }
  return { path: target, sha256: want.sha256, copied }
}

/**
 * What the forwarder calls before EVERY spawn (the first start and each re-spawn of the backoff): is the copy in `dir` still the pinned exe? It never copies from the package again: the copy is what ran, and a copy that
 * was changed or deleted is a failure to report (`on` repairs it, 4.8 §8 ④).
 * → `{ ok: true, sha256 }` · `{ missing: { reason: 'file-missing' | 'not-pinned' | 'unsupported-arch' } }` · `{ mismatch: { of: 'copy' } }`.
 */
export async function verifyCopy({ dir, pin, arch, fs = nodeFs, hash = (f) => hashFile(f, { fs }) } = {}) {
  const asset = pin && pin.assets && pin.assets[arch]
  if (!asset) return { missing: { reason: 'unsupported-arch' } }
  if (!asset.exe || typeof asset.exe.sha256 !== 'string') return { missing: { reason: 'not-pinned' } }
  const target = path.join(dir, KERNEL_EXE)
  if (!isFile(fs, target)) return { missing: { reason: 'file-missing' } }
  const got = await hash(target)
  return same(got, asset.exe) ? { ok: true, sha256: got.sha256 } : { mismatch: { of: 'copy' } }
}

// ---- Smart App Control (4.8 §8, W74) ------------------------------------------------------------------------------------------------------------------------------

const SAC_KEY = 'SYSTEM\\CurrentControlSet\\Control\\CI\\Policy'
const SAC_VALUE = 'VerifiedAndReputablePolicyState'

/**
 * Whether Smart App Control would stop the unsigned kernel from starting: `HKLM\SYSTEM\CurrentControlSet\Control\CI\Policy\VerifiedAndReputablePolicyState` through the helper's read-only `reg-read` (0 off, 1 on, 2
 * evaluation). No such key or value: the system has no Smart App Control, nothing stops the kernel: 'off'. An answer that is not 0, 1 or 2, or a helper that cannot read it, is `{ unknown: { reason } }`
 * (1.6 §9.4's closed reasons: `timeout` · `denied` · `unparseable`), never a guess. asight never writes this key.
 */
export async function sacState({ helper }) {
  let r
  try { r = await helper.call('reg-read', { hive: 'HKLM', key: SAC_KEY, names: [SAC_VALUE] }) } catch (e) {
    return { unknown: { reason: e && e.code === 'helper-timeout' ? 'timeout' : 'denied', detail: (e && e.code) || 'error' } }
  }
  const v = r && r.values && r.values[SAC_VALUE]
  if (!r || r.keyExists === false || v == null) return 'off'
  const n = typeof v === 'object' ? v.value : v
  return n === 0 ? 'off' : n === 1 ? 'on' : n === 2 ? 'evaluation' : { unknown: { reason: 'unparseable', detail: String(n).slice(0, 40) } }
}
/** Is the unsigned kernel at risk? Only a state that says so: an unknown one is not a reason to blame Smart App Control for a start that failed (the plan line says 「不知道」 for it, not this). */
export const sacBlocks = (state) => state === 'on' || state === 'evaluation'

// ---- the running kernel (4.8 §3.3 · §4 · §8, W12 W28 W55 W74) ---------------------------------------------------------------------------------------------

export const BACKOFF_MS = Object.freeze([1000, 2000, 4000, 8000, 16000, 30000]) // 1, 2, 4 … capped at 30 s (§8)
const DOWN_AFTER = 5 // the fifth straight failure is `forwarder-down`
const START_TOLERANCE_MS = 2000 // how far a process's start time may be from the lock's before it is not the process that wrote it

const pidAlive = (pid) => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const errText = (e) => String((e && e.message) || e)
const exitText = (e) => (e.signal ? `signal ${e.signal}` : `code ${e.code}`)

function writeAtomic(fs, file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, text, { mode: 0o600 })
  fs.renameSync(tmp, file)
}

/** What the forwarder needs to know of a config text (buildForwarderConfig's: JSON): every port the kernel is to hold, and each fallback group's probe address. A text that is not the generator's is a bug of the caller. */
function readConfig(text) {
  let c
  try { c = JSON.parse(text) } catch (e) { throw new TypeError(`the kernel's config is not JSON: ${errText(e)}`) }
  const m = /^127\.0\.0\.1:(\d+)$/.exec(String(c['external-controller']))
  if (!m || typeof c.secret !== 'string') throw new TypeError("the kernel's config has no external-controller on 127.0.0.1 or no secret")
  const probes = {}
  for (const g of c['proxy-groups'] || []) if (/^asight-fb-/.test(g.name)) probes[g.name.slice('asight-fb-'.length)] = g.url
  return { ports: new Set([...(c.listeners || []).map((l) => l.port), Number(m[1])]), probes, controller: { port: Number(m[1]), secret: c.secret } }
}

/**
 * createForwarder → the kernel's process: start it, change its config, keep it up, let agents drain from it, stop it.
 *   dir        the collector directory: `forwarder.lock` (`{pid, startedAt, endpoint, config}`) and `forwarder/` (the config, 0600, and the kernel's home) are made in it
 *   bin        the kernel exe (the copy in `kernel\`)
 *   controller `{ port, secret }` for this run, chosen at random by the caller; `adopt()` replaces it with that of a kernel that is already running
 *   verifyCopy () → verifyCopy()'s answer for THIS kernel (the caller binds dir, pin and arch): asked before EVERY spawn, the first one and each respawn (W27 ④)
 *   sacOn      () → whether Smart App Control would block an unsigned exe: a start that fails then says so (W74)
 *   isFree     (port) → whether a loopback port can be bound; REQUIRED: this file may not import `node:net` (W27 ⑦). A taken port is not re-chosen here: the form's entry holds it (ingress-config.mjs).
 *   procStart  (pid) → the process's start time in ms, or null; REQUIRED (the helper's `ps`, the one source the lock and the adopt rule both read). A helper that rejects or answers nothing is null: the kernel is still tracked and
 *              its lock is written with `startedAt: null`, which no later daemon will adopt (4.8 §8: no readable start time, no adoption)
 *   spawn · makeController · now · setTimer · clearTimer · isAlive · kill · fs   the OS and the clock, injected
 *   events     `{ failure(rec), state(rec) }`: the §12 records, to the daemon's recorder
 * `build(controller)` → the config text for the controller the forwarder is really talking to (so the text and the client cannot disagree); `forms` is `[{ f, on }]`, the forms whose fallback group should be there
 * (on) or not (off), which the read-back checks (§4.1: an entry is written only after it says on).
 */
export function createForwarder({
  dir, bin, controller, spawn = nodeSpawn, makeController = ({ port, secret }) => createController({ endpoint: `tcp:127.0.0.1:${port}`, secret, own: true }),
  now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, events = { failure() {}, state() {} }, sacOn = async () => false, verifyCopy: verify = async () => ({ ok: true }), isFree,
  isAlive = pidAlive, kill = (pid) => process.kill(pid), procStart, fs = nodeFs,
  pollMs = 50, startTimeoutMs = 10_000, stableMs = 30_000, stopWaitMs = 5_000, watchMs = 1000, backoffMs = BACKOFF_MS,
} = {}) {
  if (typeof isFree !== 'function') throw new TypeError('createForwarder needs isFree(port)')
  if (typeof procStart !== 'function') throw new TypeError('createForwarder needs procStart(pid): the lock and the adopt rule read the same clock, and a wiring that forgot it writes locks nobody can adopt')
  const P = { lock: path.join(dir, 'forwarder.lock'), config: path.join(dir, 'forwarder', 'config.json'), home: path.join(dir, 'forwarder', 'home'), forwarder: path.join(dir, 'forwarder') }
  let creds = { ...controller }
  let ctl = makeController(creds)
  let cur = null // { text, forms, ports: Set, probes }: the config the kernel runs
  let proc = null // { pid, startedAt, child, adopted, stable: timer }
  let phase = 'stopped' // stopped · starting · running · backoff
  let streak = 0
  let downReported = false
  let respawnTimer = null
  let watchTimer = null
  let drainTimer = null
  let stopping = false
  let drainPids = null

  // The kernel is changed by one thing at a time: a call of the daemon (start, reload, adopt, stopNow), the supervisor's own re-spawn and a drain's last stop each wait for the one in front. Without it a stopNow
  // returned "stopped" while a re-spawn was still coming up and the attempt then committed a kernel nobody tracked, and a reload during a re-spawn spawned a second kernel. `stopping` is how a call that is waiting
  // (or an attempt that is running) tells the one in front to give up: stopNow sets it before it queues.
  let tail = Promise.resolve()
  const exclusive = (fn) => { const run = tail.then(fn); tail = run.then(() => {}, () => {}); return run }

  const fail = (code, reason, extra = {}) => { const rec = { where: code === 'forwarder-down' ? 'netenv' : 'forwarder', code, reason, ...extra }; events.failure(rec); return { ok: false, ...rec } }
  const startOf = async (pid) => { try { const v = await procStart(pid); return Number.isFinite(v) ? v : null } catch { return null } }
  const rmLock = () => { try { fs.rmSync(P.lock, { force: true }) } catch { /* nothing to remove */ } }

  // a start that did not come up is Smart App Control's when it is on (or evaluating): that is the reason an operator can act on (W74)
  async function startFailed(what, detail = {}) {
    if (await sacOn()) return fail('forwarder-start-failed', 'smart-app-control', { ...detail, because: what })
    return fail('forwarder-start-failed', what, detail)
  }

  // kill a process we hold (our child) or adopted (a pid) and wait for it to be gone: true when it is
  async function reap(p) {
    try { if (p.child) p.child.kill(); else kill(p.pid) } catch { /* already gone */ }
    const t0 = now()
    while (isAlive(p.pid) && now() - t0 < stopWaitMs) await sleep(pollMs)
    return !isAlive(p.pid)
  }

  /** One attempt to bring the kernel up on `text`: the copy is checked, the ports are free, the config is written, the process is spawned and its controller answers. A failure it returns has already been recorded. */
  async function attempt(text, next) {
    const v = await verify()
    if (v && v.mismatch) return fail('forwarder-digest-mismatch', 'the kernel copy in kernel\\ is not the pinned exe (its sha256 differs): it is not started, `asight on` puts the pinned one back', { of: v.mismatch.of || 'copy' })
    if (v && v.missing) return fail('forwarder-binary-missing', v.missing.reason || 'file-missing')
    for (const port of next.ports) if (!(await isFree(port))) return fail('forwarder-start-failed', 'port-taken', { port })
    writeAtomic(fs, P.config, text)
    fs.mkdirSync(P.home, { recursive: true, mode: 0o700 })
    let child
    let spawnError = null
    let exited = null
    try { child = spawn(bin, ['-d', P.home, '-f', P.config], { cwd: P.home, detached: true, stdio: 'ignore', windowsHide: true }) } catch (e) { spawnError = e }
    const spawnFailed = () => startFailed(spawnError.code || errText(spawnError), { errno: spawnError.code ?? null })
    if (spawnError) return spawnFailed()
    const p = { pid: child.pid, startedAt: null, child, adopted: false, stable: null }
    child.once('error', (e) => { spawnError = e })
    child.once('exit', (code, sig) => { exited = { code, signal: sig }; if (proc === p) onExit(p, exitText(exited)) })
    const t0 = now()
    for (;;) {
      if (spawnError) return spawnFailed()
      if (exited) return startFailed(`the kernel exited (${exitText(exited)}) before it answered`, { exit: exited.signal || exited.code })
      if (stopping) { await reap(p); return { ok: false, stopped: true } } // stopNow came while we waited: this kernel is not to live
      if ((await ctl.get('/version')).ok) break
      if (now() - t0 > startTimeoutMs) { try { child.kill() } catch { /* gone */ } return startFailed(`the kernel's controller did not answer within ${startTimeoutMs} ms`) }
      await sleep(pollMs)
    }
    child.unref?.()
    p.startedAt = await startOf(p.pid)
    if (stopping) { await reap(p); return { ok: false, stopped: true } } // asked to stop while it came up (or while its start time was read): do not commit it
    writeAtomic(fs, P.lock, `${JSON.stringify({ pid: p.pid, startedAt: p.startedAt, endpoint: `tcp:127.0.0.1:${creds.port}`, config: P.config })}\n`)
    proc = p
    phase = 'running'
    cur = { ...next, text }
    p.stable = setTimer(() => { if (proc === p) { streak = 0; downReported = false } }, stableMs) // the failures are "straight" until it has stayed up this long
    p.stable?.unref?.()
    events.state({ event: 'forwarder-start', where: 'forwarder', pid: p.pid, adopted: false })
    if (exited) onExit(p, exitText(exited)) // it died between "answered" and here
    return { ok: true, pid: p.pid }
  }

  // a kernel that exits by itself or is killed is brought back after a backoff; the fifth straight failure is `forwarder-down`, and the tries go on at the cap
  function onExit(p, how) {
    if (proc !== p) return
    proc = null
    clearTimer(p.stable)
    clearTimer(watchTimer); watchTimer = null
    rmLock()
    if (stopping) return
    streak++
    schedule(`exited (${how})`)
  }
  function schedule(why) {
    const delay = backoffMs[Math.min(streak - 1, backoffMs.length - 1)]
    events.failure({ where: 'forwarder', code: 'forwarder-restart', reason: `the kernel ${why}; trying again in ${delay} ms`, attempt: streak, delay_ms: delay })
    if (streak >= DOWN_AFTER && !downReported) { downReported = true; events.failure({ where: 'netenv', code: 'forwarder-down', reason: `the kernel did not stay up ${streak} times in a row`, attempts: streak }) }
    phase = 'backoff'
    respawnTimer = setTimer(() => { respawnTimer = null; exclusive(respawn).catch((e) => { if (stopping) return; streak++; schedule(`did not start again (${errText(e)})`) }) }, delay)
    respawnTimer?.unref?.()
  }
  async function respawn() {
    if (stopping || !cur || proc) return // stopped meanwhile, or a start / reload that was in front of us brought it up
    phase = 'starting'
    const r = await attempt(cur.text, cur) // the same text and the same ports; the copy was checked again inside
    if (stopping) return
    if (!r.ok) { streak++; schedule(`did not start again (${r.reason})`); return }
    await refresh(cur.forms)
  }

  // the probe of each form that is on, asked for now rather than at the next interval (4.8 §3.3): the engine may have just come up
  const refresh = (forms) => Promise.all((forms || []).filter((f) => f.on && cur && cur.probes[f.f]).map((f) => ctl.get(`/group/asight-fb-${f.f}/delay?url=${encodeURIComponent(cur.probes[f.f])}&timeout=2000`)))
  // what the kernel says now, form by form: on = its fallback group selects the engine; fallback = it selects the re-entry (the engine is down); off = no group; anything it does not say plainly is unknown, not a guess
  async function readBack(forms) {
    const out = {}
    await Promise.all((forms || []).map(async ({ f, on }) => {
      const r = await ctl.get(`/proxies/asight-fb-${f}`)
      const now_ = r.ok && r.json && typeof r.json.now === 'string' ? r.json.now : null
      if (r.status === 404) out[f] = { state: on ? 'missing' : 'off' }
      else if (now_ !== null) out[f] = !on ? { state: 'still-on' } : now_ === `asight-in-${f}` ? { state: 'on', now: now_ } : now_.startsWith('asight-re-') ? { state: 'fallback', now: now_ } : { state: 'unknown', reason: 'unexpected-now' }
      else out[f] = { state: 'unknown', reason: r.status ? `status-${r.status}` : r.error || 'no-answer' }
    }))
    return { ok: (forms || []).every(({ f, on }) => out[f].state === (on ? 'on' : 'off')), forms: out }
  }

  async function startNow({ build, forms }) {
    if (proc && phase === 'running') return reloadNow({ build, forms })
    const text = build({ ...creds })
    const parsed = readConfig(text)
    clearTimer(respawnTimer); respawnTimer = null
    stopping = false; streak = 0; downReported = false
    phase = 'starting'
    const r = await attempt(text, { forms, ports: parsed.ports, probes: parsed.probes })
    if (!r.ok) { phase = 'stopped'; const { ok, ...why } = r; return { ok, ...why } }
    await refresh(forms)
    const back = await readBack(forms)
    return { ok: back.ok, pid: r.pid, readBack: back }
  }

  async function reloadNow({ build, forms }) {
    if (!proc || phase !== 'running') return startNow({ build, forms })
    const text = build({ ...creds })
    const parsed = readConfig(text)
    for (const port of parsed.ports) {
      if (!cur.ports.has(port) && !(await isFree(port))) { const f = fail('forwarder-start-failed', 'port-taken', { port }); return { ok: false, readBack: null, code: f.code, reason: f.reason, port } }
    }
    const put = await ctl.put('/configs?force=true', { payload: text })
    if (!put.ok) return { ok: false, readBack: null, error: { status: put.status, text: put.text } }
    writeAtomic(fs, P.config, text)
    cur = { text, forms, ports: parsed.ports, probes: parsed.probes }
    await refresh(forms)
    const back = await readBack(forms)
    return { ok: back.ok, readBack: back }
  }

  const check = async () => (proc && cur ? readBack(cur.forms) : { ok: false, forms: {}, reason: 'not-running' })

  // a kernel left by an earlier daemon is kept only when its pid, its start time and its controller all say it is the one the lock names
  async function adoptNow() {
    let lock
    try { lock = JSON.parse(fs.readFileSync(P.lock, 'utf8')) } catch (e) { return { adopted: false, reason: e && e.code === 'ENOENT' ? 'no-lock' : 'lock-unreadable' } }
    if (!lock || !Number.isInteger(lock.pid) || typeof lock.config !== 'string') return { adopted: false, reason: 'lock-unreadable' }
    if (!isAlive(lock.pid)) { rmLock(); return { adopted: false, reason: 'not-running' } }
    const started = await startOf(lock.pid)
    if (!Number.isFinite(started) || !Number.isFinite(lock.startedAt)) return { adopted: false, reason: 'start-time-unreadable' }
    if (Math.abs(started - lock.startedAt) > START_TOLERANCE_MS) return { adopted: false, reason: 'start-time-differs' } // the pid is somebody else's now
    let text
    let parsed
    try { text = fs.readFileSync(lock.config, 'utf8'); parsed = readConfig(text) } catch { return { adopted: false, reason: 'config-unreadable' } }
    if (lock.endpoint !== `tcp:127.0.0.1:${parsed.controller.port}`) return { adopted: false, reason: 'config-differs' }
    const probe = makeController(parsed.controller)
    if (!(await probe.get('/version')).ok) return { adopted: false, reason: 'version-no-answer' }
    creds = parsed.controller
    ctl = probe
    cur = { text, forms: [], ports: parsed.ports, probes: parsed.probes }
    const p = { pid: lock.pid, startedAt: lock.startedAt, child: null, adopted: true, stable: null }
    proc = p
    phase = 'running'
    stopping = false
    const watch = () => { watchTimer = setTimer(() => { watchTimer = null; if (proc !== p) return; if (isAlive(p.pid)) watch(); else onExit(p, 'is gone') }, watchMs); watchTimer?.unref?.() }
    watch()
    events.state({ event: 'forwarder-start', where: 'forwarder', pid: p.pid, adopted: true })
    return { adopted: true, pid: p.pid, controller: { ...creds } }
  }

  const remaining = () => (drainPids || []).filter((pid) => isAlive(pid))

  // stop the process we hold (or adopted) and wait for it to be gone; `reason` is what the state event says. Only called inside `exclusive`.
  async function stopKernel(reason) {
    stopping = true
    clearTimer(respawnTimer); respawnTimer = null
    clearTimer(watchTimer); watchTimer = null
    const p = proc
    if (!p) { phase = 'stopped'; return true }
    if (!(await reap(p))) return false
    proc = null
    clearTimer(p.stable)
    rmLock()
    phase = 'stopped'
    events.state({ event: 'forwarder-stop', where: 'forwarder', pid: p.pid, reason })
    return true
  }

  /**
   * After an `off` the kernel only forwards, and the agents that started while asight was on keep using it until they exit: `pidsInWindow` are those agents' pids (4.8 §4.2). The kernel is stopped
   * when the last of them is gone. → `{ remaining, done }`: how many are left now, and a promise that settles `{ stopped }` when the drain ends (the daemon holds its exit on it).
   */
  function drain({ pidsInWindow = [] } = {}) {
    drainPids = [...pidsInWindow]
    events.state({ event: 'forwarder-draining', where: 'forwarder', pids: [...drainPids] })
    const done = new Promise((resolve) => {
      const tick = async () => {
        drainTimer = null
        if (remaining().length > 0) { drainTimer = setTimer(tick, watchMs); drainTimer?.unref?.(); return }
        resolve({ stopped: await exclusive(() => stopKernel('drained')) })
      }
      drainTimer = setTimer(tick, 0)
    })
    return { remaining: remaining().length, done }
  }

  /** `off --now` and `uninstall`: stop at once. `pids` are the agents still in the drain window that lose their connection. */
  function stopNow() {
    stopping = true // an attempt in flight sees it and gives up; a waiting re-spawn does nothing
    clearTimer(respawnTimer); respawnTimer = null
    clearTimer(drainTimer); drainTimer = null
    return exclusive(async () => {
      const pids = remaining()
      const stopped = await stopKernel('stop-now')
      return { pids, stopped }
    })
  }
  const start = (a) => exclusive(() => startNow(a))
  const reload = (a) => exclusive(() => reloadNow(a))
  const adopt = () => exclusive(adoptNow)

  /** `uninstall`: remove the copy and the files beside it. A file Windows still holds (the kernel is running, a drain is on) stays and `reason` says why (W28). */
  function removeBinary() {
    try { fs.rmSync(bin, { force: true }) } catch (e) { return { removed: false, reason: (e && e.code) || errText(e) } }
    for (const name of [KERNEL_LICENSE, KERNEL_SOURCE]) { try { fs.rmSync(path.join(path.dirname(bin), name), { force: true }) } catch { /* the exe is gone: a stray text file is not a lock */ } }
    try { fs.rmdirSync(path.dirname(bin)) } catch { /* not empty, or gone */ }
    return { removed: true }
  }
  /** `uninstall`: the lock, the config (it holds the controller secret and the tokens) and the kernel's home. */
  function removeState() {
    try { fs.rmSync(P.forwarder, { recursive: true, force: true }); fs.rmSync(P.lock, { force: true }) } catch (e) { return { removed: false, reason: (e && e.code) || errText(e) } }
    return { removed: true }
  }

  return {
    start, reload, check, adopt, drain, remaining, stopNow, removeBinary, removeState,
    controller: () => ({ ...creds }),
    state: () => ({ phase, pid: proc ? proc.pid : null, adopted: proc ? proc.adopted : false, streak, down: downReported, draining: remaining().length }),
  }
}
