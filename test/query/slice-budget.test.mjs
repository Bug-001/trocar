// test/query/slice-budget.test.mjs — 3.5 #38 (§后台抽取与归约 「每片 ≤ 50 ms CPU」): what comes after a background slice's fold —
// the answer files a seal renders, compresses and writes, and the idle save's sealing of the line files' parts — is in the slice's
// budget, in units that go on in the next slice. Driven with a budget no unit fits in, so every call does the least it can: the
// work spreads over calls that each say more is left, and what is written at the end is the bytes of a run with no budget. No
// wall clock is asserted: a wait lasts while the fold process reports and fails after STALL ms with no report.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tmpDir } from '../helpers/tmp.mjs'
import { lineFile } from '../../src/query/line-file.mjs'
import { sessionDir } from '../../src/query/projection.mjs'
import { bigSession } from './big-session.mjs'

const NO_REAL_OS = fileURLToPath(new URL('../helpers/no-real-os.cjs', import.meta.url))
const at = (p) => JSON.stringify(new URL(p, import.meta.url).href)
const SHAPE = { subLanes: 3, late: 4, subEvery: 4, compactAt: 20_000, growth: 1_000 }
const CALLS = 1_100 // two sealed packs (3.5 PACK_MEMBERS) and an open span
const SPENT = 1e-6 // a budget spent before any unit of work ends
const STALL = 60_000

// The worker's background slices in a process of their own (the query modules keep per-process state): extendSession at `ms` a
// slice until it says nothing is left, a line per slice (1: more, 0: none) and a dot while a slice reads or folds; then the idle save.
const DRIVER = `
await import(${at('../../src/query/named/index.mjs')})
const { extendSession, saveIndexes } = await import(${at('../../src/query/named/session.mjs')})
const [home, id, ms] = [process.argv[1], process.argv[2], Number(process.argv[3])]
let t = 0
const progress = () => { const n = Date.now(); if (n - t > 200) { t = n; process.stdout.write('.\\n') } }
for (let more = true; more;) { more = await extendSession({ home, writer: true, progress }, id, ms); process.stdout.write(more ? '1\\n' : '0\\n') }
saveIndexes()
process.exit(0)`
/** drive(home, id, ms) → the slices' answers in order (true: more is left), once the process exits; fails after STALL ms with no line. */
async function drive(home, id, ms) {
  const c = spawn(process.execPath, ['--require', NO_REAL_OS, '--input-type=module', '-e', DRIVER, home, id, String(ms)], { stdio: ['ignore', 'pipe', 'pipe'] })
  let out = '', err = '', seen = Date.now()
  c.stdout.on('data', (b) => { out += b; seen = Date.now() })
  c.stderr.on('data', (b) => { err += b })
  const code = await new Promise((ok, no) => {
    const tick = setInterval(() => { if (Date.now() - seen > STALL) { clearInterval(tick); c.kill('SIGKILL'); no(new Error(`the fold process: no slice for ${STALL} ms`)) } }, 50)
    c.on('close', (k) => { clearInterval(tick); ok(k) })
  })
  assert.equal(code, 0, `the fold process failed: ${err.split('\n').slice(0, 6).join(' / ')}`)
  return out.split('\n').filter((l) => l === '0' || l === '1').map((l) => l === '1')
}

const homeOf = () => { const home = path.join(tmpDir('trocar-budget-'), '.trocar'); fs.mkdirSync(path.join(home, 'raw'), { recursive: true, mode: 0o700 }); return home }
const sessionIn = (home) => { const s = bigSession({ home, wire: 'http', ...SHAPE }); s.append(CALLS); return s.id }
const ANSWER = /^(head\.json\.gz|p\d+\.(main|rest)\.ndjson\.gz|open\.(main|rest)\.ndjson)$/
const SEALED = /^(head\.json\.gz|p\d+\.(main|rest)\.ndjson\.gz)$/
/** the head and pack files of a session (3.5 #34 compares these; a tail is apply-equal, not byte-equal, across runs), name → bytes */
const filesOf = (home, id) => Object.fromEntries(fs.readdirSync(sessionDir(home, id)).filter((f) => SEALED.test(f)).sort().map((f) => [f, fs.readFileSync(path.join(sessionDir(home, id), f))]))
function sameFiles(got, want, what) {
  assert.deepEqual(Object.keys(got), Object.keys(want), `${what}: the same head and pack files`)
  for (const f of Object.keys(want)) assert.ok(got[f].equals(want[f]), `${what}: ${f} is the bytes of the run with no budget`)
}

