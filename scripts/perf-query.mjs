// scripts/perf-query.mjs — the measurements of spec 1.6 附录 D.2 on a dataset made by gen-dataset.mjs:
// every named query's cold-process wall clock (5 runs, median), the sealing ratio, what ~/.asight
// occupies, and whether the daemon's auto-sealing sealed every closed segment and how long it took.
//
//   node scripts/perf-query.mjs --home <HOME> [--runs 5] [--queries sessions,calls] [--compare <dir>] [--json]
//
// --home is the HOME the dataset lives in (<HOME>/.asight), so each run is a real cold `asight` process
// against it. The index is removed first (it is a rebuildable projection) to time building it once.
// They are acceptance only as spec 1.6 附录 D.2 defines it; a run is not one on its own.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { QUERIES } from '../src/query/named/index.mjs'

export const DEFAULT_RUNS = 5
const CLI = path.join(import.meta.dirname, '..', 'bin', 'asight.mjs')
// Queries that need a parameter take its value from another query's document (附录 C.5 key → the flag to pass).
// `block` is measured on the LAST record of the biggest segment: that is the worst case for reading one record
// back (§4.1 ≤ 0.3 s), and the ref `<segment>:<line>` is what C.5 calls a record.
const ARG_FROM = {
  session: { query: 'sessions', flag: '--id', pick: (d) => (d.sessions || [])[0]?.session_id },
  block: { query: 'segments', flag: '--ref', pick: (d) => { const s = (d.segments || []).filter((x) => x.records > 0).sort((a, b) => a.bytes - b.bytes).pop(); return s ? `${s.segment}:${s.records}` : null } },
}

/** The named queries to measure: every name `asight query` has (src/query/named/index.mjs QUERIES — one fact, one place). */
export function queryNames() { return Object.keys(QUERIES) }

export const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2 }

/** Bytes of a directory tree, in JS (no OS tools), 0 when it does not exist. */
export function dirBytes(dir) {
  let total = 0
  for (const ent of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    const p = path.join(ent.parentPath ?? ent.path, ent.name)
    if (ent.isFile()) total += fs.statSync(p).size
  }
  return total
}
const sizeOr0 = (p) => { try { return fs.statSync(p).isDirectory() ? dirBytes(p) : fs.statSync(p).size } catch { return 0 } }

