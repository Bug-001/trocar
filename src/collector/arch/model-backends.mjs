// model-backends.mjs — what the collector model (RFC 4.11) takes from the OS on macOS and Windows, gathered in one place for `install`, `on` and
// `uninstall` (plan T20): the key custody (P1), the user root store (P3), the wrapper kit (P8), the platform facts and the sources ctx readers
// (§2.3). Each is the arch's own module, imported lazily, so Linux never loads them. A test passes its own pieces instead (0.1 §3).
import nodeFs from 'node:fs'
import path from 'node:path'

import { isModelOs } from '../model-install.mjs'
import { redactProxyUrl } from '../../netenv/redact.mjs'
import { recordDrift } from '../../netenv/adopt.mjs'
export { MODEL_OS, isModelOs } from '../model-install.mjs' // the one list of the OSes the model runs on

/** The installed signing helper the darwin custody runs (4.11 P1): under ~/.asight/bin, beside asight-off. */
export const signHelperPath = (home, name) => path.join(home, '.asight', 'bin', name)

/** `which(command)` over the user's PATH (the install env): the first <dir>/<command><suffix> that exists, or null. */
export function whichIn(env, { os, exists = nodeFs.existsSync } = {}) {
  const get = (k) => (env instanceof Map ? env.get(k) : env && env[k])
  const dirs = String(get('PATH') || get('Path') || '').split(os === 'win32' ? ';' : ':').filter(Boolean)
  const exts = os === 'win32' ? String(get('PATHEXT') || '.EXE;.CMD;.BAT').split(';').filter(Boolean).concat(['']) : ['']
  return (command) => {
    for (const d of dirs) for (const x of exts) { const f = path.join(d, `${command}${x.toLowerCase()}`); if (exists(f)) return f }
    return null
  }
}

/** Whether this user owns `p` (rule U, P8): the uid on POSIX; on Windows a path under the profile counts (the owner SID is not read here). */
export const ownsBy = ({ os, home, uid = typeof process.getuid === 'function' ? process.getuid() : null, fs = nodeFs }) => (p) => {
  if (os === 'win32') return path.resolve(p).toLowerCase().startsWith(`${path.resolve(home).toLowerCase()}${path.sep}`) ? true : null
  try { return uid == null ? null : fs.statSync(p).uid === uid } catch { return null }
}

/** The sources ctx (sources.mjs header) for this machine and user. */
export function sourcesCtx({ os, home, env = process.env, cwd = process.cwd(), dirs, fs = nodeFs, which = null, policy = null }) {
  return {
    os, home, cwd, env, dirs: dirs || {},
    readFile: (p) => fs.readFileSync(p, 'utf8'), exists: (p) => fs.existsSync(p), readdir: (p) => fs.readdirSync(p),
    which: which || whichIn(env, { os, exists: (p) => fs.existsSync(p) }), policy: policy || (() => ({ set: false })),
  }
}

/** backendsFor({ os, home, run, env, fs }) → { custody, rootStore, installHelper, wrapperKit, facts, dirs, policy } for macOS / Windows. */
export async function backendsFor({ os, home, run = null, env = process.env, fs = nodeFs }) {
  if (os === 'darwin') {
    const [{ keychainCustody, installHelper }, { NATIVE }, { userRootStore }, { renderWrapper }, pol] = await Promise.all([
      import('./darwin/custody.mjs'), import('./darwin/native.mjs'), import('./darwin/root-store.mjs'), import('./darwin/wrapper.mjs'), import('./darwin/policy.mjs')])
    const helperPath = signHelperPath(home, NATIVE.signHelper)
    return {
      custody: keychainCustody({ helperPath, run, env }), rootStore: userRootStore({ home, run, env, fs }),
      installHelper: (interactive) => installHelper({ dest: helperPath, interactive, run, env, fs }),
      wrapperKit: { renderWrapper }, facts: pol.platformFacts, dirs: pol.dirsOf(home), policy: pol.policyReader({ run, env }),
    }
  }
  if (os === 'win32') {
    const [{ cngCustody }, { userRootStore }, { renderWrapper, makeCompile }, pol] = await Promise.all([
      import('./win32/custody.mjs'), import('./win32/root-store.mjs'), import('./win32/wrapper.mjs'), import('./win32/policy.mjs')])
    return {
      custody: cngCustody({ run, env }), rootStore: userRootStore({ home, run, env, fs }), installHelper: null,
      wrapperKit: { renderWrapper, compile: makeCompile({ dir: path.join(home, '.asight', 'collector'), run, fs }) },
      facts: pol.platformFacts({ run, env }), dirs: pol.dirsOf(home, env), policy: pol.policyReader({ run, env }),
    }
  }
  throw new Error(`the collector model runs on macOS and Windows, not ${os}`)
}