test('3.5 #38: answer files a slice cannot fit are written over several slices that each say more is left; the files are the bytes of a run with no budget', { timeout: 900_000 }, async () => {
  const x = homeOf(), id = sessionIn(x)
  assert.deepEqual(await drive(x, id, 1e9), [false], 'with no budget: one slice does it all')
  const want = filesOf(x, id)
  assert.ok(Object.keys(want).filter((f) => f.startsWith('p')).length >= 4, 'at least two sealed packs')

  // folded, then its answer files gone (a session folded before them, 3.5 「答案文件」 upgrade): nothing is left to fold, the packs are
  const y = homeOf()
  assert.equal(sessionIn(y), id)
  await drive(y, id, 1e9)
  for (const f of fs.readdirSync(sessionDir(y, id))) if (ANSWER.test(f)) fs.unlinkSync(path.join(sessionDir(y, id), f))
  const ys = await drive(y, id, SPENT)
  assert.equal(ys[0], true, 'a slice whose budget is spent does not write every pack: it says more is left')
  assert.deepEqual(ys.slice(0, -1).filter((m) => !m), [], 'every slice before the last says more is left')
  sameFiles(filesOf(y, id), want, 'written over spent slices')

  // folded from nothing in spent slices: the fold waits while a seal's files are written, then goes on
  const z = homeOf()
  assert.equal(sessionIn(z), id)
  await drive(z, id, SPENT)
  sameFiles(filesOf(z, id), want, 'folded and written in spent slices')
})

const rng = (seed) => () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32)
const lineOf = (r) => `${'abcdefghij'.repeat(1 + Math.floor(r() * 400))}${Math.floor(r() * 1e9)}\n`
const PARTS = /^x\.(\d+)-(\d+)\.br$/

test('3.5 #38 / 4.3 §4 分片: a seal whose budget is spent goes on over calls; meanwhile every line reads back and lines append; the parts are a one-pass seal\'s bytes', () => {
  const r = rng(5), lines = Array.from({ length: 400 }, () => lineOf(r)), O = { partBytes: 120_000, frameBytes: 9_000 }
  const fill = (dir) => { const lf = lineFile({ fs, base: path.join(dir, 'x') }); return { lf, want: lines.map((t) => ({ off: lf.append(t), buf: Buffer.from(t) })) } }
  const parts = (dir) => fs.readdirSync(dir).filter((f) => PARTS.test(f)).sort()

  const one = tmpDir('trocar-seal-one-'), a = fill(one)
  assert.equal(a.lf.seal(O), true)
  const sealed = parts(one)
  assert.ok(sealed.length >= 3, 'three parts or more')

  const sliced = tmpDir('trocar-seal-sliced-'), b = fill(sliced), more = []
  let calls = 0
  for (let done = false; !done;) {
    done = b.lf.seal({ ...O, deadline: 0 })
    if (++calls === 1) assert.deepEqual(parts(sliced), [], 'a seal whose budget is spent seals no part in its first call')
    assert.ok(calls < 100_000, 'the seal ends')
    for (const l of [...b.want, ...more]) assert.ok(b.lf.read(l.off, l.buf.length).equals(l.buf), `the line at ${l.off} reads back between the calls`)
    if (!done && calls % 7 === 0) { const t = lineOf(r); more.push({ off: b.lf.append(t), buf: Buffer.from(t) }) }
  }
  assert.deepEqual(parts(sliced), sealed, 'the parts of a one-pass seal')
  for (const f of sealed) assert.ok(fs.readFileSync(path.join(sliced, f)).equals(fs.readFileSync(path.join(one, f))), `${f}: the bytes of a one-pass seal`)
  b.lf.close()
  const re = lineFile({ fs, base: path.join(sliced, 'x') })
  for (const l of [...b.want, ...more]) assert.ok(re.read(l.off, l.buf.length).equals(l.buf), `the line at ${l.off} reads back reopened`)
  re.close(); a.lf.close()
})
