// autostart.mjs — how the darwin collector is started and kept up, and what it refuses to start under (RFC 4.9 §4 · §7; the mechanisms it inherits are 4.8 §7, acceptance W24 W25; the
// userUnit interface is arch/linux/unit.mjs's). The daemon is `node <asight> daemon`, started at login by a LaunchAgent — a plist in ~/Library/LaunchAgents, `RunAtLoad` + `KeepAlive` —
// and that is the whole of it: NO supervisor parent (4.9 §4). launchd's KeepAlive really does bring a killed process back (the Windows scheduled task does not, which is why the win32
// side built one), so the win32 supervisor machinery — superviseChild, runSupervisor, supervisor.lock, the backoff — is dropped, and with it the task / Run-key double mechanism:
// launchd is the one autostart, and when launchctl refuses it there is no fallback to succeed through (the `launchd-register-failed` record, 4.9 §11). The launchctl verbs are the modern
// ones: `bootstrap gui/<uid> <plist>` installs the job into the user's GUI session domain and starts it, `bootout gui/<uid> <label>` takes it out — and bootout is what `off` leans on:
// **the autostart goes FIRST, before the daemon process is stopped**, because a process stopped while the agent is still loaded is pulled right back by KeepAlive (the off order, 4.9 §4;
// this module's verbs return before the caller stops anything). launchctl runs only through execTool, so a test injects the runner; the spawn, the uid and the fs are parameters too,
// and every piece runs on any OS against a temp directory. Node built-ins and src/off/exec.mjs only (this file never imports a harness, 4.6 §结构).
import nodeFs from 'node:fs'
import path from 'node:path'
import { spawn as nodeSpawn } from 'node:child_process'
import { execTool } from '../../../off/exec.mjs'
import { daemonLogPaths, ensureDaemonLogs } from '../daemon-logs.mjs'

export const AGENT_LABEL = 'com.asight.collector' // the launchd job's label
export const PLIST_FILE = 'com.asight.collector.plist' // the plist's name in the user's LaunchAgents directory
/** ~/Library/LaunchAgents/com.asight.collector.plist — launchd scans this directory at every login, so the file IS the registration: `enable`'s bootstrap starts the job now, and the undo takes the file out again or the next login brings the agent back. */
export const plistPath = (home) => path.join(home, 'Library', 'LaunchAgents', PLIST_FILE)

/** The oldest Node `on` accepts (package.json `engines`; a test holds the two equal). Older than that and the daemon would exit at every login with an error nobody sees (4.8 §7, the same reason on darwin: launchd starts it with the Node that is installed). */
export const NODE_MIN_MAJOR = 20

/**
 * The Node preflight of `on` (4.8 §7): → `{ ok: true, have, min }` or `{ ok: false, have, min, doctor }`. `doctor` is the line to print: what was found and what is needed. A version that
 * cannot be read is not a pass (it names itself as such): a daemon on an unknown Node is the one that exits at login. `versions` is `process.versions`.
 */
export function nodePreflight({ versions = process.versions } = {}) {
  const have = versions && versions.node
  const major = typeof have === 'string' && /^\d+(\.|$)/.test(have) ? Number(have.split('.')[0]) : null
  if (major === null) return { ok: false, have: have ?? null, min: NODE_MIN_MAJOR, doctor: `读不到 Node 的版本(${JSON.stringify(have ?? null)}):asight 在 macOS 上要 Node ≥ ${NODE_MIN_MAJOR}。确认 \`node --version\` 之后再 asight on` }
  if (major < NODE_MIN_MAJOR) return { ok: false, have, min: NODE_MIN_MAJOR, doctor: `Node ${have} 太旧:asight 在 macOS 上要 Node ≥ ${NODE_MIN_MAJOR}(守护进程每次登录都由 launchd 用这个 Node 拉起,更老的版本起不来)。升级 Node 之后再 asight on` }
  return { ok: true, have, min: NODE_MIN_MAJOR }
}

const processUid = () => (typeof process.getuid === 'function' ? process.getuid() : -1) // -1: a platform without getuid (a test on Windows) — never 0, so never a refusal; that platform's own check is the win32 helper's

/**
 * R7 on darwin (4.9 §7): asight never runs as root. → `null` (go on) or `{ code: 'root-token', reason, token }`, which `on` and `daemon` turn into the refusal and the `start` failure
 * record — `root-token` is the darwin name of win32's `elevated-token` (4.9 §11; the closed set takes it). The check is this process's own uid and euid: darwin has no resident helper
 * (4.9 §1) and a uid needs none, so there is no unreadable case (the win32 helper's R11 unknown has no darwin counterpart) and `getuid` / `geteuid` are parameters only so a test can say
 * which world it is in.
 */
