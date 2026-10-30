// test/collector/arch/linux/identity-real.test.mjs — who a process is, from the REAL /proc of this Linux machine: the twin of
// test/collector/arch/darwin/identity-real.test.mjs over the same table (test/helpers/real-procs.mjs; 0.1 §3 约定 2 / 3, G3; RFC 4.6 「认进程」; D51;
// 0.1 §3 约定 2 / 3). The system's `sleep`, copied under a tmpDir() into each install shape and started, goes both ways a
// process is judged: the collector's facts (/proc exe, cmdline, environ → registry.match) and `off`'s table (listProcs → harnessesOf, as one answer, over the
// liveness snapshot). /proc has no tool output to record: the fake side of this contract is the synthetic /proc trees the other linux tests build.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { listProcs, readExe, readArgv, readEnviron } from '../../../../src/off/proc.mjs'
import { matchHarness } from '../../../helpers/one-harness.mjs'
import { readAgentList, agentListPath } from '../../../../src/off/identity.mjs'
import { loadHarnesses } from '../../../../src/collector/harness/index.mjs'
import { createRegistry, livenessOf } from '../../../../src/collector/core/registry.mjs'
import { SLEEP, stageShapes, startShapes, stopAll } from '../../../helpers/real-procs.mjs'
import { tmpDir } from '../../../helpers/tmp.mjs'

const ALL = await loadHarnesses()
const procs = []
after(() => stopAll(procs))

const skip = process.platform !== 'linux' && `linux only (this is ${process.platform}): the real /proc contract; darwin runs test/collector/arch/darwin/identity-real.test.mjs`
const dir = skip ? null : tmpDir('trocar-idreal-')
if (!skip) procs.push(...await startShapes(stageShapes(path.join(dir, 'u'), SLEEP)))

async function contract(agentList, expectOf) {
  const reg = createRegistry(ALL, { agentList })
  const liveness = JSON.parse(JSON.stringify(Object.fromEntries(ALL.map((d) => [d.name, livenessOf(d, { agentList })]))))
  const table = await listProcs({ platform: 'linux' })
  const wrong = []
  for (const { shape, pid } of procs) {
    const want = expectOf(shape)
    const facts = { os: 'linux', pid, exe: readExe(pid), argv: readArgv(pid), env: readEnviron(pid) }
    if (facts.exe !== shape.exe) wrong.push(`${shape.label}: /proc/${pid}/exe is ${facts.exe}, the file is ${shape.exe}`)
    const got = reg.match(facts)
    if (got.agent !== want) wrong.push(`${shape.label}: registry.match → ${got.agent} (${got.reason}), want ${want}`)
    const row = table.find((p) => p.pid === pid)
    if (!row) { wrong.push(`${shape.label}: listProcs has no row for pid ${pid}`); continue }
    const off = matchHarness(liveness, row)
    if (off !== want) wrong.push(`${shape.label}: matchHarness → ${off}, want ${want}`)
  }
  return wrong
}

test('real /proc: every install shape is the harness the presets name — the collector and off agree, and the exe is the real file', { skip }, async () => {
  assert.ok(procs.length > 0)
  assert.deepEqual(await contract([], (s) => s.expect), [])
})

test('real /proc: a name agents.json adds (in a sandbox HOME) is claimed by its harness, both ways', { skip }, async () => {
  const home = path.join(dir, 'home')
  fs.mkdirSync(path.dirname(agentListPath(home)), { recursive: true })
  fs.writeFileSync(agentListPath(home), JSON.stringify({ version: 1, agents: [{ harness: 'claude-code', name: 'claude-nightly' }] }))
  const read = readAgentList({ home })
  assert.deepEqual(read.problems, [])
  assert.deepEqual(await contract(read.entries, (s) => (s.listed !== undefined ? s.listed : s.expect)), [])
})
