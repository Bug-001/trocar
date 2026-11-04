#!/usr/bin/env node
// scripts/contract-check.mjs — everything about the CLI's contract a machine can judge, judged through the CLI itself (spec 1.12 §4).
//
//   node scripts/contract-check.mjs [--json] [--sample <n>] [--cli <path>]
//
// It runs no command that changes state and touches no raw record; a read through the daemon does write the derived layers, which are the
// daemon's own. The data is whatever HOME the environment gives the CLI. The CLI is the installed `trocar` on PATH; `--cli` names another,
// `.mjs` and `.js` run with node. `--sample` is how many segments, how many records, and how many of each harness's newest sessions it reads
// (default 5).
// The report is {ok, checks: [{id, part, status, expected, observed, contract, reason?}]}: status is pass, fail or skip, and skip says why.
// It holds counts, ids and sha256 only, never what was captured: captured bytes stay in this process, to be counted and hashed.
// Exit 0 nothing failed (a skip is not a failure), 1 something failed, 2 usage error or no CLI.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual, parseArgs } from 'node:util'
import { COMMANDS } from '../src/cli/commands.mjs'
import { expandRequestBody } from '../src/dissect/request-body.mjs'
import { QUERY_NAMES } from '../src/query/client.mjs'
import { callOf, findCli } from './lib/trocar-cli.mjs'

const USAGE = 'usage: node scripts/contract-check.mjs [--json] [--sample <n>] [--cli <path>]'
const CALL_MS = 30_000
const PAGE = ['--limit', '500'] // 1.6 §4.1: the largest page of a list query
const LISTS = { sessions: 'sessions', traffic: 'hosts' } // query name → the key of its rows
const NEEDS_ID = ['session', 'lane', 'block'] // these ask about something the other answers name
const META = ['calls', 'logged', 'probes', 'other', 'harness']
const CONTRACT = { query: '1.6 C.5', json: '1.6 §1.2 §1.3', records: '1.12 §4, 4.2', bytes: '1.12 §4, 3.5', numbers: '1.12 §4, 1.6 C.5', since: '3.5, 1.6 C.5', recognition: '1.12 §4' }
const TIMED_OUT = `the CLI call ran past ${CALL_MS / 1000} s`
const UNREAD = 'a document this needs could not be read'
const GROWING = 'as_of moved while reading: the data is growing'
const PENDING = 'the answer still carries pending'

const sum = (rows, of) => rows.reduce((n, r) => n + (of(r) || 0), 0)
const pick = (o, keys) => Object.fromEntries(keys.map((k) => [k, o[k]]))
const counts = (o) => Object.fromEntries(Object.entries(o || {}).filter(([, v]) => typeof v === 'number'))
const sha256 = (text) => createHash('sha256').update(text).digest('hex')
const documentOf = (text) => { try { return JSON.parse(text) } catch { return null } }
/** `n` items spread evenly over `list`, so that both ends of a long history get read, the same ones each run. */
const spread = (list, n) => (list.length <= n ? list : Array.from({ length: n }, (_, i) => list[Math.floor((i * list.length) / n)]))
/** `<segment>:<line>` → the two parts; the position of a record in capture order. */
const posOf = (rid) => { const at = rid.lastIndexOf(':'); return [rid.slice(0, at), Number(rid.slice(at + 1))] }
const isAfter = (rid, mark) => {
  const [[s, l], [ms, ml]] = [posOf(rid), posOf(mark)]
  return s === ms ? l > ml : s > ms
}

/** run(args, onChunk?) → {code, out, err, timedOut}. With `onChunk` the stdout is handed over as it comes and not kept: a segment can be gigabytes. */
const runnerOf = (cli) => (args, onChunk) => new Promise((resolve) => {
  let call
  try { call = callOf(cli, args) } catch { resolve({ code: null, out: '', err: '', timedOut: false }); return }
  const [file, argv, how] = call
  const kid = spawn(file, argv, { ...how, stdio: ['ignore', 'pipe', 'pipe'] })
  const out = [], err = []
  const timer = setTimeout(() => { kid.kill('SIGKILL'); resolve({ code: null, out: '', err: '', timedOut: true }) }, CALL_MS)
  kid.stdout.on('data', (b) => { if (onChunk) onChunk(b); else out.push(b) })
  kid.stderr.on('data', (b) => err.push(b))
  kid.on('error', () => { clearTimeout(timer); resolve({ code: null, out: '', err: '', timedOut: false }) })
  kid.on('close', (code) => { clearTimeout(timer); resolve({ code, out: Buffer.concat(out).toString(), err: Buffer.concat(err).toString(), timedOut: false }) })
})

