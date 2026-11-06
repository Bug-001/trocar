// model-backends.mjs — what the collector model (RFC 4.11) takes from the OS on macOS and Windows, gathered in one place for `install`, `on` and
// `uninstall` (plan T20): the key custody (P1), the user root store (P3), the wrapper kit (P8), the platform facts and the sources ctx readers
// (§2.3). Each is the arch's own module, imported lazily, so Linux never loads them. A test passes its own pieces instead (0.1 §3).
import nodeFs from 'node:fs'
import path from 'node:path'

import { isModelOs } from '../model-install.mjs'
import { redactProxyUrl } from '../../netenv/redact.mjs'
import { recordDrift } from '../../netenv/adopt.mjs'
import { userPathEnv } from '../../off/user-path.mjs'
export { MODEL_OS, isModelOs } from '../model-install.mjs' // the one list of the OSes the model runs on

/** The installed signing helper the darwin custody runs (4.11 P1): under ~/.trocar/bin, beside trocar-off. */
export const signHelperPath = (home, name) => path.join(home, '.trocar', 'bin', name)

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

/** The sources ctx (sources.mjs header) for this machine and user. A `{ command }` resolves against the user's recorded PATH (4.11 `present`), never
 *  the asking process's own once one is recorded: the daemon and its worker run with the login service's PATH, the CLI with the shell's. */
export function sourcesCtx({ os, home, env = process.env, cwd = process.cwd(), dirs, fs = nodeFs, which = null, policy = null }) {
  return {
    os, home, cwd, env, dirs: dirs || {},
    readFile: (p) => fs.readFileSync(p, 'utf8'), exists: (p) => fs.existsSync(p), readdir: (p) => fs.readdirSync(p),
    which: which || whichIn(userPathEnv({ home, env, fs }), { os, exists: (p) => fs.existsSync(p) }), policy: policy || (() => ({ set: false })),
  }
}

/** The forms of this OS present on this machine (4.11 `present`, over the sources ctx with the platform's dirs), per harness that has forms here:
 *  { <harness>: [form id] } — an empty list = none of them is installed. With no names `status` lists the harnesses with one beside the ones trocar's
 *  own records know (1.6 §3.5); a harness with none is not captured (4.11 P5). Reads only. */
export async function presentForms({ os, home, env = process.env, harnesses, fs = nodeFs }) {
  const [{ dirsOf }, { isPresent }] = await Promise.all([os === 'darwin' ? import('./darwin/policy.mjs') : import('./win32/policy.mjs'), import('../core/proxymode/sources.mjs')])
  const ctx = sourcesCtx({ os, home, env, dirs: dirsOf(home, env), fs })
  const here = (d) => d.proxyMode.forms.filter((f) => f.os.includes(os))
  return Object.fromEntries(harnesses.filter((d) => d.proxyMode && here(d).length).map((d) => [d.name, here(d).filter((f) => isPresent(f, ctx)).map((f) => f.id)]))
}

/** The program files a process of a form runs, for each form of this OS whose certificate carrier is the install-folder wrapper (4.11 P8: one native
 *  program by name): { <form id>: [its place, the real program moved aside] }. A process of the harness running anything else (another install of
 *  it) is on none of those forms (4.11 P5). Paths only, nothing is read. */
export async function formPrograms({ os, home, env = process.env, harnesses }) {
  const [{ dirsOf, platformFacts }, { targetOf }] = await Promise.all([os === 'darwin' ? import('./darwin/policy.mjs') : import('./win32/policy.mjs'), import('../core/proxymode/hooks/wrapper.mjs')])
  const ctx = { ...sourcesCtx({ os, home, env, dirs: dirsOf(home, env) }), facts: typeof platformFacts === 'function' ? platformFacts({ env }) : platformFacts }
  const out = {}
  for (const d of harnesses) {
    for (const f of (d.proxyMode && d.proxyMode.forms) || []) {
      const cert = f.os.includes(os) && (d.proxyMode.certs || {})[f.cert]
      const t = cert && cert.kind === 'wrapper' ? targetOf(ctx, cert) : null
      if (t) out[f.id] = [t.file, t.real]
    }
  }
  return out
}

