// test/query/fold-resume.test.mjs — the reduction state in the fold log's sidecar (RFC 4.3 §4 旁索引, 3.5:42 后台抽取与归约): a worker
// killed at any point and reopened resumes from it (the state covers the log's last frontier, or the log is cut back to what it
// covers), and every answer and every keyed line it leaves equal a one-shot build (4.3 #1, #7); a reopened worker over a grown
// session folds only the new members.
//
// The trials run the worker in child processes (session.mjs keeps its stores and states per process): one drives background slices,
// with idle periods (saveIndexes) at seeded slices, and exits abruptly after a seeded slice count; in some trials the fold log and/or
// the projection then lose a torn tail at a seeded byte past what their sidecars cover; a second child resumes to the end. "Equal"
// is what 4.3 #1 makes byte for byte: the answers (`session`, `session --since` an early member, every lane's tail), and the lines
// an answer reads, by key — the projection's definitions (bid), call rows (rid) and break details (pair); the fold log's latest line
// of each rid and lane (less `p`), its items and failures, its last frontier (less `pb`). Where frontiers fall and what offsets
// lines sit at move with the slices, so those are not compared.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tmpDir } from '../helpers/tmp.mjs'
import { within } from '../helpers/bounded.mjs'
import { bigSession, rng } from './big-session.mjs'
import { runQuery } from '../../src/query/named/index.mjs'
import { extendSession, saveIndexes } from '../../src/query/named/session.mjs'
import { projectionFile, openProjection } from '../../src/query/projection.mjs'
import { foldLogFile, openFoldLog } from '../../src/query/fold-log.mjs'
import { loadSidecar, saveSidecar, sidecarOf } from '../../src/query/line-file.mjs'

const NO_REAL_OS = fileURLToPath(new URL('../helpers/no-real-os.cjs', import.meta.url))
const at = (p) => JSON.stringify(new URL(p, import.meta.url).href)
const SHAPE = { growth: 2_000, compactAt: 20_000, subEvery: 3, subLanes: 3, late: 2 }

// The worker's background in a process of its own: slices of `ms`, an idle period (saveIndexes) after a slice with probability
// `idle`, an abrupt exit after slice `kill` (0: never; at the end an idle period). Prints {slices, killed}.
const WORKER = `
await import(${at('../../src/query/named/index.mjs')})
const { extendSession, saveIndexes } = await import(${at('../../src/query/named/session.mjs')})
const { rng } = await import(${at('./big-session.mjs')})
const [home, id, kill, idle, seed] = [process.argv[1], process.argv[2], Number(process.argv[3]), Number(process.argv[4]), Number(process.argv[5])]
const r = rng(seed)
let k = 0
while (await extendSession({ home, writer: true }, id, 4)) {
  if (r() < idle) saveIndexes()
  if (++k === kill) { process.stdout.write(JSON.stringify({ slices: k, killed: true })); process.exit(0) }
  await new Promise((ok) => setImmediate(ok))
}
saveIndexes()
process.stdout.write(JSON.stringify({ slices: k, killed: false }))`

async function worker(home, id, { kill = 0, idle = 0.2, seed = 1 } = {}) {
  const c = spawn(process.execPath, ['--require', NO_REAL_OS, '--input-type=module', '-e', WORKER, home, id, String(kill), String(idle), String(seed)], { stdio: ['ignore', 'pipe', 'pipe'] })
  let out = '', err = ''
  c.stdout.on('data', (b) => { out += b }); c.stderr.on('data', (b) => { err += b })
  const [code] = await within(new Promise((ok) => c.on('close', (...a) => ok(a))), 120_000, 'the worker process', () => c.kill('SIGKILL'))
  assert.equal(code, 0, `the worker failed: ${err.split('\n').slice(0, 6).join(' / ')}`)
  return JSON.parse(out)
}

// The answers a reader gives (the local path, which folds nothing over a log that covers every member), as bytes.
async function answers(home, id, since) {
  const doc = await runQuery('session', { id }, { home })
  assert.equal(doc.pending, undefined, 'the session was folded whole')
  const out = { session: JSON.stringify(doc), since: JSON.stringify(await runQuery('session', { id, since }, { home })) }
  for (const l of doc.lanes) out[`lane ${l.lane}`] = JSON.stringify(await runQuery('lane', { id, lane: l.lane }, { home }))
  return out
}

