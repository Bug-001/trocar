// test/query/ctx-packs.test.mjs — `lane --pack` / `lane --tail` and their answer files ctx/<k>/p<n>.<part>.ndjson.gz and
// open.<part>.ndjson (RFC 3.5 §会话读, §谁执行它「答案文件」; 验收 #33 · #34 · #35). Generated sessions on the three wire shapes, ≥ 1,600
// members (≥ 3 sealed packs), compactions, subagent lanes and late calls. Folds run in child processes that drive the worker's own
// background slices (extendSession with the writer); the worker answers through the real service; the local path is runQuery.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { gunzipSync, gzipSync, brotliDecompressSync } from 'node:zlib'
import { createQueryService } from '../../src/query/service.mjs'
import { runQuery } from '../../src/query/named/index.mjs'
import { sessionDir } from '../../src/query/projection.mjs'
import { workerFork } from '../helpers/worker-fork.mjs'
import { within } from '../helpers/bounded.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { bigSession, rng } from './big-session.mjs'

const NO_REAL_OS = fileURLToPath(new URL('../helpers/no-real-os.cjs', import.meta.url))
const at = (p) => JSON.stringify(new URL(p, import.meta.url).href)
const SHAPE = { subLanes: 3, late: 4, subEvery: 4, compactAt: 20_000, growth: 1_000 }
const CALLS = 1_700
// 3.5 §会话读: the lines' closed sets
const HEAD = ['schema', 'command', 'ok', 'errors', 'v', 'id']
const STEP = ['rid', 'lane', 'i', 'parent', 'ops', 'reply', 'attrs', 'detail', 'events']
const DEF = ['bid', 'fh', 'ref', 'sec', 'role', 'kind', 'label', 'name', 'mcp', 'cc', 'ff', 'head', 'preview', 'chars', 'bytes', 'resKey', 'r', 'unaddressable', 'inline']
const REC = ['id', 'ts_request', 'is_llm_call', 'response']
const ERR = ['where', 'code', 'reason']

// The worker's background in a process of its own: slices of `ms` (0: one slice that does everything), an idle save at seeded
// slices, SIGKILL after slice `kill` (0: never).
const DRIVER = `
await import(${at('../../src/query/named/index.mjs')})
const { extendSession, saveIndexes } = await import(${at('../../src/query/named/session.mjs')})
const { rng } = await import(${at('./big-session.mjs')})
const [home, id, ms, kill, seed] = [process.argv[1], process.argv[2], Number(process.argv[3]), Number(process.argv[4]), Number(process.argv[5])]
const r = rng(seed)
let k = 0
while (await extendSession({ home, writer: true }, id, ms ? 1 + r() * ms : 1e9)) {
  if (r() < 0.2) saveIndexes()
  if (++k === kill) process.kill(process.pid, 'SIGKILL')
  await new Promise((ok) => setImmediate(ok))
}
saveIndexes()`
async function drive(home, id, { ms = 0, kill = 0, seed = 1 } = {}) {
  const c = spawn(process.execPath, ['--require', NO_REAL_OS, '--input-type=module', '-e', DRIVER, home, id, String(ms), String(kill), String(seed)], { stdio: ['ignore', 'pipe', 'pipe'] })
  let err = ''
  c.stderr.on('data', (b) => { err += b })
  const [code, signal] = await within(new Promise((ok) => c.on('close', (...a) => ok(a))), 240_000, 'the fold process', () => c.kill('SIGKILL'))
  assert.ok(code === 0 || (kill && signal === 'SIGKILL'), `the fold process failed: ${err.split('\n').slice(0, 6).join(' / ')}`)
}

const homeOf = () => { const home = path.join(tmpDir('trocar-packs-'), '.trocar'); fs.mkdirSync(path.join(home, 'raw'), { recursive: true, mode: 0o700 }); return home }
const sessionIn = (home, wire) => { const s = bigSession({ home, wire, ...SHAPE }); s.append(CALLS); return s.id }
// home X per wire: folded in one slice
const oneShot = new Map()
const folded = (wire) => {
  if (!oneShot.has(wire)) oneShot.set(wire, (async () => { const home = homeOf(), id = sessionIn(home, wire); await drive(home, id); return { home, id } })())
  return oneShot.get(wire)
}
// home Y per wire: the same session folded in small random slices, the process killed twice at seeded slices, then resumed to the end
const sliced = new Map()
const incremental = (wire) => {
  if (!sliced.has(wire)) {
    sliced.set(wire, (async () => {
      const home = homeOf(), id = sessionIn(home, wire), r = rng(wire.length * 31)
      await drive(home, id, { ms: 6, kill: 20 + Math.floor(r() * 60), seed: 2 })
      await drive(home, id, { ms: 6, kill: 30 + Math.floor(r() * 90), seed: 3 })
      await drive(home, id, { ms: 6, seed: 4 })
      return { home, id }
    })())
  }
  return sliced.get(wire)
}

