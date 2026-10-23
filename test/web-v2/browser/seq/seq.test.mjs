// seq.test.mjs — the sequence suite (only under `npm run test:browser`). First every saved regression replays (regressions/*.json, by
// name): `fixed` and `new` must not break any invariant; `open` (a triaged product bug, with owner and suspect) and `flaky` are
// node:test `todo` (replayed and reported, never red), and an open one's key (sig + fingerprint, runner keyOf) is known in the random
// runs: a violation of the same class with another fingerprint is new. Then one test per seed: SEQ_SEED, or
// SEQ_SEED_BASE (1) … + SEQ_SEEDS (6) − 1 (runner DEFAULT_SEEDS), each SEQ_STEPS (60) steps, the big world when SEQ_BIG=1. A violation
// with an unknown key is shrunk and saved as `new`, and the test fails with the seed, the minimal steps and the screenshot path.
import test from 'node:test'
import assert from 'node:assert/strict'
import { probe } from '../harness.mjs'
import { generate, lookOf, runSequence, regressions, findOne, keyOf, replayTodo, replayFailure, DEFAULT_SEEDS, DEFAULT_STEPS } from './runner.mjs'

const gate = await probe()
const skip = gate.ok ? false : gate.reason
const env = process.env
const STEPS = +(env.SEQ_STEPS || DEFAULT_STEPS), BIG = env.SEQ_BIG === '1'
const SEEDS = env.SEQ_SEED ? [+env.SEQ_SEED] : env.SEQ_SEEDS || env.SEQ_SEED_BASE
  ? Array.from({ length: +(env.SEQ_SEEDS || DEFAULT_SEEDS.length) }, (_, k) => +(env.SEQ_SEED_BASE || DEFAULT_SEEDS[0]) + k) : DEFAULT_SEEDS
const saved = regressions()
const known = new Set(saved.filter((r) => r.status === 'open').map(keyOf))
const shrunk = new Set() // a key is shrunk once per run; later seeds that meet it fail without shrinking

const report = (label, r) => {
  for (const [id, p] of Object.entries(r.pending)) console.log(`PENDING ${id} ${p.max || 'seen'} in ${p.n} step(s) (${label})`)
  const by = Map.groupBy(r.seen, keyOf)
  for (const [sig, vs] of by) console.log(`known ${sig} at ${vs.length} step(s), first ${vs[0].step} (${label})`)
  for (const e of r.serverErrors) console.log(`SERVER ${e} (${label})`)
  console.log(`${label}: ${r.ms} ms, ${r.step + 1} step(s), max long task ${r.maxLongTask} ms`)
}

for (const reg of saved) {
  test(reg.name, { skip, todo: replayTodo(reg) }, async () => {
    const r = await runSequence({ steps: reg.steps, seed: reg.seed, big: reg.big, viewport: reg.viewport, theme: reg.theme, chromium: gate.chromium, shot: `replay-${reg.name}`,
      known: new Set([...known].filter((k) => k !== keyOf(reg))) }) // another open bug met on the way is that bug's own regression: run past it
    report(`${reg.name} [${reg.status}]`, r)
    const failure = replayFailure(reg, r)
    if (failure) assert.fail(failure)
  })
}

for (const seed of SEEDS) {
  test(`seed ${seed}`, { skip }, async () => {
    const steps = generate(seed, STEPS, null)
    const opts = { seed, big: BIG, ...lookOf(seed), chromium: gate.chromium, known }
    const r = await runSequence({ ...opts, steps })
    report(`seed ${seed} ${opts.viewport} ${opts.theme}`, r)
    console.log(`coverage (ran/skipped): ${Object.entries(r.coverage).map(([a, c]) => `${a} ${c.ran}/${c.skipped}`).join(' · ')}`)
    if (!r.violation) return
    const v = r.violation
    if (shrunk.has(keyOf(v))) assert.fail(`seed ${seed}: ${v.sig} again at step ${v.step} — ${v.detail} (screenshot ${v.screenshot}); shrunk once in this run`)
    shrunk.add(keyOf(v))
    console.log(`seed ${seed}: ${keyOf(v)} at step ${v.step} — ${v.detail}; shrinking`)
    const reg = await findOne(v, steps, opts, { log: (m) => console.log(`  ${m}`) })
    assert.fail(`seed ${seed}: ${v.sig} (${reg.status}) — ${v.detail}\n  minimal steps (${reg.steps.length}, ${reg.trials} trials): ${JSON.stringify(reg.steps)}\n  screenshot ${v.screenshot}\n  saved ${reg.file}`)
  })
}