/** The system proxy the door hands the P7 chain (4.11 P7; D49): the arch's watcher over `read`, each answer put in the chain's shape by the arch's own
 *  `chainSystemProxy` ({ url, bypass } · { pac } · { ok: false, why } · null) — the one place a raw reader answer (the scutil dictionary, the registry values)
 *  becomes what core/proxymode/chain.mjs reads; the chain never sees a raw answer. `io`: what `read` needs ({ helper } on win32); `event`: the daemon's event writer. → { now(), poll() (read now, as the timer does), stop() }. */
export async function systemProxyWatch({ up, read, io = {}, failure = () => {}, event = () => {} }) {
  const watch = up.watchSystemProxy({ ...io, read, initial: await read(io).catch(() => null), onError: failure })
  // 1.6 §9.5 (D49 ⑤): a change of the system proxy is one `netenv-change` (`netenv-changed`, captured: the door follows it per connection), zero failures.
  // from / to: the chain's answer as one word (the url without credentials, `pac`, `off`, or why it cannot be followed)
  const word = (raw) => { const c = up.chainSystemProxy(raw); return c == null ? 'off' : c.url ? redactProxyUrl(c.url) : c.pac ? 'pac' : (c.why || 'unreadable') }
  watch.on('change', ({ before, after }) => recordDrift({ drift: { code: 'netenv-changed', from: word(before), to: word(after), captured: true }, h: null, desired: null, appendEvent: event }))
  return { now: () => up.chainSystemProxy(watch.last()), poll: () => watch.poll(), stop: () => watch.stop() }
}

/** The door's readers of the world for the model collector (4.11 §1, createModelCollector): who owns a socket and that pid's facts, its env / cwd /
 *  parent (P7), how a proxy address is dialled, the system proxy now (a watcher's last read), the process table (P12). → { ownerOf, factsOf, proc,
 *  proxyOf, systemProxy, procTable, close }. Read-only, as the arch's own modules are. `io`: the OS readers only (a test's seam, 0.1 §3; the daemon's
 *  `model.io`) — `exec`, a spawnSync-shaped runner of ps / netstat / procenv (darwin) and of the process table (both); `helper`, startHelper's
 *  { spawn, exe, args } (win32). Everything above them stays this function's own. */