const dirOf = (h) => sessionDir(h.home, h.id)
const packNames = (h) => fs.readdirSync(dirOf(h)).filter((f) => /^p\d+\.(main|rest)\.ndjson\.gz$/.test(f)).sort()
const fileText = (h, f) => { const b = fs.readFileSync(path.join(dirOf(h), f)); return (f.endsWith('.gz') ? gunzipSync(b) : b).toString('utf8') }
const headOf = (h) => JSON.parse(fileText(h, 'head.json.gz'))
const statOf = (f) => { const s = fs.statSync(f); return [s.ino, s.mtimeMs] }
const linesOf = (text) => { assert.ok(text.endsWith('\n'), 'every line ends with a newline'); return text.slice(0, -1).split('\n').map((l) => JSON.parse(l)) }
const recorder = () => {
  const r = { status: null, chunks: [] }
  return Object.assign(r, { writeHead: (s) => { r.status = s }, write: (b) => { r.chunks.push(b); return true }, end: () => {}, once: () => {}, text: () => Buffer.concat(r.chunks).toString('utf8') })
}
const ask = async (svc, name, params) => {
  const res = recorder()
  await within(svc.relay({ name, params, res }), 120_000, `${name} answered`)
  assert.equal(res.status, 200, `${name} answers 200`)
  return res.text()
}
const until = (ok, ms, what) => { let t; return within(new Promise((d) => { t = setInterval(() => ok() && (clearInterval(t), d()), 50) }), ms, what, () => clearInterval(t)) }
const tryHead = (h) => { try { return headOf(h) } catch { return null } }

// A tail applied as a client applies it: per rid its latest row and its latest step with the list its ops rebuild against the
// parent's list (the parent's latest line before it in the file); `g` drops a rid.
function applied(text) {
  const rows = new Map(), steps = new Map(), lists = new Map()
  for (const o of linesOf(text).slice(1)) {
    if (o.c) rows.set(o.c.rid, JSON.stringify(o.c))
    else if (o.s) {
      const s = o.s, P = s.parent == null ? [] : lists.get(s.parent)
      assert.ok(P, `step ${s.rid}: its parent ${s.parent} is in the file before it`)
      const list = s.ops.flatMap((op) => (op[0] === 0 ? P.slice(op[1], op[1] + op[2]) : op.slice(1)))
      lists.set(s.rid, list)
      steps.set(s.rid, JSON.stringify({ lane: s.lane, i: s.i, list, reply: s.reply, detail: s.detail, events: s.events }))
    } else if (o.g) { rows.delete(o.g); steps.delete(o.g) }
  }
  return { rows: Object.fromEntries([...rows].sort()), steps: Object.fromEntries([...steps].sort()) }
}

test('3.5 #33 A7: per sealed span gunzip(file) = the worker\'s `lane --pack` = the local path\'s; the worker\'s `lane --tail` = the tail file, the local one apply-equal to it', { timeout: 600_000 }, async () => {
  const x = await folded('http'), head = headOf(x)
  assert.ok(head.packs.length >= 3, 'at least three sealed packs')
  const svc = createQueryService({ home: x.home, fork: workerFork })
  try {
    for (const { n } of head.packs) {
      for (const part of ['main', 'rest']) {
        const pack = `${n}.${part}`, file = fileText(x, `p${pack}.ndjson.gz`)
        assert.equal(await ask(svc, 'lane', { id: x.id, pack }), file, `pack ${pack}: the worker's answer = the file`)
        assert.equal((await runQuery('lane', { id: x.id, pack }, { home: x.home })).$text, file, `pack ${pack}: the local path's answer = the file`)
      }
    }
    for (const part of ['main', 'rest']) assert.equal(await ask(svc, 'lane', { id: x.id, tail: part }), fileText(x, `open.${part}.ndjson`), `tail ${part}: the worker's answer = the file`)
  } finally { svc.stop() }
  const y = await incremental('http')
  for (const part of ['main', 'rest']) {
    const local = (await runQuery('lane', { id: y.id, tail: part }, { home: y.home })).$text
    assert.deepEqual(applied(local), applied(fileText(y, `open.${part}.ndjson`)), `tail ${part}: the appended file applies to the local rendering`)
  }
  await assert.rejects(runQuery('lane', { id: x.id, pack: `${head.open.n}.main` }, { home: x.home }), { name: 'QueryArgError' }, 'the open span is no pack yet')
  await assert.rejects(runQuery('lane', { id: x.id, pack: '0.main', tail: 'main' }, { home: x.home }), { name: 'QueryArgError' })
  await assert.rejects(runQuery('lane', { id: x.id, pack: '0.main', lane: head.axis }, { home: x.home }), { name: 'QueryArgError' })
})

