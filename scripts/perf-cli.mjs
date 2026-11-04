// scripts/perf-cli.mjs — the CLI performance baseline of spec 1.6 §3 / §4.1 (D62), on one dataset, in one command:
//
//   node scripts/perf-cli.mjs --home <HOME> [--runs 7] [--only sessions,status] [--json out.json]
//   node scripts/perf-cli.mjs --idle <pid> [--seconds 60]        ← the resource line of §3.1 (D62④) on a running daemon
//   node scripts/perf-cli.mjs --write-amp <HOME> [--records 200]  ← the write-amplification line of §3.1, both halves
//   node scripts/perf-cli.mjs --reply-reads <HOME> --lane-doc a.json[,b.json]  ← 2.3 #42: each step's reply, `block` in one process
//
// It reports, per command: the COLD wall clock (the index deleted first), the WARM p50/p95 wall clock, the
// command's own CPU time and peak RSS, and — separately — the CORE time, which is runQuery inside an already
// running process. The core time is what a board server pays per click; the wall clock is the core plus the
// FLOOR (node's own boot plus trocar's module load), which this script measures on its own line.
// `nearby` is the sequence §4.1 calls 「附近的查询」: a session is open, and the next page / another step's block /
// its calls follow in the SAME process — the 50 ms budget is theirs.
// `--idle <pid>` is the OTHER half of D62: the daemon's own idle cost, read the way §3.1 says (two readings of
// `top`, never one cumulative row) plus the CPU-time delta over `--seconds` of idle.
//
// Every number is wall clock from one process per run, so nothing here can be faster than the product is.
// Measurement only: it writes nothing but the index the queries themselves write (and `--json`'s file).
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { median } from './perf-query.mjs'

const CLI = path.join(import.meta.dirname, '..', 'bin', 'trocar.mjs')
const SELF = import.meta.filename
const DEFAULT_RUNS = 7

// ── the wrapper: a real cold `trocar` process that also reports its own CPU and RSS ──────────────
// `--wrap <file> -- <argv…>` runs the CLI in this process and, on exit (the CLI may exit itself), appends
// its cpuUsage and peak RSS to <file>. The modules are the same ones bin/trocar.mjs loads, so the wall
// clock the parent measures is the product's, plus this file's own import.
async function wrap(out, argv) {
  process.on('exit', () => {
    const cpu = process.cpuUsage(), mem = process.memoryUsage()
    try { fs.writeFileSync(out, JSON.stringify({ cpu_user_ms: cpu.user / 1e3, cpu_sys_ms: cpu.system / 1e3, rss_kb: Math.round(mem.rss / 1024) })) } catch { /* the parent falls back to no counters */ }
  })
  const { runCli } = await import('../src/cli/main.mjs')
  process.exitCode = await runCli(argv)
}

const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] }

