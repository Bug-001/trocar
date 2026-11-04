#!/usr/bin/env node
// scripts/deploy-check.mjs — before updating an installed trocar: what the user meets right after a version change, on a copy of the real
// capture (RFC 4.4 acceptance #19, D78). Local only, in no test run: real captures never enter the repository, and the screenshots and the
// report in <out> hold real content: they stay on this machine.
//
//   node scripts/deploy-check.mjs [--home ~/.trocar] [--out <dir>] [--no-bump] [--seconds 90] [--full] [--keep]
//
// A pre-read: `--no-bump --full --keep` leaves a side index at this code's versions, and a run that passes prints how to put it in place of the
// real one with the daemon stopped, so an update meets no re-read. This script never runs that itself.
//
// The real home is only read, and that is checked: raw/ is listed before and after, and a sealed segment that moved, an open one that shrank or
// a segment that went is a refusal (exit 2, naming the file). A side home in <out> links raw/ to the real one and holds a clone of its index/,
// every link followed, so whatever the worker writes lands there; it is removed at exit unless --keep. This checkout's code runs over it from a
// copy whose PROJ_V and INDEX_V are one higher (--no-bump runs the checkout as it is), so the copied index and projections are what an update
// finds: one version behind. The real board runs in Chrome with a cold worker, started as the daemon starts it: the sweep forks the worker, then
// `status`, then the page. The numbers below are taken while the background re-read runs. --full then waits for the re-read to end, and for
// every segment of raw to be in the rows once.
// --home may be an earlier run's side home: a stored answer of this code is then there, as at the next update. With none (the first
// open after a stored answer's format changed) `firstListMs` is reported instead of `listMs`; the page must say it is loading, and
// never that there are no sessions.
//
// Then the agent's side: a real daemon on a home of its own re-reads the same copy, and scripts/deploy-check-daemon.mjs times one request through
// its door and the index that follows, in windows under the re-read and idle. With nothing to re-read those two lines are not measured, and fail.
//
// PASS LINES, the times measured from the moment the page is asked, all must hold (exit 0; else 1 and the report says which):
const LINES = Object.freeze({
  listMs: 1000, // the session list on screen, its rows with their titles
  headMs: 200, // the biggest session's head file (D71①)
  roughMs: 1000, // the biggest session's first useful page on screen (the desk's own `desk-rough` mark)
  statusP95: 500, // `status`, while the re-read runs
  sessionsP95: 500, // `sessions`, while the re-read runs
  smallP95: 500, // a small session's head, while the re-read runs
  fullMs: 30 * 60_000, // --full: the whole re-read, nothing left over any session
  roundTripP95: { idle: 'roundTripIdleP95', times: 1.5, plusMs: 10 }, // one request through a real daemon's door, under the re-read, against idle
  indexP95: { idle: 'indexIdleP95', times: 1.5, plusMs: 10 }, // from that reply to its segment's index growing, the same
})
const AGENT_PATH = Object.freeze({ windowMs: 20_000, pairs: 3, probeMs: 3000 }) // windows under the re-read and idle, in turn (deploy-check-daemon.mjs)
// and: no answer of 500 or more, no worker lost, no "not read yet" on screen, no first-read state on the biggest session (`updating` is what a
// re-read says), never "no sessions" while the list loads, and no title source outside {wire, unread, null}.
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { fork } from 'node:child_process'
import { parseArgs } from 'node:util'

const { values: o } = parseArgs({ options: { home: { type: 'string' }, out: { type: 'string' }, 'no-bump': { type: 'boolean' }, seconds: { type: 'string' }, full: { type: 'boolean' }, keep: { type: 'boolean' } } })
const real = path.resolve(o.home || path.join(os.homedir(), '.trocar')), realRaw = path.join(real, 'raw')
if (!fs.existsSync(realRaw)) { console.error(`no raw/ in ${real}`); process.exit(2) }
const out = path.resolve(o.out || fs.mkdtempSync(path.join(os.tmpdir(), 'trocar-deploy-check-')))
const seconds = Number(o.seconds || 90)
const checkout = path.resolve(import.meta.dirname, '..')
fs.mkdirSync(out, { recursive: true })

