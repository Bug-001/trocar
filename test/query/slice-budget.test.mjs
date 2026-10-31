// test/query/slice-budget.test.mjs — 3.5 #39 (§后台抽取与归约 「每片 ≤ 50 ms CPU」): what comes after a background slice's fold —
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
// slice until it says nothing is left, a line per slice (1: more, 0: none) then the head's `pending.done` (h<done>; h- when the head
// has no pending; nothing while there is no head), and a dot while a slice reads or folds; then the idle save.
// With `late` > 0 the process writes the session itself, CALLS − late calls first, and the rest in two halves (an `a` line each): the
// first once the slices said nothing is left, the second after the next slice that wrote answer files only (the frontier at the last
// member) — so it arrives while the files of the first half are being written. With `drips` > 0 the second half comes in that many
// drips instead, each `gap` slices that wrote answer files only after the one before, or at once after a slice that said nothing is
// left (an `r` line: the files reached the state while calls were still coming). It prints an `f` for each slice that began with
// members past the frontier and did not move it.
const DRIVER = `
await import(${at('../../src/query/named/index.mjs')})
const { extendSession, saveIndexes, version } = await import(${at('../../src/query/named/session.mjs')})
const { bigSession } = await import(${at('./big-session.mjs')})
const { indexRows, sessionGroups } = await import(${at('../../src/query/rows.mjs')})
const { headFile } = await import(${at('../../src/query/ctx-files.mjs')})
const { gunzipSync } = await import('node:zlib')
const fs = await import('node:fs')
const [home, id, ms, late, drips, gap] = [process.argv[1], process.argv[2], ...process.argv.slice(3).map(Number)]
const s = late > 0 ? bigSession({ home, wire: 'http', ...${JSON.stringify(SHAPE)} }) : null
if (s) s.append(${CALLS} - late)
const frontier = async () => JSON.parse((await version({ home, writer: true, params: { id } })).key)[1]
const last = async () => String(sessionGroups(await indexRows({ home, errors: [] })).get(id).at(-1).id)
const head = () => { try { return JSON.parse(gunzipSync(fs.readFileSync(headFile(home, id)))) } catch { return null } }
let t = 0, added = 0, since = 0
const progress = () => { const n = Date.now(); if (n - t > 200) { t = n; process.stdout.write('.\\n') } }
for (let more = true; more;) {
  const was = s && await frontier(), left = s && was !== await last()
  more = await extendSession({ home, writer: true, progress }, id, ms)
  process.stdout.write(more ? '1\\n' : '0\\n')
  const h = head()
  if (h) process.stdout.write(h.pending ? \`h\${h.pending.done}\\n\` : 'h-\\n')
  if (left && await frontier() === was) process.stdout.write('f\\n')
  if (!s || added >= late) continue
  const atEnd = await frontier() === await last()
  if (added > 0 && atEnd) since++
  const due = added === 0 ? !more : drips > 0 ? !more || since >= gap : !more || atEnd
  if (!due) continue
  if (added > 0 && drips > 0 && !more) process.stdout.write('r\\n')
  const n = added === 0 || drips === 0 ? late / 2 : late / 2 / drips
  s.append(n); added += n; since = 0; more = true; process.stdout.write('a\\n')
}
saveIndexes()
process.exit(0)`
/** drive(home, id, ms, late, drips, gap) → {slices: the slices' answers in order (true: more is left), added: the arrivals appended,
 *  stood: the slices that left the frontier where it was with members past it (late > 0), reached: the slices that said nothing is
 *  left while drips were still due, done: the head's pending.done after each slice that left a head with pending}, once the process
 *  exits; fails after STALL ms with no line. */
