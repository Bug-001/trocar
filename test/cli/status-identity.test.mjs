// test/cli/status-identity.test.mjs — RFC 1.6 §9.7「名单」, V65 (D51③⑤): `trocar status` reads ~/.trocar/agents.json itself, with or without a daemon, and
// shows per harness the names in effect (with their source), the preset names an `ignore` dropped, the file's problems, and the processes on no list that
// used the harness's door (the `process-unknown` events of this daemon life, folded from flows/). Sandbox HOME, injected process table and control socket (0.1 §3).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { installedHome } from '../off/fixtures/off-ctx.mjs'
import { runStatus, asDaemon, reply, claudeProc } from './fixtures/status-ctx.mjs'
import { validateReceipt } from '../../src/cli/schema.mjs'
import { foldFlows } from '../../src/health/flows.mjs'

const writeList = (home, doc) => fs.writeFileSync(path.join(home, '.trocar', 'agents.json'), JSON.stringify(doc))
function writeFlows(home, recs) {
  const dir = path.join(home, '.trocar', 'collector', 'flows')
  fs.mkdirSync(dir, { recursive: true })
  const ts = new Date().toISOString()
  fs.appendFileSync(path.join(dir, `${ts.slice(0, 10)}.ndjson`), recs.map((r) => JSON.stringify({ ts, ...r }) + '\n').join(''))
}
const unknownEvent = (name, pid, o = {}) => ({ event: 'process-unknown', where: 'engine', harness: 'claude-code', door: 'claude-code.settings', name, wide: false, pid, reason: 'r', ...o })

async function identityOf(s, deps = {}) {
  const r = await runStatus(s, ['--json'], deps)
  const j = JSON.parse(r.text)
  assert.deepEqual(validateReceipt(j), [], r.text) // V9: validateReceipt checks every harnesses[].identity against its shape
  const [first, x] = Object.entries(j.harnesses)[0]
  const broken = { ...j, harnesses: { ...j.harnesses, [first]: { ...x, identity: { ...x.identity, unknown: [{ name: 'y' }] } } } }
  assert.equal(validateReceipt(broken).filter((p) => /identity/.test(p)).length, 1, 'and a broken identity block is a problem')
  return { j, by: Object.fromEntries(Object.entries(j.harnesses).map(([h, v]) => [h, v.identity])), r }
}

test('V65 status --json: the identity block — a good custom item (source custom), a bad one in problems, an ignored preset, the processes on no list — the same with and without a daemon', async () => {
  const s = await installedHome()
  writeList(s.home, { version: 1, agents: [{ harness: 'claude-code', name: 'claude-nightly' }, { harness: 'claude-code', name: 'node' }, { harness: 'codex', name: 'codex', ignore: true }] })
  writeFlows(s.home, [{ event: 'daemon-start', pid: 1 }, unknownEvent('claude-canary', 7001), unknownEvent('claude-canary', 7002), unknownEvent('python', 7003, { wide: true })])
  const procs = async () => [claudeProc(5000, Date.now() + 5000)]
  for (const [label, deps] of [['no daemon', { procs }], ['daemon', { procs, request: asDaemon(reply({ agents: [{ pid: 5000, agent: 'claude-code', trusted: true }] })) }]]) {
    const { j, by } = await identityOf(s, deps)
    const cc = by['claude-code']
    assert.ok(cc, `${label}: claude-code has an identity block`)
    assert.deepEqual([j.agent_list.path, j.agent_list.state], [path.join(s.home, '.trocar', 'agents.json'), 'ok'], label)
    assert.deepEqual(j.agent_list.problems.map((p) => [p.index, p.code]), [[1, 'wide-name-needs-args']], `${label}: the bad item is a problem with its index`)
    assert.ok(!('file' in cc), `${label}: the file is said once, not per harness`)
    assert.deepEqual(cc.names.find((n) => n.name === 'claude-nightly'), { name: 'claude-nightly', source: 'custom' }, label)
    assert.deepEqual(cc.names.find((n) => n.name === 'claude'), { name: 'claude', source: 'preset' }, label)
    assert.ok(!cc.names.some((n) => n.name === 'node'), `${label}: the bad item does not apply`)
    assert.deepEqual(cc.unknown.map((u) => [u.name, u.wide, u.pid, u.door]), [['claude-canary', false, 7002, 'claude-code.settings'], ['python', true, 7003, 'claude-code.settings']], `${label}: one row per name, the newest pid`)
    assert.deepEqual(by.codex.names, [], `${label}: the ignored preset is gone from the names`)
    assert.deepEqual(by.codex.ignored, [{ name: 'codex', source: 'preset' }], `${label}: and listed as ignored`)
    const row = j.harnesses['claude-code'].processes.find((x) => x.pid === 5000)
    assert.equal(row && row.name, 'claude', `${label}: the process row names the name it matched`)
  }
  // §3.5 prints no list of its own: the file, its problems and the processes on no list are the document's (and `doctor`'s findings, 附录 B agent-list-invalid / process-unknown)
  const t = (await runStatus(s, ['claude-code'], { procs })).text
  assert.ok(!/agents\.json/.test(t), t)
})

