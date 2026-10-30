// test/query/pending-work.test.mjs — `pending.work` follows the running fold (RFC 3.5 §会话读 `pending?: {done, total, work}`, #31):
// while a `session` answer carries `pending`, its `work` grew between two answers with background slices between them, `done` never
// went down, and the run ends with no `pending` — whether the fold starts from scratch, resumes from the fold log's sidecar, or
// cannot resume (the sidecar's reduction state is of another REDUCE_V, missing or unreadable) and rebuilds up to the log's frontier — and when its store is closed and opened again in the middle (3.5:43).
//
// A long session folded whole by a worker and saved at an idle period, then grown; each axis runs in a fresh process (session.mjs
// keeps its stores and states per process: a warm one never resumes): it alternates answers (`session`, as the worker answers) with
// small background slices and prints the `pending` of every answer.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tmpDir } from '../helpers/tmp.mjs'
import { within } from '../helpers/bounded.mjs'
import { bigSession } from './big-session.mjs'
import '../../src/query/named/index.mjs'
import { extendSession, saveIndexes } from '../../src/query/named/session.mjs'
import { foldLogFile } from '../../src/query/fold-log.mjs'
import { loadSidecar, saveSidecar } from '../../src/query/line-file.mjs'

const NO_REAL_OS = fileURLToPath(new URL('../helpers/no-real-os.cjs', import.meta.url))
const at = (p) => JSON.stringify(new URL(p, import.meta.url).href)
const SHAPE = { wire: 'threads', growth: 1_500, compactAt: 20_000, subEvery: 4, subLanes: 2, late: 1 }

// answers and background slices of `ms`, `per` slices between two answers, until an answer has no pending. Prints [{pending, bg}].
const LOOP = `
const { runQuery } = await import(${at('../../src/query/named/index.mjs')})
const { extendSession } = await import(${at('../../src/query/named/session.mjs')})
const [home, id, others] = [process.argv[1], process.argv[2], JSON.parse(process.argv[3])]
const ctx = { home, writer: true }, out = []
for (let bg = 0, more = true; ;) {
  const doc = await runQuery('session', { id }, ctx)
  out.push({ pending: doc.pending ?? null, bg })
  if (!doc.pending || out.length > 5000) break
  // once, a few answers in: other sessions opened past the store cache, so this one's store is closed and opened again
  if (out.length === 3) for (const o of others) await runQuery('session', { id: o }, ctx)
  bg = 0
  for (let i = 0; i < 3 && more; i++) { more = await extendSession(ctx, id, 2); bg++ }
  if (!more) more = true
}
process.stdout.write(JSON.stringify(out))`

async function answers(home, id, others = []) {
  const c = spawn(process.execPath, ['--require', NO_REAL_OS, '--input-type=module', '-e', LOOP, home, id, JSON.stringify(others)], { stdio: ['ignore', 'pipe', 'pipe'] })
  let out = '', err = ''
  c.stdout.on('data', (b) => { out += b }); c.stderr.on('data', (b) => { err += b })
  const [code] = await within(new Promise((ok) => c.on('close', (...a) => ok(a))), 240_000, 'the answering process', () => c.kill('SIGKILL'))
  assert.equal(code, 0, `the answering process failed: ${err.split('\n').slice(0, 6).join(' / ')}`)
  return JSON.parse(out)
}

const sidecarEdit = (home, id, edit) => {
  const file = foldLogFile(home, id), sc = loadSidecar({ file })
  assert.ok(sc && sc.parts['r.m'] && sc.parts['r.s'], 'the fold log has a sidecar with a reduction state')
  saveSidecar({ file, head: sc.head, parts: Object.entries(edit({ ...sc.parts })) })
}
const AXES = {
  'from scratch': (home) => { fs.rmSync(path.join(home, 'index', 'ctx'), { recursive: true, force: true }) },
  'resumed from the sidecar': () => {},
  'refused: another REDUCE_V': (home, id) => sidecarEdit(home, id, (p) => { const m = JSON.parse(p['r.m'][0]); return { ...p, 'r.m': [JSON.stringify({ ...m, rv: m.rv + 1 })] } }),
  'refused: no reduction state': (home, id) => sidecarEdit(home, id, (p) => { delete p['r.s']; return p }),
  // 3.5:43: `work` is the worker's count for the session, so a store closed between answers (evicted by others) does not restart it;
  // on a rebuild, so the fold runs across many answers
  'store evicted between answers': (home, id) => (AXES['refused: another REDUCE_V'](home, id), Array.from({ length: 24 }, (_, i) => {
    const id = `big-0000-4a1b-9c2d-0000000002${String(i).padStart(2, '0')}`
    bigSession({ home, id, segment: `20261019T0000${String(i).padStart(2, '0')}Z`, growth: 300, seed: 11 + i }).append(2)
    return id
  })),
  'refused: an unreadable reduction state': (home, id) => sidecarEdit(home, id, (p) => ({ ...p, 'r.s': Uint8Array.from({ length: 64 }, (_, i) => (i * 37 + 11) & 255) })),
}

test('pending.work grows between answers while the fold runs, done never goes down, the run ends folded (3.5 #31)', { timeout: 900_000 }, async (t) => {
  const src = path.join(tmpDir('trocar-work-'), '.trocar')
  const s = bigSession({ home: src, ...SHAPE })
  s.append(2_000)
  while (await extendSession({ home: src, writer: true }, s.id, Infinity));
  saveIndexes()
  s.append(400)
  for (const [axis, apply] of Object.entries(AXES)) {
    const home = path.join(tmpDir('trocar-work-'), '.trocar')
    fs.cpSync(src, home, { recursive: true })
    const others = apply(home, s.id)
    const seq = await answers(home, s.id, Array.isArray(others) ? others : [])
    const pend = seq.filter((a) => a.pending)
    t.diagnostic(`${axis}: ${pend.length} pending answers`)
    assert.ok(pend.length >= 2, `${axis}: the fold was still running across answers`)
    assert.equal(seq.at(-1).pending, null, `${axis}: the run ends folded`)
    for (const a of pend) assert.ok(Number.isInteger(a.pending.work) && a.pending.work >= 0, `${axis}: work is a count: ${JSON.stringify(a.pending)}`)
    for (let i = 1; i < seq.length; i++) {
      const [a, b] = [seq[i - 1].pending, seq[i].pending]
      if (!a || !b) continue
      assert.ok(b.work >= a.work, `${axis}: work went down at answer ${i}: ${JSON.stringify([a, b])}`)
      assert.ok(b.done >= a.done, `${axis}: done went down at answer ${i}: ${JSON.stringify([a, b])}`)
      if (seq[i].bg >= 1) assert.ok(b.work > a.work, `${axis}: work did not grow across ${seq[i].bg} slices at answer ${i}: ${JSON.stringify([a, b])}`)
    }
  }
})