// the code: this checkout, or a copy one version on
function bumped() {
  const code = path.join(out, 'code')
  fs.mkdirSync(code)
  for (const d of ['src', 'test', 'scripts', 'samples', 'web', 'package.json']) if (fs.existsSync(path.join(checkout, d))) fs.cpSync(path.join(checkout, d), path.join(code, d), { recursive: true })
  fs.symlinkSync(path.join(checkout, 'node_modules'), path.join(code, 'node_modules'))
  for (const [file, rule] of [['src/query/projection.mjs', /export const PROJ_V = (\d+);/], ['src/query/index-build.mjs', /const INDEX_V = (\d+);/]]) {
    const f = path.join(code, file), text = fs.readFileSync(f, 'utf8')
    if (!rule.test(text)) throw new Error(`${file}: the version line is not where this script looks`)
    fs.writeFileSync(f, text.replace(rule, (m, n) => m.replace(n, String(Number(n) + 1))))
  }
  return code
}
const code = o['no-bump'] ? checkout : bumped()
const from = (file) => import(path.join(code, file)) // anything versioned is read by the code under check, never by this checkout
const { clone, p95, preRead, rawDiff, rawList, requestsByPath, rereading, segmentCheck, verdict } = await from('scripts/deploy-check-lib.mjs')
const { withBoard } = await from('test/web-v2/browser/harness.mjs')
const { NO_SESSIONS } = await from('web/legacy/labels/library.mjs')
const { storedFile } = await from('src/query/stored.mjs')
const { withToken } = await from('test/server/face.mjs')
const { indexRows, sessionGroups } = await from('src/query/rows.mjs')

// the side home
const rawBefore = rawList(realRaw)
const userHome = fs.mkdtempSync(path.join(out, 'home-')), home = path.join(userHome, '.trocar')
fs.mkdirSync(home, { mode: 0o700 })
fs.symlinkSync(realRaw, path.join(home, 'raw'))
if (fs.existsSync(path.join(real, 'index'))) clone(path.join(real, 'index'), path.join(home, 'index'))

const report = { home: real, code, bumped: !o['no-bump'], lines: LINES, measured: {}, failures: [] }
const lines = { ...LINES } // the lines this run can read: each one kept here that is not measured fails the run (verdict)
const fail = (m) => { report.failures.push(m) }
const took = (name, got) => { report.measured[name] = got; console.log(`${name.padEnd(14)} ${got} ms`) }

let port = null, t0 = 0
const stored = fs.existsSync(storedFile(home, 'sessions', { limit: 500 }))
function get(p) { return new Promise((resolve) => {
  const s = performance.now()
  const r = http.request({ host: '127.0.0.1', port, path: p, agent: false, headers: withToken({ 'accept-encoding': 'gzip' }) }, (res) => {
    const cs = []
    res.on('data', (c) => cs.push(c))
    res.on('end', () => {
      let body = Buffer.concat(cs)
      if (res.headers['content-encoding'] === 'gzip') { try { body = zlib.gunzipSync(body) } catch { /* cut: not JSON below */ } }
      resolve({ ms: Math.round(performance.now() - s), status: res.statusCode, body })
    })
  })
  r.on('error', () => resolve({ ms: Math.round(performance.now() - s), status: 0, body: Buffer.alloc(0) }))
  r.end()
}) }
const docOf = (r) => { try { return JSON.parse(r.body) } catch { return null } }
const bad = []
const seen = (name, r) => { if (r.status >= 500 || r.status === 0) bad.push(`${name} ${r.status}`); return r }

