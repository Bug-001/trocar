// autostart.mjs — how the Windows collector is started and kept up, and what it refuses to start under (RFC 4.8 §7; acceptance W24 W25). The daemon is `node <asight> daemon`, started at login by one Task Scheduler task per user,
// supervised by a small parent that brings it back when it dies. Tools (`schtasks`, `reg`) run only through execTool, so a test injects the runner; the helper, the spawn and the clock are parameters too, and every piece runs on
// any OS against a temp directory. Node built-ins, src/paths.mjs, src/off/exec.mjs and src/off/win32.mjs only (this file never imports a harness, 4.6 §结构).
import nodeFs from 'node:fs'
import { directStartEnv, startDaemonDirect } from '../direct-start.mjs'
import { autostartNode } from '../autostart-node.mjs'
import os from 'node:os'
import path from 'node:path'
import { spawn as nodeSpawn } from 'node:child_process'
import { execTool } from '../../../off/exec.mjs'
import { collectorHome } from '../../../paths.mjs'
import { elevationByWhoami, elevatedRefusal } from '../../../off/win32.mjs'

export const TASK_NAME = '\\asight\\collector' // the scheduled task, in the \asight folder of the Task Scheduler
export const TASK_FILE = 'asight-collector.task.xml' // the task's XML, an owned file of the install manifest, beside the collector's other files
/** The login start-up entry that stands in when the Task Scheduler refuses the task (4.8 §7): one value of the user's own Run key. */
export const RUN_KEY = Object.freeze({ hive: 'HKCU', key: 'Software\\Microsoft\\Windows\\CurrentVersion\\Run', name: 'asight-collector' })
const RUN_PATH = `${RUN_KEY.hive}\\${RUN_KEY.key}`

/** The oldest Node `on` accepts (package.json `engines`; a test holds the two equal). Older than that and the daemon would exit at every login with an error nobody sees (4.8 §7). */
export const NODE_MIN_MAJOR = 20

/**
 * The Node preflight of `on` (4.8 §7): → `{ ok: true, have, min }` or `{ ok: false, have, min, doctor }`. `doctor` is the line to print: what was found and what is needed. A version that cannot be read is not a pass (it names
 * itself as such): a daemon on an unknown Node is the one that exits at login. `versions` is `process.versions`.
 */
export function nodePreflight({ versions = process.versions } = {}) {
  const have = versions && versions.node
  const major = typeof have === 'string' && /^\d+(\.|$)/.test(have) ? Number(have.split('.')[0]) : null
  if (major === null) return { ok: false, have: have ?? null, min: NODE_MIN_MAJOR, doctor: `读不到 Node 的版本(${JSON.stringify(have ?? null)}):asight 在 Windows 上要 Node ≥ ${NODE_MIN_MAJOR}。确认 \`node --version\` 之后再 asight on` }
  if (major < NODE_MIN_MAJOR) return { ok: false, have, min: NODE_MIN_MAJOR, doctor: `Node ${have} 太旧:asight 在 Windows 上要 Node ≥ ${NODE_MIN_MAJOR}(守护进程每次登录都由这个 Node 拉起,更老的版本起不来)。升级 Node 之后再 asight on` }
  return { ok: true, have, min: NODE_MIN_MAJOR }
}

/**
 * R7 on Windows (4.8 §7, W25): asight never runs with an elevated token or as SYSTEM. → `null` (go on) or `{ code: 'elevated-token', reason, token }`, which `on` and `daemon` turn into the refusal and the `start` failure record.
 * One criterion for on, daemon, off and uninstall: `whoami /groups` by SID (src/off/win32.mjs elevationByWhoami, with D53③'s unsplit-token exception). It used to be a
 * helper started for this one question, whose C# compile made it the costliest step of `on` (a Windows test machine 2026-10-17: 1.2 s of on's 5.8 s, and the daemon's own 0.6 s before it
 * answers). A token that cannot be read is not a refusal: `onUnknown(reason)` says why (R11). `run`: execTool's injected runner.
 */
export async function refuseElevated({ run = null, env = process.env, onUnknown = () => {} } = {}) {
  const e = elevationByWhoami({ run, env })
  if (e.elevated === null) { onUnknown(e.reason); return null }
  if (!e.elevated) return null
  const system = e.why === 'system'
  return { ...elevatedRefusal(system), token: { elevated: true, system, integrity: system ? 'system' : 'high' } }
}

