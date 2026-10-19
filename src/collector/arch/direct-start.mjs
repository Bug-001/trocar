// direct-start.mjs — the environment of a collector daemon this run starts itself (`unit.start()`, the `asight on --no-autostart` run), shared by
// every arch (RFC 1.6 §3.3; 4.9 §4, 4.8 §7): the shell's environment without the variables that change what the daemon trusts or whom it dials
// (Node's CA, TLS and proxy switches, OpenSSL's CA file and directory, the `*_PROXY` family, in any case), so a daemon started by hand trusts and
// dials exactly as the one a login entry would start. What is not in this list stays: the user-level variables a login job carries too (`CODEX_HOME`,
// `PATH`, `HOME`, `TMPDIR` — the control socket lives under it).
// One list in one place: three archs had their own copy of it.
import nodeFs from 'node:fs'
import { daemonLogPaths, ensureDaemonLogs } from './daemon-logs.mjs'

const TRUST_AND_PROXY = /^(NODE_EXTRA_CA_CERTS|NODE_OPTIONS|NODE_USE_SYSTEM_CA|NODE_USE_ENV_PROXY|NODE_TLS_REJECT_UNAUTHORIZED|SSL_CERT_FILE|SSL_CERT_DIR|(HTTPS?|ALL|NO|FTP|WSS?)_PROXY)$/i

export function directStartEnv(env = process.env) {
  const out = {}
  for (const [k, v] of Object.entries(env)) if (!TRUST_AND_PROXY.test(k)) out[k] = v
  return out
}

/** The `stdio` of a daemon this run starts itself: its stdout / stderr appended to the two files the login entry appends to (D46), so a daemon that
 *  exits at once leaves its reason where the operator and `asight status` look — `stdio: 'ignore'` left none anywhere (review 2026-10-18).
 *  → `{ stdio, logs, note }`; a logs directory that cannot be made falls back to 'ignore' and says so — it never stops the start. */
export function directStartStdio(home, { fs = nodeFs } = {}) {
  const logs = daemonLogPaths(home)
  try {
    ensureDaemonLogs(home, { fs })
    return { stdio: ['ignore', fs.openSync(logs.out, 'a'), fs.openSync(logs.err, 'a')], logs, note: null }
  } catch (e) {
    return { stdio: 'ignore', logs, note: `the daemon's log files (${logs.dir}) could not be opened (${(e && e.message) || e}); a daemon that exits at once leaves no reason behind` }
  }
}

/** The one copy of "start the daemon myself, this once" every arch's `unit.start()` returns (1.6 §3.3): the environment AND the two log files of a
 *  login-started daemon, so a start by hand trusts what a start at login trusts and leaves its reason in the same place.
 *  `carry` is what the login entry would carry beyond the shell's own environment (install's `daemonEnv(env, dir)`: `{ env, note }` — NODE_EXTRA_CA_CERTS,
 *  without which capture breaks behind a corporate MITM relay and nothing says so). `argv`: what follows `command` (win32 wraps it in conhost).
 *  → the `{ code, out, err, via, pid, warn? }` ensureDaemonUp reads; `warn` is every value or sink that could not be carried (D38: said, never dropped). */
export function startDaemonDirect({ home, env = process.env, carry = null, command, argv, spawn, fs = nodeFs, spawnOpts = {} }) {
  const s = directStartStdio(home, { fs })
  const warn = [carry && carry.note, s.note].filter(Boolean).join('; ') || null
  let child
  try { child = spawn(command, argv, { detached: true, stdio: s.stdio, env: { ...directStartEnv(env), ...((carry && carry.env) || {}) }, ...spawnOpts }) } catch (err) { return { code: null, out: '', err: `${command} could not be started (${(err && err.code) || (err && err.message) || err})` } }
  if (!child || child.pid === undefined) return { code: null, out: '', err: 'the daemon did not start' }
  if (typeof child.on === 'function') child.on('error', () => {}) // a late spawn error is not an uncaught exception; the daemon that never answers is what `on` reports
  child.unref()
  return { code: 0, out: '', err: '', via: 'direct', pid: child.pid, ...(warn ? { warn } : {}) }
}
