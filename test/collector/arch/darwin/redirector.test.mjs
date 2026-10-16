// test/collector/arch/darwin/redirector.test.mjs — the macOS Redirector as D47 wrote it (RFC 4.9 §1 · §5): the ENGINE's per-group doors are the only proxy, identity is read
// from the socket at accept time (a targeted ownerOfSocket + the pid's targeted facts), and the doors' lifecycle is attach/detach. Nothing here runs macOS: the owner answers and
// the facts come from injected runners, the doors are a recorder, the entries are a recorder. The harness files' real darwin data is used for the forms (arch/ never imports
// harness/; a test may, to pin the rule to the real data), so a form whose path or command line is changed in the data changes what this file sees.
// The acceptance cells this file carries: W16 (who the connection is, whether it is decrypted — the accept-time identity), W72's lookup half (the upstream and its bypass table),
// W12's order (the doors before the entries), and audit F7 (an off group nobody carries opens no door at all).
import test from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import tls from 'node:tls'
import { createDarwinRedirector } from '../../../../src/collector/arch/darwin/redirector.mjs'
import { groupsOf } from '../../../../src/collector/arch/darwin/route-plan.mjs'
import { createEngine } from '../../../../src/collector/core/engine/engine.mjs'
import { createCa, loadCa } from '../../../../src/collector/core/tls/ca.mjs'
import { createLeafIssuer } from '../../../../src/collector/core/tls/leaf.mjs'
import { within, closeWithin } from '../../../helpers/bounded.mjs'
import claudeCode from '../../../../src/collector/harness/darwin/claude-code.mjs'
import codex from '../../../../src/collector/harness/darwin/codex.mjs'
import deepseekDsh from '../../../../src/collector/harness/darwin/deepseek-dsh.mjs'
import zCode from '../../../../src/collector/harness/darwin/z-code.mjs'
import { loadHarnesses } from '../../../../src/collector/harness/index.mjs'
import { createRegistry } from '../../../../src/collector/core/registry.mjs'

const GROUPS = groupsOf([{ name: 'claude-code', darwin: claudeCode }, { name: 'codex', darwin: codex }, { name: 'deepseek-dsh', darwin: deepseekDsh }, { name: 'z-code', darwin: zCode }])
const HOME = '/Users/u'
const ID = createRegistry(await loadHarnesses()).match // the D51 name list the daemon hands the door (identify)
const ON = () => true // every harness's desired state is on
const IMG = {
  ccCli: '/Users/u/.npm-global/lib/node_modules/@anthropic-ai/claude-code/bin/claude',
  ccVscode: '/Users/u/.vscode/extensions/anthropic.claude-code-2.1.292-darwin-arm64/resources/native-binary/claude',
  ccElsewhere: '/Volumes/tools/claude/claude',
  codexNpm: '/Users/u/.npm-global/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex',
  node: '/usr/local/bin/node',
  helperUtility: '/Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper',
  syslogd: '/usr/libexec/syslogd',
}
const DSH_CMD = '/usr/local/bin/node /Users/u/.npm-global/lib/node_modules/@deepseek-ai/dsh/bin/dsh.js'
const ZCODE_CMD = '/Applications/ZCode.app/Contents/MacOS/ZCode /Applications/ZCode.app/Contents/Resources/glm/zcode.cjs app-server --stdio'

/** What procinfo's targeted ask carries (the fields the redirector reads, and the ones around them): the darwin ProcFacts contract, `envRead:false` included. */
const facts = (pid, exe, extra = {}) => ({ os: 'darwin', pid, ppid: 1, name: exe.split('/').pop(), exe, argv: String(extra.cmdline ?? exe).split(/\s+/), cmdline: exe, env: null, envRead: false, cwd: null, startedAt: 1000 + pid, startTicks: String(1000 + pid), sessionId: null, integrity: null, tokenDenied: false, elevated: false, elevationInferred: false, cmdlineState: 'ok', source: 'accept', ...extra })