/** The places install's certificate carriers would be at on this machine (model-install.mjs carrierPlaces), resolved with this OS's folders and
 *  platform facts, as install resolves them: what `uninstall` looks at when the install record is lost. Paths and the bytes install writes; reads only.
 *  `run`: the runner of the OS tools that read the login environment (a test's stand-in). → carrierPlaces' { places, unseen }. */
export async function carrierPlacesFor({ os, home, env = process.env, harnesses, renderHook, run = null, fs = nodeFs }) { // renderHook: the caller's (an arch part never imports the harness layer)
  const [pol, { carrierPlaces, certVars }] = await Promise.all([os === 'darwin' ? import('./darwin/policy.mjs') : import('./win32/policy.mjs'), import('../model-install.mjs')])
  const facts = typeof pol.platformFacts === 'function' ? pol.platformFacts({ run, env }) : pol.platformFacts
  // a certificate variable install saw may be set where this process does not inherit it: the user's login environment (launchd's on macOS,
  // the persistent one on Windows) is read for the ones this environment lacks — read only (4.11 §1 uninstall)
  const unset = [...new Set(harnesses.filter((d) => d.proxyMode).flatMap(certVars))].filter((n) => !env[n])
  const login = unset.length ? (os === 'darwin' ? pol.launchdEnv(unset, { run, env }) : facts.persistentEnv(unset)) : {}
  const seen = { ...env, ...login }
  const ctx = { ...sourcesCtx({ os, home, env: seen, dirs: pol.dirsOf(home, env), fs }), facts }
  return carrierPlaces({ os, harnesses, ctx, home, owns: ownsBy({ os, home, fs }), renderHook, fs })
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
      wrapperKit: { renderWrapper, compile: makeCompile({ dir: path.join(home, '.trocar', 'collector'), run, fs }) },
      facts: pol.platformFacts({ run, env }), dirs: pol.dirsOf(home, env), policy: pol.policyReader({ run, env }),
    }
  }
  throw new Error(`the collector model runs on macOS and Windows, not ${os}`)
}

/** The system proxy the door hands the P7 chain (4.11 P7; D49): the arch's watcher over `read`, each answer put in the chain's shape by the arch's own
 *  `chainSystemProxy` ({ url, bypass } · { pac } · { ok: false, why } · null) — the one place a raw reader answer (the scutil dictionary, the registry values)
 *  becomes what core/proxymode/chain.mjs reads; the chain never sees a raw answer. `io`: what `read` needs ({ helper } on win32); `event`: the daemon's event writer.
 *  `changes`: the arch's change notice (darwin's scutilChanges), handed to its watcher. `holdMs`: how long a reading that could not be read is held before it is said to be the state (one watch interval and a bit; see below). → { now(), poll() (read now, as the timer does), stop() }. */
export async function systemProxyWatch({ up, read, io = {}, changes = null, failure = () => {}, event = () => {}, holdMs = 11000, timers = { setTimeout, clearTimeout } }) {
  const initial = await read(io).catch(() => null)
  const watch = up.watchSystemProxy({ ...io, read, initial, onError: failure, ...(changes ? { changes } : {}) })
  // 1.6 §9.5 (D49 ⑤) · 4.7「变了 = 归一后的那一句话变了」: a change of the system proxy is one `netenv-change` (`netenv-changed`, captured: the door follows it per
  // connection), zero failures. from / to: the chain's answer as one word (the url without credentials, `pac`, `off`). The raw readings move more than the word
  // does: a difference the word does not carry is no event (`off -> off`). A reading that could not be read is no change at all (D38: not absent, not changed):
  // it is held for `holdMs` and, if the state is still unreadable then, said as one `system-proxy-unreadable` failure per run of them; the door keeps the last
  // reading that was read, and the next one read is compared with it (the mac machine 2026-10-19 wrote `off -> system-proxy-unreadable -> off` several times a minute).
  const word = (raw) => { const c = up.chainSystemProxy(raw); return c == null ? 'off' : c.url ? redactProxyUrl(c.url) : c.pac ? 'pac' : (c.why || 'unreadable') }
  const readable = (raw) => { const c = up.chainSystemProxy(raw); return !(c && c.ok === false) }
  let good = readable(initial) ? initial : null, said = good ? word(good) : null, held = null, failed = false // `good`: the last reading that could be read, what the door dials
  const say = (to) => { if (said === null || to === said) { said = to; return } const from = said; said = to; recordDrift({ drift: { code: 'netenv-changed', from, to, captured: true }, h: null, desired: null, appendEvent: event }) }
  const unread = () => {
    if (failed) return
    failed = true
    const raw = watch.last() || {}
    try { event({ event: 'failure', where: 'netenv', code: 'system-proxy-unreadable', reason: `the system proxy could not be read (${[raw.reason, raw.detail].filter(Boolean).join(': ') || 'no reason given'}); the doors keep the last one read`, ...(said ? { last: said } : {}) }) } catch { /* the event writer's own failure: nothing left to tell */ }
  }
  const drop = () => { if (held) { timers.clearTimeout(held); held = null } }
  watch.on('change', ({ after }) => {
    drop()
    if (readable(after)) { good = after; failed = false; return say(word(after)) }
    held = timers.setTimeout(() => { held = null; if (!readable(watch.last())) unread() }, holdMs)
    if (held && typeof held.unref === 'function') held.unref()
  })
  // `now`: while the reading cannot be read, the last good one: a read that failed does not send the door direct around the user's proxy, nor recompute it
  return { now: () => up.chainSystemProxy(good && !readable(watch.last()) ? good : watch.last()), poll: () => watch.poll(), stop: () => { const pending = !!held; drop(); if (pending && !readable(watch.last())) unread(); watch.stop() } } // a daemon that goes down inside the hold window still says the read that failed (D38: none is left unsaid)
}

