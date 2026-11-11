// test/query/sidecar-behind.test.mjs — a worker killed with fold-log lines past its last sidecar (4.3 §4 旁索引, 3.5 后台抽取与归约): the
// first new member cuts the log back to what the sidecar covers, so the frontier falls and the answer files are rendered again. No data
// may go with it: the end state is a fold that was never killed, and no answer on disk says less on the way there.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync, gzipSync } from 'node:zlib'
import { runQuery } from '../../src/query/named/index.mjs' // first: the named queries' registry imports session.mjs
import { extendSession, saveIndexes } from '../../src/query/named/session.mjs'
import { openFoldLog } from '../../src/query/fold-log.mjs'
import { openProjection, sessionDir } from '../../src/query/projection.mjs'
import { readHead, CTX_V } from '../../src/query/ctx-files.mjs'
import { indexRows, sessionGroups } from '../../src/query/rows.mjs'
import { drain, within } from '../helpers/bounded.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { bigSession } from './big-session.mjs'

const NO_REAL_OS = fileURLToPath(new URL('../helpers/no-real-os.cjs', import.meta.url))
const at = (rel) => JSON.stringify(new URL(rel, import.meta.url).href)
// The worker's background folding to the end in a process of its own, then killed: the idle save never runs.
const DRIVER = `
await import(${at('../../src/query/named/index.mjs')})
const { extendSession, saveIndexes } = await import(${at('../../src/query/named/session.mjs')})
const { drain } = await import(${at('../helpers/bounded.mjs')})
const [home, id, kill] = [process.argv[1], process.argv[2], process.argv[3] === 'kill']
await drain(() => extendSession({ home, writer: true }, id, 1e9))
if (kill) process.kill(process.pid, 'SIGKILL')
saveIndexes()
process.exit(0)`
async function fold(home, id, kill) {
  const c = spawn(process.execPath, ['--require', NO_REAL_OS, '--input-type=module', '-e', DRIVER, home, id, kill ? 'kill' : 'save'], { stdio: ['ignore', 'ignore', 'pipe'] })
  let err = ''
  c.stderr.on('data', (b) => { err += b })
  const [code, signal] = await within(new Promise((ok) => c.on('close', (...a) => ok(a))), 120_000, 'the fold process', () => c.kill('SIGKILL'))
  assert.ok(kill ? signal === 'SIGKILL' : code === 0, `the fold process failed: ${err.split('\n').slice(0, 6).join(' / ')}`)
}

const homeOf = () => { const home = path.join(tmpDir('trocar-behind-'), '.trocar'); fs.mkdirSync(path.join(home, 'raw'), { recursive: true, mode: 0o700 }); return home }
const answerNames = (home, id) => fs.readdirSync(sessionDir(home, id)).filter((n) => /^(p\d+\.\w+\.ndjson\.gz|open\.\w+\.ndjson)$/.test(n)).sort()
const textOf = (home, id, n) => { const b = fs.readFileSync(path.join(sessionDir(home, id), n)); return (n.endsWith('.gz') ? gunzipSync(b) : b).toString('utf8') }
const filesOf = (home, id) => Object.fromEntries(answerNames(home, id).map((n) => [n, textOf(home, id, n)]))
// what the disk answers: the head's member and step counts, its packs, and the calls every file holds
function saying(home, id, members) {
  const d = readHead(home, id), rid = String(d.mark).replace(/@.*$/, '')
  const calls = new Set()
  for (const n of answerNames(home, id)) for (const l of textOf(home, id, n).split('\n')) if (l.startsWith('{"c":')) calls.add(JSON.parse(l).c.rid)
  return { mark: members.findIndex((r) => String(r.id) === rid) + 1, steps: d.steps, packs: d.packs.length, calls: calls.size, tier: d.tier, statCalls: d.stats.calls, done: d.pending ? d.pending.done : members.findIndex((r) => String(r.id) === rid) + 1 }
}
const atLeast = (now, was, where) => { for (const k of ['tier', 'mark', 'steps', 'packs', 'calls', 'statCalls', 'done']) assert.ok(now[k] >= was[k], `${where}: ${k} fell from ${was[k]} to ${now[k]}`) }

