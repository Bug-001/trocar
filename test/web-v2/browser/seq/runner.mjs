// test/web-v2/browser/seq/runner.mjs — one seeded sequence on a fresh board: generate(seed) draws the steps (pure); runSequence runs
// them on a new world + board + Chrome, settles after each step and checks every invariant; findOne() turns a new violation into a
// permanent regression (reproduce once, shrink with ddmin, save). Exports only; nothing runs at import.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { withBoard } from '../harness.mjs'
import { rng } from '../../../query/big-session.mjs'
import { makeWorld, mainCount } from './world.mjs'
import { installProbe, resetProbe } from './probe.mjs'
import { installFaults } from './faults.mjs'
import { genStep, runStep } from './actions.mjs'
import { check } from './invariants.mjs'
import { ddmin } from './shrink.mjs'

export const REGRESSIONS = fileURLToPath(new URL('./regressions/', import.meta.url))
const SHOTS = fileURLToPath(new URL('../shots/seq/', import.meta.url))
const QUIET_MS = 300, SETTLE_CAP_MS = 5000, SETTLE_LATENCY_MS = 25000
// checks that only mean something once the page has settled (a step that cannot settle skips these and keeps the rest)
const SETTLED_ONLY = new Set(['I-url', 'I-leak', 'I-mem', 'I-follow', 'I-hold'])

/** A violation's (or a regression's) identity: its `<id>:<screen>` sig and its fingerprint (invariants.mjs). */
export const keyOf = (v) => `${v.sig} ${v.fp}`

/** The default run (`npm run test:browser` with no SEQ_* knob): these seeds, this many steps each. */
export const DEFAULT_SEEDS = Object.freeze([1, 2, 3, 4, 5, 6]), DEFAULT_STEPS = 60

/** A saved regression `open` (a triaged product bug) or `flaky` is a node:test `todo`: reported, never red. → the todo text, or false */
export const replayTodo = (reg) => (reg.status === 'open' || reg.status === 'flaky')
  && `${reg.status}${reg.owner ? ` · owner ${reg.owner}` : ''}${reg.suspect ? ` · suspect ${reg.suspect}` : ''}`

/** How replay `r` of saved regression `reg` fails: any violation, named as its own key recurring or another one met. → text, or null */
export const replayFailure = (reg, r) => !r.violation ? null
  : `${reg.name} [${reg.status}]: ${keyOf(r.violation) === keyOf(reg) ? 'still reproduces' : `stopped at ${keyOf(r.violation)}`} at step ${r.violation.step} — ${r.violation.detail} (screenshot ${r.violation.screenshot})`

/** The steps of sequence `seed`: a pure function of (seed, steps, real). → [{a, p}] (plain JSON) */
export function generate(seed, steps, world, { real = false } = {}) {
  const r = rng(seed * 7919 + 17)
  return Array.from({ length: steps }, () => genStep(r, world, { real }))
}

/** Viewport and theme of seed `seed` (all four widths and both themes across consecutive seeds). */
export const lookOf = (seed) => ({ viewport: [1280, 390, 1440, 768][seed % 4], theme: seed % 3 === 2 ? 'dark' : 'light' })

const frames2 = (page) => page.evaluate(() => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok))))

/** 0 in-flight fetches for QUIET_MS, then two frames; false when that does not happen within capMs. */
async function settle(page, capMs) {
  const end = Date.now() + capMs
  let quietFrom = null
  while (Date.now() < end) {
    const n = await page.evaluate(() => window.__seq.snap().inflight).catch(() => 1)
    if (n === 0) { quietFrom ??= Date.now(); if (Date.now() - quietFrom >= QUIET_MS) { await frames2(page).catch(() => {}); return true } } else quietFrom = null
    await page.waitForTimeout(50)
  }
  return false
}

async function shoot(page, name) {
  fs.mkdirSync(SHOTS, { recursive: true })
  const file = path.join(SHOTS, `${name}.png`)
  await page.screenshot({ path: file }).catch(() => {})
  return file
}

