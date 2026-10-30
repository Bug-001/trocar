// test/collector/core/identity-presets.test.mjs — the seven harnesses' preset name lists, through the registry the tracker judges by (RFC 4.6 R1,
// 4.8 W3 the name half; D51). Every measured / specified process shape in test/helpers/proc-seeds.mjs, and
// every install variant of it (test/helpers/proc-variants.mjs), is the harness its seed says — the expectation comes from the seed's own source,
// never from the lists under test (0.1 §3 约定 7: no count pinned, no list restated here). The counter-examples name each reason of 4.6's table.
import test from 'node:test'
import assert from 'node:assert/strict'
import { loadHarnesses } from '../../../src/collector/harness/index.mjs'
import { createRegistry } from '../../../src/collector/core/registry.mjs'
import { SEEDS } from '../../helpers/proc-seeds.mjs'
import { variantsOf } from '../../helpers/proc-variants.mjs'

const ALL = await loadHarnesses()
const REG = createRegistry(ALL)
const W = String.raw`C:\Users\u`
const win = (exe, args, more = {}) => ({ os: 'win32', exe, argv: [exe, ...args], env: null, cmdlineState: 'ok', ...more })
const mac = (exe, args) => ({ os: 'darwin', exe, argv: [exe, ...args], env: null })
const lin = (exe, argv, env = new Map()) => ({ os: 'linux', exe, argv, env })
const said = (m) => [m.agent, m.reason, m.harness ?? null]

test('every harness has at least one seed: its name list is tested on a real process shape, not only on its own examples', () => {
  assert.deepEqual(ALL.map((d) => d.name).filter((n) => !SEEDS.some((s) => s.harness === n)), [])
})

test('R1 / W3: every seed, and every install variant of it (prefix, editor dir, case, .exe, (deleted), spaces and CJK, symlinked argv[0], Windows quotes and slashes), is the harness it IS — null: no agent', () => {
  const wrong = []
  let n = 0
  for (const seed of SEEDS) {
    for (const f of [seed, ...variantsOf(seed)]) {
      n++
      const m = REG.match(f)
      if (m.agent !== seed.harness) wrong.push(`${f.variant || 'seed'}: ${f.exe} ${JSON.stringify(f.argv.slice(1))} → ${m.agent} (${m.reason}); the seed says ${seed.harness} [${seed.source}]`)
    }
  }
  assert.ok(n > SEEDS.length, 'the variants ran')
  assert.deepEqual(wrong, [])
})

test('R1: wrappers and helpers are no agent — the reason says which (excluded names its harness; a known name with other arguments is args-mismatch; an unknown name is no-match)', () => {
  const mods = '/usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'
  const rows = [
    // the Node launchers of codex / opencode: node is a name of other harnesses, with other arguments
    [lin('/usr/bin/node', ['node', '/usr/local/bin/codex', 'exec']), [null, 'args-mismatch', null]],
    [lin('/usr/bin/node', ['node', '/usr/lib/node_modules/opencode-ai/bin/opencode']), [null, 'args-mismatch', null]],
    // Claude Code's helpers run under its exe with their own argv[0]
    [lin('/home/u/.local/share/claude/versions/2.1.296', ['rg', '--files']), [null, 'excluded', 'claude-code']],
    [{ ...mac('/Users/u/.local/share/claude/versions/2.1.296', []), argv: ['apply-seccomp', 'x'] }, [null, 'excluded', 'claude-code']],
    // kimi's plugin runner, on every OS (mac plugin-shim F10, win PS-F13)
    [mac('/Users/u/.kimi-code/bin/kimi', ['__plugin_run_node', 'x.js']), [null, 'excluded', 'kimi-code']],
    [win(`${W}\\.kimi-code\\bin\\kimi.exe`, ['__plugin_run_node', 'x.js']), [null, 'excluded', 'kimi-code']],
    [lin('/home/u/.kimi-code/bin/kimi', ['kimi', '__update_download']), [null, 'excluded', 'kimi-code']],
    // dsh's runner and PTC child (test/collector/harness/deepseek-dsh.test.mjs:22-27), Linux and Windows
    [lin('/usr/local/bin/node', ['node', `${mods}/dsh-subprocess-local/lib/runner.js`]), [null, 'args-mismatch', null]],
    [lin('/usr/local/bin/node', ['node', '--max-old-space-size=512', `${mods}/dsh-ptc-runtime-node/lib/process.js`, '--parent', '/usr/local/bin/dsh']), [null, 'excluded', 'deepseek-dsh']],
    [win(String.raw`C:\Program Files\nodejs\node.exe`, ['--max-old-space-size=512', `${W}\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\node_modules\\@deepseek-ai\\dsh-ptc-runtime-node\\lib\\process.js`, '--parent', `${W}\\AppData\\Roaming\\npm\\dsh.cmd`]), [null, 'excluded', 'deepseek-dsh']],
    // names that only look like a harness's
    [lin('/usr/local/bin/codexx', ['codexx']), [null, 'no-match', null]],
    [mac('/usr/local/bin/claude-helper-tool', []), [null, 'no-match', null]],
    // an interpreter with no harness's arguments
    [lin('/usr/bin/node', ['node']), [null, 'args-mismatch', null]],
    [mac('/usr/bin/python3', []), [null, 'args-mismatch', null]],
    [win('C:\\Python312\\python.exe', ['-c', 'print(1)']), [null, 'args-mismatch', null]],
  ]
  for (const [f, want] of rows) assert.deepEqual(said(REG.match(f)), want, `${f.exe} ${JSON.stringify(f.argv)}`)
})

