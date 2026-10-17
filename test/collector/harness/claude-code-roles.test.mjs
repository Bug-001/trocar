// test/collector/harness/claude-code-roles.test.mjs — D51④ (RFC 4.6 R8's Chromium half, 4.9 MA10's unit half): a name-list hit is only a candidate; a
// desktop / Chromium process is trusted by the door that really reaches it. chromiumRole(argv) splits Claude Desktop's and Z-Code Desktop's processes:
// the network service never gets the settings env (proxy mode judges it by the root; the desktop doors the old arch injected went with the overlays);
// another Chromium child gets no layer (`chromium-child`); a process with no
// `--type=` (the CLI, the Desktop-bundled CC) keeps the settings layer. Every verdict goes through the real tracker and registry (G1); the argv shapes are
// the measured ones (ps-split on darwin, splitCommandLine on win32).
import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { createCa } from '../../../src/collector/core/tls/ca.mjs'
import { createRegistry } from '../../../src/collector/core/registry.mjs'
import { createTrustChecker } from '../../../src/collector/core/trust/confirm.mjs'
import { createTracker } from '../../../src/collector/core/tracker.mjs'
import { chromiumRole } from '../../../src/collector/core/trust/chromium.mjs'
import { splitCommandLine } from '../../../src/collector/arch/win32/procinfo.mjs'
import { loadHarnesses } from '../../../src/collector/harness/index.mjs'
import { tmpDir } from '../../helpers/tmp.mjs'
import { SEEDS } from '../../helpers/proc-seeds.mjs'

const ca = createCa()
const ALL = await loadHarnesses()
const START = Date.now() + 60_000 // every file on disk predates the process
const NS = '--type=utility --utility-sub-type=network.mojom.NetworkService'
const CHILDREN = ['--type=utility --utility-sub-type=node.mojom.NodeService', '--type=renderer', '--type=gpu-process']
const HELPER = '/Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper'

function box(home = tmpDir('asight-roles-')) {
  const pem = path.join(home, 'asight-ca.pem'); fs.writeFileSync(pem, ca.certPem)
  const put = (rel, obj) => { const f = path.join(home, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(obj)) }
  return { home, pem, put }
}

/** The real tracker over the real registry. */
async function verdict(b, facts, { agentList = [] } = {}) {
  const r = new EventEmitter()
  r.calls = []
  r.watch = async (pid, v) => { r.calls.push([pid, v.decrypt]) }
  r.unwatch = async () => {}
  r.scan = async () => []
  const tracker = createTracker({ redirector: r, registry: createRegistry(ALL, { agentList }), trust: createTrustChecker({ caCertPem: ca.certPem }), home: b.home, alive: () => false })
  tracker.start()
  r.emit('exec', { pid: 40, ppid: 1, env: null, envRead: false, cwd: null, startedAt: START, source: 'exec', ...facts })
  for (let i = 0; i < 20; i++) await new Promise((res) => setImmediate(res))
  const [row] = tracker.agents()
  assert.ok(row, `${facts.argv.join(' ')}: judged as an agent`)
  return { agent: row.agent, trusted: row.trusted, reason: row.reason, via: row.trustVia, decrypt: r.calls.at(-1)[1] }
}
const mac = (exe, args = '') => ({ os: 'darwin', exe, argv: `${exe} ${args}`.trim().split(/\s+/) })
const win = (exe, args = '') => ({ os: 'win32', exe, argv: splitCommandLine(`"${exe}" ${args}`.trim()) })

test('chromiumRole: the network service, another Chromium child, or no Chromium role at all', () => {
  assert.equal(chromiumRole(mac(HELPER, NS).argv), 'network-service', 'ps-split argv: the flags arrive whole')
  for (const a of CHILDREN) assert.equal(chromiumRole(['x', ...a.split(' ')]), 'child', a)
  assert.equal(chromiumRole(['claude', '-p', 'hi']), null)
  assert.equal(chromiumRole([]), null)
})