/** The door's readers of the world for the model collector (4.11 §1, createModelCollector): who owns a socket and that pid's facts, its env / cwd /
 *  parent (P7), how a proxy address is dialled, the system proxy now (a watcher's last read), the process table (P12). → { ownerOf, factsOf, proc,
 *  proxyOf, bypassOf, systemProxy, procTable, close }. Read-only, as the arch's own modules are. `io`: the OS readers only (a test's seam, 0.1 §3; the daemon's
 *  `model.io`) — `exec`, a spawnSync-shaped runner of ps / socktable / procenv (darwin) and of the process table (both); `helper`, startHelper's
 *  { spawn, exe, args } (win32). Everything above them stays this function's own. */
export async function doorPartsFor({ os, env = process.env, event = () => {}, failure = () => {}, io = {} }) {
  if (!isModelOs(os)) throw new Error(`the collector model runs on macOS and Windows, not ${os}`)
  const [up, { listProcs, psTableVia }] = await Promise.all([import(`./${os}/upstream.mjs`), import('../../off/proc.mjs')])
  const proxyOf = (text) => { const p = up.parseProxyText(text); return p && p.ok ? { kind: p.kind, host: p.host, port: p.port, ...(p.credentialed ? { auth: up.proxyAuthOf(text) } : {}) } : null }
  const bypassOf = (text) => up.translateBypass(text, 'no-proxy').bypass // an agent ancestor's NO_PROXY, read as the agent's own libraries read it (4.11 ⑥)
  let parts, watch, winHelper = null, runner = null
  if (os === 'darwin') {
    const [{ ownerOfSocket, createTableReader }, procinfo, { execTool, runAsync }] = await Promise.all([import('./darwin/socktable.mjs'), import('./darwin/procinfo.mjs'), import('../../off/exec.mjs')])
    // every lsof / ps of the accept path runs through execFile (runAsync), never spawnSync — the daemon keeps serving its
    // other doors while one table read runs (nor may it hold the lock refresh off reads)
    runner = io.exec || runAsync // the process table's two `ps` too (below): the sweep and the holder poll read it every few seconds (4.8 §5.5)
    const execOf = (file, args, o = {}) => Promise.resolve(execTool(file, args, { ...o, run: runner })) // socktable races it: always a promise
    const run = { exec: runner }
    const tableOf = createTableReader(execOf) // owner questions asked at once share one socktable read (4.9 MA13)
    parts = { ownerOf: (q) => ownerOfSocket({ exec: tableOf, ...q, onFailure: event }), factsOf: (pid, o) => procinfo.factsOfPid(pid, { ...run, ...(o || {}) }), proc: { envOf: (p, n, o) => procinfo.envOf(p, n, { ...o, ...run }), cwdOf: (p, o) => procinfo.cwdOf(p, { ...o, ...run }), parentOf: (p, o) => procinfo.parentOf(p, { ...o, ...run }) }, close: () => {} }
    watch = await systemProxyWatch({ up, read: up.readSystemProxy, io: io.exec ? { exec: io.exec } : {}, changes: io.exec ? null : (o) => up.scutilChanges({ ...o, env }), failure: (e) => failure('netenv', e), event }) // the OS's own change notice, unless a test injects the OS
  } else {
    // no declared registry keys: the model reads a policy value through policy.mjs (reg.exe), not this helper
    const [{ ownerOfSocket }, procinfo, { startHelper, regReadAllowed }] = await Promise.all([import('./win32/socktable.mjs'), import('./win32/procinfo.mjs'), import('./win32/helper.mjs')])
    const helper = startHelper({ env, onFailure: event, ...(io.helper || {}) })
    winHelper = helper
    const r = procinfo.procReaders({ helper })
    parts = { ownerOf: (q) => ownerOfSocket({ helper, ...q, onFailure: event }), factsOf: (pid, o) => procinfo.factsOfPid(pid, { helper, ...(o || {}) }), proc: r, regReadAllowed, close: () => helper.close() }
    watch = await systemProxyWatch({ up, read: up.readSystemProxyChain, io: { helper }, failure: (e) => failure('helper', e), event })
  }
  // the process table (P12's holder poll, and the CLI's own question through `POST /helper`): on Windows the warm helper's `ps` verb, never a
  // powershell.exe of its own — each start costs ~450 ms on a Windows test machine and `GET /holders` paid it per call (D62, 4.8 §1). ONE reader asks it
  // (src/off/proc.mjs psTableVia), so both sides of the seam read the same rows and say the same thing when the answer is no table (D38).
  const procTable = winHelper
    ? () => psTableVia(winHelper, { timeoutMs: 10000 })
    : () => listProcs({ platform: os, env, exec: runner })
  return { ...parts, proxyOf, bypassOf, systemProxy: watch.now, procTable, helper: winHelper, close: () => { watch.stop(); parts.close() } }
}