/** Why these answers cannot be judged yet, or null. */
const blocked = (...answers) => (answers.some((r) => r.timedOut) ? TIMED_OUT : answers.some((r) => !r.doc) ? UNREAD : answers.some((r) => r.doc.pending) ? PENDING : null)

/** contractCheck(run, sample) → the list of checks. */
async function contractCheck(run, sample) {
  const checks = []
  const skip = (part, id, reason) => { checks.push({ id, part, status: 'skip', expected: null, observed: null, contract: CONTRACT[part], reason }) }
  const judge = (part, id, expected, observed, holds = isDeepStrictEqual(expected, observed)) => {
    checks.push({ id, part, status: holds ? 'pass' : 'fail', expected, observed, contract: CONTRACT[part] })
  }
  const query = async (name, ...args) => {
    const r = await run(['query', name, ...args])
    return { ...r, doc: documentOf(r.out) }
  }
  const clock = async () => (await query('segments')).doc?.as_of

  const judgeQuery = (name, r) => {
    if (r.timedOut || r.doc?.pending) return skip('query', `query/${name}`, blocked(r))
    const d = r.doc, errors = Array.isArray(d?.errors) ? d.errors : null
    judge('query', `query/${name}`, { exit: 0, documents: 1, schema: 2, command_is_the_name: true, errors_is_a_list: true, ok_is_no_error_without_level: true }, {
      exit: r.code, documents: d ? 1 : 0, schema: d?.schema, command_is_the_name: d?.command === name, errors_is_a_list: !!errors,
      ok_is_no_error_without_level: !!errors && d.ok === !errors.some((e) => !e.level),
    })
  }

  /** The rest of a list query after its first page: {rows, stamps, last}, or null when a page could not be read. */
  const allPages = async (name, first) => {
    if (!first) return null
    const rows = [...first[LISTS[name]]], stamps = [first.as_of]
    let last = first
    for (let after = null; last.next != null && last.next !== after;) { // a next that does not move would never end
      after = last.next
      last = (await query(name, ...PAGE, '--after', String(after))).doc
      if (!last) return null
      rows.push(...last[LISTS[name]]); stamps.push(last.as_of)
    }
    return { rows, stamps, last }
  }

  // ── query: every name that needs nothing named; these answers are also what the rest of the run reads
  const docs = {}
  for (const name of QUERY_NAMES.filter((n) => !NEEDS_ID.includes(n))) {
    const r = await query(name, ...(LISTS[name] ? PAGE : []))
    judgeQuery(name, r)
    docs[name] = r.doc
  }
  const sessions = await allPages('sessions', docs.sessions), traffic = await allPages('traffic', docs.traffic)

  // ── json: every command that reads and promises --json; never one that changes state, never the one that opens a browser
  for (const c of COMMANDS) {
    const mutates = typeof c.mutates === 'function' ? c.mutates({ positionals: [] }) : c.mutates
    if (mutates || c.name === 'board' || !c.usage.includes('--json')) continue
    const r = await run([c.name, '--json']), d = documentOf(r.out)
    if (r.timedOut) { skip('json', `json/${c.name}`, TIMED_OUT); continue }
    judge('json', `json/${c.name}`, { exit_is_declared: true, documents: 1, stderr_bytes: 0, schema: 2, command: c.name }, {
      exit_is_declared: c.exits.some(([code]) => code === r.code), documents: d ? 1 : 0, stderr_bytes: Buffer.byteLength(r.err), schema: d?.schema, command: d?.command,
    })
  }
  const wrong = await Promise.all([['status', '--frob', '--json'], ['query', 'nope', '--json']].map((a) => run(a)))
  if (wrong.some((r) => r.timedOut)) skip('json', 'json/usage', TIMED_OUT)
  else judge('json', 'json/usage', wrong.map(() => ({ exit: 2, code: 'usage' })), wrong.map((r) => ({ exit: r.code, code: documentOf(r.out)?.error?.code })))

  // ── records: lines that end in a newline against what `segments` counts; a half line at the end is not a record
  const segments = docs.segments?.segments || []
  for (const s of spread(segments, sample)) {
    let lines = 0
    const r = await run(['raw', s.segment], (b) => { for (const x of b) if (x === 10) lines++ })
    if (r.timedOut) { skip('records', `segments/${s.segment}`, TIMED_OUT); continue }
    const writing = s.state === 'writing'
    judge('records', `segments/${s.segment}`, { exit: 0, records: s.records }, { exit: r.code, records: lines }, r.code === 0 && (writing ? lines >= s.records : lines === s.records))
  }

  // ── numbers across documents: the same number in every document that carries it
  if (!docs.segments || !docs.overview || !docs.classes || !sessions || !traffic) {
    for (const id of ['records', 'llm', 'logged', 'sessions', 'traffic']) skip('numbers', `agree/${id}`, UNREAD)
  } else if (new Set([docs.segments, docs.overview, docs.classes].map((d) => d.as_of).concat(sessions.stamps, traffic.stamps)).size > 1) {
    for (const id of ['records', 'llm', 'logged', 'sessions', 'traffic']) skip('numbers', `agree/${id}`, GROWING)
  } else {
    const o = docs.overview
    const agree = (id, named) => judge('numbers', `agree/${id}`, Object.fromEntries(Object.keys(named).map((k) => [k, Object.values(named)[0]])), named)
    agree('records', { segments: sum(segments, (s) => s.records), overview: o.calls.total, traffic: traffic.last.totals.requests, classes: sum(docs.classes.classes, (c) => c.counts.all.calls) })
    agree('llm', { sessions: sum(sessions.rows, (s) => s.calls), overview: o.calls.llm, harnesses: sum(o.harnesses, (h) => h.calls) })
    agree('logged', { sessions: sum(sessions.rows, (s) => s.logged), overview: o.calls.logged })
    agree('sessions', { sessions: sessions.rows.length, overview: o.sessions.total })
    agree('traffic', { hosts: sum(traffic.rows, (h) => h.requests), totals: traffic.last.totals.requests })
  }

  // ── sessions: each harness's newest, as `sessions` lists them newest first
  const taken = new Map()
  const sampled = (sessions?.rows || []).filter((s) => { taken.set(s.harness, (taken.get(s.harness) || 0) + 1); return taken.get(s.harness) <= sample })
  const recognition = new Map(), llmRecords = []
  let at = await clock()
  for (const row of sampled) {
    const id = row.session_id
    const whole = await query('session', '--id', id), d = whole.doc
    if (checks.every((c) => c.id !== 'query/session')) {
      judgeQuery('session', whole)
      if (d?.lanes?.length) judgeQuery('lane', await query('lane', '--id', id, '--lane', d.lanes[0].lane))
    }
    const seen = recognition.get(row.harness) || { sessions: 0, calls: 0, unparsed: 0, unknown: 0, other: 0, inferred: 0, incomplete: 0, unread: 0 }
    recognition.set(row.harness, seen)
    const why = blocked(whole)
    if (why) {
      seen.unread++
      skip('numbers', `agree/session/${id}`, why); skip('since', `since/${id}`, why)
      continue
    }
    llmRecords.push(...d.records.filter((r) => r.is_llm_call).map((r) => r.id))

    // recognition reads every page: a call older than the newest page is still a call this harness made
    const rows = [...d.calls]
    for (let page = d; page?.more;) {
      page = (await query('session', '--id', id, '--before', rows[0].rid)).doc
      if (!page?.calls?.length) { seen.unread++; break }
      rows.unshift(...page.calls)
    }
    seen.sessions++
    seen.calls += rows.length
    seen.unparsed += rows.filter((c) => c.unparsed).length
    seen.unknown += d.unknown?.records || 0
    seen.other += sum(d.lanes.filter((l) => l.kind === 'aux'), (l) => l.count)
    seen.inferred += d.meta.harness_inferred ? rows.length : 0
    seen.incomplete += rows.filter((c) => c.reqIncomplete || c.wsIncomplete || c.respIncomplete).length

    const head = await query('session', '--id', id, '--head')
    const incremental = d.more || d.truncated !== null ? 'the session is paged or truncated' : d.records.length < 2 ? 'the session has fewer than two records' : null
    const mid = incremental ? null : d.records[d.records.length >> 1].id
    const since = mid && await query('session', '--id', id, '--since', mid), tip = mid && await query('session', '--id', id, '--since', d.mark)
    const now = await clock(), grew = now !== at
    at = now

    const headWhy = grew ? GROWING : blocked(head)
    if (headWhy) skip('numbers', `agree/session/${id}`, headWhy)
    else {
      // a title is what the user asked: only its hash goes into the report
      const title = (o) => (row.title == null ? {} : { title_sha256: o.title == null ? null : sha256(String(o.title)) })
      judge('numbers', `agree/session/${id}`, { ...pick(row, META), ...title(row), lanes_count: d.stats.calls, head_stats: counts(d.stats) },
        { ...pick(d.meta, META), ...title(d.meta), lanes_count: sum(d.lanes, (l) => l.count), head_stats: counts(head.doc.stats) })
    }

    const sinceWhy = incremental || (grew ? GROWING : blocked(since, tip))
    if (sinceWhy) skip('since', `since/${id}`, sinceWhy)
    else {
      const full = new Map(d.calls.map((c) => [c.rid, c])), delta = new Set(since.doc.calls.map((c) => c.rid))
      judge('since', `since/${id}`, { base: mid, mark: d.mark, stats: counts(d.stats), rows_unlike_the_whole: 0, rows_missing: 0, rows_past_the_mark: 0 }, {
        base: since.doc.base, mark: since.doc.mark, stats: counts(since.doc.stats),
        rows_unlike_the_whole: since.doc.calls.filter((c) => !isDeepStrictEqual(c, full.get(c.rid))).length,
        rows_missing: d.calls.filter((c) => isAfter(c.rid, mid) && !delta.has(c.rid)).length,
        rows_past_the_mark: tip.doc.calls.length,
      })
    }
  }
  for (const name of ['session', 'lane']) if (checks.every((c) => c.id !== `query/${name}`)) skip('query', `query/${name}`, 'no session has this to ask about')
  for (const [harness, seen] of recognition) {
    if (!seen.sessions) skip('recognition', `recognition/${harness}`, UNREAD)
    else judge('recognition', `recognition/${harness}`, { unparsed: 0, unknown: 0, other: 0 }, seen, seen.unparsed + seen.unknown + seen.other === 0)
  }

  // ── bytes: what `block` hands back against the record's own bytes, by hash
  const rids = spread(llmRecords, sample)
  if (rids.length) judgeQuery('block', await query('block', '--ref', rids[0]))
  else skip('query', 'query/block', 'no session has this to ask about')
  for (const rid of rids) {
    const [segment, line] = posOf(rid), id = `block/${rid}`
    const raw = await run(['raw', `${segment}:${line}`])
    if (raw.timedOut) { skip('bytes', id, TIMED_OUT); continue }
    const body = expandRequestBody(documentOf(raw.out))?.req_body
    if (typeof body !== 'string') { skip('bytes', id, 'the record holds no request body as a string'); continue }
    const r = await query('block', '--ref', rid), block = r.doc?.blocks?.[0]
    if (r.timedOut) skip('bytes', id, TIMED_OUT)
    else if (block && block.fidelity?.verbatim !== true && block.bytes !== null) skip('bytes', id, 'the block is not verbatim')
    else judge('bytes', id, { sha256: sha256(body) }, { sha256: typeof block?.bytes === 'string' ? sha256(block.bytes) : null })
  }
  return checks
}