export async function refuseElevated({ getuid = processUid, geteuid = processUid } = {}) {
  const uid = getuid()
  const euid = geteuid()
  if (uid !== 0 && euid !== 0) return null
  return {
    code: 'root-token',
    reason: `用你自己的账号跑,不要用 sudo(R7:asight 不以 root 运行;${euid === 0 && uid !== 0 ? 'euid 是 0' : 'uid 是 0'})`,
    token: { uid, euid },
  }
}

const CONTROL_CHAR = /[\u0000-\u001f\u007f]/
const plain = (name, v) => {
  if (typeof v !== 'string' || v === '' || CONTROL_CHAR.test(v)) throw new TypeError(`plist: ${name} is a non-empty string with no control character, got ${JSON.stringify(v)}`)
  return v
}
const xmlText = (v) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/**
 * The LaunchAgent plist (4.9 §4). Label com.asight.collector; ProgramArguments = `node <asight> daemon` and nothing more — no `--supervise`, that flag went with the supervisor parent;
 * RunAtLoad true and KeepAlive {SuccessfulExit: false} (a crash is relaunched, a drained daemon's exit 0 is not), and KeepAlive is the reason there is no supervisor (launchd brings a killed daemon back) and the reason `off` boots the agent out BEFORE it stops the
 * daemon. `env` is the daemon's own environment (install's daemonEnv: NODE_EXTRA_CA_CERTS of the install shell, an absolute path), written as EnvironmentVariables — a launchd job starts
 * with none of the shell's exports, so what install wants the daemon to have must be in the plist (the linux unit's `Environment=`, 4.6 §引擎 5; a Windows task cannot carry any, 4.8 §7).
 * `logs` (D46, given by userUnit) adds StandardOutPath / StandardErrorPath under ~/.asight/collector/logs/ — the daemon's own stdout / stderr, a launchd-started daemon's only console:
 * without them a daemon that dies at every login does so with an error nobody sees. A quote in a path is harmless here (plist element content, not a command line): only & < > are escaped,
 * and a control character or a non-string is a bug of the caller.
 */
export function plistXml({ node, asight, env = {}, logs = null } = {}) {
  const n = plain('node', node)
  const a = plain('asight', asight)
  if (!env || typeof env !== 'object' || Array.isArray(env)) throw new TypeError(`plist: env is an object of variable names to strings, got ${JSON.stringify(env)}`)
  const vars = Object.entries(env)
  for (const [k, v] of vars) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new TypeError(`plist: env key ${JSON.stringify(k)} is not a variable name`)
    plain(`env ${k}`, v)
  }
  const sinks = logs ? [['StandardOutPath', plain('logs.out', logs.out)], ['StandardErrorPath', plain('logs.err', logs.err)]] : []
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${xmlText(AGENT_LABEL)}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    `    <string>${xmlText(n)}</string>`,
    `    <string>${xmlText(a)}</string>`,
    '    <string>daemon</string>',
    '  </array>',
    ...(vars.length ? ['  <key>EnvironmentVariables</key>', '  <dict>', ...vars.map(([k, v]) => `    <key>${xmlText(k)}</key>\n    <string>${xmlText(v)}</string>`), '  </dict>'] : []),
    ...sinks.flatMap(([key, file]) => ['  <key>' + key + '</key>', `  <string>${xmlText(file)}</string>`]),
    '  <key>RunAtLoad</key>',
    '  <true/>',
    '  <key>KeepAlive</key>', // relaunched only after an exit that is not clean — a daemon that drained after `off` exits 0 and stays down
    '  <dict>',
    '    <key>SuccessfulExit</key>',
    '    <false/>',
    '  </dict>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n')
}

// The slash form for bootout's target (`gui/<uid>/<label>`, ONE argument — the rule src/off/darwin.mjs's `launchctl` carries,
// measured on a macOS test machine, 2026-10-11): the two-argument form answers `Boot-out failed: 5: Input/output error` on every
// job and leaves it loaded — an `on` over a loaded job and every uninstall would then report launchd failures of their own making.
const launchctl = (args, { run, env }) => execTool('launchctl', args, { run, env })
/** The user's GUI session domain, launchd's per-user target (`bootstrap` / `bootout` take it): `gui/<uid>`, this process's own uid. */
const domainOf = (uid) => `gui/${uid}`

const ok = { code: 0, out: '', err: '' }
/** Is the agent loaded in this user's session? `launchctl print gui/<uid>/<label>` is the question (never a localised error text): exit 0 = there; any other exit = not there; a print
 *  that did not run at all (timeout, blocked, no launchctl: code null) is NOT "not there" — nothing was asked of launchd, so an undo that took it for gone would report success while the
 *  agent stays loaded and pulls the daemon back. → `{ state: 'present' }` · `{ state: 'absent' }` · `{ state: 'unknown', err }`. (The win32 taskState's rule, W24.) */
