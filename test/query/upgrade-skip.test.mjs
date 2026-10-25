// test/query/upgrade-skip.test.mjs — the upgrade queue's marker (RFC 3.5 §谁执行它「答案文件」 upgrade.skip, 4.3 §4「目录」; 验收 #35).
// A session the upgrade cannot finish: folded whole, its answer files gone, and the tail's temporary path taken by a directory, so
// every tail write fails (no generated session shape leaves the mark null, and a small heap either folds these sessions or dies of
// the heap: measured 2026-10-25, heaps of 13-16 MB). Real workers over a temp HOME, each left to its idle period: the first marks the
// session with its last member; the second does not fold it (its fold log's files untouched); a new member queues it again.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { sessionDir } from '../../src/query/projection.mjs'
import { indexRows, sessionGroups } from '../../src/query/rows.mjs'
import { recordId } from '../../src/collector/core/record/segments.mjs'
import { workerFork } from '../helpers/worker-fork.mjs'
import { within } from '../helpers/bounded.mjs'
import { rawHome } from './raw-home.mjs'

const SEGMENT = '20261025T090000Z'
const line = (n) => JSON.stringify({ ts: `2026-10-25T09:00:0${n}.000Z`, endpoint: '/v1/chat/completions', method: 'POST',
  req_headers: { 'content-type': 'application/json' }, req_body: JSON.stringify({ model: 'm', prompt_cache_key: 'upgrade-skip-1', messages: [{ role: 'user', content: `ask ${n}` }] }),
  resp: { status: 200, kind: 'json', body: { choices: [{ message: { role: 'assistant', content: `answer ${n}` } }] } },
  id: `req_${n}`, ts_request: `2026-10-25T09:00:0${n}.000Z`, is_llm_call: true, capture: 'transparent', host: 'api.example.test', traffic_class: 'llm',
  proc: { pid: 9, exe: '/x/kimi', agent: 'kimi' } })
const append = (home, ...ns) => fs.appendFileSync(path.join(home, 'raw', `${SEGMENT}.ndjson`), ns.map(line).join('\n') + '\n', { mode: 0o600 })
const session = async (home) => { const [[id, ms]] = sessionGroups(await indexRows({ home, errors: [] })); return { id, last: String(ms[ms.length - 1].id) } }
const folds = (d) => Object.fromEntries(fs.readdirSync(d).filter((f) => f.startsWith('fold.')).map((f) => { const s = fs.statSync(path.join(d, f)); return [f, [s.ino, s.size, s.mtimeMs]] }))

// A worker run until `done()` and then until it has said nothing for QUIET ms after its last report (its idle period's background
// work ends with a report: worker.mjs worked()); it must not exit on its own.
const QUIET = 3000
async function run(home, { kick = null, done = () => true } = {}) {
  const w = workerFork(home)
  let last = 0, err = ''
  w.stderr.on('data', (b) => { err += b })
  w.on('message', () => { last = Date.now() })
  const exited = new Promise((ok) => w.on('exit', (code, signal) => ok(`exited (${code ?? signal}): ${err.split('\n').slice(0, 4).join(' / ')}`)))
  if (kick) w.send({ kick })
  try {
    await within(Promise.race([exited.then((m) => assert.fail(m)), (async () => {
      for (;;) { if (last && Date.now() - last >= QUIET && done()) return; await new Promise((ok) => setTimeout(ok, 50)) }
    })()]), 60_000, 'the worker\'s idle period', () => w.kill())
  } finally { w.kill() }
}

test('3.5 #35: a session the upgrade could not finish is marked with its last member and not folded again until a member is added', { timeout: 300_000 }, async () => {
  const home = rawHome('trocar-upskip-')
  append(home, 1, 2)
  const s = await session(home), d = sessionDir(home, s.id), skip = path.join(d, 'upgrade.skip')
  await run(home, { kick: [recordId(SEGMENT, 2)], done: () => fs.existsSync(path.join(d, 'open.main.ndjson')) }) // folded whole
  for (const f of fs.readdirSync(d)) if (/^(head|open)\./.test(f)) fs.unlinkSync(path.join(d, f))
  fs.mkdirSync(path.join(d, 'open.main.ndjson.tmp')) // every tail write fails from here on
  assert.ok(Object.keys(folds(d)).length > 0, 'a fold log, no tail: an upgrade target')

  await run(home)
  assert.equal(fs.readFileSync(skip, 'utf8'), s.last, 'the first worker marked the session with its last member')
  assert.equal(fs.statSync(skip).mode & 0o777, 0o600)

  const before = folds(d)
  await run(home)
  assert.deepEqual(folds(d), before, 'the second worker did not fold the session again')

  append(home, 3)
  const grown = await session(home)
  assert.notEqual(grown.last, s.last)
  await run(home)
  assert.notDeepEqual(folds(d), before, 'the third worker folded the new member')
  assert.equal(fs.readFileSync(skip, 'utf8'), grown.last, 'and marked the session with its new last member')
})