for (const wire of ['http', 'threads', 'ws']) {
  test(`3.5 #34 A8 (${wire}): folded in one slice or in random slices with kills and a resume, the head and every pack file are the same bytes`, { timeout: 600_000 }, async () => {
    const [x, y] = await Promise.all([folded(wire), incremental(wire)])
    const names = packNames(x)
    assert.ok(names.length >= 6, 'at least three sealed packs')
    assert.deepEqual(packNames(y), names)
    assert.equal(fileText(y, 'head.json.gz'), fileText(x, 'head.json.gz'), 'the heads')
    for (const f of names) assert.ok(fs.readFileSync(path.join(dirOf(y), f)).equals(fs.readFileSync(path.join(dirOf(x), f))), `${f}: the same bytes`)
    assert.equal(headOf(x).packs.length * 2, names.length, 'the head lists every sealed pack')
  })
}

test('3.5 #35 A10: a missing head, a truncated pack, a pack of another v and a torn tail are each rewritten alone, to the bytes of the untouched home', { timeout: 600_000 }, async () => {
  const x = await folded('http')
  const z = { home: path.join(tmpDir('trocar-packs-z-'), '.trocar'), id: x.id }
  fs.cpSync(x.home, z.home, { recursive: true })
  const d = dirOf(z), file = (f) => path.join(d, f)
  const hit = ['head.json.gz', 'p0.main.ndjson.gz', 'p1.rest.ndjson.gz', 'open.main.ndjson']
  fs.unlinkSync(file(hit[0]))
  fs.truncateSync(file(hit[1]), Math.floor(fs.statSync(file(hit[1])).size / 2))
  fs.writeFileSync(file(hit[2]), gzipSync(Buffer.from(fileText(z, hit[2]).replace(/"v":1,/, '"v":999,'))))
  fs.truncateSync(file(hit[3]), fs.statSync(file(hit[3])).size - 3)
  const others = fs.readdirSync(d).filter((f) => /^(p\d+\.|open\.|head\.)/.test(f) && !hit.includes(f))
  assert.ok(others.length >= 5)
  const before = Object.fromEntries(others.map((f) => [f, statOf(file(f))]))
  await new Promise((ok) => setTimeout(ok, 20)) // a rewrite has another mtime
  await drive(z.home, z.id)
  for (const f of others) assert.deepEqual(statOf(file(f)), before[f], `${f} was not written`)
  for (const f of hit) assert.ok(fs.readFileSync(file(f)).equals(fs.readFileSync(path.join(dirOf(x), f))), `${f}: rewritten to the untouched home's bytes`)
})