/** The report as one screen: a line per part, then what failed and what was skipped, as far as fits. */
function screen(checks) {
  const SHOWN = 6, of = (status) => checks.filter((c) => c.status === status)
  const tally = (list) => ['pass', 'fail', 'skip'].map((s) => `${String(list.filter((c) => c.status === s).length).padStart(4)} ${s}`).join('  ')
  const lines = [`Contract check: ${of('fail').length ? 'problems found' : 'nothing failed'}.`, '']
  for (const part of Object.keys(CONTRACT)) lines.push(`  ${part.padEnd(12)}${tally(checks.filter((c) => c.part === part))}`)
  const list = (title, rows, say) => {
    if (!rows.length) return
    lines.push('', `${title}:`, ...rows.slice(0, SHOWN).flatMap(say))
    if (rows.length > SHOWN) lines.push(`  and ${rows.length - SHOWN} more; --json lists them all.`)
  }
  const differs = (c) => Object.keys(c.expected).filter((k) => !isDeepStrictEqual(c.expected[k], c.observed[k]))
    .map((k) => `${k} expected ${JSON.stringify(c.expected[k])}, observed ${JSON.stringify(c.observed[k])}`).join('; ')
  list('Failed', of('fail'), (c) => [`  ${c.id} (${c.contract}): ${differs(c)}`])
  list('Skipped', of('skip'), (c) => [`  ${c.id}: ${c.reason}`])
  return lines.join('\n') + '\n'
}

async function main() {
  let opts
  try { ({ values: opts } = parseArgs({ options: { json: { type: 'boolean' }, sample: { type: 'string', default: '5' }, cli: { type: 'string' } } })) } catch { opts = null }
  if (!opts || !/^[1-9]\d*$/.test(opts.sample)) { process.stderr.write(`${USAGE}\n`); return 2 }
  const cli = findCli(opts.cli)
  if (!cli) { process.stderr.write(`${opts.cli === undefined ? 'no trocar on PATH: install it, or name one with --cli <path>' : `no CLI at ${opts.cli}`}\n`); return 2 }
  const checks = await contractCheck(runnerOf(cli), Number(opts.sample))
  const ok = !checks.some((c) => c.status === 'fail')
  process.stdout.write(opts.json ? `${JSON.stringify({ ok, checks })}\n` : screen(checks))
  return ok ? 0 : 1
}

process.exitCode = await main()