async function theBoard() {
  const b = await withBoard({
    home: { userHome, home }, width: 1600, height: 1000, idleMs: 600_000,
    setup: async (page, face) => {
      port = face.port
      await page.addInitScript((empty) => {
        const look = () => { if (document.body && document.body.innerText.includes(empty)) globalThis.__sawEmpty = true }
        new MutationObserver(look).observe(document, { childList: true, subtree: true, characterData: true })
      }, NO_SESSIONS)
      face.sweep()
      await get('/api/status')
      t0 = performance.now()
    },
  })
  try {
    const notRead = async () => { if (/not read yet/i.test(await b.page.evaluate(() => document.body.innerText))) fail('the page says something is not read yet') }
    // 1 the list, from the moment the page was asked for
    await b.page.evaluate(() => { location.hash = '#/sessions' })
    await b.page.waitForFunction(() => document.querySelectorAll('.lrow').length > 0, null, { timeout: 180_000, polling: 25 })
    const listed = Math.round(performance.now() - t0)
    if (stored) took('listMs', listed); else { delete lines.listMs; took('firstListMs', listed) } // no stored answer of this code: reported, no line
    await b.page.screenshot({ path: path.join(out, 'list.png') })
    if (await b.page.evaluate(() => globalThis.__sawEmpty === true)) fail(`the page said "${NO_SESSIONS}" while the list was loading`)
    await notRead()
    const list = docOf(await get('/api/sessions?limit=500'))
    const rows = (list && list.sessions) || []
    if (!rows.length) fail('the session list is empty')
    report.sessions = { listed: rows.length, titled: rows.filter((s) => s.title != null).length, unread: rows.filter((s) => s.title_source === 'unread').length }
    for (const s of rows) if (![null, undefined, 'wire', 'unread'].includes(s.title_source)) fail(`title_source ${JSON.stringify(s.title_source)}`)

    // 2 the biggest session
    const big = rows.slice().sort((x, y) => (y.calls || 0) - (x.calls || 0))[0], enc = encodeURIComponent
    const small = rows.filter((s) => s.calls >= 3 && s !== big).slice(0, 3)
    report.biggest = { calls: big.calls }
    took('headMs', seen('head', await get(`/api/d/head?id=${enc(big.session_id)}`)).ms)
    took('roughMs', await b.page.evaluate(async (hash) => {
      const before = performance.getEntriesByName('desk-rough').length, t = performance.now()
      location.hash = hash
      while (performance.getEntriesByName('desk-rough').length === before && performance.now() - t < 60_000) await new Promise((ok) => setTimeout(ok, 10))
      const e = performance.getEntriesByName('desk-rough')[before]
      return e ? Math.round(e.startTime - t) : null
    }, `#/replay/p/${enc(big.session_id)}`))
    await b.page.waitForTimeout(1000)
    await b.page.screenshot({ path: path.join(out, 'biggest.png') })
    await notRead()
    const reads = await b.page.evaluate(() => [...document.querySelectorAll('[data-read-state]')].map((e) => e.dataset.readState))
    report.readState = reads
    if (reads.includes('reading')) fail('the biggest session says it is read for the first time')

    // 3 small reads while the re-read runs
    const lat = { status: [], sessions: [], small: [] }, until = Date.now() + seconds * 1000
    const poll = async (key, url, every) => { while (Date.now() < until) { lat[key].push(seen(key, await get(url())).ms); await new Promise((ok) => setTimeout(ok, every)) } }
    let i = 0
    await Promise.all([poll('status', () => '/api/status', 1000), poll('sessions', () => '/api/sessions?limit=500', 1000),
      small.length ? poll('small', () => `/api/d/head?id=${enc(small[i++ % small.length].session_id)}`, 500) : null])
    took('statusP95', p95(lat.status))
    took('sessionsP95', p95(lat.sessions))
    if (small.length) took('smallP95', p95(lat.small)); else delete lines.smallP95
    await b.page.evaluate(() => { location.hash = '#/sessions' })
    await b.page.waitForTimeout(1000)
    await b.page.screenshot({ path: path.join(out, 'list-after.png') })

    // 4 the end of the re-read: over every session, not one marker alone
    if (o.full) {
      const ids = [...sessionGroups(await indexRows({ home })).keys()]
      let left = rereading(home, ids)
      while (left.length && performance.now() - t0 < LINES.fullMs) { await new Promise((ok) => setTimeout(ok, 5000)); left = rereading(home, left) }
      took('fullMs', left.length ? null : Math.round(performance.now() - t0))
      report.left = left.length
      const d = docOf(await get(`/api/d/head?id=${enc(big.session_id)}`))
      report.after = { tier: d && d.tier, pending: d && d.pending, steps: d && d.steps }
      const disk = rawList(realRaw), parts = [] // listed first: a segment opened after the rows were read is not one they lost
      for (const r of await indexRows({ home })) { if (parts.at(-1)?.segment !== r.segment) parts.push({ segment: r.segment, rows: 0 }); parts.at(-1).rows++ }
      report.segments = segmentCheck(disk, parts)
      if (!report.segments.ok) fail(`segments lost ${report.segments.lost.join(' ') || '-'}, twice ${report.segments.twice.join(' ') || '-'}`)
    } else delete lines.fullMs
    report.requests = requestsByPath(b.requests)
    if (bad.length) fail(`answers that failed: ${[...new Set(bad)].join(', ')}`)
    if (!b.face.workers().length) fail('no query worker is alive')
    if (b.errors.length) fail(`page errors: ${b.errors.slice(0, 3).join(' · ')}`)
  } finally { await b.stop() }
}

