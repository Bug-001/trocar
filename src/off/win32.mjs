// win32.mjs (src/off) — what `asight off` and `asight uninstall` do on Windows that no other OS needs (RFC 4.8 §4.2, §7; 1.6 R3, R7). It imports Node's own modules and files of src/off and nothing else: the standalone `asight-off`
// is made of the files of this directory alone, so it cannot reach the helper, the collector or the source tree (0.1 §2). Today this file holds the elevation check; the Windows undo (`undoWin32`, plan Task 9(b)) joins it.
//
// R7 on Windows (4.8 §7): asight never runs with an elevated token or as SYSTEM, so `on`, `daemon`, `off` and `uninstall` refuse to. `on` and `daemon` ask the helper (arch/win32/autostart.mjs `refuseElevated`); `off` and
// `uninstall` cannot start a helper (the standalone has none, and `off` has to work when asight is broken), so they ask `whoami /groups` through execTool. The SIDs are the same in every language of Windows, so the check reads
// SIDs, never group names: the integrity label is `S-1-16-<rid>` (High is 12288, System 16384) and SYSTEM is `S-1-5-18`.
import nodeFs from 'node:fs'
import nodeHttp from 'node:http'
import nodePath from 'node:path'
import { execTool } from './exec.mjs'
import { supervisorHolderAlive } from './daemon-stop.mjs' // the kernel's stop checks its lock the same way the supervisor's does (4.8 §7: 2 s)

const HIGH_RID = 12288

/** → `{ elevated: false }` · `{ elevated: true, why: 'high-integrity' | 'system' }` · `{ elevated: null, reason }` (R11: not readable is not "no", and `reason` says why). `run` is the injected runner (execTool's). */
export function elevationByWhoami({ run = null, env = process.env } = {}) {
  const r = execTool('whoami', ['/groups', '/fo', 'csv', '/nh'], { run, env })
  if (r.code !== 0) return { elevated: null, reason: `whoami /groups ${r.code === null ? `did not run (${r.err || 'no reason given'})` : `failed (exit ${r.code})`}` }
  const rids = [...r.out.matchAll(/\bS-1-16-(\d+)\b/g)].map((m) => Number(m[1]))
  if (/\bS-1-5-18\b/.test(r.out)) return { elevated: true, why: 'system' }
  if (!rids.length) return { elevated: null, reason: 'whoami /groups gave no mandatory label (S-1-16-…)' }
  return Math.max(...rids) >= HIGH_RID ? { elevated: true, why: 'high-integrity' } : { elevated: false }
}

/** → null (go on) or `{ code: 'elevated-token', reason }`. A token that cannot be read is not a refusal: an undo that stops on a broken `whoami` is not an undo. */
export function refuseElevatedByWhoami(opts = {}) {
  const e = elevationByWhoami(opts)
  if (e.elevated !== true) return null
  return { code: 'elevated-token', reason: `用你自己的账号跑,不要「以管理员身份运行」,也不要用 SYSTEM(R7:asight 不以提升的令牌运行;这个令牌是${e.why === 'system' ? ' SYSTEM' : '高完整性级别'})` }
}

// ── the collector's undo pieces (plan Task 9(b); RFC 4.8 §4.2, §7) ───────────────────────────────────────────────────────────
// src/off cannot import arch/, so the task and Run-value undo are inlined here with the SAME fixed questions, the SAME verbs and the
// SAME "never on a guess" rules as arch/win32/autostart.mjs's own (test/off/win32.test.mjs holds the two equal, the way Linux's
// unit.mjs and src/off/autostart.mjs are held). The names and paths are written here too; the equality test holds them.

/** The scheduled task's name and the Run value's place — the same literals as arch/win32/autostart.mjs's TASK_NAME and RUN_KEY (the test holds them equal). */
export const TASK_NAME = '\\asight\\collector'
export const RUN_KEY = Object.freeze({ hive: 'HKCU', key: 'Software\\Microsoft\\Windows\\CurrentVersion\\Run', name: 'asight-collector' })
const RUN_PATH = `${RUN_KEY.hive}\\${RUN_KEY.key}`
const ours = (value) => /\bdaemon --supervise\s*$/.test(value) // what an earlier `on` of asight wrote: the supervised daemon command

/** The Run value, read (arch's readRunValue, inlined): `{ present: true, kind, value, lossy? }` · `{ present: false }` · `{ error }`. */
export function readRunValue({ run = null, env = process.env } = {}) {
  const r = execTool('reg', ['query', RUN_PATH, '/v', RUN_KEY.name], { run, env })
  if (r.code === null) return { error: `reg query did not run (${r.err || 'no reason given'})` }
  if (r.code !== 0) return { present: false }
  const m = new RegExp(`^[ \\t]+${RUN_KEY.name}[ \\t]+(REG_[A-Z_]+)(?:[ \\t]+(.*))?$`, 'mi').exec(r.out)
  if (!m) return { error: `reg query answered, but not with the value ${RUN_KEY.name}` }
  const value = m[2] ?? ''
  return { present: true, kind: m[1].toUpperCase(), value, ...(value.includes('�') ? { lossy: true } : {}) }
}

