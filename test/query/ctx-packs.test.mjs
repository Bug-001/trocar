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
import { gunzipSync, gzipSync } from 'node:zlib'
import { createQueryService } from '../../src/query/service.mjs'
import { runQuery } from '../../src/query/named/index.mjs'
import { sessionDir, PROJ_V } from '../../src/query/projection.mjs'
import { lineFile } from '../../src/query/line-file.mjs'
import { indexRows, sessionGroups } from '../../src/query/rows.mjs'
import { PACK_MEMBERS, CTX_V } from '../../src/query/ctx-files.mjs'
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
const DEF = ['bid', 'fh', 'ref', 'sec', 'role', 'kind', 'label', 'name', 'mcp', 'cc', 'ff', 'head', 'preview', 'chars', 'bytes', 'resKey', 'resKeys', 'r', 'unaddressable', 'inline']
const REC = ['id', 'ts_request', 'is_llm_call', 'response']
const ERR = ['where', 'code', 'reason']

// The worker's background in a process of its own: slices of `ms` (0: one slice that does everything), an idle save at seeded
// slices, SIGKILL after slice `kill` (0: never). `then`: once folded to the end and saved, the process waits while then() runs
// (the session grows) and folds on in the same process.
const DRIVER = `
await import(${at('../../src/query/named/index.mjs')})
const { extendSession, saveIndexes } = await import(${at('../../src/query/named/session.mjs')})
const { rng } = await import(${at('./big-session.mjs')})
const [home, id, ms, kill, seed, rounds] = [process.argv[1], process.argv[2], Number(process.argv[3]), Number(process.argv[4]), Number(process.argv[5]), Number(process.argv[6])]
const r = rng(seed)
let k = 0
for (let round = 0; round < rounds; round++) {
  if (round) { process.stdout.write('folded\\n'); await new Promise((ok) => process.stdin.once('data', ok)) }
  while (await extendSession({ home, writer: true }, id, ms ? 1 + r() * ms : 1e9)) {
    if (r() < 0.2) saveIndexes()
    if (++k === kill) process.kill(process.pid, 'SIGKILL')
    await new Promise((ok) => setImmediate(ok))
  }
  saveIndexes()
}
process.exit(0)`
async function drive(home, id, { ms = 0, kill = 0, seed = 1, then = null } = {}) {
  const c = spawn(process.execPath, ['--require', NO_REAL_OS, '--input-type=module', '-e', DRIVER, home, id, String(ms), String(kill), String(seed), then ? '2' : '1'], { stdio: ['pipe', 'pipe', 'pipe'] })
  let err = ''
  c.stderr.on('data', (b) => { err += b })
  if (then) c.stdout.once('data', async () => { await then(); c.stdin.write('go\n') })
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

// A tail applied as a client applies it (later lines for the same key override earlier ones): per rid its latest row and its
// latest step with the list its ops rebuild against the parent's list (the parent's latest line before it in the file), per bid a
// kept step refers to its definition (one written for a step since gone stays: the tail only appends), per lane its header, per
// member its record, per failed member its failure; `g` drops a rid.
function applied(text) {
  const rows = new Map(), steps = new Map(), lists = new Map(), uses = new Map(), defs = new Map(), heads = new Map(), recs = new Map(), fails = new Map()
  for (const o of linesOf(text).slice(1)) {
    if (o.c) rows.set(o.c.rid, JSON.stringify(o.c))
    else if (o.d) defs.set(o.d.bid, JSON.stringify(o.d))
    else if (o.l) heads.set(o.l.lane, JSON.stringify(o.l))
    else if (o.r) recs.set(o.r.id, JSON.stringify(o.r))
    else if (o.x) fails.set(o.x.where, JSON.stringify(o.x))
    else if (o.s) {
      const s = o.s, P = s.parent == null ? [] : lists.get(s.parent)
      assert.ok(P, `step ${s.rid}: its parent ${s.parent} is in the file before it`)
      const list = s.ops.flatMap((op) => (op[0] === 0 ? P.slice(op[1], op[1] + op[2]) : op.slice(1)))
      lists.set(s.rid, list)
      steps.set(s.rid, JSON.stringify({ lane: s.lane, i: s.i, list, reply: s.reply, detail: s.detail, events: s.events }))
      uses.set(s.rid, [...list, ...s.reply])
    } else if (o.g) { rows.delete(o.g); steps.delete(o.g); uses.delete(o.g) }
  }
  const of = (m) => Object.fromEntries([...m].sort()), used = new Set([...uses.values()].flat())
  return { rows: of(rows), steps: of(steps), defs: of([...defs].filter(([bid]) => used.has(bid))), heads: of(heads), recs: of(recs), fails: of(fails) }
}

test('3.5 #33: per sealed span gunzip(file) = the worker\'s `lane --pack` = the local path\'s; the worker\'s `lane --tail` = the tail file, the local one apply-equal to it', { timeout: 600_000 }, async () => {
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
  test(`3.5 #34 (${wire}): folded in one slice or in random slices with kills and a resume, the head and every pack file are the same bytes`, { timeout: 600_000 }, async () => {
    const [x, y] = await Promise.all([folded(wire), incremental(wire)])
    const names = packNames(x)
    assert.ok(names.length >= 6, 'at least three sealed packs')
    assert.deepEqual(packNames(y), names)
    assert.equal(fileText(y, 'head.json.gz'), fileText(x, 'head.json.gz'), 'the heads')
    for (const f of names) assert.ok(fs.readFileSync(path.join(dirOf(y), f)).equals(fs.readFileSync(path.join(dirOf(x), f))), `${f}: the same bytes`)
    assert.equal(headOf(x).packs.length * 2, names.length, 'the head lists every sealed pack')
  })
}

test('3.5 #35, damaged files: a missing head, a truncated pack, a pack of another v and a torn tail are each rewritten alone, to the bytes of the untouched home', { timeout: 600_000 }, async () => {
  const x = await folded('http')
  const z = { home: path.join(tmpDir('trocar-packs-z-'), '.trocar'), id: x.id }
  fs.cpSync(x.home, z.home, { recursive: true })
  const d = dirOf(z), file = (f) => path.join(d, f)
  const hit = ['head.json.gz', 'p0.main.ndjson.gz', 'p1.rest.ndjson.gz', 'open.main.ndjson']
  fs.unlinkSync(file(hit[0]))
  fs.truncateSync(file(hit[1]), Math.floor(fs.statSync(file(hit[1])).size / 2))
  const other = fileText(z, hit[2]).replace(`"v":${CTX_V},`, '"v":999,')
  assert.notEqual(other, fileText(z, hit[2]), 'the pack is of another v now')
  fs.writeFileSync(file(hit[2]), gzipSync(Buffer.from(other)))
  fs.truncateSync(file(hit[3]), fs.statSync(file(hit[3])).size - 3)
  const others = fs.readdirSync(d).filter((f) => /^(p\d+\.|open\.|head\.)/.test(f) && !hit.includes(f))
  assert.ok(others.length >= 5)
  const before = Object.fromEntries(others.map((f) => [f, statOf(file(f))]))
  await new Promise((ok) => setTimeout(ok, 20)) // a rewrite has another mtime
  await drive(z.home, z.id)
  for (const f of others) assert.deepEqual(statOf(file(f)), before[f], `${f} was not written`)
  for (const f of hit) assert.ok(fs.readFileSync(file(f)).equals(fs.readFileSync(path.join(dirOf(x), f))), `${f}: rewritten to the untouched home's bytes`)
})

test('3.5 #35 neighbour: answer files of the same `v` with stale content are written anew when the projection under them is of another version', { timeout: 600_000 }, async () => {
  const shape = { ...SHAPE, wire: 'http', compactAt: 8_000 }, calls = PACK_MEMBERS + 40
  const homes = [homeOf(), homeOf()].map((home) => { const s = bigSession({ home, ...shape }); s.append(calls); return { home, id: s.id } })
  for (const h of homes) await drive(h.home, h.id)
  const [x, z] = homes, file = (f) => path.join(dirOf(z), f)
  // the last digit of a file's text moved: a line that still parses, the `v` of its head as it was
  const stale = (text) => { const i = text.search(/\d\D*$/); return text.slice(0, i) + (text[i] === '7' ? '8' : '7') + text.slice(i + 1) }
  const hit = ['head.json.gz', 'p0.main.ndjson.gz', 'open.main.ndjson']
  for (const f of hit) {
    const text = stale(fileText(z, f))
    assert.equal(JSON.parse(text.split('\n')[0]).v, CTX_V)
    fs.writeFileSync(file(f), f.endsWith('.gz') ? gzipSync(Buffer.from(text)) : text)
  }
  const proj = fs.readFileSync(file('extract.0.ndjson'), 'utf8'), nl = proj.indexOf('\n')
  fs.writeFileSync(file('extract.0.ndjson'), JSON.stringify({ ...JSON.parse(proj.slice(0, nl)), v: PROJ_V + 1 }) + proj.slice(nl))
  await drive(z.home, z.id)
  for (const f of hit) assert.equal(fileText(z, f), fileText(x, f), `${f}: the bytes of the untouched fold`)
})

// the layout the fold log is in when the worker starts: the session's directory, or the flat layout (4.3 §4 迁移), which the start-up
// sweep's tier-0 head finds with a directory holding that head only
const FLAT = { 'extract.0.ndjson': '.ndjson', 'extract.idx': '.idx', 'fold.0.ndjson': '.fold.ndjson', 'fold.idx': '.fold.idx' }
test('3.5 #35, files missing: a session folded before the answer files (fold log, no head, no packs) gets a tier-1 head and its packs from the worker\'s idle slices, the bytes of a fresh fold', { timeout: 600_000 }, async () => {
  const x = await folded('http')
  for (const layout of ['dir', 'flat']) {
    const m = { home: path.join(tmpDir(`trocar-packs-m-${layout}-`), '.trocar'), id: x.id }
    fs.cpSync(x.home, m.home, { recursive: true })
    for (const f of fs.readdirSync(dirOf(m))) if (/^(p\d+\.|open\.|head\.)/.test(f)) fs.unlinkSync(path.join(dirOf(m), f))
    if (layout === 'flat') { // each line file whole from byte 0 (its sealed parts in order, then its plain tail), offsets unchanged
      const d = dirOf(m)
      for (const base of ['extract', 'fold']) {
        const lf = lineFile({ fs, base: path.join(d, base), write: false })
        fs.writeFileSync(d + FLAT[`${base}.0.ndjson`], Buffer.concat([...lf.scan()].map((l) => Buffer.from(l.nl ? `${l.text}\n` : l.text))))
        lf.close()
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

// The worker following a growing session: one process that, per line `<ms> <seed> <kill>` on stdin, folds to the frontier in slices
// of up to `ms` (SIGKILL after slice `kill`, 0: never) and answers `done`; the files are written by the same writer across rounds.
const FOLLOWER = `
await import(${at('../../src/query/named/index.mjs')})
const { extendSession, saveIndexes } = await import(${at('../../src/query/named/session.mjs')})
const { rng } = await import(${at('./big-session.mjs')})
const home = process.argv[1], id = process.argv[2]
let buf = ''
process.stdin.on('data', async (b) => {
  buf += b
  for (let i; (i = buf.indexOf('\\n')) >= 0;) {
    const [ms, seed, kill] = buf.slice(0, i).split(' ').map(Number), r = rng(seed)
    buf = buf.slice(i + 1)
    let k = 0
    while (await extendSession({ home, writer: true }, id, 1 + r() * ms)) { if (r() < 0.1) saveIndexes(); if (++k === kill) process.kill(process.pid, 'SIGKILL') }
    saveIndexes() // the round over: the worker's idle period (its save writes a head a slice left behind)
    process.stdout.write('done\\n')
  }
})`
function follower(home, id) {
  const c = spawn(process.execPath, ['--require', NO_REAL_OS, '--input-type=module', '-e', FOLLOWER, home, id], { stdio: ['pipe', 'pipe', 'pipe'] })
  let out = '', err = '', exit = null
  c.stdout.on('data', (b) => { out += b })
  c.stderr.on('data', (b) => { err += b })
  const gone = new Promise((ok) => c.on('close', (code, signal) => ok(exit = { code, signal })))
  return {
    round: async (ms, seed, kill = 0) => {
      const n = out.split('\n').length
      c.stdin.write(`${ms} ${seed} ${kill}\n`)
      await until(() => exit || out.split('\n').length > n, 240_000, 'a round')
      if (exit) { assert.ok(kill && exit.signal === 'SIGKILL', `the follower failed: ${err.split('\n').slice(0, 6).join(' / ')}`); return false }
      return true
    },
    stop: () => { c.kill(); return gone },
  }
}
// per lane its last `{l}` line in a file
const headsIn = (text) => { const m = new Map(); for (const o of linesOf(text).slice(1)) if (o.l) m.set(o.l.lane, JSON.stringify(o.l)); return Object.fromEntries([...m].sort()) }

// 3.5 §会话读 pack / tail (D71②③ · 不变式 2): a session followed as it grows — rounds of a few new calls (late ones among them) each
// folded in small slices by one process, killed mid-fold twice and resumed by a new one — leaves the head and every pack the bytes of a
// fresh fold of the same disk, and tails that apply to the local rendering: the same rows and steps, and as the last `{l}` of each
// lane every lane header of the part.
test('3.5 §会话读: a session followed as it grows (seals, late calls, kills mid-fold) leaves the bytes of a fresh fold; its tails apply to the local rendering, lane headers included', { timeout: 600_000 }, async () => {
  const x = await folded('http'), home = homeOf(), s = bigSession({ home, wire: 'http', ...SHAPE }), r = rng(5)
  s.append(300)
  let f = follower(home, s.id), round = 0, kills = 0
  try {
    while (s.calls < CALLS) {
      const k = Math.min(CALLS - s.calls, 1 + Math.floor(r() * (r() < 0.2 ? 80 : 12)))
      s.append(k)
      if (!(await f.round(4, ++round, k > 40 && kills < 2 ? 2 : 0))) { kills++; f = follower(home, s.id); assert.ok(await f.round(4, ++round)) }
    }
  } finally { await f.stop() }
  assert.equal(kills, 2, 'killed mid-fold twice')
  assert.ok(fs.readFileSync(s.file).equals(fs.readFileSync(path.join(x.home, 'raw', path.basename(s.file)))), 'the same disk')
  const y = { home, id: s.id }, names = packNames(x)
  assert.ok(round > 40 && names.length >= 6, 'many rounds, at least three sealed packs')
  assert.deepEqual(packNames(y), names)
  assert.equal(fileText(y, 'head.json.gz'), fileText(x, 'head.json.gz'), 'the heads')
  for (const n of names) assert.equal(fileText(y, n), fileText(x, n), `${n}: the same bytes`)
  const lanes = headOf(x).lanes
  for (const part of ['main', 'rest']) {
    const local = (await runQuery('lane', { id: y.id, tail: part }, { home: y.home })).$text, file = fileText(y, `open.${part}.ndjson`)
    assert.deepEqual(applied(file), applied(local), `tail ${part}: the appended file applies to the local rendering`)
    assert.deepEqual(headsIn(file), headsIn(local), `tail ${part}: the last {l} of each lane is the local rendering's`)
    for (const n of names.filter((m) => m.endsWith(`.${part}.ndjson.gz`))) assert.deepEqual(headsIn(fileText(y, n)), {}, `${n}: a pack holds no lane header`)
  }
  const all = { ...headsIn(fileText(y, 'open.main.ndjson')), ...headsIn(fileText(y, 'open.rest.ndjson')) }
  for (const h of lanes) assert.equal(all[h.lane], JSON.stringify(h), `lane ${h.lane}: the tails hold the head's lane header`)
})

// 3.5 §会话读 `{l}` (D71③): lane headers live in the tails only, so a sealed pack is not rewritten when a lane with steps in it goes on
// into the open span (its last step leaves the pack, its header changes). No late calls: no row of a sealed span changes.
test('3.5 §会话读 {l}: a sealed pack is not rewritten when its lanes grow on into the open span', { timeout: 600_000 }, async () => {
  const home = homeOf(), s = bigSession({ home, wire: 'http', ...SHAPE, late: 0 }), h = { home, id: s.id }
  s.append(2 * PACK_MEMBERS + 8) // just past a seal: the lanes running then have their last steps in the sealed pack
  await drive(home, s.id)
  const names = packNames(h), was = headOf(h)
  assert.ok(names.length >= 4, 'at least two sealed packs')
  const before = Object.fromEntries(names.map((f) => [f, [statOf(path.join(dirOf(h), f)), fileText(h, f)]]))
  await new Promise((ok) => setTimeout(ok, 20)) // a rewrite has another mtime
  s.append(200)
  await drive(home, s.id)
  const now = headOf(h), members = sessionGroups(await indexRows({ home, errors: [] })).get(s.id), pos = new Map(members.map((r, i) => [String(r.id), i]))
  const sealedEnd = PACK_MEMBERS * was.open.n
  const crossed = was.lanes.filter((l) => pos.get(l.last) < sealedEnd && now.lanes.some((m) => m.lane === l.lane && m.last !== l.last))
  assert.ok(crossed.length >= 1, 'a lane whose last step was in a sealed pack went on into the open span: else this case shows nothing')
  for (const f of names) assert.deepEqual([statOf(path.join(dirOf(h), f)), fileText(h, f)], before[f], `${f} was not rewritten`)
})

test('3.5 §谁执行它「答案文件」: a worker that starts again continues the tails the last one wrote — the board\'s held bytes stay the file\'s first bytes; the tail applies to a one-pass rendering', { timeout: 600_000 }, async () => {
  const home = homeOf(), s = bigSession({ home, wire: 'http', ...SHAPE }), tails = () => ['main', 'rest'].map((p) => fs.readFileSync(path.join(sessionDir(home, s.id), `open.${p}.ndjson`)))
  const onePass = async (part, file) => { // the tail file: the doc-head line a one-pass rendering's, applying to it
    const local = (await runQuery('lane', { id: s.id, tail: part }, { home })).$text, text = file.toString('utf8')
    assert.equal(local.slice(0, local.indexOf('\n')), text.slice(0, text.indexOf('\n')), `tail ${part}: the doc-head line is a one-pass rendering's`)
    assert.deepEqual(applied(text), applied(local), `tail ${part}: applies to the one-pass rendering`)
    assert.deepEqual(headsIn(text), headsIn(local), `tail ${part}: the last {l} of each lane is the one-pass rendering's`)
  }
  s.append(560)
  await drive(home, s.id, { ms: 6, seed: 4 }) // worker 1, in slices (its tails appended to): its last idle save is the checkpoint
  const n = headOf({ home, id: s.id }).open.n, before = tails()
  await drive(home, s.id) // a new worker, nothing new
  tails().forEach((t, i) => assert.ok(t.equals(before[i]), `tail ${i}: a worker that starts again over an unchanged session leaves the tail as it was`))
  s.append(200)
  await drive(home, s.id, { ms: 6, seed: 5 }) // a new worker, more calls, in slices
  assert.equal(headOf({ home, id: s.id }).open.n, n, 'no pack was sealed in between')
  const after = tails()
  for (const [i, part] of ['main', 'rest'].entries()) {
    assert.ok(after[i].length > before[i].length && after[i].subarray(0, before[i].length).equals(before[i]), `tail ${part}: begins with the bytes the last worker wrote`)
    await onePass(part, after[i])
  }
  // a tail gone while no worker ran: the next worker writes it whole and carries the other on
  fs.rmSync(path.join(sessionDir(home, s.id), 'open.rest.ndjson'))
  s.append(40)
  await drive(home, s.id) // a new worker, more calls, in one slice
  assert.equal(headOf({ home, id: s.id }).open.n, n, 'no pack was sealed in between')
  const last = tails()
  assert.ok(last[0].subarray(0, after[0].length).equals(after[0]), 'tail main: begins with the bytes the last worker wrote')
  for (const [i, part] of ['main', 'rest'].entries()) await onePass(part, last[i])
})

// 3.5 #34, the axis lane changing: a session of one-call subagent lanes and no main lane (subEvery 1, subLen 0: the axis is the
// lane of the earliest call, 1.3), every call ending up to `late` calls later (seed 35: the call that sorts first arrives at write
// place 684, past the first seal) — the axis lane changes after a pack was sealed. Folded in slices in one worker, and by a worker
// that starts again after the change (its checkpoint's axis the old one), every pack file is the one-pass fold's bytes.
test('3.5 #34 axis: after the axis lane changes past a sealed pack, the same worker and a worker that starts again write the one-pass fold\'s packs', { timeout: 600_000 }, async () => {
  const AXIS = { wire: 'http', subEvery: 1, subLen: 0, late: 1_500, seed: 35, growth: 1_000 }, ALL = 1_700
  const grown = (home, upTo) => { const s = bigSession({ home, ...AXIS }); s.append(upTo); return s }
  const one = { home: homeOf() }, same = { home: homeOf() }, again = { home: homeOf() }
  one.id = grown(one.home, ALL).id
  await drive(one.home, one.id)
  // the same session grown in steps: past the first seal and before the late call that sorts first (a worker folds it and saves its
  // checkpoint), then to its end — folded on by a worker that started before the change (`same`: the change comes in its slices) or
  // after it (`again`)
  const upTo = (s, k) => { while (s.calls - s.held < k) s.append(1); return s }
  const s1 = upTo(bigSession({ home: same.home, ...AXIS }), PACK_MEMBERS + 40), s2 = upTo(bigSession({ home: again.home, ...AXIS }), PACK_MEMBERS + 40)
  same.id = s1.id; again.id = s2.id
  await drive(same.home, same.id, { ms: 6, seed: 2 })
  await drive(again.home, again.id, { ms: 6, seed: 3 })
  const was = headOf(again)
  assert.ok(was.packs.length >= 1, 'a pack was sealed before the axis changed')
  upTo(s1, PACK_MEMBERS + 80)
  await drive(same.home, same.id, { ms: 6, seed: 4, then: () => s1.append(ALL - s1.calls) })
  s2.append(ALL - s2.calls)
  await drive(again.home, again.id)
  const want = headOf(one), names = packNames(one)
  assert.notEqual(want.axis, was.axis, 'the axis lane changed after the seal: else this case shows nothing')
  assert.ok(names.length >= 2 && want.packs.length * 2 === names.length)
  const bad = []
  for (const [how, h] of [['the same worker', same], ['a worker that starts again', again]]) {
    if (JSON.stringify(packNames(h)) !== JSON.stringify(names)) { bad.push(`${how}: the pack files`); continue }
    if (JSON.stringify(headOf(h).packs.map((p) => p.tag)) !== JSON.stringify(want.packs.map((p) => p.tag))) bad.push(`${how}: the head's pack tags`)
    for (const f of names) if (fileText(h, f) !== fileText(one, f)) bad.push(`${how}: ${f}`)
  }
  assert.deepEqual(bad, [], 'every pack file and tag is the one-pass fold\'s')
})

// 3.5 #34, a sealed pack's doc head changing while its rows do not (3.5:45: such a pack is rewritten whole): subagents only, told
// apart by order (`marked`), two side by side; call 1 ends late (`hold`), past the second seal. Its arrival folds span 0 again in step
// order and the axis lane (the earliest call's) loses a step there, so pack 1, which holds no axis step, gets another [s0, s1] with
// the same rows. A worker that starts again on the checkpoint saved before the arrival writes the one-pass fold's packs and head.
test('3.5 #34 doc head: a pack whose [s0, s1] changed while its rows did not, met by a worker that starts again, is the one-pass fold\'s bytes', { timeout: 600_000 }, async () => {
  const LATE = 2 * PACK_MEMBERS + 80, ALL = LATE + 40
  const SHAPE1 = { wire: 'http', subEvery: 1, subLanes: 2, subLen: 30, growth: 600, marked: true, hold: { 1: LATE } }
  const one = { home: homeOf() }, again = { home: homeOf() }
  const s1 = bigSession({ home: one.home, ...SHAPE1 }), s2 = bigSession({ home: again.home, ...SHAPE1 })
  one.id = s1.id; again.id = s2.id
  s1.append(ALL)
  await drive(one.home, one.id)
  s2.append(LATE - 1) // past the second seal, call 1 not written yet
  await drive(again.home, again.id) // its last idle save is the checkpoint
  const was = headOf(again)
  s2.append(ALL - s2.calls)
  await drive(again.home, again.id)
  const want = headOf(one), names = packNames(one)
  assert.ok(was.packs.length >= 2, 'two sealed packs before the late call')
  assert.ok(want.packs.some((p) => p.n < was.packs.length && (p.s0 !== was.packs[p.n].s0 || p.s1 !== was.packs[p.n].s1)), 'a sealed pack\'s [s0, s1] changed: else this case shows nothing')
  assert.deepEqual(packNames(again), names)
  assert.equal(fileText(again, 'head.json.gz'), fileText(one, 'head.json.gz'), 'the heads')
  for (const f of names) assert.equal(fileText(again, f), fileText(one, f), `${f}: the one-pass fold's bytes`)
})
