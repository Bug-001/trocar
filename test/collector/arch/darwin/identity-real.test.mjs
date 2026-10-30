// test/collector/arch/darwin/identity-real.test.mjs — who a process is, from the REAL `ps` and the native `procenv` of a macOS machine (0.1 §3 约定 2 / 3, G3, G7;
// RFC 4.6 「认进程」, 4.9 §5.3; D51; 0.1 §3 约定 2 / 3).
//
// The install shapes of test/helpers/real-procs.mjs are made real (the system's `sleep`, copied under a tmpDir() and started), and each one goes
// both ways a process is judged on darwin: the collector's targeted ask (procinfo factsOfPid → registry.match) and `off`'s table (listProcs →
// matchHarness over the liveness snapshot). The same table is then run once more over the `ps` / `procenv` output the real run printed, replayed by a
// fake runner — the contract the other tests' recorded outputs stand on: one set of assertions, fake and real (约定 2). Facts the real tools give
// are checked for their real shape too (约定 3): the collector's executable is the copied FILE even when argv[0] is a symlink or `ps` cut the path at
// a space (procenv realpaths the path the kernel exec'd), and `off`'s table — which has `ps -Axo pid=,comm=` for a whole machine, not a read per
// process — names the same file through the path the process was started as. No lsof is run: nothing on macOS asks it any more.
//
// The native helper runs for real from a COPY inside the temp dir (0.1 §3: the committed binary is one of the tools no-real-os refuses, for it reads
// another process's memory — a copy on a test's own path is what the rule allows, and this is the one test that wants the real read).
// The copy is re-signed ad hoc (`codesign -s -`): a platform binary copied out of /bin is killed at exec on Apple Silicon (status 137, measured on
// a macOS machine 2026-10-14), and an ad-hoc signature over the same bytes runs. Nothing outside the temp dir is touched: the sandbox HOME holds the
// only agents.json read, the daemon that may be capturing on this machine is never asked, no agent is started.
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { factsOfPid, PS_TIMEOUT_MS } from '../../../../src/collector/arch/darwin/procinfo.mjs'
import { NATIVE, nativePath } from '../../../../src/collector/arch/darwin/native.mjs'
import { listProcs } from '../../../../src/off/proc.mjs'
import { matchHarness } from '../../../helpers/one-harness.mjs'
import { readAgentList, agentListPath } from '../../../../src/off/identity.mjs'
import { loadHarnesses } from '../../../../src/collector/harness/index.mjs'
import { createRegistry, livenessOf } from '../../../../src/collector/core/registry.mjs'
import { hostFormOf } from '../../../../src/collector/core/host-agent.mjs'
import { SLEEP, stageShapes, startShapes, stopAll } from '../../../helpers/real-procs.mjs'
import { tmpDir } from '../../../helpers/tmp.mjs'

const ALL = await loadHarnesses()
const procs = []
after(() => stopAll(procs))

// The one place this file runs a real tool: `ps` and the shipped `procenv` only (execTool refuses a real runner under npm test unless one is injected), and
// every answer is kept in memory — the command lines it holds are this user's, never written anywhere — for the replay below.
const recorded = new Map()
const key = (file, args) => JSON.stringify([file, args])
function realRunner(file, args, opts) {
  if (file !== 'ps' && path.basename(file) !== 'procenv') throw new Error(`identity-real runs ps and the native procenv only, not ${file}`)
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
  const dir = tmpDir('trocar-idreal-')
  const signed = path.join(dir, 'sleep-signed')
  fs.copyFileSync(SLEEP, signed)
  const sign = spawnSync('codesign', ['-s', '-', '-f', signed], { encoding: 'utf8' })
  if (sign.status !== 0) return { skip: `codesign could not re-sign the copy of ${SLEEP} (${String(sign.stderr || sign.error).trim()}), so no copy of it runs here` }
  const trial = spawnSync(signed, ['0'])
  if (trial.status !== 0) return { skip: `the re-signed copy of ${SLEEP} does not run here (status ${trial.status}, signal ${trial.signal})` }
  const home = path.join(dir, 'home')
  const procenv = path.join(dir, NATIVE.procenv) // the shipped helper, run from the temp dir (see the header)
  fs.copyFileSync(nativePath(NATIVE.procenv), procenv)
  fs.chmodSync(procenv, 0o755)
  const staged = stageShapes(path.join(dir, 'u'), signed)
  procs.push(...await startShapes(staged))
  return { home, procenv }
}
const ctx = await setUp()
const skip = ctx.skip || false

// A shape whose copy is no longer running is no process to ask the OS about: this machine SIGKILLs an ad-hoc-signed copy named `claude` under a
// temp directory about a second after it starts (measured 2026-10-18: the `claude*` shapes die, the `Code Helper` ones live), which is a security
// agent on the machine and no fact about trocar. Such a shape is left out with a word about it, and a run where nothing survived is skipped, never
// a green that asserted nothing.
const living = () => procs.filter(({ child }) => child.exitCode === null && child.signalCode === null) // call it after a turn of the loop (see `alive` below)
const killed = () => procs.filter(({ child }) => !(child.exitCode === null && child.signalCode === null)).map(({ shape, child }) => `${shape.label} (${child.signalCode || `exit ${child.exitCode}`})`)