// after the board has stopped: its re-read would load both kinds of window alike
function theAgentPath() {
  const { windowMs, pairs } = AGENT_PATH
  return new Promise((resolve) => {
    const child = fork(path.join(code, 'scripts/deploy-check-daemon.mjs'), [JSON.stringify({ real, ...AGENT_PATH })],
      { execArgv: ['--require', path.join(code, 'test/helpers/no-real-os.cjs')], env: { ...process.env, HOME: out, USERPROFILE: out } })
    const cut = setTimeout(() => child.kill('SIGKILL'), windowMs * pairs * 2 + 10 * 60_000)
    child.on('message', (m) => { report.agentPath = m; Object.assign(report.measured, m.measured); for (const [k, v] of Object.entries(m.measured)) console.log(`${k.padEnd(18)} ${v} ms`) })
    child.on('exit', (status, signal) => { clearTimeout(cut); if (status !== 0) fail(`the agent path's daemon ended with ${status ?? signal}`); resolve() })
  })
}

try { await theBoard(); await theAgentPath() } catch (e) { fail(`the check stopped: ${e.stack || e}`) }
const moved = rawDiff(rawBefore, rawList(realRaw))
report.raw = moved
const { pass, failures } = verdict(lines, report.measured, report.failures)
report.failures = failures
fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2))
if (!o.keep) { fs.rmSync(userHome, { recursive: true, force: true }); if (code !== checkout) fs.rmSync(code, { recursive: true, force: true }) }
for (const f of failures) console.log(`FAIL ${f}`)
for (const r of moved.refused) console.log(`REFUSED ${r.file}: it was ${JSON.stringify(r.was)}, it is ${JSON.stringify(r.now)}`)
console.log(`${moved.ok ? (pass ? 'PASS' : 'FAIL') : 'REFUSED'} · ${out}`)
if (moved.ok && pass && o['no-bump'] && o.full && o.keep) {
  const { version } = JSON.parse(fs.readFileSync(path.join(code, 'package.json'), 'utf8')), before = `index.before-${version}`
  console.log(`\nA side index of this code's versions is ready. With the daemon stopped, to put it in place:\n\n${preRead({ real, side: path.join(home, 'index'), before })}\n`)
  console.log(`Then check status, the biggest session's head and the growing segments; ${path.join(real, before)} is yours to remove by hand after that.`)
}
process.exit(moved.ok ? (pass ? 0 : 1) : 2)
