// test/collector/agent-list.test.mjs — RFC 4.6 R6, the daemon's half (D51③): the running daemon reads ~/.asight/agents.json at start
// and on every check, swaps the name list in place when the file changed (stat key), re-judges the table and rescans — no restart.
// A broken file is one `agent-list-invalid` failure per file version (D38); a file that reads cleanly again, or is removed, ends the
// condition with `agent-list-ok`; a file that was never there writes nothing. Asserted on flows/ and on the daemon's own verdicts.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startDaemon } from '../../src/collector/daemon.mjs'
import { installCollector } from '../../src/collector/install.mjs'
import { controlRequest } from '../../src/collector/core/control.mjs'
import { createRedirectorClient } from '../../src/collector/arch/linux/redirector-client.mjs'
import { createLinuxRedirector } from '../../src/collector/arch/linux/redirector.mjs'
import cc from '../../src/collector/harness/claude-code.mjs'
import { fakeProc } from './arch/linux/fixtures/fake-proc.mjs'
import { factsOfPid } from '../../src/collector/arch/darwin/procinfo.mjs'
import { factsOfRow } from '../../src/collector/arch/win32/procinfo.mjs'
import { checkRecord } from '../../src/health/codes.mjs'
import { captureHealth } from '../../src/health/read.mjs'
import { tmpDir } from '../helpers/tmp.mjs'

const FAKE = fileURLToPath(new URL('./arch/linux/fixtures/fake-loader.mjs', import.meta.url))
const UID = process.getuid()
const CC_EXE = '/home/u/.local/share/claude/versions/2.1.289'
const NIGHTLY_EXE = '/home/u/.local/bin/claude-nightly'

function fakeArch(p) {
  const clients = []
  const makeClient = () => { const c = createRedirectorClient({ binary: process.execPath, args: [FAKE], env: { ...process.env, ASIGHT_FAKE_LOADER: '1' }, autoHeartbeatMs: 0 }); clients.push(c); return c }
  return { clients, arch: { os: 'linux', createRedirector: () => createLinuxRedirector({ makeClient, procRoot: p.root, uid: UID }) } }
}
async function sandbox() {
  const root = tmpDir('as-al-')
  const home = path.join(root, 'home'); fs.mkdirSync(home)
  const s = { root, home, collector: path.join(home, '.asight', 'collector'), sock: path.join(root, 'run', 'c.sock'), list: path.join(home, '.asight', 'agents.json') }
  await installCollector({ home, env: { HOME: home }, osName: 'none', harnesses: [cc], freePort: async () => 0 })
  return s
}
const start = (s, arch) => startDaemon({ dir: s.collector, socketPath: s.sock, arch, harnesses: [cc], env: { ...process.env, HOME: s.home }, checkMs: 30 })
const req = (s, method, p, body) => controlRequest({ socketPath: s.sock, method, path: p, body })
// a new file version every time: written aside and renamed in (a new inode), as an editor's atomic save does
let seq = 0
function writeList(s, doc, mode = 0o644) {
  const tmp = `${s.list}.tmp-${++seq}`
  fs.writeFileSync(tmp, typeof doc === 'string' ? doc : JSON.stringify(doc), { mode }); fs.chmodSync(tmp, mode)
  fs.renameSync(tmp, s.list)
}
async function until(fn, ms = 4000) { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 20)) } }
const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms)) // several checks at checkMs 30
const flowsOf = (s) => {
  const d = path.join(s.collector, 'flows')
  const lines = fs.existsSync(d) ? fs.readdirSync(d).filter((n) => fs.statSync(path.join(d, n)).isFile()).flatMap((n) => fs.readFileSync(path.join(d, n), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))) : []
  for (const l of lines) assert.deepEqual(checkRecord(l), [], `outside the closed sets: ${JSON.stringify(l)}`)
  return lines
}
const listEvents = (s) => flowsOf(s).filter((l) => l.code === 'agent-list-invalid' || l.event === 'agent-list-ok')
const agentOf = async (s, pid) => ((await req(s, 'GET', '/status')).agents.find((a) => a.pid === pid) || {}).agent ?? null
const spawnFake = async (p, clients, pid, exe, argv) => {
  p.add(pid, { uid: UID, exe, argv, cwd: '/', env: { HOME: '/home/u' }, startTicks: 1 })
  await clients[0].raw({ op: '__emit', ev: 'exec', tgid: pid, pid, comm: path.basename(exe).slice(0, 15), filename: exe, ts_ns: 1 })
}

test('agent-list: a custom name added while the daemon runs is judged as its harness at the next check, without a restart (R6)', async () => {
  const s = await sandbox(); const p = fakeProc(); const { arch, clients } = fakeArch(p)
  const d = await start(s, arch)
  try {
    await spawnFake(p, clients, 4301, NIGHTLY_EXE, ['claude-nightly', '-p', 'hi'])
    await settle()
    assert.equal(await agentOf(s, 4301), null, 'claude-nightly is on no preset list')
    writeList(s, { version: 1, agents: [{ harness: 'claude-code', name: 'claude-nightly' }] })
    assert.equal(await until(async () => agentOf(s, 4301)), 'claude-code')
    assert.deepEqual(listEvents(s), [], 'a good file writes no failure and no ok')
  } finally { await d.stop() }
})

test('agent-list: ignoring a preset name takes a running agent off the table with agent-exit via list (R6)', async () => {
  const s = await sandbox(); const p = fakeProc(); const { arch, clients } = fakeArch(p)
  const d = await start(s, arch)
  try {
    await req(s, 'POST', '/on', {})
    await spawnFake(p, clients, 4302, CC_EXE, ['claude', '-p', 'hi'])
    assert.equal(await until(async () => agentOf(s, 4302)), 'claude-code')
    writeList(s, { version: 1, agents: [{ harness: 'claude-code', name: 'claude', ignore: true }] })
    const exit = await until(async () => flowsOf(s).find((l) => l.event === 'agent-exit' && l.pid === 4302))
    assert.equal(exit.via, 'list')
    assert.equal(await agentOf(s, 4302), null)
  } finally { await d.stop() }
})