const agentState = ({ run, env, uid }) => {
  const r = launchctl(['print', `${domainOf(uid)}/${AGENT_LABEL}`], { run, env })
  if (r.code === 0) return { state: 'present' }
  if (r.code === null) return { state: 'unknown', err: `launchctl print did not run (${r.err || 'no reason given'})` }
  return { state: 'absent' }
}

const TRUST_AND_PROXY = /^(NODE_EXTRA_CA_CERTS|NODE_OPTIONS|NODE_USE_SYSTEM_CA|NODE_USE_ENV_PROXY|NODE_TLS_REJECT_UNAUTHORIZED|SSL_CERT_FILE|SSL_CERT_DIR|(HTTPS?|ALL|NO|FTP|WSS?)_PROXY)$/i
/**
 * The environment of a daemon that is started directly (`start()`, the `--no-autostart` run): the installer shell's, without the variables that change what the daemon trusts or whom it
 * dials (Node's CA, TLS and proxy switches, OpenSSL's CA file and directory, the `*_PROXY` family, any case — on darwin names are case sensitive and the lowercase spellings
 * (`https_proxy`) are as meaningful as the uppercase ones, so the case-insensitive match strips a few mixed-case names that mean nothing too, which costs nothing). A daemon the LaunchAgent
 * starts at login has none of the shell's: launchd starts it with a bare environment plus the plist's EnvironmentVariables, so a daemon that got the shell's from `on` would trust and dial
 * differently from the same daemon after the next login. The one residue is the plist's own NODE_EXTRA_CA_CERTS (install's daemonEnv): a directly started daemon does not get it — on
 * darwin the engine verifies an upstream with the merged bundle (4.9 §5), so what the daemon trusts does not turn on it. What is not in this list stays: the user-level variables a login
 * job carries (`CODEX_HOME`, `PATH`, `HOME`, `TMPDIR`) are in the shell's environment too.
 */
export function directStartEnv(env = process.env) {
  const out = {}
  for (const [k, v] of Object.entries(env)) if (!TRUST_AND_PROXY.test(k)) out[k] = v
  return out
}

// the two parts of an undo as one answer; a tool that did not run (code null) is code 1, a failure that a caller's `if (r.code)` sees (the win32 settle's rule)
const settle = (agent, plist) => ({ code: (agent.code !== 0 ? agent.code : plist.code) ?? 1, out: [agent.out, plist.out].filter(Boolean).join('\n'), err: [agent.err, plist.err].filter(Boolean).join('; '), agent: agent.state, plist: plist.state })

/**
 * The per-user autostart as `asight on` (src/cli/on.mjs) and install.mjs consume it, the same shape as arch/linux/unit.mjs `userUnit` (and win32's): `{ name, path, links, text(env),
 * enable({ now }), start(), reload(), disable(), remove() }`, each verb returning `{ code, out, err }`. `path` is the plist, an owned file the install manifest lists (written by install,
 * atomic and durable like every owned file); `links` is empty (a LaunchAgent has no wants/ link — the file in LaunchAgents is the whole registration, which is why the undo removes it).
 * `text(env)` is the plist; the daemon environment install offers is carried (see plistXml). Nothing is registered until install writes the file.
 *   enable({ now })  bootstraps the job into gui/<uid> from the plist install wrote, which also starts it (RunAtLoad) — after a best-effort `bootout` of an earlier copy of the job (the
 *                    win32 `/Create /F` analog: a job that is already loaded is replaced, and a bootout of a job that is not loaded answers with an error that is not ours to fail on).
 *                    With `now: false` (a daemon already answers) launchctl is not asked at all: the plist in ~/Library/LaunchAgents is what launchd loads at the NEXT login, and a
 *                    bootstrap would start a second daemon beside the one that answers (拉起不是重启, R8). When launchctl refuses the bootstrap the answer is not 0 and carries the
 *                    `launchd-register-failed` failure record for the caller to write: launchd is the only autostart, so `on`'s receipt says it (4.9 §11) — there is no fallback.
 *   start()          the `--no-autostart` run: this session, nothing at login. A LaunchAgent with RunAtLoad would be an autostart, so none is registered: the daemon is started directly,
 *                    detached, with the environment of `directStartEnv(env)` (the shell's, without the trust and proxy variables a login-started daemon would not have) and no
 *                    supervisor flag (launchd is the restart; a `--no-autostart` daemon is not under it and dies when it dies).
 *   reload()         nothing to do: a rewritten plist is replaced by the next `enable` (bootout + bootstrap).
 *   disable()        a no-argument `off`: `launchctl disable gui/<uid>/<label>` only — the draining daemon exits itself and launchd loads the job no more until `enable`.
 *   remove()         an `uninstall`. The undo, in its order: **`launchctl bootout` FIRST** (the autostart off the hook, so KeepAlive does not pull the
 *                    daemon back — the caller stops the daemon process after this verb returns, never before, 4.9 §4), then the plist leaves ~/Library/LaunchAgents (launchd scans that
 *                    directory at every login: a file left there brings the agent back at the next one, which would undo the off, D39). → `{ code, out, err, agent: 'booted-out' |
 *                    'absent' | 'failed', plist: 'removed' | 'absent' | 'failed' }`. An agent that is not there is already as asked, not an error (found with `launchctl print`, never by
 *                    parsing a localised error text); a print that did not run at all is not "not there": it is a failure (`agent: 'failed'`, code 1) and nothing is booted out on a
 *                    guess — the plist is a separate part of the undo and still goes.
 */