/** One cold `asight <argv…>` process: its wall clock, exit code and parsed --json document. */
export function runQuery(home, argv) {
  const t = process.hrtime.bigint()
  const r = spawnSync(process.execPath, [CLI, ...argv, '--json'], { env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8', maxBuffer: 1 << 28 })
  const ms = Number(process.hrtime.bigint() - t) / 1e6
  let doc = null
  try { doc = JSON.parse(r.stdout) } catch { /* a failed command has no document; the exit code says so */ }
  return { ms, status: r.status, doc, stderr: (r.stderr || '').trim().split('\n').slice(0, 2).join(' ') }
}

/** Sealing ratio per segment and overall, from the `segments` document (附录 C.5). */
export function sealingReport(segmentsDoc) {
  const segments = (segmentsDoc?.segments || []).map((s) => ({ segment: s.segment, state: s.state, records: s.records, bytes: s.bytes, sealed_bytes: s.sealed_bytes, ratio: s.ratio, problems: s.problems || [] }))
  const sealed = segments.filter((s) => s.sealed_bytes > 0)
  const plain = sealed.reduce((n, s) => n + (s.bytes || 0), 0)
  return { segments, ratio: plain ? sealed.reduce((n, s) => n + s.sealed_bytes, 0) / plain : null }
}

/**
 * Did auto-sealing seal every closed segment, and how long did each take?
 * Closed = a segment that is not the daemon's current one. SEALED = `state: "sealed"`, which the read side says
 * only when the plaintext is GONE (4.2:30 明文为准): a segment that still has its plaintext beside a sealed copy
 * is not done, however many sealed bytes it has (a test-machine run 2026-10-18 looked like 8/8 sealed). The per-segment
 * duration comes from the sealer's own journal line (raw/journal.jsonl, `took_ms`).
 */
export function autosealReport({ segmentsDoc, journal = [] }) {
  const took = new Map(journal.filter((l) => l && l.op === 'seal' && l.outcome === 'ok' && l.segment).map((l) => [l.segment, l.took_ms ?? l.duration_ms ?? null]))
  const closed = (segmentsDoc?.segments || []).filter((s) => s.state !== 'writing')
  const segments = closed.map((s) => ({ segment: s.segment, state: s.state, sealed: s.state === 'sealed', plaintext_left: s.state !== 'sealed' && s.sealed_bytes > 0, took_ms: took.get(s.segment) ?? null, problems: s.problems || [] }))
  return { closed: segments.length, sealed: segments.filter((s) => s.sealed).length, unsealed: segments.filter((s) => !s.sealed).map((s) => s.segment), plaintext_left: segments.filter((s) => s.plaintext_left).map((s) => s.segment), segments }
}

function readJournal(asightHome) {
  try { return fs.readFileSync(path.join(asightHome, 'raw', 'journal.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }) } catch { return [] }
}

/** measure({home, runs, names, compare}) → the whole 附录 D.2 report. */
export function measure({ home, runs = DEFAULT_RUNS, names = queryNames(), compare = null }) {
  const asightHome = path.join(home, '.asight')
  const indexPath = path.join(asightHome, 'index')
  fs.rmSync(indexPath, { recursive: true, force: true })  // a rebuildable projection: timed once, cold
  // `segments` reads EVERY segment, so this one process builds the whole index — which is what the
  // following medians are measured with. A build that failed or wrote nothing is said so (a run once:
  // the build step ran a name that is not a query, exited 2, and every median was index-less).
  const build = runQuery(home, ['query', 'segments'])
  const index = { built_by: 'segments', build_ms: Math.round(build.ms), status: build.status, bytes: sizeOr0(indexPath) }
  if (build.status !== 0 || index.bytes === 0) index.error = build.status ? build.stderr : 'the build wrote no index file'

  const docs = new Map([['segments', build.doc]])
  // A query whose parameter comes from another document is given it, even when that one is measured later.
  const docOf = (name) => { if (!docs.has(name)) docs.set(name, runQuery(home, ['query', name]).doc); return docs.get(name) || {} }
  const queries = []
  for (const name of names) {
    const arg = ARG_FROM[name]
    const value = arg ? arg.pick(docOf(arg.query)) : null
    if (arg && !value) { queries.push({ query: name, skipped: `no value for ${arg.flag} in the ${arg.query} document` }); continue }
    const times = []
    let last = null
    for (let i = 0; i < runs; i++) { last = runQuery(home, value ? ['query', name, arg.flag, value] : ['query', name]); times.push(last.ms) }
    docs.set(name, last.doc)
    queries.push({ query: name, ...(value ? { arg: `${arg.flag} ${value}` } : {}), runs: times.map((t) => Math.round(t)), median_ms: Math.round(median(times)), status: last.status, ...(last.status ? { error: last.stderr } : {}) })
  }

  const rawDir = path.join(asightHome, 'raw')
  const files = fs.existsSync(rawDir) ? fs.readdirSync(rawDir) : []
  const disk = {
    asight_bytes: sizeOr0(asightHome),
    plaintext_bytes: files.filter((f) => f.endsWith('.ndjson')).reduce((n, f) => n + sizeOr0(path.join(rawDir, f)), 0),
    sealed_bytes: files.filter((f) => f.endsWith('.sealed')).reduce((n, f) => n + sizeOr0(path.join(rawDir, f)), 0),
    index_bytes: index.bytes,
    ...(compare ? { compare: { dir: compare, bytes: sizeOr0(compare) } } : {}),
  }
  const segmentsDoc = docs.get('segments') || runQuery(home, ['query', 'segments']).doc
  return { home, runs, index, queries, sealing: sealingReport(segmentsDoc), autoseal: autosealReport({ segmentsDoc, journal: readJournal(asightHome) }), disk }
}

function main(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 2) args[argv[i].replace(/^--/, '')] = argv[i + 1]
  if (!args.home) { console.error('usage: node scripts/perf-query.mjs --home <HOME> [--runs 5] [--queries a,b] [--compare <dir>] [--json]'); process.exit(2) }
  const out = measure({ home: args.home, runs: args.runs ? Number(args.runs) : undefined, names: args.queries ? args.queries.split(',') : undefined, compare: args.compare || null })
  if ('json' in args) { console.log(JSON.stringify(out, null, 2)); return }
  console.log(`index  built by query ${out.index.built_by}  ${out.index.build_ms} ms  ${out.index.bytes} bytes${out.index.error ? `  FAILED: ${out.index.error}` : ''}`)
  for (const q of out.queries) console.log(`  ${q.query.padEnd(10)} ${q.skipped ? q.skipped : `${String(q.median_ms).padStart(6)} ms median of ${q.runs.length}${q.status ? `  FAILED: ${q.error}` : ''}`}`)
  console.log(`sealing  ratio ${out.sealing.ratio == null ? 'unknown' : out.sealing.ratio.toFixed(3)}  segments ${out.sealing.segments.length}`)
  for (const s of out.sealing.segments) console.log(`  ${s.segment}  ${s.state.padEnd(8)} ${String(s.bytes).padStart(12)} → ${String(s.sealed_bytes).padStart(12)}  ratio ${s.ratio ?? '-'}${s.problems.length ? `  ${s.problems.map((p) => p.code).join(',')}` : ''}`)
  console.log(`autoseal  ${out.autoseal.sealed}/${out.autoseal.closed} closed segments sealed${out.autoseal.unsealed.length ? `  still plaintext: ${out.autoseal.unsealed.join(', ')}` : ''}${out.autoseal.plaintext_left.length ? `  sealed but the plaintext is still there: ${out.autoseal.plaintext_left.join(', ')}` : ''}`)
  for (const s of out.autoseal.segments) if (s.took_ms != null) console.log(`  ${s.segment}  ${s.took_ms} ms`)
  console.log(`disk  .asight ${out.disk.asight_bytes}  plaintext ${out.disk.plaintext_bytes}  sealed ${out.disk.sealed_bytes}  index ${out.disk.index_bytes}${out.disk.compare ? `  ${out.disk.compare.dir} ${out.disk.compare.bytes}` : ''}`)
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main(process.argv.slice(2))