// The whole lines of a file past its header (a torn tail no append cut is no line).
const linesOf = (file) => fs.readFileSync(file, 'utf8').split('\n').slice(1, -1).map((l) => JSON.parse(l))
// a value with its shared values (`{"$s": k}`, written once where they repeat: where depends on what the store held) in place
const deref = (v, S) => Array.isArray(v) ? v.map((x) => deref(x, S))
  : v && typeof v === 'object' ? (Object.keys(v).length === 1 && '$s' in v ? deref(S.get(v.$s), S) : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deref(x, S)]))) : v
function keyed(home, id) {
  const proj = new Map(), fold = new Map(), lines = linesOf(projectionFile(home, id)), S = new Map(lines.filter((o) => o.s).map((o) => [o.s.k, o.s.v]))
  for (const o of lines) {
    if (o.d) proj.set(`d ${o.d.bid}`, JSON.stringify(deref(o.d, S)))
    else if (o.c) proj.set(`c ${o.c.rid}`, JSON.stringify(deref(o.c, S)))
    else if (o.b) proj.set(`b ${JSON.stringify(o.b.brk)}`, JSON.stringify(deref(o.b, S)))
  }
  let last = null
  for (const o of linesOf(foldLogFile(home, id))) {
    const [kind] = Object.keys(o), { p, ...rest } = o
    if (kind === 'f') { const { pb, ...f } = o; last = f; continue }
    const key = kind === 'c' || kind === 'g' ? `rid ${o[kind]}` : kind === 'l' || kind === 'lg' ? `lane ${o[kind]}` : `${kind} ${o[kind]}`
    fold.set(key, JSON.stringify(rest))
  }
  return { proj, fold, last }
}
// the keys whose lines differ (a few), and the last frontiers
const differ = (a, b) => {
  const out = []
  for (const k of ['proj', 'fold']) for (const key of new Set([...a[k].keys(), ...b[k].keys()])) if (a[k].get(key) !== b[k].get(key)) out.push(`${k} ${key}`)
  return { lines: out.slice(0, 5), more: Math.max(0, out.length - 5), last: JSON.stringify(a.last) === JSON.stringify(b.last) }
}

// `file` cut at a seeded byte at or past what its sidecar covers (a torn tail); nothing when it has no sidecar
function tear(file, r) {
  const sc = loadSidecar({ file }), size = fs.statSync(file).size
  if (!sc || size <= sc.head.bytes) return false
  fs.truncateSync(file, sc.head.bytes + Math.floor(r() * (size - sc.head.bytes)))
  return true
}
// the fold log's sidecar with its reduction state's meta naming another REDUCE_V
function otherRv(home, id) {
  const file = foldLogFile(home, id), sc = loadSidecar({ file })
  const m = sc && sc.parts['r.m'], meta = m && JSON.parse(m[0])
  if (!meta) return false
  saveSidecar({ file, head: sc.head, parts: Object.entries({ ...sc.parts, 'r.m': [JSON.stringify({ ...meta, rv: meta.rv + 1 })] }) })
  return true
}

test('killed at any point and resumed from the sidecar: every answer and every keyed line equal a one-shot build (4.3 #1, #7; 3.5:42)', { timeout: 600_000 }, async (t) => {
  for (const wire of ['http', 'threads']) {
    const src = path.join(tmpDir('trocar-resume-'), '.trocar')
    const s = bigSession({ home: src, wire, ...SHAPE })
    s.append(360)
    const fresh = () => { const home = path.join(tmpDir('trocar-resume-'), '.trocar'); fs.cpSync(path.join(src, 'raw'), path.join(home, 'raw'), { recursive: true }); return home }
    const ref = fresh()
    while (await extendSession({ home: ref, writer: true }, s.id, Infinity));
    const members = (await runQuery('session', { id: s.id }, { home: ref })).calls.map((c) => c.rid)
    const since = members[Math.floor(members.length / 4)]
    const want = await answers(ref, s.id, since), wantLines = keyed(ref, s.id)
    const r = rng(wire === 'http' ? 11 : 23)
    const { slices } = await worker(fresh(), s.id, { seed: 5 })
    const seen = { killed: 0, torn: 0, otherRv: 0 }
    for (let trial = 0; trial < 7; trial++) {
      const home = fresh(), kill = 1 + Math.floor(r() * slices)
      const run = await worker(home, s.id, { kill, seed: trial, idle: trial % 2 ? 0.05 : 0.3 })
      if (run.killed) seen.killed++
      const how = Math.floor(r() * 4) // 0 none, 1 the fold log, 2 the projection, 3 both
      if (how & 1 && tear(foldLogFile(home, s.id), r)) seen.torn++
      if (how & 2 && tear(projectionFile(home, s.id), r)) seen.torn++
      if (trial === 6 && otherRv(home, s.id)) seen.otherRv++
      await worker(home, s.id, { seed: 100 + trial })
      const label = `${wire} trial ${trial} (killed after ${kill} of ${slices} slices, tear ${how})`
      const got = await answers(home, s.id, since)
      assert.deepEqual(Object.keys(want).filter((k) => got[k] !== want[k]), [], `${label}: the answers`)
      assert.deepEqual(differ(keyed(home, s.id), wantLines), { lines: [], more: 0, last: true }, `${label}: the keyed lines`)
    }
    t.diagnostic(JSON.stringify({ wire, slices, ...seen }))
    assert.ok(seen.killed >= 4 && seen.torn >= 1 && seen.otherRv === 1, `${wire}: the trials killed, tore and changed REDUCE_V: ${JSON.stringify(seen)}`)
  }
})