export function userUnit({ home, node, script, run = null, env = process.env, fs = nodeFs, spawn = nodeSpawn, uid = null } = {}) {
  const file = plistPath(home)
  const tools = { run, env, uid: uid ?? processUid() }
  function startDirect() {
    let child
    try { child = spawn(node, [script, 'daemon'], { detached: true, stdio: 'ignore', env: directStartEnv(env) }) } catch (e) { return { code: null, out: '', err: `the daemon could not be started (${(e && e.code) || (e && e.message) || e})` } }
    if (!child || child.pid === undefined) return { code: null, out: '', err: 'the daemon did not start' }
    if (typeof child.on === 'function') child.on('error', () => {}) // a late spawn error is not an uncaught exception; the daemon that never answers is what `on` reports
    child.unref()
    return { ...ok, via: 'direct', pid: child.pid }
  }
  // the agent is booted out of the session and the plist out of LaunchAgents, in that order (see the userUnit header); each half says what it did
  const undo = () => {
    const q = agentState(tools)
    const a = q.state === 'present' ? (() => { const r = launchctl(['bootout', `${domainOf(tools.uid)}/${AGENT_LABEL}`], tools); return { ...r, state: r.code === 0 ? 'booted-out' : 'failed' } })()
      : q.state === 'absent' ? { ...ok, state: 'absent' }
      : { code: 1, out: '', err: q.err, state: 'failed' } // not known to be gone: a failure, and nothing is changed on a guess; the plist below is a separate part and still goes
    let p
    try {
      if (!fs.existsSync(file)) p = { ...ok, state: 'absent' }
      else { fs.rmSync(file, { force: true }); p = { ...ok, state: 'removed' } }
    } catch (e) { p = { code: 1, out: '', err: `the plist ${file} could not be removed (${(e && e.code) || (e && e.message) || e})`, state: 'failed' } }
    return settle(a, p)
  }
  return {
    name: AGENT_LABEL, path: file, links: [],
    text: (e = {}) => plistXml({ node, asight: script, env: e, logs: daemonLogPaths(home) }),
    // D46: the daemon's log files, made at unit-write time and listed in the manifest (install calls these); never rewritten by a later on
    logFiles: () => { const { out, err } = daemonLogPaths(home); return [{ path: out }, { path: err }] },
    ensureLogs: () => ensureDaemonLogs(home, { fs }),
    enable({ now = true } = {}) {
      if (!fs.existsSync(file)) return { code: null, out: '', err: `the plist ${file} is not there: launchd is not asked (install writes it first)`, precondition: true } // not a refusal of launchctl: nothing was asked of it
      this.ensureLogs() // the sinks the plist names exist whatever wrote the plist (one upgraded from before D46 included)
      launchctl(['enable', `${domainOf(tools.uid)}/${AGENT_LABEL}`], tools) // `off` disabled the job; a disabled job is neither bootstrapped now nor loaded at the next login
      if (!now) return { ...ok }
      launchctl(['bootout', `${domainOf(tools.uid)}/${AGENT_LABEL}`], tools) // an earlier copy of the job goes out first (the /F analog); a job that is not loaded answers with an error that is not ours to fail on — the bootstrap below is the answer
      const r = launchctl(['bootstrap', domainOf(tools.uid), file], tools)
      if (r.code === 0) return r
      return { ...r, code: r.code ?? 1, event: { event: 'failure', where: 'install', code: 'launchd-register-failed', reason: `launchctl bootstrap was refused (${r.code === null ? 'it did not run' : `exit ${r.code}`}${r.err ? `: ${r.err}` : ''}); launchd is the only autostart, so asight does not start at login` } }
    },
    start: startDirect,
    reload: () => ({ ...ok }),
    // a no-names off: launchctl disable, never a bootout of a draining daemon — the same call as src/off/darwin.mjs disableAgent; the plist stays
    disable: () => { const r = launchctl(['disable', `${domainOf(tools.uid)}/${AGENT_LABEL}`], tools); return { ...r, code: r.code ?? 1, state: r.code === 0 ? 'disabled' : 'failed' } },
    remove: undo,
  }
}
