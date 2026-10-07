// test/helpers/no-real-os.cjs — `--require` preload for `npm test`: no test process runs a real launchctl / systemctl / security /
// certutil / loginctl.
//
// 0.1 §3 「不碰真实机器」: the author's Mac runs the old capture while the tests run, and the user's real launchctl, systemctl,
// security and certutil are one forgotten injected runner away. Three layers, because a rule that only the new code's own helper
// honours protects nothing from the code that does not use the helper:
//   1. ASIGHT_TEST_SANDBOX=1, set here and inherited by every child a test starts. src/off/exec.mjs (`execTool`, the one way new
//      code runs an OS tool) reads it and refuses a real tool: a stub inside the temp dir, or an injected runner, is all it runs.
//   2. `node:child_process` is wrapped (spawn, spawnSync, execFile, execFileSync, exec, execSync, and the promisified exec /
//      execFile): a command that is one of those five tools, or that a `sudo` / `env` / `sh -c` line puts in command position, is
//      refused with code ESANDBOX unless it resolves (symlinks followed) to a file inside the temp dir. This is what catches the old
//      capture's default runners (src/capture/*, src/collector/arch/linux/*) when a test forgot to inject one, and a stray direct
//      `spawnSync('launchctl')` anywhere. The patch is seen by later `import { spawnSync } from 'node:child_process'`.
//   3. Every refusal is written to a ledger (`globalThis[Symbol.for('asight.no-real-os')].refused`). A test process that ends with a
//      refusal nobody acknowledged (`takeRefusals()` in test/helpers/no-real-os.mjs) exits 1 and names it: a caller that catches
//      ESANDBOX as "the tool failed" no longer turns a path it never ran into a green test.
// Load it with `--require` like the other preloads; the test files' children inherit the variable (not the wrapper: a child that
// must be guarded runs the same preload, or relies on layer 1). Guard: test/helpers/no-real-os.test.mjs, test/off/exec.test.mjs.
'use strict'
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const util = require('node:util')
const cp = require('node:child_process')
const { syncBuiltinESMExports } = require('node:module')

process.env.ASIGHT_TEST_SANDBOX = '1'
// the VPN software's control socket, pinned to a place nothing listens (0.1 §3 「Clash 用 ASIGHT_MIHOMO_SOCK」): a command a test starts as a child (`asight status`, `asight doctor`) looks at the VPN software
// (1.6 §6) and, without the pin, would ask the developer's own mihomo. A test that wants a core sets the variable itself; src/netenv/clash.mjs and src/capture/desktop-steer.mjs read it before anything else.
process.env.ASIGHT_MIHOMO_SOCK = path.join(fs.realpathSync(os.tmpdir()), 'asight-test-no-mihomo.sock')

const REAL_TOOLS = new Set(['launchctl', 'systemctl', 'security', 'certutil', 'loginctl'])
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash'])
// words that put another command after them: `sudo launchctl …`, `env X=1 security …`, `if systemctl …; then`
const PREFIXES = new Set(['sudo', 'doas', 'env', 'command', 'exec', 'nice', 'nohup', 'time', 'timeout', 'xargs', 'arch', 'if', 'then', 'else', 'elif', 'do', 'while', 'until', '!'])

const KEY = Symbol.for('asight.no-real-os')
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
  if (typeof original !== 'function' || original.asightGuarded) return
  const wrapped = function (...a) { guard(name, a); return original.apply(this, a) }
  Object.defineProperty(wrapped, 'name', { value: name })
  Object.defineProperty(wrapped, 'asightGuarded', { value: true })
  const custom = original[util.promisify.custom] // exec / execFile resolve to {stdout, stderr}; that function holds the original
  if (custom) Object.defineProperty(wrapped, util.promisify.custom, { value: function (...a) { guard(name, a); return custom.apply(this, a) } })
  cp[name] = wrapped
}
for (const name of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync']) patch(name)
syncBuiltinESMExports() // an ESM `import { spawnSync } from 'node:child_process'` reads the patched functions

process.on('exit', () => {
  if (!refused.length) return
  const lines = refused.map((r) => `  ${r.command || r.tool}`)
  fs.writeSync(2, `\nno-real-os: ${refused.length} attempt${refused.length === 1 ? '' : 's'} to run a real OS tool ${refused.length === 1 ? 'was' : 'were'} refused in this process and never acknowledged:\n${lines.join('\n')}\n` +
    '  something ran a real tool, and whatever caught the ESANDBOX error went on as if the tool had failed; the path was not tested.\n' +
    '  inject a runner (run) there, or put a stub on PATH inside the temp dir; a test that provokes the refusal on purpose calls takeRefusals() from test/helpers/no-real-os.mjs\n')
  process.exitCode = 1
})

module.exports = { REAL_TOOLS, realToolsIn, commandWords }
