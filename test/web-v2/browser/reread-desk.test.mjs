// test/web-v2/browser/reread-desk.test.mjs — 3.5 §访问模式「版本变更的重读」(#43) on the mounted desk, over the real worker and real answer files: a desk
// on one step, scrolled, a block open, while its session is re-read to its end and switched: the desk stays where the reader left it
// through the whole re-read and past the switch, and ends on the new answer. Runs only under `npm run test:browser`.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { gzipSync, gunzipSync } from 'node:zlib'
import { probe, withBoard } from './harness.mjs'
import { tmpDir } from '../../helpers/tmp.mjs'
import { bigSession } from '../../query/big-session.mjs'
import { headFile, readHead, rereadFile } from '../../../src/query/ctx-files.mjs'
import { projectionFile, sessionDir, PROJ_V } from '../../../src/query/projection.mjs'

const gate = await probe()
const skip = gate.ok ? false : gate.reason
const CALLS = 5000, NEW = 5, STEP = 500 // CALLS: the re-read spans several of the desk's head polls (1.5 s apart) even at the fastest re-read rate seen, ~930 calls/s
const BOUND = 120_000 // the fold of a whole session by a niced worker; a wait past it is a stall

const until = async (ok, what) => {
  for (const t = Date.now(); !(await ok()); await new Promise((r) => setTimeout(r, 100))) assert.ok(Date.now() - t < BOUND, what)
}
// the place a reader holds: the step, the scroll of the window and which block is open
const placeOf = (page) => page.evaluate(() => {
  let win = document.querySelector('#ctxwin')
  while (win && win.scrollHeight <= win.clientHeight) win = win.parentElement
  return { step: document.querySelector('#stepbar .sb-no')?.dataset.n ?? null, top: win?.scrollTop ?? null,
    open: [...document.querySelectorAll('#ctxwin .cblk[data-bi]:not(.collapsed)')].map((e) => e.dataset.bi).join() }
})
const lineOf = (page) => page.evaluate(() => { const e = document.querySelector('.readstate'); return e ? { state: e.dataset.readState, text: e.textContent } : null })

test('3.5 重读 #43: through a re-read and past the switch the desk keeps its step, scroll and open block, and ends on the new answer', { skip, timeout: 4 * BOUND }, async (t) => {
  const userHome = tmpDir('trocar-reread-desk-'), home = path.join(userHome, '.trocar')
  fs.mkdirSync(path.join(home, 'raw'), { recursive: true, mode: 0o700 })
  const s = bigSession({ home, id: 'big-0000-4a1b-9c2d-000000000001', segment: '20261020T164731Z', growth: 120, compactAt: 6_000 }), { id } = s
  s.append(CALLS)
  const b = await withBoard({ home: { userHome, home }, width: 1440, chromium: gate.chromium })
  try {
    const { page, face } = b
    await face.get('session', { id })
    await until(() => { const d = readHead(home, id); return d?.tier === 1 && d.pending === null }, 'the first read reached its end')
    await page.evaluate(([i, n]) => { location.hash = `#/replay/p/${i}?step=${n}` }, [id, STEP])
    await page.waitForFunction((n) => document.querySelector('#stepbar .sb-no')?.dataset.n === String(n) && !!document.querySelector('#ctxwin .cblk[data-bi] > .cbh'), STEP, { timeout: BOUND })
    // a block the window has to be scrolled to, opened, and the window left on it
    const bi = await page.evaluate(() => { const all = document.querySelectorAll('#ctxwin .cblk[data-bi].collapsed'), e = all[Math.floor(all.length / 2)]; e.querySelector('.cbh').click(); return e.dataset.bi })
    await until(async () => (await placeOf(page)).open !== '', 'a block is open')
    await page.evaluate((i) => document.querySelector(`#ctxwin .cblk[data-bi="${i}"]`).scrollIntoView({ block: 'center' }), bi)
    const place = await placeOf(page), was = readHead(home, id)
    assert.ok(place.top > 0, `the window is scrolled: ${JSON.stringify(place)}`)

    // the last version's answer: a new worker finds the projection stale, the packs under other tags, and new calls behind them
    face.killWorker()
    // a poll of the page can fork a new worker right behind the kill, and its polls keep it warm: kill until none is left
    await until(() => face.workers().length === 0 || (face.killWorker(), false), 'the worker is gone')
    for (const n of fs.readdirSync(sessionDir(home, id))) if (n.startsWith('extract.')) fs.rmSync(path.join(sessionDir(home, id), n))
    fs.writeFileSync(projectionFile(home, id), `${JSON.stringify({ v: PROJ_V + 1 })}\n`)
    fs.writeFileSync(headFile(home, id), gzipSync(Buffer.from(JSON.stringify({ ...was, packs: was.packs.map((p) => ({ ...p, tag: 'last' })) }), 'utf8')))
    s.append(NEW)
    // the line can say "updating" only once the page holds a head carrying `pending.read`: wait for one, never pass without it
    const gotRead = page.waitForResponse(async (r) => {
      if (new URL(r.url()).pathname !== '/api/d/head' || r.status() !== 200) return false
      let buf
      try { buf = await r.body() } catch { return false } // the page let the response go
      let doc
      try { doc = JSON.parse(buf.toString('utf8')) } catch { doc = JSON.parse(gunzipSync(buf).toString('utf8')) }
      return doc?.pending?.read != null
    }, { timeout: BOUND }).then(() => true, () => false)
    face.sweep()

    const words = new Set()
    let began = false, samples = 0, from = 0
    await until(async () => {
      const on = fs.existsSync(rereadFile(home, id)), line = await lineOf(page)
      if (on && !began) from = Date.now()
      began ||= on
      if (line) words.add(line.state)
      assert.deepEqual(await placeOf(page), place, 'the desk holds its place')
      samples++
      return began && !on
    }, 'the re-read ended')
    t.diagnostic(`the re-read of ${CALLS + NEW} calls took ${Date.now() - from} ms`)
    assert.ok(samples > 3, 'sampled along the re-read')
    assert.ok(await gotRead, 'the page received a head carrying pending.read while the re-read ran')
    assert.ok(words.has('updating'), `the line said it: ${[...words]}`)

    const now = readHead(home, id)
    assert.equal(now.pending, null)
    assert.notDeepEqual(now.packs.map((p) => p.tag), was.packs.map(() => 'last'), 'the tags changed')
    await page.waitForFunction((m) => { const e = document.querySelector('#stepbar .sb-no'); return !!e && new RegExp(`/\\s*${m}\\b`).test(e.textContent) }, now.steps, { timeout: BOUND })
    assert.ok(now.steps > was.steps, 'the newest calls are on the page')
    await until(async () => (await lineOf(page))?.state !== 'updating', 'the read-state line left')
    assert.equal(await page.evaluate(() => document.body.textContent.includes('Updating')), false)
    assert.deepEqual(await placeOf(page), place, 'past the switch too')
    assert.deepEqual(b.errors, [])
  } finally { await b.stop() }
})