const SIDECARS = ['extract.idx', 'fold.idx']
const sidecarsOf = (home, id) => SIDECARS.map((n) => [n, fs.readFileSync(path.join(sessionDir(home, id), n))])

test('4.3 §4 旁索引: a head of another CTX_V on disk does not stand while the fold is behind: the first slice writes this version\'s', async () => {
  const home = homeOf(), s = bigSession({ home, id: 'big-0000-4a1b-9c2d-000000000003', segment: '20261020T164731Z', growth: 120, compactAt: 6_000 }), { id } = s
  s.append(300)
  await fold(home, id, false)
  const old = sidecarsOf(home, id)
  s.append(600)
  await fold(home, id, true)
  for (const [n, b] of old) fs.writeFileSync(path.join(sessionDir(home, id), n), b)
  const head = path.join(sessionDir(home, id), 'head.json.gz')
  fs.writeFileSync(head, gzipSync(JSON.stringify({ ...readHead(home, id), v: CTX_V - 1 }))) // a release moved CTX_V since it was written
  s.append(1)
  await extendSession({ home, writer: true }, id, 20)
  assert.equal(readHead(home, id).v, CTX_V, 'this version\'s head, while the fold is still behind the files')
})

for (const [axis, asks] of [['background slices alone', false], ['a request between two slices', true]]) {
  test(`4.3 §4 旁索引: killed far past the sidecar, a new member, ${axis}: the end is a fold never killed, and no answer on disk says less`, async () => {
    const home = homeOf(), s = bigSession({ home, id: `big-0000-4a1b-9c2d-00000000000${asks ? 2 : 1}`, segment: '20261020T164731Z', growth: 120, compactAt: 6_000 }), { id } = s // the worker keeps what it wrote of a head by id: one id a test
    s.append(300)
    await fold(home, id, false)
    const old = sidecarsOf(home, id) // what the disk holds when a worker's saves stopped here: more than a request's slice folds lies past them
    s.append(600)
    await fold(home, id, true)
    for (const [n, b] of old) fs.writeFileSync(path.join(sessionDir(home, id), n), b)
    const store = openProjection({ home, key: id, write: false, errors: [] }), log = openFoldLog({ home, key: id, write: false, projection: { id: store.id, bytes: store.bytes } })
    const behind = !!log.saved && log.saved.bytes <= log.frontier
    log.close(); store.close()
    assert.ok(behind, 'the log has lines past the sidecar')
    s.append(1)
    const members = sessionGroups(await indexRows({ home })).get(id), was = saying(home, id, members)
    const check = (where) => atLeast(saying(home, id, members), was, where)
    const f = Object.assign(Object.create(fs), { renameSync: (a, b) => { fs.renameSync(a, b); if (/head|\.gz$|open\./.test(path.basename(b))) check(`after ${path.basename(b)}`) } })
    const ctx = { home, fs: f, writer: true }
    let slices = 0, held = 0
    await drain(async () => {
      const more = await extendSession(ctx, id, 20)
      check(`slice ${++slices}`)
      if (!more || !asks) return more
      const { mark } = await runQuery('session', { id }, ctx)
      check(`the request after slice ${slices}`)
      if (members.findIndex((r) => String(r.id) === String(mark)) + 1 >= was.mark) return true
      held++ // the fold is behind the files: they are the answer
      assert.equal((await runQuery('lane', { id, pack: '0.main' }, ctx)).$text, textOf(home, id, 'p0.main.ndjson.gz'), 'lane --pack is the file on disk')
      assert.equal((await runQuery('lane', { id, tail: 'main' }, ctx)).$text, textOf(home, id, 'open.main.ndjson'), 'lane --tail is the file on disk')
      return true
    })
    assert.equal(held > 0, asks, 'a request came while the fold was behind')
    saveIndexes() // the head a mark alone did not make due (3.5 答案文件): `fold` below ends on the same save
    const other = homeOf()
    fs.cpSync(path.join(home, 'raw'), path.join(other, 'raw'), { recursive: true })
    await fold(other, id, false)
    assert.deepEqual(readHead(home, id), readHead(other, id), 'the head')
    assert.deepEqual(filesOf(home, id), filesOf(other, id), 'every pack and tail')
  })
}