const CONTROL_CHAR = /[\u0000-\u001f\u007f]/
const plain = (name, v, { quoted = false } = {}) => {
  if (typeof v !== 'string' || v === '' || CONTROL_CHAR.test(v) || (quoted && v.includes('"'))) throw new TypeError(`taskXml: ${name} is a non-empty string with no control character${quoted ? ' and no quote' : ''}, got ${JSON.stringify(v)}`)
  return v
}
const xmlText = (v) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const daemonArgs = (node, asight) => `--headless "${plain('node', node, { quoted: true })}" "${plain('asight', asight, { quoted: true })}" daemon --supervise`
/** The task's action as one command line, which is what the Run value holds: `conhost.exe --headless "<node>" "<asight>" daemon --supervise` (no window; the supervisor parent; 4.8 §7). */
export function daemonCommandLine({ node, asight, conhost = 'conhost.exe' } = {}) {
  const c = plain('conhost', conhost, { quoted: true })
  return `${/\s/.test(c) ? `"${c}"` : c} ${daemonArgs(node, asight)}`
}

/** `DOMAIN\name`, the form the Task Scheduler wants for a trigger and a principal: from USERDOMAIN and USERNAME, the name alone without a domain, the OS's own answer when the environment says nothing. */
export function taskUser(env = process.env) {
  const name = env.USERNAME || os.userInfo().username
  return env.USERDOMAIN && env.USERNAME ? `${env.USERDOMAIN}\\${name}` : name
}

/**
 * The task XML (4.8 §7; the form that registered at Medium integrity in the T0 measurement). A login trigger of this user; this user as the principal, `InteractiveToken` at `LeastPrivilege` (S4U is not subject to UAC
 * filtering, so it would be High integrity: R7); no time limit, no stop on battery, one instance; restart on failure every minute, 999 times (the supervisor parent does the real restarting: the T0 measurement showed the task
 * does not bring back a killed daemon, §7). The action is `conhost.exe --headless "<node>" "<asight>" daemon --supervise`: no window, the supervisor parent, and no `--use-system-ca` (it needs Node 22.15, and an older Node would
 * exit at every login with "bad option"). The XML says UTF-16 because that is the form that was measured; `register` hands schtasks a UTF-16 copy, while the file install writes is this text as it stands.
 */
export function taskXml({ user, node, asight, conhost = 'conhost.exe' } = {}) {
  const u = xmlText(plain('user', user))
  const args = daemonArgs(node, asight)
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <RegistrationInfo><Description>asight transparent collector (per user)</Description></RegistrationInfo>',
    `  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${u}</UserId></LogonTrigger></Triggers>`,
    `  <Principals><Principal id="Author"><UserId>${u}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>`,
    '  <Settings>',
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '    <AllowHardTerminate>true</AllowHardTerminate><StartWhenAvailable>true</StartWhenAvailable><ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
    '    <RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure>',
    '  </Settings>',
    `  <Actions Context="Author"><Exec><Command>${xmlText(plain('conhost', conhost, { quoted: true }))}</Command><Arguments>${xmlText(args)}</Arguments></Exec></Actions>`,
    '</Task>',
    '',
  ].join('\n')
}

const schtasks = (args, { run, env }) => execTool('schtasks', args, { run, env })

/** What a task that did not start looks like in its own answer: SCHED_S_TASK_HAS_NOT_RUN (267011 = 0x41303). A `/Run` with no interactive session for the task answers exit 0
 *  SUCCESS and starts NOTHING — the only word that tells is this value, probe-verified on a Windows test machine (2026-10-12): after such a /Run, `schtasks /Query /V` shows LastTaskResult
 *  267011 and no daemon ever comes up (`on` then spent its 15 s probing and failed with `start-failed`). */
export const TASK_NOT_YET_RUN = 267011

/** The task's LastTaskResult, read from `schtasks /Query /TN <task> /V /FO CSV` (the one question whose answer says whether a /Run that said SUCCESS actually started anything).
 *  The column is found by its header — `Last Result` in the en locale, `上次运行结果` on zh-CN, the two this build has seen — and the value may be decimal or 0x-prefixed. A header the
 *  parser does not know falls back to looking for the not-yet-run VALUE itself in the row (it is a number no other column carries). → the number, or null when the query failed, was
 *  killed, or answered nothing readable (null is "no verdict": the caller falls back on nothing and changes nothing). */
function lastTaskResult({ run, env }) {
  const r = schtasks(['/Query', '/TN', TASK_NAME, '/V', '/FO', 'CSV'], { run, env })
  if (r.code !== 0 || !r.out) return null
  const lines = String(r.out).split(/\r?\n/).filter((l) => l.trim() !== '')
  if (lines.length < 2) return null
  const cells = (line) => [...line.matchAll(/"([^"]*)"/g)].map((m) => m[1])
  const head = cells(lines[0])
  const row = cells(lines[1])
  if (row.length === 0) return null
  let at = head.findIndex((h) => /^last([ _]run)?[ _]?result$/i.test(h.trim()) || /上次运行结果/.test(h))
  if (at < 0 || at >= row.length) at = row.findIndex((v) => /^(267011|0x41303)$/i.test(v.trim()))
  if (at < 0) return null
  const v = row[at].trim()
  const n = /^0x[0-9a-f]+$/i.test(v) ? parseInt(v, 16) : /^-?\d+$/.test(v) ? Number(v) : NaN
  return Number.isInteger(n) ? n : null
}

