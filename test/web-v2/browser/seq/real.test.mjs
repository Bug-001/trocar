// real.test.mjs — the local-only soak against a read-only side board over real captured data. Never in the default run: it runs only
// with TROCAR_PLAYWRIGHT=1 and SEQ_REAL = the path of the side board's url file (one line, `http://127.0.0.1:<port>/#t=<token>`).
// Reader steps only (no growth, no worker kill: the data and the worker are not this test's), route faults stay browser-local, I-cjk
// is off. SEQ_SEEDS × SEQ_STEPS from SEQ_SEED_BASE; no shrinking (live data does not replay): every violation is reported with its
// full sequence and screenshot. The board's URL and token are never printed.
import fs from 'node:fs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { probe } from '../harness.mjs'
import { generate, lookOf, runSequence } from './runner.mjs'

const env = process.env
const gate = env.SEQ_REAL && env.TROCAR_PLAYWRIGHT === '1' ? await probe() : { ok: false, reason: 'SEQ_REAL and TROCAR_PLAYWRIGHT=1 are not both set' }
const skip = gate.ok ? false : gate.reason
const STEPS = +(env.SEQ_STEPS || 60)
const SEEDS = Array.from({ length: +(env.SEQ_SEEDS || 6) }, (_, k) => +(env.SEQ_SEED_BASE || 1) + k)

const base = skip ? null : fs.readFileSync(env.SEQ_REAL, 'utf8').trim()
const secrets = base ? [base, new URL(base).origin, new URLSearchParams(new URL(base).hash.slice(1)).get('t')].filter(Boolean) : []
const redact = (s) => secrets.reduce((x, k) => x.split(k).join('<board>'), String(s))

for (const seed of SEEDS) {
  test(`real seed ${seed}`, { skip }, async () => {
    const steps = generate(seed, STEPS, null, { real: true })
    let r
    try { r = await runSequence({ steps, seed, ...lookOf(seed), chromium: gate.chromium, real: true, base, known: 'all', shot: `real-${seed}` }) } catch (e) { throw new Error(redact(e?.stack || e)) }
    for (const [id, p] of Object.entries(r.pending)) console.log(`PENDING ${id} ${p.max || 'seen'} in ${p.n} step(s)`)
    for (const v of r.seen) console.log(redact(`seed ${seed} step ${v.step}: ${v.sig} — ${v.detail} (screenshot ${v.screenshot})`))
    console.log(`real seed ${seed}: ${r.ms} ms, max long task ${r.maxLongTask} ms`)
    assert.deepEqual(r.seen.map((v) => v.sig), [], redact(`steps: ${JSON.stringify(steps)}`))
  })
}