test('agent-list: a bad item is one agent-list-invalid with its index and code, the good one applies; fixed → agent-list-ok ends the condition (R6, D38)', async () => {
  const s = await sandbox(); const p = fakeProc(); const { arch, clients } = fakeArch(p)
  const d = await start(s, arch)
  try {
    await spawnFake(p, clients, 4303, NIGHTLY_EXE, ['claude-nightly'])
    writeList(s, { version: 1, agents: [{ harness: 'no-such-harness', name: 'x' }, { harness: 'claude-code', name: 'claude-nightly' }] })
    assert.equal(await until(async () => agentOf(s, 4303)), 'claude-code', 'the good item applies')
    await settle()
    const bad = listEvents(s)
    assert.equal(bad.length, 1, 'one failure for one file version, however many checks see it')
    assert.deepEqual([bad[0].event, bad[0].where, bad[0].code, bad[0].path], ['failure', 'harness', 'agent-list-invalid', s.list])
    assert.deepEqual(bad[0].problems.map((x) => [x.index, x.code]), [[0, 'unknown-harness']])
    assert.ok(captureHealth({ home: path.dirname(s.collector) }).collector.conditions.some((c) => c.code === 'agent-list-invalid'), 'a broken list is a condition until it is fixed')

    writeList(s, { version: 1, agents: [{ harness: 'claude-code', name: 'claude-nightly' }] })
    await until(async () => listEvents(s).some((l) => l.event === 'agent-list-ok'))
    await settle()
    assert.deepEqual(listEvents(s).map((l) => l.event), ['failure', 'agent-list-ok'])
    assert.ok(!captureHealth({ home: path.dirname(s.collector) }).collector.conditions.some((c) => c.code === 'agent-list-invalid'), 'agent-list-ok ends the condition')
    assert.equal(await agentOf(s, 4303), 'claude-code')
  } finally { await d.stop() }
})

test('agent-list: no file writes nothing; an unreadable one is one failure, and removing it is agent-list-ok (R6, D38)', { skip: UID === 0 ? 'root reads a mode-000 file' : false }, async () => {
  const s = await sandbox(); const p = fakeProc(); const { arch } = fakeArch(p)
  const d = await start(s, arch)
  try {
    await settle()
    assert.deepEqual(listEvents(s), [], 'absent: no event at all')
    writeList(s, { version: 1, agents: [] }, 0o000)
    const bad = await until(async () => listEvents(s).find((l) => l.code === 'agent-list-invalid'))
    assert.deepEqual(bad.problems.map((x) => [x.index, x.code]), [[null, 'EACCES']])
    await settle()
    assert.equal(listEvents(s).length, 1)
    fs.rmSync(s.list)
    await until(async () => listEvents(s).some((l) => l.event === 'agent-list-ok'))
    await settle()
    assert.deepEqual(listEvents(s).map((l) => l.event), ['failure', 'agent-list-ok'])
  } finally { await d.stop() }
})

// The daemon -> collector handoff (D51 T7, review of the T7 branch): on darwin and win32 the daemon builds the registry FIRST and hands its own `match` to the
// collector as `identify`. A daemon that dropped it would never start on a real mac or Windows machine (the wiring throws), and one that handed a stand-in would
// name nobody; neither shows in the door's own tests, which inject identify directly. The arch is a recorder over the Linux fake (its os is all the daemon's
// ternary reads); what it records is asked real-shaped facts of a name only agents.json lists, which only the daemon's own registry can know.
for (const os of ['darwin', 'win32']) {
  test(`agent-list: the daemon hands the ${os} collector its own registry's match as identify — a name only agents.json lists is named`, async () => {
    const s = await sandbox(); const p = fakeProc(); const { arch } = fakeArch(p)
    writeList(s, { version: 1, agents: [{ harness: 'claude-code', name: 'claude-nightly' }] })
    const seen = []
    const recorder = { os, createRedirector: (o) => { seen.push(o); return arch.createRedirector(o) } }
    const d = await start(s, recorder)
    try {
      const o = seen.find((x) => x.dir) // the daemon's own construction (loadParts' { env } shell carries no dir)
      assert.ok(o, `the daemon built the ${os} collector with its dir`)
      assert.equal(typeof o.identify, 'function', 'identify is handed in (without it the real wiring throws at daemon start)')
      const exec = (file) => {
        if (file === 'ps') return { status: 0, stdout: `4401     1   ${UID} claude-nightly  Tue Oct 14 10:00:01 2026     claude-nightly -p hi\n`, stderr: '' }
        if (file === 'lsof') return { status: 0, stdout: `p4401\nftxt\nn${NIGHTLY_EXE}\n`, stderr: '' }
        return { status: 1, stdout: '', stderr: 'not in the fake' }
      }
      const facts = os === 'darwin'
        ? factsOfPid(4401, { exec, env: {} })
        : factsOfRow({ pid: 4401, ppid: 1, name: 'claude-nightly.exe', exe: String.raw`C:\Users\u\bin\claude-nightly.exe`, cmdline: 'claude-nightly.exe -p hi', startedAt: 1760000000000, sessionId: 1, integrity: 'medium', tokenDenied: false })
      const m = o.identify(facts)
      assert.deepEqual([m.reason, m.agent], ['match', 'claude-code'], `${os}: the custom name is named — the identify handed in is the daemon's registry, agents.json read`)
    } finally { await d.stop() }
  })
}