test('W3: a Windows node.exe whose command line is not known yet is pending (re-asked on the next connection), not "no agent"; once it arrives, dsh', () => {
  const node = String.raw`C:\Program Files\nodejs\node.exe`
  for (const state of ['pending', 'cim-backoff']) assert.deepEqual(said(REG.match({ os: 'win32', exe: node, argv: [], env: null, cmdlineState: state })), [null, 'pending', null], state)
  assert.equal(REG.match(win(node, [`${W}\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js`])).agent, 'deepseek-dsh')
})

test('the user\'s list (D51③): a custom item makes a renamed build an agent; ignore drops a preset; replaceAgentList swaps in place (a held match keeps working)', () => {
  const nightly = lin('/opt/claude-nightly/bin/claude-nightly', ['claude-nightly', '-p', 'hi'])
  const codex = lin('/usr/local/bin/codex', ['codex', 'exec'])
  assert.deepEqual(said(REG.match(nightly)), [null, 'no-match', null], 'not on the preset list')
  const reg = createRegistry(ALL, { agentList: [{ harness: 'claude-code', name: 'claude-nightly' }] })
  const { match } = reg
  assert.equal(match(nightly).agent, 'claude-code')
  assert.equal(match(codex).agent, 'codex')
  reg.replaceAgentList([{ harness: 'codex', name: 'codex', ignore: true }])
  assert.equal(match(codex).agent, null, 'the preset codex is ignored — and its exclude items naming it went with it, without an error')
  assert.equal(match(nightly).agent, null, 'the custom item is gone with the old list')
  reg.replaceAgentList([{ harness: 'deepseek-dsh', name: 'node', args: 'my-fork/bin\\.js' }])
  assert.equal(match(lin('/usr/bin/node', ['node', '/opt/my-fork/bin.js'])).agent, 'deepseek-dsh')
})

