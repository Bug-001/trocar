// no-sysproxy-no-elevation.test.mjs — the D43 boundaries that had no source-level guard (phase-A audit F1; capture safety, 1.6 §8, 4.8 §2.4 「点名也不做」):
//   (a) no code writes the SYSTEM PROXY: the WinINET/WinHTTP write APIs never appear, and no exec call carries the system proxy's key, its values or `netsh`;
//   (b) no code puts a PROXY variable into the LOGIN environment or a system-wide one (login profiles, HKCU\Environment, setx, launchctl setenv), on or off: the agent's own entry (a shim that sets
//       HTTPS_PROXY for the process tree it launches, a block in the agent's own .env) is not this scan's business — it never reaches past the launched tree;
//   (c) no code elevates ITSELF or feeds a password to an elevator: no exec call runs sudo / runas / pkexec / gksudo. The named exception is elevate.mjs (4.8 §2.4, plan Task 14: the machine-level
//       opt-in's UAC launch lives there and nowhere else); it does not exist yet, and when it does, `runas` in ITS calls is allowed and everything else here still is not.
// The old capture is exempt by the shared pinned list (fixtures/old-capture.mjs: its login-env plist is booked by 1.6 §4 and §6). The reading side needs no allowlist for the exec scan — reads go
// through the helper's read verbs (`reg-read`) and doctor's TEXT (findings.mjs), neither of which is an exec call; upstream.mjs's mentions of the registry names are data it hands the helper, not
// args of a tool. Planted counter-examples turn each half red.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { views, callArgs } from './fixtures/write-scan.mjs'
import { isOldCapture } from './fixtures/old-capture.mjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/')
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    return e.isDirectory() ? walk(p) : /\.(m|c)?js|\.ps1$/.test(e.name) ? [p] : []
  })
}
const SOURCES = walk(path.join(ROOT, 'src'))