/**
 * The environment of a daemon that is started directly (`start()`, the fallback with `now`): the installer shell's, without the variables that change what the daemon trusts or whom it dials (Node's CA, TLS and proxy
 * switches, OpenSSL's CA file and directory, the `*_PROXY` family, any case). A daemon the task or the Run value starts at login has none of the shell's: a task has no environment of its own (4.8 §7), so a daemon that
 * got them from `on` would trust and dial differently from the same daemon after the next login. What is not in this list stays: the user-level variables a login task carries (`CODEX_HOME`, `PATH`, `USERPROFILE`) are in
 * the shell's environment too, and the shell's own extras are harmless; the difference that remains is the user's own `NODE_OPTIONS` and `*_PROXY` at user level, which a login would carry and this does not.
 */
export { directStartEnv }

/** `schtasks /Create /XML <file> /TN \asight\collector /F` from the task file install wrote. schtasks reads the file as the encoding it declares, which is UTF-16, and install writes text as UTF-8: so a UTF-16LE copy with a byte
 *  order mark (the T0 form) is made beside it, handed over, and removed. → `{ code, out, err }`; a file that cannot be read is `code: null` with the reason and `precondition: true` (schtasks was not asked, so it is not a refusal to fall back from). */
export function register({ file, run = null, env = process.env, fs = nodeFs } = {}) {
  const copy = `${file}.utf16`
  try {
    fs.writeFileSync(copy, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(fs.readFileSync(file, 'utf8'), 'utf16le')]), { mode: 0o600 })
  } catch (e) {
    try { fs.rmSync(copy, { force: true }) } catch { /* nothing was made */ }
    return { code: null, out: '', err: `the task file ${file} cannot be read or copied (${(e && e.code) || (e && e.message) || e})`, precondition: true } // not a refusal of schtasks: nothing was asked of it
  }
  try { return schtasks(['/Create', '/XML', copy, '/TN', TASK_NAME, '/F'], { run, env }) } finally { try { fs.rmSync(copy, { force: true }) } catch { /* the next register overwrites it */ } }
}

const ok = { code: 0, out: '', err: '' }
/** Is the task registered? `/Query /TN` is the question (never a localised error text): exit 0 = there; any other exit = not there (the one ambiguity left, which `schtasks` itself does not break: exit 1 is "not found" and
 *  also "the service is down"); a query that did not run at all (timeout, blocked, no schtasks: code null) is NOT "not there": nothing was asked of the task, so an undo that took it for gone would report success while the
 *  task stays registered and starts asight at the next login. → `{ state: 'present' }` · `{ state: 'absent' }` · `{ state: 'unknown', err }`. */
const taskState = ({ run, env }) => {
  const r = schtasks(['/Query', '/TN', TASK_NAME], { run, env })
  if (r.code === 0) return { state: 'present' }
  if (r.code === null) return { state: 'unknown', err: `schtasks /Query did not run (${r.err || 'no reason given'})` }
  return { state: 'absent' }
}
const errOf = (r) => r.err || (r.code === null ? 'it did not run' : `exit ${r.code}`)
const ours = (value) => /\bdaemon --supervise\s*$/.test(value) // what an earlier `on` of asight wrote: the supervised daemon command

/**
 * The Run value, read: `reg query HKCU\...\Run /v asight-collector` → `{ present: true, kind, value }` · `{ present: false }` · `{ error }` (reg did not run, or answered with something that is no value).
 * One fixed query of one value: asight reads no other value of that key. reg.exe writes a redirected stdout in the console's code page (cp936 on a zh-CN Windows) and execTool decodes UTF-8, so a character outside ASCII
 * comes back as U+FFFD: then `lossy: true` is there, and the value is not what the registry holds, byte for byte (the blanks at the start and end of a value are lost too, as execTool trims; a command line does not mind).
 */
export function readRunValue({ run = null, env = process.env } = {}) {
  const r = execTool('reg', ['query', RUN_PATH, '/v', RUN_KEY.name], { run, env })
  if (r.code === null) return { error: `reg query did not run (${r.err || 'no reason given'})` }
  if (r.code !== 0) return { present: false }
  const m = new RegExp(`^[ \\t]+${RUN_KEY.name}[ \\t]+(REG_[A-Z_]+)(?:[ \\t]+(.*))?$`, 'mi').exec(r.out)
  if (!m) return { error: `reg query answered, but not with the value ${RUN_KEY.name}` }
  const value = m[2] ?? ''
  return { present: true, kind: m[1].toUpperCase(), value, ...(value.includes('\uFFFD') ? { lossy: true } : {}) }
}