// What a worker reopened over a grown session reads of the projection and the fold log past opening them: by the new members, not
// by the members (follow-work.test.mjs's counting fs). N calls folded whole and saved at an idle period; M new calls appended; a
// fresh worker (a second fs object: fresh stores and states) folds to the end. The extraction context of a store opened anew still
// notes every call row once (createExtractContext, src/view/extract.mjs; seeded from the projection's sidecar by
// the fast-open work, which drops that allowance here).
const CTX = /[\\/]index[\\/]ctx[\\/][^\\/]+\.ndjson$/
const ctxBytes = (home) => { const d = path.join(home, 'index', 'ctx'); return fs.readdirSync(d).filter((f) => f.endsWith('.ndjson')).reduce((a, f) => a + fs.statSync(path.join(d, f)).size, 0) }
async function reopenAt(calls, M) {
  const home = path.join(tmpDir('trocar-regrow-'), '.trocar')
  const s = bigSession({ home, ...SHAPE, subEvery: 4, paths: 4 })
  s.append(calls)
  while (await extendSession({ home, writer: true }, s.id, Infinity));
  saveIndexes()
  let counting = false, bytes = 0
  const counted = () => {
    const fds = new Set()
    return { ...fs,
      openSync(p, ...a) { const fd = fs.openSync(p, ...a); if (CTX.test(String(p))) fds.add(fd); else fds.delete(fd); return fd },
      closeSync(fd) { fds.delete(fd); return fs.closeSync(fd) },
      readSync(fd, ...a) { const n = fs.readSync(fd, ...a); if (counting && fds.has(fd)) bytes += n; return n },
      readFileSync(p, ...a) { const b = fs.readFileSync(p, ...a); if (counting && CTX.test(String(p))) bytes += b.length; return b },
    }
  }
  const count = async (work) => { bytes = 0; counting = true; try { await work() } finally { counting = false } return bytes }
  // the call rows the extraction context of a store opened anew notes once, each read back (the fast-open work seeds it from the sidecar)
  const rows = fs.readFileSync(projectionFile(home, s.id), 'utf8').split('\n').filter((l) => l.startsWith('{"c":')).reduce((n, l) => n + Buffer.byteLength(l), 0)
  s.append(M)
  const open = await count(async () => {
    const own = counted(), p = openProjection({ home, fs: own, key: s.id, write: false })
    openFoldLog({ home, fs: own, key: s.id, write: false, projection: { id: p.id, bytes: p.bytes } }).close()
    p.close()
  })
  const was = ctxBytes(home), own = counted()
  const read = await count(async () => { while (await extendSession({ home, fs: own, writer: true }, s.id, Infinity)); })
  return { read: read - open, appended: ctxBytes(home) - was, rows }
}

test('a reopened worker over a grown session folds only the new members: what it reads past opening at 4N is what it reads at N (3.5:42; 4.3 #7)', { timeout: 300_000 }, async () => {
  const M = 6, a = await reopenAt(300, M), b = await reopenAt(1200, M)
  // past opening, it reads the call rows the extraction context notes (one read of each, until the fast-open work seeds them from the sidecar), and by the new members only
  assert.ok(b.read <= a.read + b.appended + (b.rows - a.rows), `projection and fold log bytes read past opening at 300 / 1200 calls (+${M} new): ${JSON.stringify({ a, b })}`)
})