/** The facts store the test fills and factsOf answers from: the pid's facts as the targeted ask would give them. */
const factsStore = (rows = new Map()) => { const f = (pid) => (rows.has(pid) ? rows.get(pid) : null); f.rows = rows; return f }

/** The doors as a recorder: what was opened and closed, in order. */
const doorsLog = (log, { openResult = null } = {}) => {
  const opened = []
  const closed = []
  return {
    opened, closed,
    open: async (list) => { log.push('doors'); opened.push(list.map(({ id, port, auth, token }) => ({ id, port, auth, token: token ? '…' : null }))); if (openResult) return openResult(list); return list.map((x) => ({ [x.id]: x.port })) },
    close: async (ids) => { log.push('close'); closed.push([...ids]) },
  }
}
/** The proxy-entry writer: what it was asked for, in order with the doors' calls; `fail` makes the n-th write throw (a crash between the doors and the entries). */
function entriesLog(log, { writeResult = null, throwOnWrite = 0 } = {}) {
  let writes = 0
  const e = {
    written: [], undone: [], checked: [],
    async write(list) { log.push('write'); writes++; e.written.push(list); if (writes === throwOnWrite) throw new Error('crashed'); return writeResult ? writeResult(list) : list.map((x) => ({ g: x.g, ok: true })) },
    async undo(list) { log.push('undo'); e.undone.push(list); return list.map((x) => ({ g: x.g, ok: true })) },
    async check(list) { e.checked.push(list); return list.map((x) => ({ g: x.g, ok: true })) },
  }
  return e
}

const made = (over = {}) => {
  const store = factsStore()
  const r = createDarwinRedirector({ groups: GROUPS, identify: ID, isOn: ON, factsOf: store, verdictWaitMs: 60, ...over })
  return { r, store }
}
const collect = (r, names) => { const got = []; for (const n of names) r.on(n, (x) => got.push([n, x])); return got }
// the verdict wait's timer is unref'd by design (a draining daemon must not be held alive by a lookup waiting on a judge that will never
// answer); a bare test process has no ref'd handles, so the loop would resolve under the wait — every wait holds the loop alive for itself
const withAliveLoop = async (fn) => {
  const keepAlive = setInterval(() => {}, 1 << 30)
  try { return await fn() } finally { clearInterval(keepAlive) }
}

// ---------- the verdict table (4.8 §5.4) and the seam the tracker judges on ----------

test('watch and unwatch are the tracker\'s verdict table (4.8 §5.4): decrypt only when the verdict says exactly true, nothing for a process it has not judged', () => {
  const { r } = made()
  assert.equal(r.verdictOf(10), null)
  r.watch(10, { decrypt: true, agent: 'claude-code' }); r.watch(11, { decrypt: false, agent: 'claude-code' }); r.watch(12, { decrypt: 'yes' }); r.watch(13, undefined)
  assert.deepEqual([10, 11, 12, 13].map((p) => r.verdictOf(p).decrypt), [true, false, false, false], 'a verdict that is not the boolean true is not trust')
  r.unwatch(10)
  assert.equal(r.verdictOf(10), null)
  assert.doesNotThrow(() => r.unwatch(404))
})

test('start() has nothing to wait for (no helper, no watcher — D47 deleted the scan); helperInfo() and expectedProto say what daemon.ensureReady compares; close() is a no-op', async () => {
  const { r } = made()
  assert.deepEqual(r.helperInfo(), { pid: null, proto: null, build: null }, 'before start there is nothing to say')
  assert.deepEqual(await r.start(), { pid: null, proto: null, build: null })
  assert.equal(r.expectedProto, null)
  assert.equal(r.heartbeat(), undefined, 'a heartbeat gates nothing here')
  await r.close()
})

test('the redirector asks for what it needs: the groups (the rest — ownerOf, factsOf, doors — are optional seams, their absence answered fail-safe)', () => {
  assert.throws(() => createDarwinRedirector({}), /needs the groups/)
})