/**
 * Is what `reg query` printed the value that was written? Byte for byte; and, when what was written has characters outside ASCII (a profile path in Chinese), through the console code page of reg.exe (see readRunValue):
 * the ASCII has to match exactly and each run of non-ASCII characters is whatever it came back as (U+FFFD, `?`, other characters). A lossy channel proves less, and it proves what it can.
 */
function sameValue(read, wanted) {
  if (read === wanted) return true
  if (!/[^\x00-\x7f]/.test(wanted)) return false
  let pattern = ''
  let run = false
  for (const ch of wanted) {
    if (ch.codePointAt(0) > 0x7f) { if (!run) pattern += '(?:[^\\x00-\\x7f]|\\?)+'; run = true } else { run = false; pattern += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }
  }
  return new RegExp(`^${pattern}$`, 'u').test(read)
}

/**
 * The fallback of 4.8 §7: write the one Run value that starts the supervised daemon at login, with `reg add … /t REG_SZ` through execTool, and read it back (生效要复核).
 * → `{ ok: true, ours, entry }` · `{ ok: false, reason, entry? }`. `entry` is what the manifest ledgers: `{ kind: 'run-key', hive, key, name, value, prior }`, where `prior` is the user's own value that was there (`{ kind, value }`, to be put back by
 * the undo) or null. A value an earlier `on` of asight wrote is not a prior: `ours` is true and `prior` null, and the caller keeps the prior its ledger already has. A prior that is not a string (REG_SZ or REG_EXPAND_SZ) could
 * not be put back, so it is never overwritten. `entry` comes with a failure only when the write went through and the read-back disagreed (the undo is idempotent, so it is ledgered all the same).
 */
export function runKeyFallback({ command, run = null, env = process.env } = {}) {
  const before = readRunValue({ run, env })
  if (before.error) return { ok: false, reason: before.error }
  const mine = before.present && ours(before.value)
  if (before.present && !mine && !['REG_SZ', 'REG_EXPAND_SZ'].includes(before.kind)) return { ok: false, reason: `${RUN_PATH}\\${RUN_KEY.name} already exists as ${before.kind}, not a string, and asight does not overwrite what it cannot put back` }
  if (before.present && !mine && before.lossy) return { ok: false, reason: `${RUN_PATH}\\${RUN_KEY.name} already exists and has characters that reg.exe printed in a console code page, not UTF-8 (U+FFFD): asight cannot put it back byte for byte, so it does not overwrite it` }
  const entry = { kind: 'run-key', hive: RUN_KEY.hive, key: RUN_KEY.key, name: RUN_KEY.name, value: command, prior: before.present && !mine ? { kind: before.kind, value: before.value } : null }
  const w = execTool('reg', ['add', RUN_PATH, '/v', RUN_KEY.name, '/t', 'REG_SZ', '/d', command, '/f'], { run, env })
  if (w.code !== 0) return { ok: false, reason: `reg add failed (${errOf(w)})` }
  const after = readRunValue({ run, env })
  if (after.error || !after.present || !sameValue(after.value, command)) return { ok: false, entry, reason: `the Run value did not take: read back as ${after.error ? after.error : after.present ? JSON.stringify(after.value) : 'absent'}` }
  return { ok: true, ours: mine, entry }
}

/**
 * Takes asight's Run value out, and only that value: ours with no prior is deleted (`reg delete … /v asight-collector /f`), ours over a prior puts the prior back with its kind, a value that is not ours is left, an absent one is already
 * as asked. → `{ code, out, err, runKey: 'removed' | 'restored' | 'left' | 'absent' | 'failed' }`. `prior` is the ledger entry's.
 */
export function removeRunValue({ run = null, env = process.env, prior = null } = {}) {
  const cur = readRunValue({ run, env })
  if (cur.error) return { code: null, out: '', err: cur.error, runKey: 'failed' }
  if (!cur.present) return { ...ok, runKey: 'absent' }
  if (!ours(cur.value)) return { ...ok, runKey: 'left' }
  const r = prior ? execTool('reg', ['add', RUN_PATH, '/v', RUN_KEY.name, '/t', prior.kind, '/d', prior.value, '/f'], { run, env }) : execTool('reg', ['delete', RUN_PATH, '/v', RUN_KEY.name, '/f'], { run, env })
  return { code: r.code, out: '', err: r.err, runKey: r.code === 0 ? (prior ? 'restored' : 'removed') : 'failed' } // reg's "The operation completed successfully." is not worth carrying
}

// the two parts of an undo as one answer; a tool that did not run (code null) is code 1, a failure that a caller's `if (r.code)` sees
const settle = (task, k) => ({ code: (task.code !== 0 ? task.code : k.code) ?? 1, out: [task.out, k.out].filter(Boolean).join('\n'), err: [task.err, k.err].filter(Boolean).join('; '), task: task.state, runKey: k.runKey })