// ── W76 (moved from the old win32 verdicts.test.mjs, which went with the old win32 collector): measured Windows image paths and command lines ──
// each form's process, as the Windows procinfo gives it (the command line split the helper's way, splitCommandLine), is its harness by the one name list.
import { splitCommandLine } from '../../../src/collector/arch/win32/procinfo.mjs'
const IMG = {
  ccCli: String.raw`C:\Users\u\AppData\Roaming\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe`,
  ccVscode: String.raw`C:\Users\u\.vscode\extensions\anthropic.claude-code-2.1.289-win32-x64\resources\native-binary\claude.exe`,
  ccDesktop: String.raw`C:\Program Files\WindowsApps\Claude_1.0.0.0_x64__abc\app\claude.exe`,
  codexNpm: String.raw`C:\Users\u\AppData\Roaming\npm\node_modules\@openai\codex\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe`,
  codexApp: String.raw`C:\Users\u\AppData\Local\OpenAI\Codex\bin\0123456789abcdef\codex.exe`,
  hermesPy: String.raw`C:\Users\u\AppData\Local\hermes\tools\python-3.12.6\python.exe`,
  kimi: String.raw`C:\Users\u\.kimi-code\bin\kimi.exe`,
  node: String.raw`C:\Program Files\nodejs\node.exe`,
  dshDesktop: String.raw`C:\Users\u\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe`,
  opencode: String.raw`C:\Users\u\AppData\Roaming\npm\node_modules\opencode-ai\bin\opencode.exe`,
  opencodeDesk: String.raw`C:\Users\u\AppData\Local\@opencode-aidesktop\OpenCode.exe`,
  zcode: String.raw`C:\Users\u\AppData\Local\Programs\ZCode\ZCode.exe`,
  svchost: String.raw`C:\Windows\System32\svchost.exe`,
}
const DSH_CMD = String.raw`"C:\Program Files\nodejs\node.exe" C:\Users\u\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\lib\bin.js`
// what `hermes.exe -z …` execs (measured win 2026-10-14): the private python runs the zip appended to the launcher
const HERMES_CMD = String.raw`"C:\Users\u\AppData\Local\hermes\tools\python-3.12.6\python.exe" -I "C:\Users\u\AppData\Local\hermes\bin\hermes.exe" -z "hi"`
const HERMES_RERUN_CMD = String.raw`"C:\Users\u\AppData\Local\hermes\tools\python-3.12.6\python.exe" -I -I -c "import sys, runpy; sys.argv = ['C:\\Users\\u\\AppData\\Local\\hermes\\bin\\hermes.exe', '-z', 'hi']; runpy.run_path('C:\\Users\\u\\AppData\\Local\\hermes\\bin\\hermes.exe', run_name='__main__')"`
const ZCODE_NET_CMD = String.raw`"C:\Users\u\AppData\Local\Programs\ZCode\ZCode.exe" --type=utility --utility-sub-type=network.mojom.NetworkService`
const ZCODE_CMD = String.raw`"C:\Users\u\AppData\Local\Programs\ZCode\ZCode.exe" C:\Users\u\AppData\Local\Programs\ZCode\resources\glm\zcode.cjs app-server --stdio`

/** What the Windows procinfo gives, with its `envRead` field: `envRead: false` says "this OS never reads another process's environment", so `env: null` is the rule here and not a failure to read. */
const winFacts = (pid, exe, extra = {}) => ({ os: 'win32', pid, ppid: 1, name: exe.split('\\').pop(), exe, argv: splitCommandLine(extra.cmdline === undefined ? `"${exe}"` : extra.cmdline), cmdline: `"${exe}"`, env: null, envRead: false, cwd: null, startedAt: 1700000000000 + pid, cmdlineState: 'ok', ...extra })
const one = (name) => ALL.find((d) => d.name === name)

test('W76 the registry finds the harness of a process of each Windows form by its name; a name alone is not enough where the list asks for arguments; one name list for every OS (D51)', () => {
  const rows = [
    [IMG.ccCli, {}, 'claude-code'], [IMG.ccVscode, {}, 'claude-code'], [IMG.ccDesktop, {}, 'claude-code'],
    [IMG.codexNpm, {}, 'codex'], [IMG.codexApp, {}, 'codex'],
    [IMG.hermesPy, { cmdline: HERMES_CMD }, 'hermes'], [IMG.hermesPy, { cmdline: HERMES_RERUN_CMD }, 'hermes'], [IMG.kimi, {}, 'kimi-code'],
    [IMG.node, { cmdline: DSH_CMD }, 'deepseek-dsh'], [IMG.dshDesktop, {}, 'deepseek-dsh'],
    [IMG.opencode, {}, 'opencode'], [IMG.opencodeDesk, {}, 'opencode'],
    [IMG.zcode, { cmdline: ZCODE_CMD }, 'z-code'], [IMG.zcode, { cmdline: ZCODE_NET_CMD }, 'z-code'],
  ]
  for (const [exe, extra, harness] of rows) assert.deepEqual(REG.match(winFacts(10, exe, extra)), { agent: harness, descriptor: one(harness), reason: 'match' }, `${exe} ${extra.cmdline || ''}: the registry finds ${harness}`)
  assert.equal(REG.match(winFacts(11, IMG.svchost)).agent, null, 'a process on no list is no agent')
  assert.deepEqual([REG.match(winFacts(13, IMG.zcode)).agent, REG.match(winFacts(14, IMG.hermesPy)).agent], [null, null], 'the Z-Code GUI itself (no zcode.cjs, no network-service args) and a bare python are no agent')
  assert.equal(REG.match(winFacts(12, IMG.node, { cmdline: null, argv: [], cmdlineState: 'pending' })).agent, null, 'a command line not known yet judges nothing')
  for (const d of ALL) assert.ok(d.processes && !d.signatures, `${d.name}: one name list for every OS (D51), no per-OS signatures`)
})