// installed before the probe (so its listeners are not the board's): the time and kind of every reader input the page receives
function recordInput() {
  for (const e of ['keydown', 'pointerdown', 'hashchange', 'popstate']) addEventListener(e, () => (window.__seqInput ||= []).push([Date.now(), e]), true)
}

// the server's truth right after a worker kill: the restart answers 500 / 503 for a moment
async function retry(fn, ms = 10000) {
  const end = Date.now() + ms
  for (;;) { try { return await fn() } catch (e) { if (Date.now() > end) throw e; await new Promise((ok) => setTimeout(ok, 300)) } }
}

const sessionOf = (hash) => { const m = /^#\/replay\/[^/]+\/([^/?]+)/.exec(hash); return m ? decodeURIComponent(m[1]) : null }

/**
 * runSequence({steps, seed, big, viewport, theme, chromium, real, base, known, shot}) →
 *   { violation?: {id, sig, detail, step, screenshot}, step, seen:[{id, sig, detail, step}], pending:{id: {n, max}}, ms, coverage:{a: {ran, skipped}}, maxLongTask,
 *     serverErrors:[text] (the server's truth read failed past a restart's grace) }
 * Stops at the first violation whose keyOf() is not in `known` (a Set of keys, or 'all' to run every step); a known one is recorded in
 * `seen`, its evidence logs are cleared and the run goes on. `shot` names the screenshot (default `<id>-<screen>-<seed>`).
 */
export async function runSequence({ steps, seed = 1, big = false, viewport = 1280, theme = 'light', chromium, real = false, base, known = new Set(), shot } = {}) {
  const t0 = Date.now()
  const world = base ? null : makeWorld({ seed, big })
  let faults
  const out = { step: -1, seen: [], pending: {}, coverage: {}, maxLongTask: 0, serverErrors: [] }
  const b = await withBoard({ home: world, base, chromium, width: viewport, height: viewport < 768 ? 844 : 900, theme,
    setup: async (page) => { await page.addInitScript(recordInput); await installProbe(page); faults = await installFaults(page) } })
  const ctx = { b, page: b.page, world, faults, actions: [], hidden: [], follow: false, grownAt: null, lastGrow: null }
  const baseline = new Map()
  let prev = null
  try {
    for (let i = 0; i < steps.length; i++) {
      out.step = i
      const step = steps[i], cov = out.coverage[step.a] ||= { ran: 0, skipped: 0 }
      const t = Date.now()
      const r = await runStep(ctx, step).catch(() => ({ skipped: true })) // a navigation tore the page's context mid-step
      cov[r.skipped ? 'skipped' : 'ran']++
      // a reload re-runs the probe, so the page is visible again: the reader's hidden window ends with that step
      const open = ctx.hidden.find((h) => h.to == null)
      if (open && !(await b.page.evaluate(() => document.hidden).catch(() => true))) open.to = t
      await b.page.$('body').catch(() => {}) // Playwright's injected script adds its own window listeners on a document's first query: never count them as the board's
      const slow = faults.log.some((f) => f.kind === 'latency' && f.to == null) || (step.a === 'fault' && step.p.kind === 'latency') || step.a === 'switchInFlight'
      const settled = await settle(b.page, slow ? SETTLE_LATENCY_MS : SETTLE_CAP_MS)
      const hash = await b.page.evaluate(() => location.hash).catch(() => '')
      const id = sessionOf(hash)
      // the server's own read failing is no frontend fault: reported, and that step's I-follow is not judged
      let noTruth = false
      const truth = id && !real ? () => retry(() => mainCount(b.get, id)).catch((e) => { noTruth = true; out.serverErrors.push(`step ${i}: ${e.message}`); return null }) : undefined
      // every input the page saw (a compound step clicks after its own waits) opens a reader window for I-rate
      for (const [at, e] of await b.page.evaluate(() => (window.__seqInput || []).splice(0)).catch(() => [])) ctx.actions.push({ t: at, a: e })
      const c = { page: b.page, requests: b.requests, errors: b.errors, actions: ctx.actions, faults: faults.log, hidden: ctx.hidden, follow: ctx.follow,
        grownAt: ctx.grownAt, truth, real, prev, baseline }
      const had = new Set(baseline.keys())
      const res = await check(c).catch(async () => { await b.page.waitForTimeout(500); return check(c) })
      // a first visit drawn under a fault (a failed read draws a short error) is no baseline for I-leak / I-mem: the next visit is
      if (faults.log.some((f) => f.to == null || f.to >= t - 2000)) for (const k of baseline.keys()) if (!had.has(k)) baseline.delete(k)
      prev = res.view
      for (const p of res.pending) { const e = out.pending[p.id] ||= { n: 0, max: 0 }; e.n++; if (typeof p.value === 'number') e.max = Math.max(e.max, p.value) }
      out.maxLongTask = Math.max(out.maxLongTask, await b.page.evaluate(() => window.__seq.snap().longtaskMax).catch(() => 0))
      const vs = res.violations.filter((v) => (settled || !SETTLED_ONLY.has(v.id)) && !(noTruth && v.id === 'I-follow'))
      const fresh = vs.find((v) => !(known === 'all' || known.has(keyOf(v))))
      if (fresh) {
        out.violation = { ...fresh, step: i, screenshot: await shoot(b.page, shot || `${fresh.id}-${fresh.sig.split(':')[1]}-${seed}`) }
        break
      }
      if (vs.length) {
        const screenshot = known === 'all' ? await shoot(b.page, `${shot || seed}-${i}`) : undefined // run-everything mode: one picture per step that broke something
        for (const v of vs) out.seen.push({ ...v, step: i, screenshot })
        b.errors.length = 0
        await resetProbe(b.page).catch(() => {})
      }
    }
  } finally {
    await faults?.close()
    await b.stop()
  }
  out.ms = Date.now() - t0
  return out
}

/** The saved regressions, sorted by file name. → [{file, ...doc}] */
export function regressions() {
  if (!fs.existsSync(REGRESSIONS)) return []
  return fs.readdirSync(REGRESSIONS).filter((f) => f.endsWith('.json')).sort()
    .map((f) => ({ file: path.join(REGRESSIONS, f), ...JSON.parse(fs.readFileSync(path.join(REGRESSIONS, f), 'utf8')) }))
}

/**
 * A violation `v` met at step v.step of `steps` (run `opts`): reproduce once on the list up to that step, shrink it with ddmin (each
 * trial a fresh board; it fails only when the same sig and fingerprint recur), save regressions/<id>-<screen>-<seed>.json as `new` (or `flaky` with
 * the full list when it does not reproduce). → the saved document plus {file, trials}.
 */
export async function findOne(v, steps, opts, { budgetMs = +(process.env.SEQ_SHRINK_MS || 600000), maxTrials = 40, log = () => {} } = {}) {
  const head = steps.slice(0, v.step + 1)
  let trials = 0
  const fails = async (sub) => { trials++; const r = await runSequence({ ...opts, steps: sub, shot: 'trial' }); log(`trial ${trials}: ${sub.length} steps → ${r.violation?.sig || 'pass'}`); return !!r.violation && keyOf(r.violation) === keyOf(v) }
  const again = await fails(head)
  const min = again ? await ddmin(head, fails, { budgetMs, maxTrials: maxTrials - 1 }) : head
  const [id, screen] = v.sig.split(':')
  const name = `${id}-${screen}-${opts.seed}`
  const doc = { name, invariant: id, sig: v.sig, fp: v.fp, seed: opts.seed, big: !!opts.big, viewport: opts.viewport, theme: opts.theme, steps: min,
    screenshot: path.relative(process.cwd(), v.screenshot), status: again ? 'new' : 'flaky', detail: v.detail }
  fs.mkdirSync(REGRESSIONS, { recursive: true })
  const file = path.join(REGRESSIONS, `${name}.json`)
  // one step per line: a long minimal list stays a short, reviewable file
  const lines = `[\n${min.map((x) => `    ${JSON.stringify(x)}`).join(',\n')}\n  ]`
  fs.writeFileSync(file, JSON.stringify({ ...doc, steps: 0 }, null, 2).replace('"steps": 0', () => `"steps": ${lines}`) + '\n')
  return { ...doc, file, trials }
}