/**
 * The per-user autostart as `asight on` (src/cli/on.mjs) and install.mjs consume it, the same shape as arch/linux/unit.mjs `userUnit`: `{ name, path, links, text(env), enable({ now }), start(), reload(), disable(), remove() }`, each verb
 * returning `{ code, out, err }`. `path` is the task's XML, an owned file the install manifest lists; `links` is empty (a task has no wants/ link); `text(env)` is the XML (a Windows task has no environment of its own, so the
 * daemon environment install offers is not carried: a daemon the task starts trusts the system store, 4.8 §6.2). Nothing is registered until `enable`.
 *   enable({ now })  registers the task (`/Create /XML … /F`, which also switches a disabled one on) and, with `now` (the default; install passes false when a daemon already answers), runs it (`/Run`) → `via: 'task'`.
 *                    A `/Run` that answered SUCCESS is not trusted on its word: the task's LastTaskResult is read back (`/Query /V /FO CSV`), and 267011 — the task has not run, what a /Run with no
 *                    interactive session for the task answers while starting nothing (probe-verified on a Windows test machine, 2026-10-12) — starts the daemon DIRECTLY this run (`start()`'s spawn; on's probe
 *                    of the control socket is the "no daemon answers" check here) with `warn` saying exactly that ('started directly this run; the task will start it at next login'); the task keeps
 *                    the login either way. A result that cannot be read changes nothing: the /Run's own answer stands.
 *                    When schtasks REFUSES the registration, the Run-key fallback takes over (4.8 §7): `via: 'run-key'`, code 0 (`on` does not fail because the Task Scheduler said no), `reason` (why), `ledger` (the manifest entry,
 *                    runKeyFallback's), `ours`, `event` (the `task-register-failed` failure record for the caller to write: it carries the reason and names the entry used instead), and with `now` the supervised daemon is started
 *                    directly (the Run value only runs at the next login). When the fallback fails too, code is not 0 and `err` has both reasons.
 *                    Exactly one login mechanism is left live: by the task, asight's own Run value of an earlier fallback is taken out (`runKey: 'removed' | 'restored'` when it was there: the caller drops the `run-key`
 *                    ledger entry; `enable({ prior })` takes the ledger entry's prior so that the user's own value comes back); by the fallback, an earlier task is switched off (`task: 'disabled'`). Either that cannot be
 *                    done is `warn` (a line for the receipt; `on` does not fail for it, because the supervisor singleton keeps a second start from running a second daemon).
 *   start()          the fallback `on` uses when the task cannot start it: this session, nothing registered. A task with a login trigger would be an autostart, so none is registered: the supervised daemon is started directly, detached, with no window, with the
 *                    environment of `directStartEnv(env)` (the shell's, without the trust and proxy variables a login-started daemon would not have).
 *   reload()         nothing to do: a rewritten task is registered again by `enable` (`/F`).
 *   disable({ prior }) a no-argument `off`: the task is switched off (`/Change /DISABLE`; it does not end a running instance, the caller stops the supervisor parent first, 4.8 §4.2) and asight's Run value is taken out, whichever
 *                    of the two an earlier `on` used. → `{ code, out, err, task: 'disabled' | 'absent' | 'failed', runKey }`. `prior` is the Run entry's ledgered prior value.
 *   remove({ prior }) `uninstall`: the task is deleted (`/Delete /F`) and the Run value taken out the same way. A task that is not there is already as asked (found with `/Query`, never by parsing a localised error text); a `/Query` that did not run at all is not "not there": it is a failure (`task: 'failed'`, code 1) and nothing is changed on a guess.
 */
