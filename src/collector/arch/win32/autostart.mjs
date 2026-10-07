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
  const args = `--headless "${plain('node', node, { quoted: true })}" "${plain('asight', asight, { quoted: true })}" daemon --supervise`
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
 *  order mark (the T0 form) is made beside it, handed over, and removed. → `{ code, out, err }`; a file that cannot be read is `code: null` with the reason. */
export function register({ file, run = null, env = process.env, fs = nodeFs } = {}) {
  const copy = `${file}.utf16`
  try {
    fs.writeFileSync(copy, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(fs.readFileSync(file, 'utf8'), 'utf16le')]), { mode: 0o600 })
  } catch (e) {
    try { fs.rmSync(copy, { force: true }) } catch { /* nothing was made */ }
    return { code: null, out: '', err: `the task file ${file} cannot be read or copied (${(e && e.code) || (e && e.message) || e})` }
  }
  try { return schtasks(['/Create', '/XML', copy, '/TN', TASK_NAME, '/F'], { run, env }) } finally { try { fs.rmSync(copy, { force: true }) } catch { /* the next register overwrites it */ } }
}

const ok = { code: 0, out: '', err: '' }
const taskExists = ({ run, env }) => schtasks(['/Query', '/TN', TASK_NAME], { run, env }).code === 0

/**
 * The per-user autostart as `asight on` (src/cli/on.mjs) and install.mjs consume it, the same shape as arch/linux/unit.mjs `userUnit`: `{ name, path, links, text(env), enable({ now }), start(), reload(), disable(), remove() }`, each verb
 * returning `{ code, out, err }`. `path` is the task's XML, an owned file the install manifest lists; `links` is empty (a task has no wants/ link); `text(env)` is the XML (a Windows task has no environment of its own, so the
 * daemon environment install offers is not carried: a daemon the task starts trusts the system store, 4.8 §6.2). Nothing is registered until `enable`.
 *   enable({ now })  registers the task (`/Create /XML … /F`, which also switches a disabled one on) and, with `now` (the default; install passes false when a daemon already answers), runs it (`/Run`).
 *   start()          the `--no-autostart` run: this session, nothing at login. A task with a login trigger would be an autostart, so none is registered: the supervised daemon is started directly, detached, with no window.
 *   reload()         nothing to do: a rewritten task is registered again by `enable` (`/F`).
 *   disable()        a no-argument `off`: `/Change /DISABLE`. It does not end a running instance (the supervisor parent is stopped first by the caller, 4.8 §4.2). A task that is not there is already as asked.
 *   remove()         `uninstall`: `/Delete /F`.
 */
export function userUnit({ home, node, script, run = null, env = process.env, fs = nodeFs, spawn = nodeSpawn, user = null, conhost = 'conhost.exe' } = {}) {
  const file = path.join(collectorHome(path.join(home, '.asight')), TASK_FILE)
  const tools = { run, env }
  return {
    name: 'asight-collector', path: file, links: [],
    text: () => taskXml({ user: user || taskUser(env), node, asight: script, conhost }),
    enable({ now = true } = {}) {
      const c = register({ file, run, env, fs })
      if (c.code !== 0) return { ...c, via: 'task' }
      return { ...(now ? schtasks(['/Run', '/TN', TASK_NAME], tools) : c), via: 'task' }
    },
    start() {
      let child
      try { child = spawn(conhost, ['--headless', node, script, 'daemon', '--supervise'], { detached: true, stdio: 'ignore', windowsHide: true }) } catch (e) { return { code: null, out: '', err: `${conhost} could not be started (${(e && e.code) || (e && e.message) || e})` } }
      if (!child || child.pid === undefined) return { code: null, out: '', err: `${conhost} did not start the supervised daemon` }
      if (typeof child.on === 'function') child.on('error', () => {}) // a late spawn error is not an uncaught exception; the daemon that never answers is what `on` reports
      child.unref()
      return { ...ok, via: 'direct', pid: child.pid }
    },
    reload: () => ({ ...ok }),
    disable() {
      if (!taskExists(tools)) return { ...ok, absent: true }
      return { ...schtasks(['/Change', '/TN', TASK_NAME, '/DISABLE'], tools), via: 'task' }
    },
    remove() {
      if (!taskExists(tools)) return { ...ok, absent: true }
      return { ...schtasks(['/Delete', '/TN', TASK_NAME, '/F'], tools), via: 'task' }
    },
  }
}