/** Takes asight's Run value out, and only that value (arch's removeRunValue, inlined): ours with no prior deleted, ours over a prior
 *  restored with its kind, a value that is not ours left, an absent one already as asked. → `{ ok, result: 'removed'|'restored'|'left'|'absent'|'failed', reason? }`. */
export function undoRunKey({ prior = null, run = null, env = process.env } = {}) {
  const cur = readRunValue({ run, env })
  if (cur.error) return { ok: false, result: 'failed', reason: cur.error }
  if (!cur.present) return { ok: true, result: 'absent' }
  if (!ours(cur.value)) return { ok: true, result: 'left' }
  const r = prior ? execTool('reg', ['add', RUN_PATH, '/v', RUN_KEY.name, '/t', prior.kind, '/d', prior.value, '/f'], { run, env }) : execTool('reg', ['delete', RUN_PATH, '/v', RUN_KEY.name, '/f'], { run, env })
  return r.code === 0 ? { ok: true, result: prior ? 'restored' : 'removed' } : { ok: false, result: 'failed', reason: `reg ${prior ? 'add' : 'delete'} failed (exit ${r.code}${r.err ? `: ${r.err.slice(0, 200)}` : ''})` }
}

/** Is the scheduled task there? `/Query`'s exit code answers (0 there, 1 not) — never a localised error text; a query that did not run at
 *  all is NOT "not there" (arch's taskState, inlined): → 'present' | 'absent' | { state: 'unknown', err }. */
export function taskState({ run = null, env = process.env } = {}) {
  const r = execTool('schtasks', ['/Query', '/TN', TASK_NAME], { run, env })
  if (r.code === 0) return { state: 'present' }
  if (r.code === null) return { state: 'unknown', err: `schtasks /Query did not run (${r.err || 'no reason given'})` }
  if (r.code === 1) return { state: 'absent' }
  return { state: 'unknown', err: `schtasks /Query exited ${r.code}${r.err ? `: ${r.err.slice(0, 200)}` : ''}: whether the task ${TASK_NAME} is registered is not known` }
}

/** The task off the login path: `/Change /DISABLE` for an `off` (it does not end a running instance — the supervisor is stopped first,
 *  4.8 §4.2), `/Delete /F` for an `uninstall`. A task that is not there is already as asked; a query that cannot tell changes nothing on a
 *  guess. → `{ ok, task: 'disabled'|'deleted'|'absent'|'failed', reason? }`; the Run value goes with it (undoRunKey), the two are one
 *  undo whatever an earlier `on` used (§7: exactly one login mechanism is left live). */
export function undoScheduledTask({ uninstall = false, prior = null, run = null, env = process.env } = {}) {
  const q = taskState({ run, env })
  let t
  if (q.state === 'present') {
    const r = execTool('schtasks', [uninstall ? '/Delete' : '/Change', '/TN', TASK_NAME, ...(uninstall ? ['/F'] : ['/DISABLE'])], { run, env })
    t = r.code === 0 ? { ok: true, task: uninstall ? 'deleted' : 'disabled' } : { ok: false, task: 'failed', reason: `schtasks ${uninstall ? '/Delete' : '/Change /DISABLE'} failed (exit ${r.code}${r.err ? `: ${r.err.slice(0, 200)}` : ''})` }
  } else if (q.state === 'absent') t = { ok: true, task: 'absent' }
  else t = { ok: false, task: 'failed', reason: `${q.err}; nothing was changed on a guess` }
  const k = undoRunKey({ prior, run, env })
  return { ok: t.ok && k.ok, ...t, runKey: k.result, ...(k.ok ? {} : { runKeyReason: k.reason }) }
}

// ── the kernel without its daemon (plan Task 9(b) undoWin32 step 1; RFC 4.8 §4.2) ─────────────────────────────────────────────
// The kernel (asight-forwarder.exe) outlives the daemon on purpose: agents drain from it. With the daemon gone — the standalone `off`,
// or a stuck daemon that was killed — its fallback groups still PREFER the engine (which is gone), and the honest state for an off is
// forward-only: every listener kept (the agents' entries point at them until step 2 undoes them), no groups, `MATCH,DIRECT`. That is
// done through the kernel's own controller (forwarder.lock names the config, the config the controller port and secret) with the one
// reload mihomo has: PUT /configs?force=true. src/off cannot import netenv's controller client (0.1 §2), so the two requests it takes
// are inlined — the same endpoint, the same Bearer, nothing else asked.
/** One request to the kernel's controller → `{ status, json }` · `{ error }`. Bearer-authed; a pipe is never involved (it listens on 127.0.0.1). */
function controllerRequest({ port, secret, method = 'GET', path = '/configs', body = null, timeoutMs = 5000, transport = nodeHttp }) {
  return new Promise((resolve) => {
    const payload = body == null ? null : JSON.stringify(body)
    let settled = false
    const done = (v) => { if (!settled) { settled = true; resolve(v) } }
    const req = transport.request({ host: '127.0.0.1', port, method, path, headers: { authorization: `Bearer ${secret}`, ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}) }, timeout: timeoutMs }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => { let json = null; try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { /* an answer that is not JSON */ } done({ status: res.statusCode, json }) })
    })
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')))
    req.on('error', (e) => done({ error: String((e && e.message) || e) }))
    req.end(payload ?? undefined)
  })
}