export function userUnit({ home, node, script, run = null, env = process.env, fs = nodeFs, spawn = nodeSpawn, user = null, conhost = 'conhost.exe' } = {}) {
  node = autostartNode({ env, execPath: node, fs, platform: 'win32' }) // D61: a node the task can still name after a node upgrade (one rule, all three OSes)
  const file = path.join(collectorHome(path.join(home, '.asight')), TASK_FILE)
  const tools = { run, env }
  // the daemon this run starts itself: the scheduled task's own environment and the task's own log files (direct-start.mjs)
  const startDirect = (carry) => {
    const r = startDaemonDirect({ home, env, carry, command: conhost, argv: ['--headless', node, script, 'daemon', '--supervise'], spawn, fs, spawnOpts: { windowsHide: true } })
    return r.code === 0 ? { ...ok, ...r } : r.err === 'the daemon did not start' ? { ...r, err: `${conhost} did not start the supervised daemon` } : r
  }
  // the task is changed or deleted when it is there, and asight's Run value is taken out; each says what it did
  // `on`'s start (D61): the task's own `/Run`, and the direct start when /Run answers SUCCESS and runs nothing (267011, no
  // interactive session for the task) — the registration is never touched here, `install` made it.
  const runNow = () => {
    const ran = schtasks(['/Run', '/TN', TASK_NAME], tools)
    if (!(ran.code === 0 && lastTaskResult(tools) === TASK_NOT_YET_RUN)) return ran
    const started = startDirect()
    const warn = 'schtasks /Run answered success but the task has not run (LastTaskResult 267011, no interactive session for it): the daemon was started directly this run; the task will start it at next login'
    return started.code !== 0 ? { code: started.code ?? 1, out: '', err: started.err, warn } : { ...ok, ...(started.pid != null ? { pid: started.pid } : {}), warn }
  }
  const undo = (args, done, prior) => {
    const q = taskState(tools)
    const t = q.state === 'present' ? (() => { const r = schtasks(args, tools); return { ...r, state: r.code === 0 ? done : 'failed' } })()
      : q.state === 'absent' ? { ...ok, state: 'absent' }
      : { code: 1, out: '', err: q.err, state: 'failed' } // not known to be gone: a failure, and nothing is changed on a guess; the Run value below is a separate part and still goes
    return settle(t, removeRunValue({ run, env, prior }))
  }
  return {
    name: 'asight-collector', path: file, links: [],
    text: () => taskXml({ user: user || taskUser(env), node, asight: script, conhost }),
    enable({ now = true, prior = null } = {}) {
      const c = register({ file, run, env, fs })
      if (c.code === 0) {
        // the task is the one start at login now: an earlier fallback's Run value would start a second supervisor at every login, so it goes (the user's own prior value, the ledger's, comes back)
        const gone = removeRunValue({ run, env, prior })
        const note = gone.runKey === 'failed' ? { warn: `the HKCU Run entry ${RUN_KEY.name} of an earlier \`on\` could not be taken out (${gone.err || 'no reason given'}): both it and the task start asight at login (one supervisor runs, the other leaves at once); \`asight off\` removes both` } : {}
        const base = { via: 'task', ...(gone.runKey !== 'absent' ? { runKey: gone.runKey } : {}), ...note }
        if (!now) return { ...c, ...base }
        const r = runNow()
        return { ...r, ...base, ...(r.warn ? { warn: r.warn } : {}) }
      }
      if (c.precondition) return { ...c, via: 'task' }
      const why = errOf(c)
      const f = runKeyFallback({ command: daemonCommandLine({ node, asight: script, conhost }), run, env })
      if (!f.ok) {
        const reason = `schtasks /Create was refused (${why}) and the HKCU Run entry ${RUN_KEY.name} could not be written either (${f.reason}): asight does not start at login`
        return { code: c.code ?? 1, out: '', err: `${why}; the Run-key fallback failed too: ${f.reason}`, via: 'task', ...(f.entry ? { ledger: f.entry } : {}), event: { event: 'failure', where: 'install', code: 'task-register-failed', reason } }
      }
      const event = { event: 'failure', where: 'install', code: 'task-register-failed', reason: `schtasks /Create was refused (${why}); asight starts at login through the HKCU Run entry ${RUN_KEY.name} instead, with the supervisor parent restarting the daemon` }
      // the Run value is the one start at login now: a task an earlier `on` registered would start a second supervisor, so it is switched off (it stays registered; the undo takes it out)
      const q = taskState(tools)
      const off = q.state === 'present' ? schtasks(['/Change', '/TN', TASK_NAME, '/DISABLE'], tools) : null
      const task = off ? (off.code === 0 ? 'disabled' : 'failed') : null
      const warn = task === 'failed' ? `the task ${TASK_NAME} of an earlier \`on\` is still registered and enabled (/Change /DISABLE: ${errOf(off)}): both it and the Run entry start asight at login (one supervisor runs, the other leaves at once); \`asight off\` disables both`
        : q.state === 'unknown' ? `${q.err}: an earlier task ${TASK_NAME} may still be registered and enabled next to the Run entry (one supervisor runs, the other leaves at once); \`asight off\` disables both` : null
      const started = now ? startDirect() : null
      const base = { via: 'run-key', reason: why, ledger: f.entry, ours: f.ours, event, ...(task ? { task } : {}), ...(warn ? { warn } : {}) }
      return started && started.code !== 0 ? { code: started.code, out: '', err: started.err, ...base } : { ...ok, ...base, ...(started ? { pid: started.pid } : {}) }
    },
    start: (carry = null) => startDirect(carry),
    startNow: () => runNow(), // D61: `on` starts the daemon through the task, never touching the registration
    reload: () => ({ ...ok }),
    remove: ({ prior = null } = {}) => undo(['/Delete', '/TN', TASK_NAME, '/F'], 'removed', prior),
  }
}


// ---- the supervisor parent (4.8 §7) -------------------------------------------------------------------------------------------------------------------