export async function doorPartsFor({ os, env = process.env, event = () => {}, failure = () => {}, io = {} }) {
  if (!isModelOs(os)) throw new Error(`the collector model runs on macOS and Windows, not ${os}`)
  const [up, { listProcs, psTableVia }] = await Promise.all([import(`./${os}/upstream.mjs`), import('../../off/proc.mjs')])
  const proxyOf = (text) => { const p = up.parseProxyText(text); return p && p.ok ? { kind: p.kind, host: p.host, port: p.port, ...(p.credentialed ? { auth: up.proxyAuthOf(text) } : {}) } : null }
  let parts, watch, winHelper = null
  if (os === 'darwin') {
    const [{ ownerOfSocket }, pi, { execTool, runAsync }] = await Promise.all([import('./darwin/socktable.mjs'), import('./darwin/procinfo.mjs'), import('../../off/exec.mjs')])
    // every lsof / ps of the accept path runs through execFile (runAsync), never spawnSync — the daemon keeps serving its
    // other doors while one table read runs (nor may it hold the lock refresh off reads)
    const runner = io.exec || runAsync
    const execOf = (file, args, o = {}) => Promise.resolve(execTool(file, args, { ...o, run: runner })) // socktable races it: always a promise
    const run = { exec: runner }
    parts = { ownerOf: (q) => ownerOfSocket({ exec: execOf, ...q, onFailure: event }), factsOf: (pid) => pi.factsOfPid(pid, run), proc: { envOf: (p, n) => pi.envOf(p, n, run), cwdOf: (p) => pi.cwdOf(p, run), parentOf: (p) => pi.parentOf(p, run) }, close: () => {} }
    watch = await systemProxyWatch({ up, read: up.readSystemProxy, io: io.exec ? { exec: io.exec } : {}, failure: (e) => failure('netenv', e), event })
  } else {
    // no declared registry keys (plan §E.7 ruling 4): the model reads a policy value through policy.mjs (reg.exe), not this helper
    const [{ ownerOfSocket }, pi, { startHelper, regReadAllowed }] = await Promise.all([import('./win32/socktable.mjs'), import('./win32/procinfo.mjs'), import('./win32/helper.mjs')])
    const helper = startHelper({ env, onFailure: event, ...(io.helper || {}) })
    winHelper = helper
    const r = pi.procReaders({ helper })
    parts = { ownerOf: (q) => ownerOfSocket({ helper, ...q, onFailure: event }), factsOf: (pid) => pi.factsOfPid(pid, { helper }), proc: r, regReadAllowed, close: () => helper.close() }
    watch = await systemProxyWatch({ up, read: up.readSystemProxyChain, io: { helper }, failure: (e) => failure('helper', e), event })
  }
  // the process table (P12's holder poll, and the CLI's own question through `POST /helper`): on Windows the warm helper's `ps` verb, never a
  // powershell.exe of its own — each start costs ~450 ms on a Windows test machine and `GET /holders` paid it per call (D62, 4.8 §1). ONE reader asks it
  // (src/off/proc.mjs psTableVia), so both sides of the seam read the same rows and say the same thing when the answer is no table (D38).
  const procTable = winHelper
    ? () => psTableVia(winHelper, { timeoutMs: 10000 })
    : () => listProcs({ platform: os, env, exec: io.exec || null })
  return { ...parts, proxyOf, systemProxy: watch.now, procTable, helper: winHelper, close: () => { watch.stop(); parts.close() } }
}

/** The proxy-mode half of status's facts on macOS / Windows (1.6 §9.7, 4.11 CM21): the model's per-form reader over this user's install manifest, the daemon's
 *  reply and `chainSp` (the arch's system proxy in the chain's shape) → { forms, forwarder } for gatherNetFacts. Read-only: the manifest is read, nothing written. */
export async function modelNetForms({ os, home, env = process.env, status, settings = {}, harnesses, procs, systemProxy, chainSp, dirs, fs = nodeFs }) {
  const [{ readManifest }, { modelFormFacts, netFormsOf }, { installDrift }, { collectorHome }] = await Promise.all([
    import('../core/trust/journal.mjs'), import('../core/proxymode/status-facts.mjs'), import('../model-on.mjs'), import('../../paths.mjs')])
  let m = null
  try { m = readManifest(collectorHome(path.join(home, '.asight')), fs) } catch (e) { if (e && e.code === 'ESANDBOX') throw e } // unreadable: no installed harness to draw
  const ctx = sourcesCtx({ os, home, env, dirs, fs })
  const model = await modelFormFacts({ harnesses, os, manifest: m, reply: status.daemon && status.daemon.reply, root: status.cert && status.cert.root, systemProxy: chainSp, ctx, fs, drift: (h) => installDrift(m, h, fs) })
  return netFormsOf({ model, status, procs, systemProxy, settings })
}