test('darwin Claude Helper (network service): the settings CA is not borrowed — no layer, so never trusted by the tracker', async () => {
  const b = box()
  b.put('.claude/settings.json', { env: { NODE_EXTRA_CA_CERTS: b.pem } })
  assert.deepEqual(await verdict(b, mac(HELPER, NS)), { agent: 'claude-code', trusted: false, reason: 'var-missing', via: null, decrypt: false }, 'forwarded, though settings holds the CA')
})

test('another Chromium child is chromium-child, never trusted (darwin with a custom name, win32 claude.exe by its preset name)', async () => {
  const b = box()
  b.put('.claude/settings.json', { env: { NODE_EXTRA_CA_CERTS: b.pem } })
  for (const a of CHILDREN) {
    assert.deepEqual(await verdict(b, mac(HELPER, a), { agentList: [{ harness: 'claude-code', name: 'claude helper' }] }), { agent: 'claude-code', trusted: false, reason: 'chromium-child', via: null, decrypt: false }, `darwin ${a}`)
    assert.deepEqual(await verdict(b, win(String.raw`C:\Users\u\AppData\Local\AnthropicClaude\app-1.0.0\claude.exe`, a)), { agent: 'claude-code', trusted: false, reason: 'chromium-child', via: null, decrypt: false }, `win32 ${a}`)
  }
})

test('a Chromium child is chromium-child whichever harness the name list says it is (one core rule): OpenCode Desktop and DeepSeek Harness children too', async () => {
  const b = box()
  const procs = [
    win(String.raw`C:\Users\u\AppData\Local\Programs\@opencodedesktop\OpenCode.exe`),
    win(String.raw`C:\Users\u\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe`),
    { os: 'darwin', exe: '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness', argv: ['/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness'], argvSplit: true },
  ]
  for (const p of procs) {
    for (const a of CHILDREN) {
      const v = await verdict(b, { ...p, argv: [...p.argv, ...a.split(' ')] })
      assert.deepEqual([v.trusted, v.reason, v.decrypt], [false, 'chromium-child', false], `${p.exe} ${a} (${v.agent})`)
    }
  }
})

test('the Desktop-bundled Claude Code (no --type=) is judged by the settings layer (mac F1)', async () => {
  const spaced = path.join(tmpDir('asight-roles-'), 'Desktop User') // a home with a space in it: ps splits the exe across argv
  fs.mkdirSync(spaced)
  const b = box(spaced)
  const seed = SEEDS.find((s) => /mac claude-code F1/.test(s.source)).exe.replace('/Users/u', '')
  for (const exe of [`${b.home}${seed}`, `/Applications/Claude.app/Contents/Resources${seed}`, `${b.home}/Applications/Claude.app/Contents/Resources${seed}`]) {
    fs.rmSync(path.join(b.home, '.claude'), { recursive: true, force: true })
    const bare = await verdict(b, mac(exe, '--output-format stream-json'))
    assert.deepEqual([bare.agent, bare.trusted, bare.reason], ['claude-code', false, 'var-missing'], `${exe}: no settings, no trust`)
    b.put('.claude/settings.json', { env: { NODE_EXTRA_CA_CERTS: b.pem } })
    const set = await verdict(b, mac(exe, '--output-format stream-json'))
    assert.deepEqual([set.trusted, set.decrypt], [true, true], `${exe}: trusted by its settings`)
    assert.match(set.via, /settings/)
  }
})

test('win32 Claude Desktop: the network service is never trusted by settings.json; claude.exe with no --type= is (win F9)', async () => {
  const b = box()
  b.put('.claude/settings.json', { env: { NODE_EXTRA_CA_CERTS: b.pem } })
  const exe = String.raw`C:\Users\u\AppData\Local\AnthropicClaude\app-1.0.0\claude.exe`
  assert.deepEqual(await verdict(b, win(exe, NS)), { agent: 'claude-code', trusted: false, reason: 'var-missing', via: null, decrypt: false }, 'settings.json is not its door')
  const main = await verdict(b, win(exe))
  assert.deepEqual([main.trusted, main.decrypt], [true, true], 'no --type=: the settings layer')
})