export const SUPERVISOR_LOCK = 'supervisor.lock'
export const SUPERVISE_CAP_MS = 60_000 // the longest wait between two starts of the daemon (4.8 §7: 1, 2, 4 … 60 s)
export const SUPERVISE_STABLE_MS = 60_000 // a daemon that ran this long before it died starts the backoff over: it was not crash-looping (4.8 §7, Task 9(a))
/** The wait before the restart after `attempt` failures in a row (0 = the first): 1, 2, 4, 8, 16, 32, then 60 s. */
export const supervisorBackoff = (attempt) => Math.min(SUPERVISE_CAP_MS, 1000 * 2 ** attempt)

const realSleep = (ms, { signal } = {}) => new Promise((resolve) => {
  if (signal && signal.aborted) return resolve()
  const t = setTimeout(done, ms)
  function done() { clearTimeout(t); if (signal) signal.removeEventListener('abort', done); resolve() }
  if (signal) signal.addEventListener('abort', done, { once: true })
})

/**
 * The supervisor parent (4.8 §7): `asight daemon --supervise` runs the real daemon, `node <asight> daemon`, as its child and starts it again with the backoff above ONLY when it exits with a code other than 0 or is killed.
 * A daemon that exits 0 was asked to stop (`off` once it drained, `uninstall`, `off --now`): the parent exits too, so that after `off` no asight process is left and `off` is not undone by its own parent. The task that starts this
 * parent does not restart a dead daemon (the T0 measurement), so this is where the restarting is. It writes `supervisor.lock` (`{ pid, startedAt }`: what `off` checks before it stops this process first, §4.2) and holds nothing else.
 *   command  { node, args }: the child, which MUST NOT carry `--supervise` (a child that did would be a supervisor of its own)
 *   dir      the collector directory (the lock goes there)
 *   spawn · now · sleep(ms, { signal }) · fs · pid · startedAt · log(line)   what the world gives; a test passes fakes. `startedAt` defaults to this process's start (now minus its uptime).
 *   isLive({ pid, startedAt }) → boolean   the identity check of a lock that is already there (`lockHolderAlive`: runSupervisor passes it): true = that supervisor still runs, so this one is a second one: it says so in one line,
 *                    starts no daemon, leaves the holder's lock alone and ends with 0 (`{ done: resolved 0, stop, lockFile, refused: <holder> }`). False, a throw (said in the log) or no check at all = the lock is taken over.
 *                    The singleton matters because every supervisor would start a daemon that exits 1 against the first one's control endpoint, and be restarted for ever; and `off` can stop only the supervisor the lock names.
 * → { done: Promise<exit code of the supervisor: 0>, stop(): Promise (asked to stop: the child is ended, nothing restarts, the lock goes), lockFile }
 */
export function superviseChild({ spawn = nodeSpawn, command, dir, now = Date.now, sleep = realSleep, fs = nodeFs, pid = process.pid, startedAt = Math.round(Date.now() - process.uptime() * 1000), log = () => {}, isLive = null } = {}) {
  if (!command || typeof command.node !== 'string' || !Array.isArray(command.args)) throw new TypeError('superviseChild needs command: { node, args }')
  if (command.args.includes('--supervise')) throw new TypeError('the supervised command must not carry --supervise: it would start a supervisor of its own')
  const lockFile = path.join(dir, SUPERVISOR_LOCK)
  const body = `${JSON.stringify({ pid, startedAt })}\n`
  // the lock is made exclusively; one that is there names a supervisor that may still run: then this one is a second, and leaves (a hard stop leaves a stale lock behind, so "there" is not enough: the identity check says whether the holder lives)
  const held = () => { try { const o = JSON.parse(fs.readFileSync(lockFile, 'utf8')); return Number.isSafeInteger(o.pid) && o.pid > 0 && Number.isFinite(o.startedAt) ? { pid: o.pid, startedAt: o.startedAt } : null } catch { return null } }
  let other = null
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    try { fs.writeFileSync(lockFile, body, { mode: 0o600, flag: 'wx' }) } catch (e) {
      if (e.code !== 'EEXIST') throw e
      const h = held()
      if (h && h.pid !== pid && isLive) {
        let live = false
        try { live = Boolean(isLive(h)) } catch (err) { log(`${SUPERVISOR_LOCK} names pid ${h.pid}, and whether it still runs could not be told (${(err && err.message) || err}): taking the lock over`) }
        if (live) other = h
      }
      if (!other) fs.writeFileSync(lockFile, body, { mode: 0o600 })
    }
  } catch (e) { log(`${SUPERVISOR_LOCK} could not be written (${(e && e.code) || (e && e.message) || e}); the daemon is supervised all the same, but \`asight off\` cannot find this process by it`) }
  if (other) {
    log(`another supervisor (pid ${other.pid}) holds ${SUPERVISOR_LOCK} and runs: this one starts no second daemon and leaves`)
    return { done: Promise.resolve(0), stop: async () => 0, lockFile, refused: other }
  }
  const removeLock = () => { // only our own: a newer supervisor's lock is not ours to delete
    try { if (JSON.parse(fs.readFileSync(lockFile, 'utf8')).pid === pid) fs.rmSync(lockFile, { force: true }) } catch { /* no lock, or not readable: nothing of ours */ }
  }
  const abort = new AbortController()
  let child = null
  let stopping = false

  /** One run of the daemon → { code, signal } when it ended, { error } when it could not be started. */
  const runOnce = () => new Promise((resolve) => {
    let c
    try { c = spawn(command.node, command.args, { stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true }) } catch (e) { return resolve({ error: e }) }
    child = c
    c.once('exit', (code, signal) => resolve({ code, signal }))
    // 'error' before any pid is a spawn that failed (no exit follows). With a pid it is a kill or a message that failed while the process lives: its exit is still to come, and starting a second daemon now would be wrong
    c.on('error', (e) => { if (c.pid === undefined) resolve({ error: e }); else log(`the daemon (pid ${c.pid}): ${(e && e.message) || e}`) })
  })

  const done = (async () => {
    let failures = 0
    try {
      for (;;) {
        const began = now()
        const r = await runOnce()
        child = null
        if (stopping) return 0
        if (!r.error && r.code === 0 && !r.signal) return 0 // asked to stop
        if (now() - began >= SUPERVISE_STABLE_MS) failures = 0
        const wait = supervisorBackoff(failures++)
        const what = r.error ? `could not be started (${(r.error && r.error.code) || ''} ${(r.error && r.error.message) || r.error})`.replace(/\s+/g, ' ') : r.signal ? `was killed (${r.signal})` : `exited with code ${r.code}`
        log(`the daemon ${what}; restarting in ${wait / 1000} s`)
        await sleep(wait, { signal: abort.signal })
        if (stopping) return 0
      }
    } finally { removeLock() }
  })()

  async function stop() {
    stopping = true
    abort.abort()
    if (child && child.exitCode == null && child.signalCode == null) { try { child.kill() } catch (e) { log(`the daemon could not be stopped: ${(e && e.message) || e}`) } }
    return done
  }
  return { done, stop, lockFile }
}