/** forwarder.lock read as the forwarder writes it: `{ pid, startedAt, endpoint, config }`, or null when it is not there or names nothing usable. */
export function readForwarderLock({ dir, fs = nodeFs } = {}) {
  try {
    const o = JSON.parse(fs.readFileSync(nodePath.join(dir, 'forwarder.lock'), 'utf8'))
    return Number.isSafeInteger(o.pid) && o.pid > 0 && Number.isFinite(o.startedAt) && typeof o.config === 'string' ? o : null
  } catch { return null }
}

/** The kernel's controller endpoint from its config file: `{ port, secret }` or `{ error }` (the same read as arch's readConfig: the
 *  external-controller must be on 127.0.0.1, the secret a string — a config without them is not one the daemon wrote). */
export function kernelControllerOf({ config, fs = nodeFs } = {}) {
  let o
  try { o = JSON.parse(fs.readFileSync(config, 'utf8')) } catch (e) { return { error: `${config} cannot be read (${(e && e.code) || e})` } }
  const m = /^127\.0\.0\.1:(\d+)$/.exec(String(o && o['external-controller']))
  if (!m || typeof (o && o.secret) !== 'string') return { error: `${config} has no external-controller on 127.0.0.1 or no secret` }
  return { port: Number(m[1]), secret: o.secret }
}

/**
 * The kernel without its daemon, made forward-only (4.8 §4.2, the standalone half of taking the routing off): the listeners stay (agents drain
 * through them), the groups and sub-rules go, `MATCH,DIRECT` — new connections run direct even before their entries are undone. A controller that
 * does not answer, or refuses the reload, gets the kernel STOPPED (taskkill, its pid and start time from forwarder.lock checked first, the same
 * 2 s tolerance as the supervisor): a kernel that cannot be told is not left preferring a dead engine. → `{ done: 'forward-only' | 'stopped' |
 * 'none' | 'failed', reason?, kernel_pid? }`; nothing here is a guess — every step that cannot tell says so.
 */
export async function kernelForwardOnly({ dir, fs = nodeFs, run = null, env = process.env, request = controllerRequest, transport = nodeHttp, timeoutMs = 5000 }) {
  const lock = readForwarderLock({ dir, fs })
  if (!lock) return { done: 'none', reason: 'there is no forwarder.lock: no kernel of this install is on record' }
  const ctl = kernelControllerOf({ config: lock.config, fs })
  if (ctl.error) return { done: 'failed', reason: ctl.error, kernel_pid: lock.pid }
  const cur = await request({ port: ctl.port, secret: ctl.secret, method: 'GET', path: '/configs', timeoutMs, transport })
  if (cur.error || typeof cur.status !== 'number' || cur.status !== 200) return { done: await stopKernel({ lock, run, env }), reason: `the kernel's controller did not answer (${cur.error || `status ${cur.status}`}), so the kernel was stopped rather than left preferring a dead engine`, kernel_pid: lock.pid }
  const listeners = Array.isArray(cur.json && cur.json.listeners) ? cur.json.listeners.map(({ rule, ...l }) => l) : [] // a listener's `rule` points at a sub-rule that is not in the forward-only config
  const text = JSON.stringify({ mode: 'rule', 'bind-address': '127.0.0.1', 'allow-lan': false, 'log-level': 'warning', 'external-controller': `127.0.0.1:${ctl.port}`, secret: ctl.secret, ...(listeners.length ? { listeners } : {}), rules: ['MATCH,DIRECT'] })
  const put = await request({ port: ctl.port, secret: ctl.secret, method: 'PUT', path: '/configs?force=true', body: { payload: text }, timeoutMs, transport })
  if (put.error || put.status !== 204) return { done: await stopKernel({ lock, run, env }), reason: `the kernel's controller refused the forward-only reload (${put.error || `status ${put.status}`}), so the kernel was stopped`, kernel_pid: lock.pid }
  return { done: 'forward-only', kernel_pid: lock.pid }
}

/** taskkill the kernel the lock names, only after its start time matches (the same question and tolerance as the supervisor's). */
async function stopKernel({ lock, run, env }) {
  try { if (!supervisorHolderAlive({ pid: lock.pid, startedAt: lock.startedAt }, { run, env })) return 'stopped' /* gone, or a reused pid: not ours to kill */ }
  catch { return 'failed' }
  execTool('taskkill', ['/PID', String(lock.pid), '/F'], { run, env })
  return 'stopped'
}
