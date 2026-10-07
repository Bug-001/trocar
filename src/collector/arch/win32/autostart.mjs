// autostart.mjs — how the Windows collector is started and kept up, and what it refuses to start under (RFC 4.8 §7; acceptance W24 W25). The daemon is `node <asight> daemon`, started at login by one Task Scheduler task per user,
// supervised by a small parent that brings it back when it dies. Tools (`schtasks`, `reg`) run only through execTool, so a test injects the runner; the helper, the spawn and the clock are parameters too, and every piece runs on
// any OS against a temp directory. Node built-ins, src/paths.mjs and src/off/exec.mjs only (this file never imports a harness, 4.6 §结构).
import nodeFs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn as nodeSpawn } from 'node:child_process'
import { execTool } from '../../../off/exec.mjs'
import { collectorHome } from '../../../paths.mjs'

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
 * R7 on Windows (4.8 §7): asight never runs with an elevated token or as SYSTEM. → `null` (go on) or `{ code: 'elevated-token', reason, token }`, which `on` and `daemon` turn into the refusal and the `start` failure record.
 * The check is the helper's own token (`token` verb: `{elevated, elevationType, integrity, system}`; `elevated` is "integrity High or above"). A token that cannot be read (the helper is down, native code did not compile, an answer
 * that is not booleans) is NOT a refusal (the helper's own failure is recorded where it happens); `onUnknown(reason)` says why it is unknown (R11).
 */
export async function refuseElevated({ helper, onUnknown = () => {} } = {}) {
  let t
  try { t = await helper.call('token') } catch (e) { onUnknown(`the token could not be read: ${(e && e.code) || ''} ${(e && e.message) || e}`.replace(/\s+/g, ' ').trim()); return null }
  if (!t || typeof t !== 'object' || typeof t.elevated !== 'boolean' || typeof t.system !== 'boolean') { onUnknown(`the token answer is not {elevated, system} booleans: ${JSON.stringify(t)}`.slice(0, 300)); return null }
  if (!t.elevated && !t.system) return null
  return {
    code: 'elevated-token',
    reason: `用你自己的账号跑,不要「以管理员身份运行」,也不要用 SYSTEM(R7:asight 不以提升的令牌运行;这个令牌是${t.system ? ' SYSTEM' : '高完整性级别'})`,
    token: { elevated: t.elevated, system: t.system, integrity: t.integrity ?? null },
  }
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
const taskExists = ({ run, env }) => schtasks(['/Query', '/TN', TASK_NAME], { run, env }).code === 0
const errOf = (r) => r.err || (r.code === null ? 'it did not run' : `exit ${r.code}`)
const ours = (value) => /\bdaemon --supervise\s*$/.test(value) // what an earlier `on` of asight wrote: the supervised daemon command

/**
 * The Run value, read: `reg query HKCU\...\Run /v asight-collector` → `{ present: true, kind, value }` · `{ present: false }` · `{ error }` (reg did not run, or answered with something that is no value).
 * One fixed query of one value: asight reads no other value of that key.
 */
export function readRunValue({ run = null, env = process.env } = {}) {
  const r = execTool('reg', ['query', RUN_PATH, '/v', RUN_KEY.name], { run, env })
  if (r.code === null) return { error: `reg query did not run (${r.err || 'no reason given'})` }
  if (r.code !== 0) return { present: false }
  const m = new RegExp(`^[ \\t]+${RUN_KEY.name}[ \\t]+(REG_[A-Z_]+)(?:[ \\t]+(.*))?$`, 'mi').exec(r.out)
  if (!m) return { error: `reg query answered, but not with the value ${RUN_KEY.name}` }
  return { present: true, kind: m[1].toUpperCase(), value: m[2] ?? '' }
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
  const entry = { kind: 'run-key', hive: RUN_KEY.hive, key: RUN_KEY.key, name: RUN_KEY.name, value: command, prior: before.present && !mine ? { kind: before.kind, value: before.value } : null }
  const w = execTool('reg', ['add', RUN_PATH, '/v', RUN_KEY.name, '/t', 'REG_SZ', '/d', command, '/f'], { run, env })
  if (w.code !== 0) return { ok: false, reason: `reg add failed (${errOf(w)})` }
  const after = readRunValue({ run, env })
  if (after.error || !after.present || after.value !== command) return { ok: false, entry, reason: `the Run value did not take: read back as ${after.error ? after.error : after.present ? JSON.stringify(after.value) : 'absent'}` }
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

const settle = (task, k) => ({ code: task.code !== 0 ? task.code : k.code, out: [task.out, k.out].filter(Boolean).join('\n'), err: [task.err, k.err].filter(Boolean).join('; '), task: task.state, runKey: k.runKey })

/**
 * The per-user autostart as `asight on` (src/cli/on.mjs) and install.mjs consume it, the same shape as arch/linux/unit.mjs `userUnit`: `{ name, path, links, text(env), enable({ now }), start(), reload(), disable(), remove() }`, each verb
 * returning `{ code, out, err }`. `path` is the task's XML, an owned file the install manifest lists; `links` is empty (a task has no wants/ link); `text(env)` is the XML (a Windows task has no environment of its own, so the
 * daemon environment install offers is not carried: a daemon the task starts trusts the system store, 4.8 §6.2). Nothing is registered until `enable`.
 *   enable({ now })  registers the task (`/Create /XML … /F`, which also switches a disabled one on) and, with `now` (the default; install passes false when a daemon already answers), runs it (`/Run`) → `via: 'task'`.
 *                    When schtasks REFUSES the registration, the Run-key fallback takes over (4.8 §7): `via: 'run-key'`, code 0 (`on` does not fail because the Task Scheduler said no), `reason` (why), `ledger` (the manifest entry,
 *                    runKeyFallback's), `ours`, `event` (the `task-register-failed` failure record for the caller to write: it carries the reason and names the entry used instead), and with `now` the supervised daemon is started
 *                    directly (the Run value only runs at the next login). When the fallback fails too, code is not 0 and `err` has both reasons.
 *   start()          the `--no-autostart` run: this session, nothing at login. A task with a login trigger would be an autostart, so none is registered: the supervised daemon is started directly, detached, with no window.
 *   reload()         nothing to do: a rewritten task is registered again by `enable` (`/F`).
 *   disable({ prior }) a no-argument `off`: the task is switched off (`/Change /DISABLE`; it does not end a running instance, the caller stops the supervisor parent first, 4.8 §4.2) and asight's Run value is taken out, whichever
 *                    of the two an earlier `on` used. → `{ code, out, err, task: 'disabled' | 'absent' | 'failed', runKey }`. `prior` is the Run entry's ledgered prior value.
 *   remove({ prior }) `uninstall`: the task is deleted (`/Delete /F`) and the Run value taken out the same way. A task that is not there is already as asked (found with `/Query`, never by parsing a localised error text).
 */
export function userUnit({ home, node, script, run = null, env = process.env, fs = nodeFs, spawn = nodeSpawn, user = null, conhost = 'conhost.exe' } = {}) {
  const file = path.join(collectorHome(path.join(home, '.asight')), TASK_FILE)
  const tools = { run, env }
  function startDirect() {
    let child
    try { child = spawn(conhost, ['--headless', node, script, 'daemon', '--supervise'], { detached: true, stdio: 'ignore', windowsHide: true }) } catch (e) { return { code: null, out: '', err: `${conhost} could not be started (${(e && e.code) || (e && e.message) || e})` } }
    if (!child || child.pid === undefined) return { code: null, out: '', err: `${conhost} did not start the supervised daemon` }
    if (typeof child.on === 'function') child.on('error', () => {}) // a late spawn error is not an uncaught exception; the daemon that never answers is what `on` reports
    child.unref()
    return { ...ok, via: 'direct', pid: child.pid }
  }
  // the task is changed or deleted when it is there, and asight's Run value is taken out; each says what it did
  const undo = (args, done, prior) => {
    const t = taskExists(tools) ? (() => { const r = schtasks(args, tools); return { ...r, state: r.code === 0 ? done : 'failed' } })() : { ...ok, state: 'absent' }
    return settle(t, removeRunValue({ run, env, prior }))
  }
  return {
    name: 'asight-collector', path: file, links: [],
    text: () => taskXml({ user: user || taskUser(env), node, asight: script, conhost }),
    enable({ now = true } = {}) {
      const c = register({ file, run, env, fs })
      if (c.code === 0) return { ...(now ? schtasks(['/Run', '/TN', TASK_NAME], tools) : c), via: 'task' }
      if (c.precondition) return { ...c, via: 'task' }
      const why = errOf(c)
      const f = runKeyFallback({ command: daemonCommandLine({ node, asight: script, conhost }), run, env })
      if (!f.ok) {
        const reason = `schtasks /Create was refused (${why}) and the HKCU Run entry ${RUN_KEY.name} could not be written either (${f.reason}): asight does not start at login`
        return { code: c.code ?? 1, out: '', err: `${why}; the Run-key fallback failed too: ${f.reason}`, via: 'task', ...(f.entry ? { ledger: f.entry } : {}), event: { event: 'failure', where: 'install', code: 'task-register-failed', reason } }
      }
      const event = { event: 'failure', where: 'install', code: 'task-register-failed', reason: `schtasks /Create was refused (${why}); asight starts at login through the HKCU Run entry ${RUN_KEY.name} instead, with the supervisor parent restarting the daemon` }
      const started = now ? startDirect() : null
      const base = { via: 'run-key', reason: why, ledger: f.entry, ours: f.ours, event }
      return started && started.code !== 0 ? { code: started.code, out: '', err: started.err, ...base } : { ...ok, ...base, ...(started ? { pid: started.pid } : {}) }
    },
    start: startDirect,
    reload: () => ({ ...ok }),
    disable: ({ prior = null } = {}) => undo(['/Change', '/TN', TASK_NAME, '/DISABLE'], 'disabled', prior),
    remove: ({ prior = null } = {}) => undo(['/Delete', '/TN', TASK_NAME, '/F'], 'removed', prior),
  }
}