/** The proxy-mode half of status's facts on macOS / Windows (1.6 §9.7, 4.11 CM21): the model's per-form reader over this user's install manifest, the daemon's
 *  reply and `chainSp` (the arch's system proxy in the chain's shape) → { forms, forwarder } for gatherNetFacts. Read-only: the manifest is read, nothing written. */
export async function modelNetForms({ os, home, env = process.env, status, settings = {}, harnesses, procs, systemProxy, chainSp, dirs, fs = nodeFs }) {
  const [{ readManifest }, { modelFormFacts, netFormsOf, setupOf }, { collectorHome }] = await Promise.all([
    import('../core/trust/journal.mjs'), import('../core/proxymode/status-facts.mjs'), import('../../paths.mjs')])
  let m = null, unread = null
  try { m = readManifest(collectorHome(path.join(home, '.trocar')), fs) } catch (e) { if (e && e.code === 'ESANDBOX') throw e; unread = { error: String((e && e.message) || e) } } // unreadable: no installed harness to draw, setup unknown
  const ctx = sourcesCtx({ os, home, env, dirs, fs })
  const root = status.cert && status.cert.root
  // 4.11 P4b: each harness's setup, the one judgement `on`'s precondition ⑪ makes too (with status's root); the forms' certificate codes read it as before
  const setup = Object.fromEntries(harnesses.filter((d) => d.proxyMode).map((d) => [d.name, setupOf(d, { os, manifest: unread || m, ctx, root, fs })]))
  const DRIFT = { 'carrier-absent': 'entry-missing', 'carrier-overwritten': 'entry-changed' }
  const drift = (h) => { const s = setup[h]; if (!s || s.state === 'ready') return null; const x = s.missing.find((y) => y.form); return s.state === 'unknown' ? { reason: null, command: 'trocar install' } : x ? { reason: DRIFT[x.what], command: 'trocar install' } : null }
  const model = await modelFormFacts({ harnesses, os, manifest: m, reply: status.daemon && status.daemon.reply, root, systemProxy: chainSp, ctx, fs, drift })
  return { ...netFormsOf({ model, status, procs, systemProxy, settings }), setup }
}