// the layout the fold log is in when the worker starts: the session's directory, or the flat layout (4.3 §4 迁移), which the start-up
// sweep's tier-0 head finds with a directory holding that head only
const FLAT = { 'extract.0.ndjson': '.ndjson', 'extract.idx': '.idx', 'fold.0.ndjson': '.fold.ndjson', 'fold.idx': '.fold.idx' }
test('3.5 #35 A9: a session folded before the answer files (fold log, no head, no packs) gets a tier-1 head and its packs from the worker\'s idle slices, the bytes of a fresh fold', { timeout: 600_000 }, async () => {
  const x = await folded('http')
  for (const layout of ['dir', 'flat']) {
    const m = { home: path.join(tmpDir(`trocar-packs-m-${layout}-`), '.trocar'), id: x.id }
    fs.cpSync(x.home, m.home, { recursive: true })
    for (const f of fs.readdirSync(dirOf(m))) if (/^(p\d+\.|open\.|head\.)/.test(f)) fs.unlinkSync(path.join(dirOf(m), f))
    if (layout === 'flat') { // each line file whole from byte 0 (its sealed parts in order, then its plain tail), offsets unchanged
      const d = dirOf(m), names = fs.readdirSync(d)
      for (const base of ['extract', 'fold']) {
        const parts = names.filter((n) => n.startsWith(`${base}.`) && n.endsWith('.br')).sort((a, b) => Number(a.split('.')[1].split('-')[0]) - Number(b.split('.')[1].split('-')[0]))
        const tail = names.filter((n) => new RegExp(`^${base}\\.\\d+\\.ndjson$`).test(n))
        assert.equal(tail.length, 1, `${base}: one plain tail`)
        fs.writeFileSync(d + FLAT[`${base}.0.ndjson`], Buffer.concat([...parts.map((n) => brotliDecompressSync(fs.readFileSync(path.join(d, n)))), fs.readFileSync(path.join(d, tail[0]))]))
        fs.renameSync(path.join(d, `${base}.idx`), d + FLAT[`${base}.idx`])
      }
      fs.rmSync(d, { recursive: true })
    }
    const w = workerFork(m.home)
    try {
      await until(() => { const h = tryHead(m); return h && h.tier === 1 && h.pending == null && fs.existsSync(path.join(dirOf(m), 'open.rest.ndjson')) }, 120_000, `${layout}: the upgrade wrote a tier-1 head and the tails`)
    } finally { w.kill() }
    assert.equal(fileText(m, 'head.json.gz'), fileText(x, 'head.json.gz'), layout)
    assert.deepEqual(packNames(m), packNames(x), layout)
    for (const f of packNames(x)) assert.ok(fs.readFileSync(path.join(dirOf(m), f)).equals(fs.readFileSync(path.join(dirOf(x), f))), `${layout} · ${f}: a fresh fold's bytes`)
  }
})

test('3.5 §会话读 contract: every line kind and key is in the closed sets; rows, lane headers and records are the session answer\'s; a definition comes before its first use; each lane\'s first step in a file is a keyframe', { timeout: 600_000 }, async () => {
  const x = await folded('http')
  const doc = await runQuery('session', { id: x.id }, { home: x.home }), rows = new Map(doc.calls.map((c) => [c.rid, JSON.stringify(c)]))
  for (let d = doc; d.more;) { d = await runQuery('session', { id: x.id, before: d.calls[0].rid }, { home: x.home }); for (const c of d.calls) rows.set(c.rid, JSON.stringify(c)) }
  const lanes = new Map(doc.lanes.map((h) => [h.lane, JSON.stringify(h)]))
  const files = [...packNames(x), 'open.main.ndjson', 'open.rest.ndjson']
  const seen = { calls: new Set(), lanes: new Set() }
  for (const f of files) {
    const [h, ...lines] = linesOf(fileText(x, f)), kind = f.startsWith('open.') ? 'tail' : 'pack'
    assert.deepEqual(Object.keys(h), [...HEAD, kind], `${f}: the doc-head line`)
    assert.equal(h.command, 'lane')
    const defs = new Set(), last = new Map()
    for (const o of lines) {
      const [k, ...more] = Object.keys(o), v = o[k]
      assert.equal(more.length, 0, 'one top-level key a line')
      if (k === 'd') { for (const key of Object.keys(v)) assert.ok(DEF.includes(key), `definition key ${key}`); defs.add(v.bid) }
      else if (k === 's') {
        assert.deepEqual(Object.keys(v), STEP)
        for (const op of v.ops) if (op[0] === 1) for (const bid of op.slice(1)) assert.ok(defs.has(bid), `${f}: ${bid} defined before its first use`)
        for (const bid of v.reply) assert.ok(defs.has(bid), `${f}: reply ${bid} defined before its first use`)
        assert.equal(v.parent, last.get(v.lane) ?? null, `${f}: ${v.rid}'s parent is its lane's previous step in the file`)
        last.set(v.lane, v.rid)
        seen.calls.add(v.rid)
      } else if (k === 'c') assert.equal(JSON.stringify(v), rows.get(v.rid), `${f}: row ${v.rid} = the session answer's`)
      else if (k === 'l') { assert.equal(JSON.stringify(v), lanes.get(v.lane), `${f}: lane ${v.lane} = the session answer's`); seen.lanes.add(v.lane) }
      else if (k === 'r') assert.deepEqual(Object.keys(v), REC)
      else if (k === 'x') assert.deepEqual(Object.keys(v), ERR)
      else assert.fail(`${f}: line kind ${k}`)
    }
  }
  assert.equal(seen.calls.size, rows.size, 'every call is a step of one file')
  assert.equal(seen.lanes.size, lanes.size, 'every lane has its header in a file')
})