async function drive(home, id, ms, late = 0, drips = 0, gap = 0) {
  const c = spawn(process.execPath, ['--require', NO_REAL_OS, '--input-type=module', '-e', DRIVER, home, id, String(ms), String(late), String(drips), String(gap)], { stdio: ['ignore', 'pipe', 'pipe'] })
  let out = '', err = '', seen = Date.now()
  c.stdout.on('data', (b) => { out += b; seen = Date.now() })
  c.stderr.on('data', (b) => { err += b })
  const code = await new Promise((ok, no) => {
    const tick = setInterval(() => { if (Date.now() - seen > STALL) { clearInterval(tick); c.kill('SIGKILL'); no(new Error(`the fold process: no slice for ${STALL} ms`)) } }, 50)
    c.on('close', (k) => { clearInterval(tick); ok(k) })
  })
  assert.equal(code, 0, `the fold process failed: ${err.split('\n').slice(0, 6).join(' / ')}`)
  const lines = out.split('\n')
  const count = (x) => lines.filter((l) => l === x).length
  return { slices: lines.filter((l) => l === '0' || l === '1').map((l) => l === '1'), added: count('a'), stood: count('f'), reached: count('r'),
    done: lines.filter((l) => /^h\d+$/.test(l)).map((l) => Number(l.slice(1))) }
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

test('3.5 #39: answer files a slice cannot fit are written over several slices that each say more is left; the files are the bytes of a run with no budget', { timeout: 900_000 }, async () => {
  const x = homeOf(), id = sessionIn(x)
  assert.deepEqual((await drive(x, id, 1e9)).slices, [false], 'with no budget: one slice does it all')
  const want = filesOf(x, id)
  assert.ok(Object.keys(want).filter((f) => f.startsWith('p')).length >= 4, 'at least two sealed packs')

  // folded, then its answer files gone (a session folded before them, 3.5 「答案文件」 upgrade): nothing is left to fold, the packs are
  const y = homeOf()
  assert.equal(sessionIn(y), id)
  await drive(y, id, 1e9)
  for (const f of fs.readdirSync(sessionDir(y, id))) if (ANSWER.test(f)) fs.unlinkSync(path.join(sessionDir(y, id), f))
  const ys = (await drive(y, id, SPENT)).slices
  assert.equal(ys[0], true, 'a slice whose budget is spent does not write every pack: it says more is left')
  assert.deepEqual(ys.slice(0, -1).filter((m) => !m), [], 'every slice before the last says more is left')
  sameFiles(filesOf(y, id), want, 'written over spent slices')

  // folded from nothing in spent slices: the fold moves on every slice, the files are written once it reaches the end
  const z = homeOf()
  assert.equal(sessionIn(z), id)
  const zd = (await drive(z, id, SPENT)).done
  sameFiles(filesOf(z, id), want, 'folded and written in spent slices')
  // no answer file is written while members are left, yet the head the board reads shows the fold's progress (3.5:42, 3.5 #31)
  assert.ok(new Set(zd).size >= 2, `the head's pending.done grew before the fold ended (${[...new Set(zd)]})`)
  zd.forEach((d, i) => assert.ok(i === 0 || d >= zd[i - 1], `pending.done never drops (${zd[i - 1]} → ${d})`))

  // calls that arrive while the files of a pack sealed by calls before them are being written move the frontier under them: the files
  // still end as the bytes of a run with no budget over the same calls
  const w = homeOf(), LATE = 100 // the first half seals pack 1 (3.5 PACK_MEMBERS)
  const zs = await drive(w, id, SPENT, LATE)
  assert.equal(zs.added, 2, 'both halves arrived')
  assert.equal(zs.stood, 0, 'every slice that began with members past the frontier moved it (3.5:42), files being written or not')
  const raw = (home) => fs.readdirSync(path.join(home, 'raw'), { recursive: true }).sort().map((f) => [f, String(fs.statSync(path.join(home, 'raw', f)).size)])
  assert.deepEqual(raw(w), raw(x), 'the same calls as the run with no budget')
  sameFiles(filesOf(w, id), want, 'written in spent slices with calls arriving meanwhile')

  // calls that keep arriving, each fewer slices after the one before than sealing a pack takes, and none of them in that pack: the
  // seal goes on where it stood, so the files reach the state while calls are still coming (they would never if each started it over)
  const v = homeOf(), GAP = 150
  const vs = await drive(v, id, SPENT, LATE, 5, GAP)
  assert.equal(vs.added, 6, 'the first half and five drips arrived')
  assert.equal(vs.stood, 0, 'every slice that began with members past the frontier moved it (3.5:42)')
  assert.ok(vs.reached > 0, `the files reached the state between drips ${GAP} slices apart`)
  assert.deepEqual(raw(v), raw(x), 'the same calls as the run with no budget')
  sameFiles(filesOf(v, id), want, 'written in spent slices with calls arriving faster than a seal')
})

const rng = (seed) => () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32)
const lineOf = (r) => `${'abcdefghij'.repeat(1 + Math.floor(r() * 400))}${Math.floor(r() * 1e9)}\n`
const PARTS = /^x\.(\d+)-(\d+)\.br$/

test('3.5 #39 / 4.3 §4 分片: a seal whose budget is spent goes on over calls; meanwhile every line reads back and lines append; the parts are a one-pass seal\'s bytes', () => {
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