/** The one file whose calls may carry an elevation word: the machine-level opt-in's UAC launch (4.8 §2.4; plan Task 14, not built yet). Nothing else, and no other word in it. */
const ELEVATE_FILE = 'src/collector/arch/win32/elevate.mjs'
/** APIs that set the system proxy; they have no read use, so they may not appear in new code at all (comments are blanked; strings count). */
const SYS_PROXY_APIS = /InternetSetOption|WinHttpSetDefaultProxy|netsh\s+winhttp/i
/** Words that, in the arguments of a call that RUNS something, mean the system proxy, a login profile, or an elevator. */
const TOOL_ARGS = /internet\s+settings|proxyenable|proxyserver|proxyoverride|autoconfigurl|\bsetx\b|\bsudo\b|\brunas\b|\bpkexec\b|\bgksudo\b|with\s+administrator\s+privileges|\bnetsh\b|\/etc\/environment|\bprofile\.d\b|\.zprofile\b|\.zshenv\b|\.bash_profile\b|launchctl[^'"`]{0,40}setenv/i
/** A proxy variable written into an environment store (HKCU\Environment, a machine Environment hive): the combination is the 必拒, either word alone is not (the PATH opt-in writes HKCU\Environment\Path). */
const ENV_STORE = /environment|launchctl/i
const PROXY_VAR = /(?:https?|all)_proxy|\bno_proxy\b/i
const RUN_CALLS = ['execTool', 'spawnSync', 'execFile', 'exec', 'spawn']

/** The D43 violations of one module: the raw API words, and the exec calls whose arguments carry a forbidden word (or an env store together with a proxy variable). The old capture is exempt as a whole. */
export function violations(file, src) {
  if (isOldCapture(file)) return []
  const { nc } = views(src)
  const out = []
  const api = SYS_PROXY_APIS.exec(nc)
  if (api) out.push(`${file}:1 ${api[0]} (a system-proxy write API)`)
  const wordOf = (text) => {
    const w = TOOL_ARGS.exec(text)
    if (w) return w[0]
    return ENV_STORE.test(text) && PROXY_VAR.test(text) ? 'a proxy variable into an environment store' : null
  }
  for (const args of callArgs(src, RUN_CALLS)) {
    const w = wordOf(args.replace(/\s+/g, ' '))
    if (w && !(file === ELEVATE_FILE && /\brunas\b/i.test(w))) out.push(`${file}:1 ${w} in a call that runs something`)
  }
  return out
}

test('D43 the scan sees the whole of src/ (source and the helper\'s PowerShell), and the call finder finds the calls it judges', () => {
  assert.ok(SOURCES.length > 50, 'the walk is not an empty directory')
  assert.ok(SOURCES.some((f) => rel(f) === 'src/collector/arch/win32/autostart.mjs'), 'the exec-tool user is in the walk')
  assert.ok(SOURCES.some((f) => rel(f).endsWith('.ps1')), 'the PowerShell of the helper and the opt-in scripts is in the walk')
  assert.ok(callArgs("import { spawnSync } from 'node:child_process'\nexport const x = () => spawnSync('reg', ['add'])", RUN_CALLS).length === 1, 'and it sees a bare spawnSync call (asight imports its tools bare; a receiver is not a call this repo makes)')
  assert.ok(callArgs("const v = views(x)\nconst y = overview(x)", RUN_CALLS).length === 0, 'a name that only ends in one of the call names is not a call')
})

test('D43 nothing in src/ writes the system proxy, puts a proxy variable into a login or system-wide environment, or elevates itself', () => {
  const found = SOURCES.flatMap((f) => violations(rel(f), fs.readFileSync(f, 'utf8')))
  assert.deepEqual(found, [])
})

test('D43 planted counter-example: each half is red where it belongs, and the exemptions hold', () => {
  const sys = "import { spawnSync, execTool } from 'node:child_process'\nexport function hold() { spawnSync('netsh', ['winhttp', 'set-proxy', 'proxy=a:80']) }\n"
  assert.match(violations('src/collector/arch/win32/forwarder.mjs', sys).join(), /netsh/)
  assert.match(violations('src/collector/core/x.mjs', "import { spawnSync, execTool } from 'node:child_process'\nexport function p() { execTool('reg', ['add', 'HKCU\\\\...\\\\Internet Settings', '/v', 'ProxyEnable', '/d', 1]) }\n").join(), /internet settings/i)
  assert.match(violations('src/collector/arch/win32/x.mjs', "import { spawnSync, execTool } from 'node:child_process'\nexport function e() { spawnSync('InternetSetOption', []) }\n").join(), /InternetSetOption/)
  assert.match(violations('src/off/win32.mjs', "import { spawnSync, execTool } from 'node:child_process'\nexport function l() { execTool('setx', ['HTTPS_PROXY', 'http://127.0.0.1:1']) }\n").join(), /setx/)
  assert.match(violations('src/off/win32.mjs', "import { spawnSync, execTool } from 'node:child_process'\nexport function l() { execTool('reg', ['add', 'HKCU\\\\Environment', '/v', 'HTTPS_PROXY', '/d', 'x']) }\n").join(), /proxy variable into an environment store/)
  assert.match(violations('src/collector/arch/win32/userpath.mjs', "import { spawnSync, execTool } from 'node:child_process'\nexport function p() { execTool('reg', ['add', 'HKCU\\\\Environment', '/v', 'Path', '/d', 'x']) }\n").join(), /^$/, 'the PATH opt-in writes HKCU\\Environment with no proxy variable: not this scan\'s')
  for (const [why, call, word] of [
    ['sudo', "execTool('sudo', ['asight', 'setup-helper'])"],
    ['RunAs', "spawnSync('powershell', ['-Command', 'Start-Process -Verb RunAs -FilePath x'])"],
    ['a login profile', "execTool('sh', ['-c', 'echo \\'export HTTPS_PROXY=…\\' >> ~/.zprofile'])"],
    ['launchctl setenv', "execTool('launchctl', ['setenv', 'HTTPS_PROXY', 'x'])", 'proxy variable into an environment store'],
  ]) assert.match(violations('src/collector/x.mjs', `import { spawnSync, execTool } from 'node:child_process'\nexport function a() { ${call} }\n`).join(), new RegExp(word || why.split(' ')[0], 'i'), why)
  assert.deepEqual(violations('src/capture/desktop-steer.mjs', sys), [], 'the old capture is exempt as a whole (the shared pinned list)')
  assert.deepEqual(violations('src/off/legacy.mjs', sys), [])
  assert.deepEqual(violations(ELEVATE_FILE, "import { spawnSync, execTool } from 'node:child_process'\nexport function uac() { spawnSync('powershell', ['-Command', 'Start-Process -Verb RunAs -FilePath x']) }\n"), [], 'the one named place may launch UAC (runas); it does not exist yet')
  assert.match(violations(ELEVATE_FILE, "import { spawnSync, execTool } from 'node:child_process'\nexport function no() { execTool('sudo', ['x']) }\n").join(), /sudo/, 'and even there, only runas')
  assert.deepEqual(violations('src/collector/arch/win32/upstream.mjs', "// the reader names the registry values it asks the helper to read\nexport const NAMES = ['ProxyEnable', 'ProxyServer', 'AutoConfigURL', 'ProxyOverride']\nexport const KEY = 'Internet Settings'\n"), [], 'the reading side is data it hands the helper, not an exec call: no allowlist needed for it')
  assert.deepEqual(violations('src/netenv/findings.mjs', "export const cmd = 'Get-ItemProperty HKCU:/…/Internet Settings -Name AutoConfigURL' // doctor's text for the user"), [], 'doctor printing a command for the user is text, not a call')
})
