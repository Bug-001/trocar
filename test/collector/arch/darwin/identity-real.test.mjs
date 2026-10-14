// test/collector/arch/darwin/identity-real.test.mjs — who a process is, from the REAL `ps` and `lsof` of this machine (0.1 §3 约定 2 / 3, G3, G7;
// RFC 4.6 「认进程」, 4.9 §5.3; D51; plan 2026-10-14-d51-name-allowlist §5 「0.1 约定 2 / 3」, §7 末段).
//
// The install shapes of test/helpers/real-procs.mjs are made real (the system's `sleep`, copied under a tmpDir() and started), and each one goes
// both ways a process is judged on darwin: the collector's targeted ask (procinfo factsOfPid → registry.match) and `off`'s table (listProcs →
// matchHarness over the liveness snapshot). The same table is then run once more over the `ps` / `lsof` output the real run printed, replayed by a
// fake runner — the contract the other tests' recorded outputs stand on: one set of assertions, fake and real (约定 2). Facts the real tools give
// are checked for their real shape too (约定 3): the executable is the copied file even when argv[0] is a symlink or `ps` cut the path at a space.
//
// The copy is re-signed ad hoc (`codesign -s -`): a platform binary copied out of /bin is killed at exec on Apple Silicon (status 137, measured on
// a macOS machine 2026-10-14), and an ad-hoc signature over the same bytes runs. Nothing outside the temp dir is touched: the sandbox HOME holds the
// only agents.json read, the daemon that may be capturing on this machine is never asked, no agent is started.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { factsOfPid, PS_TIMEOUT_MS } from '../../../../src/collector/arch/darwin/procinfo.mjs'
import { listProcs } from '../../../../src/off/proc.mjs'
import { matchHarness } from '../../../helpers/one-harness.mjs'
import { readAgentList, agentListPath } from '../../../../src/off/identity.mjs'
import { loadHarnesses } from '../../../../src/collector/harness/index.mjs'
import { createRegistry, livenessOf } from '../../../../src/collector/core/registry.mjs'
import { SLEEP, stageShapes, startShapes, stopAll } from '../../../helpers/real-procs.mjs'
import { tmpDir } from '../../../helpers/tmp.mjs'

const ALL = await loadHarnesses()
const procs = []
after(() => stopAll(procs))

// The one place this file runs a real tool: `ps` and `lsof` only (execTool refuses a real runner under npm test unless one is injected), and
// every answer is kept in memory — the command lines it holds are this user's, never written anywhere — for the replay below.
const recorded = new Map()
const key = (file, args) => JSON.stringify([file, args])
function realRunner(file, args, opts) {
  if (file !== 'ps' && file !== 'lsof') throw new Error(`identity-real runs ps and lsof only, not ${file}`)
  const r = spawnSync(file, args, opts)
  recorded.set(key(file, args), { status: r.status, stdout: r.stdout, stderr: r.stderr })
  return r
}
function replayRunner(file, args) {
  const r = recorded.get(key(file, args))
  if (!r) throw new Error(`the real run printed nothing for ${file} ${args.join(' ')}: the replay asks what the real run did not`)
  return r
}

async function setUp() {
  if (process.platform !== 'darwin') return { skip: `darwin only (this is ${process.platform}): the real ps / lsof contract; linux runs test/collector/arch/linux/identity-real.test.mjs` }
  const dir = tmpDir('asight-idreal-')
  const signed = path.join(dir, 'sleep-signed')
  fs.copyFileSync(SLEEP, signed)
  const sign = spawnSync('codesign', ['-s', '-', '-f', signed], { encoding: 'utf8' })
  if (sign.status !== 0) return { skip: `codesign could not re-sign the copy of ${SLEEP} (${String(sign.stderr || sign.error).trim()}), so no copy of it runs here` }
  const trial = spawnSync(signed, ['0'])
  if (trial.status !== 0) return { skip: `the re-signed copy of ${SLEEP} does not run here (status ${trial.status}, signal ${trial.signal})` }
  const home = path.join(dir, 'home')
  const staged = stageShapes(path.join(dir, 'u'), signed)
  procs.push(...await startShapes(staged))
  return { home }
}
const ctx = await setUp()
const skip = ctx.skip || false

