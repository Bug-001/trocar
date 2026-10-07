// test/collector/arch/win32/verdicts.test.mjs — the verdict producer on Windows (RFC 4.8 §5.4 「谁产生判定」, acceptance W76; plan Task 8(v)).
// The redirector's verdict table is filled by `watch(pid, { decrypt, agent })`, and the one that pushes is the tracker. Written down after the Task 8(b) review: on Windows nothing can produce a `decrypt:true` verdict yet.
//   (a) `registry.match` keys on `descriptor.signatures[facts.os]` and no harness has `signatures.win32` (`desc.win32` is not given to `createRegistry`): a real Windows Claude Code is `no-match`;
//   (b) the tracker vetoes every process whose `facts.env === null` (`environ-unreadable`), and every Windows process has `env: null` (4.8 §10.1: no other process's environment is read), so the entry-file and
//       `installed_at` layers that §5.4 and §6.1 name are never asked.
// The table then stays empty and everything is spliced: fail-safe, and no Windows connection is ever decrypted. This file is Task 8(v)'s acceptance, run now and expected to fail: it is `todo` (node:test does not count a
// todo's failure), and the `todo` is taken off when the producer is built (8(v) extends it to all seven harnesses' Windows entries, the plugin marker's tolerance and `facts-update`). A test that only says "todo" with no body
// would never notice the day it starts to pass.
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createWin32Redirector } from '../../../../src/collector/arch/win32/redirector.mjs'
import { matchForm } from '../../../../src/collector/arch/win32/forms.mjs'
import { groupsOf } from '../../../../src/collector/arch/win32/route-plan.mjs'
import { loadHarnesses } from '../../../../src/collector/harness/index.mjs'
import { createRegistry } from '../../../../src/collector/core/registry.mjs'
import { createTracker } from '../../../../src/collector/core/tracker.mjs'
import { createTrustChecker } from '../../../../src/collector/core/trust/confirm.mjs'
import { createCa } from '../../../../src/collector/core/tls/ca.mjs'

const HOME = String.raw`C:\Users\u`
const IMG = {
  ccCli: String.raw`C:\Users\u\AppData\Roaming\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe`,
  ccVscode: String.raw`C:\Users\u\.vscode\extensions\anthropic.claude-code-2.1.289-win32-x64\resources\native-binary\claude.exe`,
  codexApp: String.raw`C:\Users\u\AppData\Local\OpenAI\Codex\bin\0123456789abcdef\codex.exe`,
  node: String.raw`C:\Program Files\nodejs\node.exe`,
}
const DSH_CMD = String.raw`"C:\Program Files\nodejs\node.exe" C:\Users\u\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\bin\dsh.js`

/** What the Windows procinfo gives, with the one field Task 8(v) adds: `envRead: false` says "this OS never reads another process's environment", so `env: null` is the rule here and not a failure to read. */
const facts = (pid, exe, extra = {}) => ({ os: 'win32', pid, ppid: 1, name: exe.split('\\').pop(), exe, argv: [], cmdline: `"${exe}"`, env: null, envError: 'env-unreadable', envRead: false, cwd: null, startedAt: 1000 + pid, startTicks: String(1000 + pid), cmdlineState: 'ok', elevated: false, source: 'exec', ...extra })

const TODO = 'Task 8(v) (note 84 seam 1): registry.match has no Windows signatures and the tracker vetoes `env: null`; nothing produces decrypt:true on Windows yet'

test('W76 the registry the tracker judges by finds the same harness as matchForm for a process of each Windows form', { todo: TODO }, async () => {
  const hs = await loadHarnesses()
  const registry = createRegistry(hs)
  const forms = groupsOf(hs).flatMap((g) => g.forms)
  for (const [pid, exe, extra, harness] of [[10, IMG.ccCli, {}, 'claude-code'], [11, IMG.ccVscode, {}, 'claude-code'], [12, IMG.codexApp, {}, 'codex'], [13, IMG.node, { cmdline: DSH_CMD }, 'deepseek-dsh']]) {
    const f = facts(pid, exe, extra)
    const form = matchForm(forms, f, { home: HOME })
    assert.equal(form.kind, 'form', `matchForm knows ${exe}`)
    assert.equal(registry.match(f).agent, harness, `the registry finds ${harness} for ${exe}, as the redirector's form ${form.id} says`)
  }
})

test('W76 a Windows process started after its entry is judged trusted although its environment is not read, and one started before it is not: the tracker pushes watch(pid, {decrypt}) to the redirector', { todo: TODO }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-verdicts-'))
  try {
    const ca = createCa()
    const pem = path.join(dir, 'asight-ca.pem'); fs.writeFileSync(pem, ca.certPem)
    fs.mkdirSync(path.join(dir, '.claude'))
    fs.writeFileSync(path.join(dir, '.claude', 'settings.json'), JSON.stringify({ env: { NODE_EXTRA_CA_CERTS: pem } })) // the trust entry `on` wrote (4.8 §6.1)
    const T0 = Date.now() // when `on` wrote it: the manifest's installed_at
    const hs = await loadHarnesses()
    const procWatcher = Object.assign(new EventEmitter(), { scan: async () => [], start: async () => true, stop() {}, unreadable: () => [] })
    const redirector = createWin32Redirector({ procWatcher, groups: groupsOf(hs), home: HOME })
    const tracker = createTracker({ redirector, registry: createRegistry(hs), trust: createTrustChecker({ caCertPem: ca.certPem }), home: dir, installedAt: () => T0, alive: () => false })
    tracker.start()
    procWatcher.emit('exec', facts(20, IMG.ccCli, { startedAt: T0 + 5000 }))
    procWatcher.emit('exec', facts(21, IMG.ccCli, { startedAt: T0 - 5000 }))
    await new Promise((r) => setTimeout(r, 50))
    assert.deepEqual([redirector.verdictOf(20), redirector.verdictOf(21)].map((v) => v && v.decrypt), [true, false], 'after the entry: trusted; before it: the entry was not in effect when it started (config-after-start)')
    assert.equal(redirector.verdictOf(20).agent, 'claude-code')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
