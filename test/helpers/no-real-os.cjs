// test/helpers/no-real-os.cjs — `--require` preload for `npm test`: no test process runs a real launchctl / systemctl / security /
// certutil / loginctl.
//
// 0.1 §3 「不碰真实机器」: a developer machine may run a live capture while the tests run, and the user's real launchctl, systemctl,
// security and certutil are one forgotten injected runner away. Three layers, because a rule that only the new code's own helper
// honours protects nothing from the code that does not use the helper:
//   1. TROCAR_TEST_SANDBOX=1, set here and inherited by every child a test starts. src/off/exec.mjs (`execTool`, the one way new
//      code runs an OS tool) reads it and refuses a real tool: a stub inside the temp dir, or an injected runner, is all it runs.
//   2. `node:child_process` is wrapped (spawn, spawnSync, execFile, execFileSync, exec, execSync, and the promisified exec /
//      execFile): a command that is one of the guarded tools (REAL_TOOLS), or that a `sudo` / `env` / `sh -c` line puts in command position, is
//      refused with code ESANDBOX unless it resolves (symlinks followed) to a file inside the temp dir. This is what catches the old
//      capture's default runners (src/capture/*, src/collector/arch/linux/*) when a test forgot to inject one, and a stray direct
//      `spawnSync('launchctl')` anywhere. The patch is seen by later `import { spawnSync } from 'node:child_process'`.
//   3. Every refusal is written to a ledger (`globalThis[Symbol.for('trocar.no-real-os')].refused`). A test process that ends with a
//      refusal nobody acknowledged (`takeRefusals()` in test/helpers/no-real-os.mjs) exits 1 and names it: a caller that catches
//      ESANDBOX as "the tool failed" no longer turns a path it never ran into a green test.
//   4. `node:fs` is wrapped the same way: a write under the machine's own folders (ROOTS) or the real home is refused with ESANDBOX and goes in the same ledger, unless it is in the
//      temp dir or the checkout. A test that makes an app "present" at its descriptor's absolute place wrote two empty files into /Applications on 2026-11-06, and every later
//      run of the install tests on that machine saw them as installed apps.
// Load it with `--require` like the other preloads; the test files' children inherit the variable (not the wrapper: a child that
// must be guarded runs the same preload, or relies on layer 1). Guard: test/helpers/no-real-os.test.mjs, test/off/exec.test.mjs.
'use strict'
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const util = require('node:util')
const cp = require('node:child_process')
const { fileURLToPath } = require('node:url')
const { syncBuiltinESMExports } = require('node:module')

process.env.TROCAR_TEST_SANDBOX = '1'
// A fresh HOME does not move the session's runtime directory, and on Linux the running collector's control socket is $XDG_RUNTIME_DIR/trocar/collector.sock:
//    a test that hands process.env on would ask the developer's own daemon. Moved to a path in the run's temp dir where nothing listens (and
//    nothing is: a test that needs one makes its own). Only when it is set: a platform without one gets none (CLAUDE.md, 平台缝).
//    os.tmpdir() is the run's own here because leak-guard.cjs loads first (package.json's test script) and moved TMPDIR.
if (process.env.XDG_RUNTIME_DIR) process.env.XDG_RUNTIME_DIR = path.join(os.tmpdir(), 'no-session-runtime')

// + the macOS native pieces trocar ships (T13): the signing helper writes the login keychain, procenv reads another process's
// memory, plutil reads managed preferences — a test injects a runner or a stub, never the committed binary or the real tool
const REAL_TOOLS = new Set(['launchctl', 'systemctl', 'security', 'certutil', 'loginctl', 'trocar-sign-helper', 'procenv', 'plutil', 'reg', 'reg.exe', 'powershell.exe', 'csc.exe'])
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash'])
// words that put another command after them: `sudo launchctl …`, `env X=1 security …`, `if systemctl …; then`
const PREFIXES = new Set(['sudo', 'doas', 'env', 'command', 'exec', 'nice', 'nohup', 'time', 'timeout', 'xargs', 'arch', 'if', 'then', 'else', 'elif', 'do', 'while', 'until', '!'])