/** The whole table through one runner: every shape that was running throughout, both ways, with the list `agentList` → the wrong answers (empty: all agree). */
async function contract(runner, agentList, expectOf) {
  const reg = createRegistry(ALL, { agentList })
  const liveness = JSON.parse(JSON.stringify(Object.fromEntries(ALL.map((d) => [d.name, livenessOf(d, { agentList })]))))
  const table = await listProcs({ platform: 'darwin', exec: runner })
  const wrong = []
  for (const { shape, pid, child } of procs) {
    const alive = async () => { await new Promise((r) => setImmediate(r)); return child.exitCode === null && child.signalCode === null } // a turn of the loop first: an exit is known only once node has reaped it
    if (!await alive()) continue
    const bad = []
    const want = expectOf(shape)
    const facts = factsOfPid(pid, { exec: runner, psTimeoutMs: PS_TIMEOUT_MS, cache: new Map(), procenvPath: ctx.procenv })
    if (!facts) bad.push(`${shape.label}: ps names no pid ${pid}`)
    else {
      if (facts.exe !== shape.exe) bad.push(`${shape.label}: the collector's exe is ${facts.exe}, the file is ${shape.exe}`)
      if (facts.cwd !== null) bad.push(`${shape.label}: the facts carry a cwd (${facts.cwd}); the door reads it only when a form asks for it`)
      const got = reg.match(facts)
      if (got.agent !== want) bad.push(`${shape.label}: registry.match → ${got.agent} (${got.reason}), want ${want}`)
    }
    const row = table.find((p) => p.pid === pid)
    if (!row) bad.push(`${shape.label}: listProcs has no row for pid ${pid}`)
    else {
      // off's table is `comm`: argv[0] whole — the path the process was started as, which may be a symlink to the file (and /var, whose real path is /private/var)
      const same = (() => { try { return fs.realpathSync(row.exe) === shape.exe } catch { return false } })()
      if (!same) bad.push(`${shape.label}: off's exe is ${row.exe}, which is not the file ${shape.exe}`)
      const off = matchHarness(liveness, row)
      if (off !== want) bad.push(`${shape.label}: matchHarness → ${off}, want ${want}`)
    }
    if (await alive()) wrong.push(...bad) // it died while being asked: what the OS said of it is a zombie's, and no fact about trocar
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

test('real ps / procenv: every install shape is the harness the presets name — the collector and off agree, and the exe is the real file', { skip }, async (t) => {
  assert.ok(procs.length > 0)
  if (!living().length) return t.skip(`this machine killed every copy before it could be asked about: ${killed().join(', ')}`)
  if (killed().length) t.diagnostic(`left out, killed by this machine: ${killed().join(', ')}`)
  assert.deepEqual(await contract(realRunner, [], presets), [])
})

test('real ps / procenv: a name agents.json adds (in a sandbox HOME) is claimed by its harness, both ways', { skip }, async (t) => {
  if (!living().length) return t.skip(`this machine killed every copy: ${killed().join(', ')}`)
  assert.deepEqual(await contract(realRunner, listInHome(ctx.home), listed), [])
})

test('the recorded ps / procenv output, replayed by a fake runner, gives the same answers (one set of assertions, fake and real)', { skip }, async (t) => {
  if (!living().length) return t.skip('nothing survived for the real run to record')
  assert.ok(recorded.has(key('ps', ['-Axo', 'pid=,ppid=,uid=,lstart=,command='])), 'the real run recorded the table')
  assert.ok(recorded.has(key('ps', ['-Axo', 'pid=,comm='])), 'and the executables ask off\'s table makes')
  assert.deepEqual(await contract(replayRunner, [], presets), [])
  assert.deepEqual(await contract(replayRunner, listInHome(ctx.home), listed), [])
})

test('the real ps splits a command line at its spaces; `comm` alone keeps the whole path, and the helper names the file itself', { skip }, (t) => {
  const spaced = living().find((p) => p.shape.file.includes(' '))
  if (!spaced) return t.skip('no copy with a space in its path survived on this machine')
  const of = (col) => spawnSync('ps', ['-p', String(spaced.pid), '-o', col], { encoding: 'utf8' }).stdout.split('\n')[0].trim()
  assert.notEqual(of('args=').split(/\s+/)[0], spaced.shape.run, 'argv[0] as the command line prints it splits at the space')
  assert.equal(of('comm='), spaced.shape.run, '`comm` as the only column is the whole path, spaces and all (the fallback when the helper cannot read the process)')
  assert.notEqual(of('comm='), spaced.shape.exe, 'and it is the path it was started as, not the file: /var is a symlink to /private/var')
  assert.equal(factsOfPid(spaced.pid, { exec: realRunner, cache: new Map(), procenvPath: ctx.procenv }).exe, spaced.shape.exe, 'the helper realpaths the path the kernel exec\'d: the file')
})

// the door names a host program by the same normalizeName the descriptor's hosts.processes is read with. VS Code's extension host is the
// form's host; its plain `Code Helper` (the Chromium network service: VS Code's own traffic, which answers a 407 from http.proxy's credentials) is not.
test('real ps / procenv: an editor helper is the host the darwin forms name, by the one normalized name', { skip }, (t) => {
  const groups = ALL.map((d) => ({ harness: d.name, forms: ((d.proxyMode && d.proxyMode.forms) || []).filter((f) => (f.os || []).includes('darwin')) }))
  const hosted = living().filter(({ shape }) => 'host' in shape)
  assert.ok(hosted.length > 0)
  const wrong = []
  for (const { shape, pid } of hosted) {
    const facts = factsOfPid(pid, { exec: realRunner, psTimeoutMs: PS_TIMEOUT_MS, cache: new Map(), procenvPath: ctx.procenv })
    const got = (hostFormOf(groups, facts) || {}).harness ?? null
    if (got !== shape.host) wrong.push(`${shape.label}: hostFormOf → ${got} (exe ${facts && facts.exe}), want ${shape.host}`)
  }
  assert.deepEqual(wrong, [])
})