test('V65 a name the user has since put on the list is no longer said to be on no list; a broken file is said with its state; no file is state absent and no problems', async () => {
  const s = await installedHome()
  writeFlows(s.home, [{ event: 'daemon-start', pid: 1 }, unknownEvent('claude-canary', 7002)])
  let { by, j } = await identityOf(s)
  assert.deepEqual([j.agent_list.state, j.agent_list.problems], ['absent', []])
  assert.deepEqual(by['claude-code'].unknown.map((u) => u.name), ['claude-canary'])
  writeList(s.home, { version: 1, agents: [{ harness: 'claude-code', name: 'claude-canary' }] })
  ;({ by } = await identityOf(s))
  assert.deepEqual(by['claude-code'].unknown, [], 'on the list now: the condition no longer names it')
  fs.writeFileSync(path.join(s.home, '.trocar', 'agents.json'), '{ not json')
  ;({ j } = await identityOf(s))
  assert.equal(j.agent_list.state, 'unparsable')
  assert.deepEqual(j.agent_list.problems.map((p) => [p.index, p.code]), [[null, 'unparsable']])
})

test('R18 V65 status puts a process under a harness by the name list in effect NOW (presets + agents.json, `ignore` applied, as the daemon identifies), not by the manifest\'s ever-growing liveness snapshot — with and without a daemon', async () => {
  const s = await installedHome()
  const procs = async () => [claudeProc(5000, Date.now() + 5000)]
  const pidsOf = (j) => j.harnesses['claude-code'].processes.map((x) => x.pid)
  for (const [label, deps] of [['no daemon', { procs }], ['daemon', { procs, request: asDaemon(reply({ agents: [] })) }]]) {
    assert.ok(pidsOf((await identityOf(s, deps)).j).includes(5000), `${label}: the preset name claude is claude-code's`)
    writeList(s.home, { version: 1, agents: [{ harness: 'claude-code', name: 'claude', ignore: true }] })
    const { j, by } = await identityOf(s, deps)
    assert.deepEqual(by['claude-code'].ignored.map((n) => n.name), ['claude'], label)
    assert.ok(!pidsOf(j).includes(5000), `${label}: an ignored name is no process of the harness — never said captured or waiting for a verdict (the daemon forwards it untouched)`)
    fs.rmSync(path.join(s.home, '.trocar', 'agents.json'))
  }
})

test('fold: process-unknown is a per-(harness, name) fact of this daemon life — not a condition (no ⚠), and a daemon restart clears it', () => {
  const at = (s) => new Date(Date.parse('2026-10-14T12:00:00Z') - s * 1000).toISOString()
  const recs = [{ ts: at(300), event: 'daemon-start', pid: 1 }, { ts: at(200), ...unknownEvent('claude-canary', 7001) }, { ts: at(100), ...unknownEvent('claude-canary', 7002) }]
  const f = foldFlows(recs, { now: Date.parse('2026-10-14T12:00:00Z') })
  assert.deepEqual(f.conditions, [], 'expected: the top bar stays as it was')
  assert.deepEqual(f.unknown_procs.map((u) => [u.harness, u.name, u.pid, u.door, u.wide]), [['claude-code', 'claude-canary', 7002, 'claude-code.settings', false]])
  const g = foldFlows([...recs, { ts: at(0), event: 'daemon-start', pid: 2 }], { now: Date.parse('2026-10-14T12:00:00Z') })
  assert.deepEqual(g.unknown_procs, [], 'a new daemon life starts with none')
})

test('1.6 §9.7: status reads agents.json itself — with no harness installed or named, a broken file is still said (--json agent_list)', async () => {
  const { tmpDir } = await import('../helpers/tmp.mjs')
  const { fakeIo } = await import('./fixtures/on-ctx.mjs')
  const { runStatusCli } = await import('../../src/cli/status.mjs')
  const { down, SOCK } = await import('./fixtures/status-ctx.mjs')
  const home = tmpDir('trocar-list-only-')
  fs.mkdirSync(path.join(home, '.trocar'), { recursive: true })
  fs.writeFileSync(path.join(home, '.trocar', 'agents.json'), '{ not json')
  const parts = { os: 'darwin', harnesses: [], scan: async () => [], match: () => ({ agent: null }), arch: {} }
  const deps = { request: down(), socketPath: SOCK, procs: async () => [], exec: () => ({ status: 0, stdout: '', stderr: '' }), parts, user: 'alice' }
  const human = fakeIo()
  assert.equal(await runStatusCli([], { io: human, home, platform: 'darwin', env: { HOME: home }, deps }), 0, human.stderrText())
  const io = fakeIo()
  await runStatusCli(['--json'], { io, home, platform: 'darwin', env: { HOME: home }, deps })
  const j = JSON.parse(io.stdoutText())
  assert.deepEqual(validateReceipt(j), [])
  assert.deepEqual([j.agent_list.state, j.agent_list.problems.map((p) => p.code)], ['unparsable', ['unparsable']])
})