/** One cold process: { ms, status, doc, cpu_ms, rss_kb }. `argv` is what follows `trocar`. */
function run(home, argv, { json = true } = {}) {
  const out = path.join(fs.mkdtempSync(path.join(fs.realpathSync(require_tmp()), 'perf-')), 'm.json')
  const t = process.hrtime.bigint()
  const r = spawnSync(process.execPath, [SELF, '--wrap', out, '--', ...argv, ...(json ? ['--json'] : [])],
    { env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8', maxBuffer: 1 << 28 })
  const ms = Number(process.hrtime.bigint() - t) / 1e6
  let m = {}
  try { m = JSON.parse(fs.readFileSync(out, 'utf8')) } catch { /* no counters */ }
  fs.rmSync(path.dirname(out), { recursive: true, force: true })
  let doc = null
  try { doc = JSON.parse(r.stdout) } catch { /* a failed command has no document */ }
  return { ms, status: r.status, doc, cpu_ms: m.cpu_user_ms == null ? null : m.cpu_user_ms + m.cpu_sys_ms, rss_kb: m.rss_kb ?? null,
    stderr: (r.stderr || '').trim().split('\n').slice(0, 2).join(' ') }
}
const require_tmp = () => process.env.TMPDIR || process.env.TEMP || '/tmp'

/** darwin only: the disk the run read, from /usr/bin/time -l ("block input operations"). null elsewhere. */
function diskRead(home, argv) {
  if (process.platform !== 'darwin') return null
  const r = spawnSync('/usr/bin/time', ['-l', process.execPath, CLI, ...argv, '--json'],
    { env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8', maxBuffer: 1 << 28 })
  const m = /(\d+)\s+block input operations/.exec(r.stderr || '')
  return m ? Number(m[1]) : null
}

// ── what is measured ──────────────────────────────────────────────────────────────────────────────
// $session / $ref / $harness come from a discovery run, so the script works on any dataset.
const CMDS = [
  ['pricing', ['query', 'pricing'], { core: ['pricing', {}] }],
  ['segments', ['query', 'segments'], { core: ['segments', {}] }],
  ['classes', ['query', 'classes'], { core: ['classes', {}] }],
  ['sessions', ['query', 'sessions'], { core: ['sessions', {}] }],
  ['session', ['query', 'session', '--id', '$session'], { core: ['session', { id: '$session' }] }],
  ['calls', ['query', 'calls'], { core: ['calls', {}] }],
  ['block', ['query', 'block', '--ref', '$ref'], { core: ['block', { ref: '$ref' }] }],
  ['raw', ['raw', '$ref'], { json: false }],
  ['status', ['status'], { core: ['status', {}] }],
  ['status-harness', ['status', '$harness'], { core: ['status', { harness: '$harness' }] }],
  ['doctor', ['doctor'], { core: ['doctor', {}] }],
]
const fill = (argv, vars) => argv.map((a) => (a.startsWith('$') ? vars[a.slice(1)] : a))
const fillParams = (p, vars) => Object.fromEntries(Object.entries(p).map(([k, v]) => [k, typeof v === 'string' && v.startsWith('$') ? vars[v.slice(1)] : v]))

/** The floor every command pays: node's own boot, and node plus trocar's module load (`--version`). */
function floor(home, runs) {
  const boot = [], load = []
  for (let i = 0; i < runs; i++) {
    let t = process.hrtime.bigint()
    spawnSync(process.execPath, ['-e', '0'], { encoding: 'utf8' })
    boot.push(Number(process.hrtime.bigint() - t) / 1e6)
    t = process.hrtime.bigint()
    spawnSync(process.execPath, [CLI, '--version'], { env: { ...process.env, HOME: home, USERPROFILE: home }, encoding: 'utf8' })
    load.push(Number(process.hrtime.bigint() - t) / 1e6)
  }
  return { node_boot_ms: Math.round(median(boot)), cli_version_ms: Math.round(median(load)), module_load_ms: Math.round(median(load) - median(boot)) }
}

/** The in-process times: runQuery once (cold index) then `runs` times, in ONE process. Plus the nearby sequence. */
async function cores({ home, names, vars, runs }) {
  const { runQuery } = await import('../src/query/named/index.mjs')
  const ctx = { home: path.join(home, '.trocar'), userHome: home, env: { ...process.env, HOME: home, USERPROFILE: home }, platform: process.platform }
  const timed = async (name, params) => { const t = process.hrtime.bigint(); let doc = null, error = null
    try { doc = await runQuery(name, params, ctx) } catch (e) { error = String((e && e.message) || e) }
    return { ms: Number(process.hrtime.bigint() - t) / 1e6, doc, error } }
  const out = {}
  for (const [label, , opt] of CMDS) {
    if (!opt?.core || !names.includes(label)) continue
    const [name, rawParams] = opt.core
    const params = fillParams(rawParams, vars)
    if (Object.values(params).some((v) => v == null)) continue
    const first = await timed(name, params)
    const ms = []
    for (let i = 0; i < runs; i++) ms.push((await timed(name, params)).ms)
    out[label] = { no_index_ms: Math.round(first.ms), p50_ms: Math.round(median(ms)), p95_ms: Math.round(pct(ms, 95)), ...(first.error ? { error: first.error } : {}) }
  }
  // 附近的查询 (§4.1 ≤ 50 ms): the session is open; these are the clicks that follow, in the same process.
  const nearby = []
  if (vars.session) {
    const open = await timed('session', { id: vars.session })
    const page = open.doc?.page || {}
    const steps = (open.doc?.records || []).map((r) => r.ref || r.text_ref).filter(Boolean)
    const seq = [
      ['session page 2', 'session', { id: vars.session, after: page.next ?? '1', limit: String(page.limit ?? 50) }],
      ['block of another step', 'block', { ref: steps[1] || vars.ref }],
      ['calls of this session', 'calls', { session: vars.session }],
      ['sessions (the list again)', 'sessions', {}],
    ]
    for (const [label, name, params] of seq) {
      const ms = []
      let err = null
      for (let i = 0; i < runs; i++) { const r = await timed(name, params); ms.push(r.ms); err = err || r.error }
      nearby.push({ step: label, p50_ms: Math.round(median(ms)), p95_ms: Math.round(pct(ms, 95)), ...(err ? { error: err } : {}) })
    }
    out.__open_ms = Math.round(open.ms)
  }
  return { core: out, nearby }
}

export async function measure({ home, runs = DEFAULT_RUNS, only = null }) {
  const indexPath = path.join(home, '.trocar', 'index')
  const names = CMDS.map(([n]) => n).filter((n) => !only || only.includes(n))
  // What the daemon leaves behind (D62, 4.2 §段索引): a reader never writes a plaintext segment's index, so after a
  // COLD run (the index deleted) the index has to be put back the way the keeper would have, or every "warm" run
  // would measure the fallback build instead of the product.
  const { allSegments, segmentIndex } = await import('../src/query/index-build.mjs')
  const kept = async () => { const h = path.join(home, '.trocar'); for (const s of await allSegments({ home: h })) await segmentIndex({ home: h, segment: s.segment, owner: true }) }
  // discovery (warm, index built): the id / ref / harness the parameterised commands use
  fs.rmSync(indexPath, { recursive: true, force: true })
  // `index_build_ms` is the REAL build — what the daemon's keeper pays to index a whole cold home, and what a user
  // pays once after deleting `index/`. A query over a plaintext segment writes nothing, so timing one would have
  // measured the reader's in-memory scan of that one query instead.
  const t0 = process.hrtime.bigint()
  await kept()
  const buildMs = Number(process.hrtime.bigint() - t0) / 1e6
  const segDoc = run(home, ['query', 'segments'])
  const sesDoc = run(home, ['query', 'sessions'])
  const big = (segDoc.doc?.segments || []).filter((s) => s.records > 0).sort((a, b) => a.bytes - b.bytes).pop()
  const { HARNESS_IDS } = await import('../src/off/harness-names.mjs')  // one fact, one place (0.1 §2)
  const vars = {
    session: (sesDoc.doc?.sessions || [])[0]?.session_id ?? null,
    ref: big ? `${big.segment}:${big.records}` : null,
    harness: HARNESS_IDS[0],
  }
  const dataset = { segments: (segDoc.doc?.segments || []).length, records: (segDoc.doc?.segments || []).reduce((n, s) => n + s.records, 0),
    bytes: (segDoc.doc?.segments || []).reduce((n, s) => n + (s.bytes || 0), 0), index_build_ms: Math.round(buildMs) }

  const commands = []
  for (const [label, argv, opt] of CMDS) {
    if (!names.includes(label)) continue
    const filled = fill(argv, vars)
    if (filled.some((a) => a == null)) { commands.push({ command: label, skipped: 'no value for its parameter in this dataset' }); continue }
    fs.rmSync(indexPath, { recursive: true, force: true })
    const noIndex = run(home, filled, opt)
    await kept()
    const warm = []
    let last = noIndex
    for (let i = 0; i < runs; i++) { last = run(home, filled, opt); warm.push(last.ms) }
    commands.push({ command: label, argv: filled.join(' '),
      // `no_index_ms`: this one run had `index/` deleted, so it is the fallback (the reader's own in-memory scan,
      // which reports `index-cold`) — NOT what a user sees with a daemon that keeps the index current (`p50`/`p95`).
      no_index_ms: Math.round(noIndex.ms), p50_ms: Math.round(median(warm)), p95_ms: Math.round(pct(warm, 95)),
      cpu_ms: last.cpu_ms == null ? null : Math.round(last.cpu_ms), rss_kb: last.rss_kb,
      disk_read_blocks: diskRead(home, filled), status: last.status, ...(last.status ? { error: last.stderr } : {}) })
  }
  const { core, nearby } = await cores({ home, names, vars, runs })
  return { platform: process.platform, node: process.version, home, runs, dataset, vars, floor: floor(home, runs), commands, core, nearby }
}

// ── the idle daemon: §3.1's resource line, read the way §3.1 says ────────────────────────────────
// macOS `top` reports every per-process counter CUMULATIVELY SINCE LAUNCH in its default mode — in EVERY
// sample, not just the first; the `+` it appends only means "this grew". That is why a `top -l 2` row once
// read 75 wakeups/s for a daemon doing ~1.4: 75 was its total since launch. Two readings give a rate, and
// this does both: `-c d` (delta mode), whose samples after the first are true per-interval deltas, and the
// difference between consecutive cumulative samples. IDLEW is pinned to 0 on a machine that is never idle
// (no idle CPU to wake), so CSW ≥ IDLEW is reported beside it as the usable upper bound. CPU comes from
// `ps -o time=` before and after, not from top's instantaneous %.
function idle(pid, seconds) {
  const secs = (t) => { const p = String(t).trim().split(':').map(Number); return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1] }
  const cpu = () => { const r = spawnSync('ps', ['-p', String(pid), '-o', 'time='], { encoding: 'utf8' }); return r.status !== 0 || !r.stdout.trim() ? null : secs(r.stdout) }
  const t0 = cpu()
  if (t0 == null) throw new Error(`no process ${pid}`)
  const samples = 5
  const n = (x) => Number(String(x).replace('+', ''))
  const top = (mode) => {
    const r = spawnSync('top', [...(mode ? ['-c', mode] : []), '-l', String(samples + 1), '-s', '1', '-stats', 'pid,cpu,idlew,csw', '-pid', String(pid)], { encoding: 'utf8', timeout: (samples + 10) * 1000 })
    return (r.stdout || '').split('\n').map((l) => l.trim()).filter((l) => l.startsWith(`${pid} `)).map((l) => l.split(/\s+/))
  }
  const d = top('d') // delta mode: every sample after the first is the per-second change
  const per_second = d.slice(1).map((c) => ({ cpu_pct: n(c[1]), idlew: n(c[2]), csw: n(c[3]) }))
  const c = top(null) // the same thing the other way: consecutive cumulative samples, differenced here
  const differenced = c.slice(1).map((row, i) => ({ idlew: n(row[2]) - n(c[i][2]), csw: n(row[3]) - n(c[i][3]) }))
  const left = Math.max(0, seconds * 1000 - 2 * samples * 1000)
  if (left) spawnSync(process.execPath, ['-e', `setTimeout(()=>{}, ${left})`])
  const t1 = cpu()
  return { pid, seconds, cumulative_at_start: c.length ? { idlew: n(c[0][2]), csw: n(c[0][3]) } : null, per_second, differenced,
    worst: per_second.length ? { idlew: Math.max(...per_second.map((s) => s.idlew)), csw: Math.max(...per_second.map((s) => s.csw)), cpu_pct: Math.max(...per_second.map((s) => s.cpu_pct)) } : null,
    mean: per_second.length ? { idlew: +(per_second.reduce((a, s) => a + s.idlew, 0) / per_second.length).toFixed(1), csw: +(per_second.reduce((a, s) => a + s.csw, 0) / per_second.length).toFixed(1) } : null,
    cpu_ms_per_minute: t1 == null ? null : Math.round(((t1 - t0) / seconds) * 60 * 1000) }
}

function printIdle(o) {
  console.log(`daemon pid ${o.pid}  (top's default mode is CUMULATIVE since launch in every row: idlew ${o.cumulative_at_start?.idlew} csw ${o.cumulative_at_start?.csw} — NOT a rate)`)
  for (const s of o.per_second) console.log(`  per second   idlew ${String(s.idlew).padStart(5)}   csw ${String(s.csw).padStart(5)}   cpu ${s.cpu_pct} %`)
  console.log(`  cross-check (cumulative, differenced): idlew ${o.differenced.map((s) => s.idlew).join(' ')} | csw ${o.differenced.map((s) => s.csw).join(' ')}`)
  console.log(`worst/s      idlew ${o.worst?.idlew}  csw ${o.worst?.csw}  cpu ${o.worst?.cpu_pct} %   mean/s  idlew ${o.mean?.idlew}  csw ${o.mean?.csw}     (§3.1: ≤ 10 idle wakeups/s, ≤ 1 % CPU)`)
  console.log(`cpu          ${o.cpu_ms_per_minute} ms per minute over ${o.seconds} s idle`)
}

// ── the write-amplification line of §3.1 (D62), both halves ───────────────────────────────
// Written bytes = the plaintext segments plus their index (the sealed copies do not count, §3.1).
// (a) THE RATIO, on the reference mix scripts/gen-dataset.mjs generates: that is where it means something, because
//     LLM calls dominate the bytes there, as they do in real traffic.
// (b) AN ABSOLUTE BOUND PER RECORD, in the worst arrival shape: one tiny record per keeper pass. A pass costs one
//     entry line plus one mark line whatever the record was, so a 236 B record can cost ~2 index bytes per captured
//     byte — a ratio that says nothing, since the bytes themselves are a few hundred. The bound is what to hold.
const du = (dir, match = () => true) => { let n = 0
  let names = []
  try { names = fs.readdirSync(dir) } catch { return 0 }
  for (const f of names) { if (!match(f)) continue; try { n += fs.statSync(path.join(dir, f)).size } catch { /* gone */ } }
  return n }

/** (b) One tiny record per keeper pass, `n` times → index bytes per record. Its own throwaway HOME. */
async function sparseAmp(n) {
  const { segmentIndex, indexDir } = await import('../src/query/index-build.mjs')
  const { fillUsage } = await import('../src/query/usage.mjs')
  const { envLine } = await import('../test/query/raw-home.mjs') // one record shape, one place (0.1 §2)
  const dir = fs.mkdtempSync(path.join(require_tmp(), 'perf-amp-'))
  const h = path.join(dir, '.trocar'), seg = '20261020T100000Z'
  fs.mkdirSync(path.join(h, 'raw'), { recursive: true })
  const file = path.join(h, 'raw', `${seg}.ndjson`)
  for (let i = 0; i < n; i++) {
    fs.appendFileSync(file, envLine({ id: `req_${String(i).padStart(5, '0')}` }) + '\n')
    await segmentIndex({ home: h, segment: seg, owner: true }) // exactly what one keeper pass does
    await fillUsage({ home: h, segments: [seg] }) // and the worker's sidecar fill after the next overview
  }
  const captured = fs.statSync(file).size
  const index = du(indexDir(h)), usage = du(indexDir(h), (f) => f.endsWith('.usage.json'))
  fs.rmSync(dir, { recursive: true, force: true })
  return { records: n, record_bytes: Math.round(captured / n), captured_bytes: captured, index_bytes: index, usage_bytes: usage,
    index_bytes_per_record: Math.round(index / n), bytes_written_per_captured_byte: +((captured + index) / captured).toFixed(2) }
}

/** (a) the reference mix already in <home>/.trocar/raw, indexed the way the daemon's keeper does. */
async function writeAmp({ home, records }) {
  const { allSegments, segmentIndex, indexDir } = await import('../src/query/index-build.mjs')
  const { fillUsage } = await import('../src/query/usage.mjs')
  const h = path.join(home, '.trocar')
  fs.rmSync(path.join(h, 'index'), { recursive: true, force: true })
  const segs = await allSegments({ home: h })
  const t0 = process.hrtime.bigint()
  for (const s of segs) await segmentIndex({ home: h, segment: s.segment, owner: true })
  const build_ms = Math.round(Number(process.hrtime.bigint() - t0) / 1e6)
  const t1 = process.hrtime.bigint()
  await fillUsage({ home: h, segments: segs.map((s) => s.segment) }) // the usage sidecars live in index/ too
  const usage_fill_ms = Math.round(Number(process.hrtime.bigint() - t1) / 1e6)
  let wire = 0, stored = 0, n = 0
  for (const s of segs) {
    const r = await segmentIndex({ home: h, segment: s.segment })
    for (const rec of r.records) { wire += (rec.sent_bytes || 0) + (rec.received_bytes || 0); stored += rec.stored_bytes || 0; n++ }
  }
  const plaintext = du(path.join(h, 'raw'), (f) => f.endsWith('.ndjson'))
  const index = du(indexDir(h)), usage = du(indexDir(h), (f) => f.endsWith('.usage.json'))
  return { mix: { segments: segs.length, records: n, plaintext_bytes: plaintext, index_bytes: index, usage_bytes: usage,
      usage_bytes_per_plaintext_byte: plaintext ? +(usage / plaintext).toFixed(5) : null,
      captured_wire_bytes: wire, stored_record_bytes: stored, build_ms, usage_fill_ms,
      bytes_written_per_captured_byte: wire ? +((plaintext + index) / wire).toFixed(3) : null,
      index_bytes_per_captured_byte: wire ? +(index / wire).toFixed(4) : null },
    sparse: await sparseAmp(records) }
}

function printAmp(o) {
  const m = o.mix, s = o.sparse
  console.log(`reference mix (gen-dataset): ${m.segments} segments  ${m.records} records  plaintext ${(m.plaintext_bytes / 1e6).toFixed(1)} MB  index + usage sidecar ${(m.index_bytes / 1e6).toFixed(2)} MB  (index built in ${m.build_ms} ms, usage filled in ${m.usage_fill_ms} ms; sidecar ${(m.usage_bytes / 1e3).toFixed(1)} kB = ${m.usage_bytes_per_plaintext_byte} B per raw byte)`)
  console.log(`  captured (wire) ${(m.captured_wire_bytes / 1e6).toFixed(1)} MB → WRITTEN PER CAPTURED BYTE ${m.bytes_written_per_captured_byte}   (§3.1: ≤ 1.1; index + usage sidecar alone is ${m.index_bytes_per_captured_byte})`)
  console.log(`worst arrival shape: ${s.records} × one ${s.record_bytes} B record per keeper pass  index + usage sidecar ${(s.index_bytes / 1024).toFixed(1)} KiB (sidecar ${(s.usage_bytes / 1024).toFixed(1)} KiB)`)
  console.log(`  INDEX + USAGE SIDECAR PER RECORD ${s.index_bytes_per_record} B   (§3.1: ≤ 1 KB; the ratio here would be ${s.bytes_written_per_captured_byte}, which is meaningless at this size)`)
}

// 2.3 #42: a step's reply text, read the way the desk reads it when the playhead rests on that step: one `block` with the step's own
// reply refs, in one process, step after step. `--lane-doc` is what `trocar query lane --json` answered (the steps and the definitions
// their reply ids name), so the walk costs no fold and the dataset needs no projection of this build. Sealed and live are apart: the
// two read a record differently (a frame decoded, a line at its offset), and a live segment's index is still growing.
const REPLY_LINE_MS = 50
async function replyReads({ home, docs }) {
  const { runQuery } = await import('../src/query/named/index.mjs')
  const h = path.join(home, '.trocar')
  const ctx = { home: h, userHome: home, env: { ...process.env, HOME: home, USERPROFILE: home }, platform: process.platform }
  await runQuery('segments', {}, ctx) // the desk is open: every segment's rows are already in memory
  const ms = { sealed: [], live: [] }
  let errors = 0
  for (const doc of docs) for (const step of doc.steps) {
    const ref = (step.reply || []).map((bid) => doc.defs.find((d) => d.bid === bid)?.ref).filter(Boolean)
    if (!ref.length) continue
    const t = process.hrtime.bigint()
    const got = await runQuery('block', { ref }, ctx)
    ms[fs.existsSync(path.join(h, 'raw', `${step.rid.split(':')[0]}.ndjson`)) ? 'live' : 'sealed'].push(Number(process.hrtime.bigint() - t) / 1e6)
    errors += got.errors.length
  }
  const row = (v) => (v.length ? { n: v.length, p50_ms: +pct(v, 50).toFixed(1), p95_ms: +pct(v, 95).toFixed(1), max_ms: +Math.max(...v).toFixed(1) } : { n: 0 })
  return { line_ms: REPLY_LINE_MS, sealed: row(ms.sealed), live: row(ms.live), errors }
}

function printReplies(o) {
  for (const k of ['sealed', 'live']) {
    const r = o[k]
    console.log(`${k.padEnd(7)} n ${String(r.n).padStart(4)}${r.n ? `  p50 ${r.p50_ms} ms  p95 ${r.p95_ms} ms  max ${r.max_ms} ms  line ${o.line_ms} ms  ${r.p95_ms <= o.line_ms ? 'within' : 'OVER'}` : ''}`)
  }
  console.log(`errors  ${o.errors}`)
}

function print(out) {
  const t = out.dataset
  console.log(`dataset  ${t.segments} segments  ${t.records} records  ${(t.bytes / 2 ** 30).toFixed(2)} GiB  index build (the keeper's, whole home) ${t.index_build_ms} ms`)
  console.log(`floor    node boot ${out.floor.node_boot_ms} ms  +trocar module load ${out.floor.module_load_ms} ms  (= ${out.floor.cli_version_ms} ms before any work)`)
  console.log('command         noindex    p50    p95   core50  core95   cpu    rss(MB)  diskblk')
  for (const c of out.commands) {
    if (c.skipped) { console.log(`  ${c.command.padEnd(16)}${c.skipped}`); continue }
    const k = out.core[c.command] || {}
    console.log(`  ${c.command.padEnd(16)}${String(c.no_index_ms).padStart(5)}${String(c.p50_ms).padStart(7)}${String(c.p95_ms).padStart(7)}${String(k.p50_ms ?? '-').padStart(8)}${String(k.p95_ms ?? '-').padStart(8)}${String(c.cpu_ms ?? '-').padStart(7)}${String(c.rss_kb == null ? '-' : (c.rss_kb / 1024).toFixed(0)).padStart(9)}${String(c.disk_read_blocks ?? '-').padStart(9)}${c.error ? `  FAILED: ${c.error}` : ''}`)
  }
  console.log(`nearby (one process, a session already open in ${out.core.__open_ms ?? '-'} ms core):`)
  for (const n of out.nearby) console.log(`  ${n.step.padEnd(26)} p50 ${String(n.p50_ms).padStart(5)} ms  p95 ${String(n.p95_ms).padStart(5)} ms${n.error ? `  FAILED: ${n.error}` : ''}`)
}

async function main(argv) {
  const w = argv.indexOf('--wrap')
  if (w === 0) return wrap(argv[1], argv.slice(argv.indexOf('--') + 1))
  const args = {}
  for (let i = 0; i < argv.length; i += 2) args[argv[i].replace(/^--/, '')] = argv[i + 1]
  if (args.idle) { const o = idle(Number(args.idle), args.seconds ? Number(args.seconds) : 60); printIdle(o); if (args.json) fs.writeFileSync(args.json, JSON.stringify(o, null, 2)); return }
  if (args['write-amp']) {
    const o = await writeAmp({ home: args['write-amp'], records: args.records ? Number(args.records) : 200 })
    printAmp(o)
    if (args.json) fs.writeFileSync(args.json, JSON.stringify(o, null, 2))
    return
  }
  if (args['reply-reads']) {
    const docs = String(args['lane-doc']).split(',').map((f) => JSON.parse(fs.readFileSync(f, 'utf8')))
    const o = await replyReads({ home: args['reply-reads'], docs })
    printReplies(o)
    if (args.json) fs.writeFileSync(args.json, JSON.stringify(o, null, 2))
    return
  }
  if (!args.home) { console.error('usage: node scripts/perf-cli.mjs --home <HOME> [--runs 7] [--only a,b] [--json out.json]\n       node scripts/perf-cli.mjs --idle <pid> [--seconds 60] [--json out.json]\n       node scripts/perf-cli.mjs --write-amp <HOME> [--records 200] [--json out.json]'); process.exit(2) }
  const out = await measure({ home: args.home, runs: args.runs ? Number(args.runs) : undefined, only: args.only ? args.only.split(',') : null })
  print(out)
  if (args.json) fs.writeFileSync(args.json, JSON.stringify(out, null, 2))
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main(process.argv.slice(2))