/** The whole table through one runner: every shape, both ways, with the list `agentList` → the wrong answers (empty: all agree). */
async function contract(runner, agentList, expectOf) {
  const reg = createRegistry(ALL, { agentList })
  const liveness = JSON.parse(JSON.stringify(Object.fromEntries(ALL.map((d) => [d.name, livenessOf(d, { agentList })]))))
  const table = await listProcs({ platform: 'darwin', exec: runner })
  const wrong = []
  for (const { shape, pid } of procs) {
    const want = expectOf(shape)
    const facts = factsOfPid(pid, { exec: runner, psTimeoutMs: PS_TIMEOUT_MS })
    if (!facts) { wrong.push(`${shape.label}: ps names no pid ${pid}`); continue }
    if (facts.exe !== shape.exe) wrong.push(`${shape.label}: the collector's exe is ${facts.exe}, the file is ${shape.exe}`)
    const got = reg.match(facts)
    if (got.agent !== want) wrong.push(`${shape.label}: registry.match → ${got.agent} (${got.reason}), want ${want}`)
    const row = table.find((p) => p.pid === pid)
    if (!row) { wrong.push(`${shape.label}: listProcs has no row for pid ${pid}`); continue }
    if (row.exe !== shape.exe) wrong.push(`${shape.label}: off's exe is ${row.exe}, the file is ${shape.exe}`)
    const off = matchHarness(liveness, row)
    if (off !== want) wrong.push(`${shape.label}: matchHarness → ${off}, want ${want}`)
  }
  return wrong
}

const presets = (s) => s.expect
const listed = (s) => (s.listed !== undefined ? s.listed : s.expect)
function listInHome(home) {
  fs.mkdirSync(path.dirname(agentListPath(home)), { recursive: true })
  fs.writeFileSync(agentListPath(home), JSON.stringify({ version: 1, agents: [{ harness: 'claude-code', name: 'claude-nightly' }] }))
  const read = readAgentList({ home })
  assert.deepEqual(read.problems, [], 'the sandbox agents.json reads clean')
  return read.entries
}

test('real ps / lsof: every install shape is the harness the presets name — the collector and off agree, and the exe is the real file', { skip }, async () => {
  assert.ok(procs.length > 0)
  assert.deepEqual(await contract(realRunner, [], presets), [])
})

test('real ps / lsof: a name agents.json adds (in a sandbox HOME) is claimed by its harness, both ways', { skip }, async () => {
  assert.deepEqual(await contract(realRunner, listInHome(ctx.home), listed), [])
})

test('the recorded ps / lsof output, replayed by a fake runner, gives the same answers (one set of assertions, fake and real)', { skip }, async () => {
  assert.ok(recorded.has(key('ps', ['-Axo', 'pid=,ppid=,uid=,lstart=,command='])), 'the real run recorded the table')
  assert.deepEqual(await contract(replayRunner, [], presets), [])
  assert.deepEqual(await contract(replayRunner, listInHome(ctx.home), listed), [])
})

test('the real ps cuts a command line at its spaces; lsof still names the whole path (why the exe comes from lsof)', { skip }, () => {
  const spaced = procs.find((p) => p.shape.file.includes(' '))
  const ps = spawnSync('ps', ['-p', String(spaced.pid), '-o', 'args='], { encoding: 'utf8' }).stdout.trim()
  assert.notEqual(ps.split(/\s+/)[0], spaced.shape.exe, 'argv[0] as ps prints it is not the file')
  assert.equal(factsOfPid(spaced.pid, { exec: realRunner }).exe, spaced.shape.exe)
})