export const LOCK_START_TOLERANCE_MS = 2000 // the lock's start time is "now minus uptime" and the OS's is the creation time: the same process agrees to within this (4.8 §7, the same 2 s as forwarder.lock)

/**
 * Does the process a supervisor.lock names still run (4.8 §7)? Windows is asked for the start time of that pid (`Get-Process`, through execTool: one fixed question about one integer) and the answer is the same process when
 * it agrees with the lock's to within 2 s; a pid that is running with another start time is a reused pid. → true · false (no such process, or another one); throws when it cannot be told (powershell did not run or answered
 * with something else), and the supervisor says so and takes the lock over: not knowing is "not running", so that asight starts instead of not starting. A pid that is not a positive integer is a TypeError: it never reaches a command.
 */
export function lockHolderAlive({ pid, startedAt } = {}, { run = null, env = process.env, toleranceMs = LOCK_START_TOLERANCE_MS } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new TypeError(`lockHolderAlive needs a positive integer pid, got ${JSON.stringify(pid)}`)
  const script = `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if (-not $p) { 'gone' } else { try { [DateTimeOffset]::new($p.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds() } catch { 'unreadable' } }`
  const r = execTool('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { run, env })
  if (r.code !== 0) throw new Error(`the start time of pid ${pid} could not be asked: powershell ${r.code === null ? 'did not run' : `exited ${r.code}`}${r.err ? ` (${r.err.slice(0, 200)})` : ''}`)
  if (r.out === 'gone') return false
  if (!/^\d{10,}$/.test(r.out)) throw new Error(`the start time of pid ${pid} could not be read: powershell answered ${JSON.stringify(r.out.slice(0, 60))}`)
  return Math.abs(Number(r.out) - startedAt) <= toleranceMs
}

/**
 * `asight daemon --supervise` (src/cli/daemon.mjs calls this): supervises `node <asight> daemon` until the daemon exits 0 or a stop signal arrives (SIGINT, SIGTERM, SIGHUP: a console closing). → the exit code.
 * `asight` is the script the daemon child runs (the CLI passes its own `process.argv[1]`); `dir` is the collector directory.
 */
export async function runSupervisor({ node = process.execPath, asight, dir, proc = process, run = null, env = process.env, log = (line) => { try { proc.stderr.write(`asight daemon --supervise: ${line}\n`) } catch { /* no console to write to */ } }, deps = {} } = {}) {
  if (typeof asight !== 'string' || asight === '') throw new TypeError('runSupervisor needs the asight script the daemon child runs')
  const sup = superviseChild({ command: { node, args: [asight, 'daemon'] }, dir, log, isLive: (holder) => lockHolderAlive(holder, { run, env }), ...deps })
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP']
  const onSignal = () => { sup.stop() }
  for (const s of signals) proc.on(s, onSignal)
  try { return await sup.done } finally { for (const s of signals) proc.removeListener(s, onSignal) }
}