const KEY = Symbol.for('trocar.no-real-os')
const refused = [] // { tool, command, message } of every refusal, here or in src/off/exec.mjs, not yet acknowledged
const ledger = { refused, takeRefusals: () => refused.splice(0) }
globalThis[KEY] = ledger

const unquote = (w) => w.replace(/^['"]+|['"]+$/g, '')

/** The words a shell line runs in command position: the first word of each `;` `&&` `|` `$(` … segment, looking through `sudo`,
 *  `env X=1`, `if` and the like. `echo launchctl` yields `echo`; best effort beyond that (`sudo -u bob launchctl` yields `bob`). */
function commandWords(line) {
  const out = []
  for (const segment of String(line).split(/[;&|\n(){}`]/)) {
    const words = segment.trim().split(/\s+/).filter(Boolean).map(unquote)
    for (const w of words) {
      if (/^[A-Za-z_]\w*=/.test(w) || w.startsWith('-') || /^\d+[smhd]?$/.test(w)) continue // VAR=value, a flag, a timeout's number
      out.push(w)
      if (!PREFIXES.has(path.basename(w))) break
    }
  }
  return out
}

/** The OS tools `file args…` would run, as the words that name them: `[]` for a command that is none. `script` is a shell line
 *  (`exec` / `execSync`, or a spawn with `shell` set). */
function realToolsIn(file, args = [], { script = false } = {}) {
  const head = path.basename(String(file))
  let words
  if (script) words = commandWords([file, ...args].join(' '))
  else if (REAL_TOOLS.has(head)) words = [String(file)]
  else if (PREFIXES.has(head)) words = commandWords(args.join(' '))
  else if (SHELLS.has(head)) {
    const c = args.findIndex((a) => /^-[a-z]*c[a-z]*$/.test(a))
    words = c >= 0 && args[c + 1] !== undefined ? commandWords(args[c + 1]) : []
  } else words = []
  return words.filter((w) => REAL_TOOLS.has(path.basename(w)))
}

/** The file `word` names on `PATH` (or as given when it holds a slash): null when it is nowhere. */
function lookupOnPath(word, PATH, cwd) {
  if (word.includes('/')) return path.resolve(cwd || process.cwd(), word)
  for (const dir of String(PATH || '').split(path.delimiter)) {
    if (!dir) continue
    const candidate = path.join(dir, word)
    try { fs.accessSync(candidate, fs.constants.X_OK); return candidate } catch { /* next directory */ }
  }
  return null
}

/** True when `word` resolves, symlinks followed, to a file inside the temp dir (a stub a test wrote on a PATH of its own). */
function isTestStub(word, options) {
  const found = lookupOnPath(word, (options.env || process.env).PATH, options.cwd)
  let real = null
  try { real = found && fs.realpathSync(found) } catch { /* missing: not a stub */ }
  return !!real && real.startsWith(fs.realpathSync(os.tmpdir()) + path.sep)
}

/** Throws ESANDBOX (and records it) when `file args…` would run a real OS tool. */
function guard(name, a) {
  const shellLine = name === 'exec' || name === 'execSync'
  if (typeof a[0] !== 'string') return // the original reports its own error for a call that is malformed
  const args = !shellLine && Array.isArray(a[1]) ? a[1].map(String) : []
  const options = [a[1], a[2]].find((x) => x && typeof x === 'object' && !Array.isArray(x)) || {}
  for (const word of realToolsIn(a[0], args, { script: shellLine || !!options.shell })) {
    if (isTestStub(word, options)) continue
    const message = `refusing to run ${word} for real under npm test (0.1 §3): inject a runner, or put a stub on PATH inside the temp dir`
    refused.push({ tool: word, command: [a[0], ...args].join(' ').slice(0, 200), message })
    throw Object.assign(new Error(message), { code: 'ESANDBOX' })
  }
}

function patch(name) {
  const original = cp[name]
  if (typeof original !== 'function' || original.trocarGuarded) return
  const wrapped = function (...a) { guard(name, a); return original.apply(this, a) }
  Object.defineProperty(wrapped, 'name', { value: name })
  Object.defineProperty(wrapped, 'trocarGuarded', { value: true })
  const custom = original[util.promisify.custom] // exec / execFile resolve to {stdout, stderr}; that function holds the original
  if (custom) Object.defineProperty(wrapped, util.promisify.custom, { value: function (...a) { guard(name, a); return custom.apply(this, a) } })
  cp[name] = wrapped
}
for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync']) patch(name)
syncBuiltinESMExports() // an ESM `import { spawnSync } from 'node:child_process'` reads the patched functions

const inside = (p, root) => p === root || p.startsWith(root + path.sep)
const realOf = (p) => { try { return fs.realpathSync(p) } catch { return p } }
const WIN_ROOTS = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.SystemRoot]
const ROOTS = [...new Set([...(process.platform === 'win32' ? WIN_ROOTS : ['/Applications', '/Library', '/System', '/usr', '/etc', '/private/etc']), os.userInfo().homedir].filter(Boolean))]
const FREE = [...new Set([os.tmpdir(), realOf(os.tmpdir()), process.cwd(), realOf(process.cwd()), path.resolve(__dirname, '..', '..')])] // __dirname: a checkout whose test/helpers is a link

const pathOf = (p) => (typeof p === 'string' ? p : Buffer.isBuffer(p) ? p.toString() : p instanceof URL && p.protocol === 'file:' ? fileURLToPath(p) : null) // anything else (an fd) is not this guard's

/** Throws ESANDBOX (and records it) when `p` is under ROOTS and not in FREE. shortcut: judged on the path as written, so a link in the temp dir that points out of it passes; upgrade if one ever does. */
function guardWrite(name, p) {
  const given = pathOf(p)
  if (given === null) return
  const at = path.resolve(given)
  if (!ROOTS.some((r) => inside(at, r)) || FREE.some((r) => inside(at, r))) return
  const message = `refusing ${name} of ${at} under npm test (0.1 §3): write in a tmpDir(), and give the code under test its roots`
  refused.push({ tool: name, command: at, message })
  throw Object.assign(new Error(message), { code: 'ESANDBOX' })
}
const opensForWrite = (flags) => (typeof flags === 'number' ? (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT)) !== 0 : typeof flags === 'string' && /[wa+]/.test(flags)) // no flags (fs.open(path, callback)): a read
const WRITERS = { writeFile: [0], appendFile: [0], mkdir: [0], mkdtemp: [0], rm: [0], rmdir: [0], unlink: [0], truncate: [0], chown: [0], lchown: [0], chmod: [0], lchmod: [0], utimes: [0], lutimes: [0], rename: [0, 1], copyFile: [1], cp: [1], link: [1], symlink: [1], createWriteStream: [0], open: 'open' }
function patchFs(obj, name, spec, wrap = (g, f) => function (...a) { g(a); return f.apply(this, a) }) {
  const original = obj[name]
  if (typeof original !== 'function') return
  const judge = (a) => { if (spec === 'open') { if (opensForWrite(a[1])) guardWrite(name, a[0]) } else for (const i of spec) guardWrite(name, a[i]) }
  obj[name] = Object.defineProperty(wrap(judge, original), 'name', { value: name })
}
const later = (g, f) => async function (...a) { g(a); return f.apply(this, a) }
for (const [name, spec] of Object.entries(WRITERS)) {
  patchFs(fs, name, spec); patchFs(fs, `${name}Sync`, spec); patchFs(fs.promises, name, spec, later)
}
syncBuiltinESMExports() // fs and fs/promises too

process.on('exit', () => {
  if (!refused.length) return
  const lines = refused.map((r) => `  ${r.command || r.tool}`)
  fs.writeSync(2, `\nno-real-os: ${refused.length} attempt${refused.length === 1 ? '' : 's'} to run a real OS tool or write on the real machine ${refused.length === 1 ? 'was' : 'were'} refused in this process and never acknowledged:\n${lines.join('\n')}\n` +
    '  something ran a real tool, and whatever caught the ESANDBOX error went on as if the tool had failed; the path was not tested.\n' +
    '  inject a runner (run) there, or put a stub on PATH inside the temp dir, or write in a tmpDir(); a test that provokes the refusal on purpose calls takeRefusals() from test/helpers/no-real-os.mjs\n')
  process.exitCode = 1
})

module.exports = { REAL_TOOLS, realToolsIn, commandWords }
