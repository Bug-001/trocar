// test/web-v2/no-load-control.test.mjs — A15 (2.3 #10 #21 #24 · 1.4 ⑧): no state of the replay desk has a load control. Over
// generated session worlds (desk-world.mjs) × {held, unheld at 0 ms / 200 ms, lane landed} × {pending first, pending later, none}
// × {truncated or not} × {reply body in flight, failed, read}, the window, the step bar, the session head and the raw panel are
// rendered as the desk renders them: no [data-load-step]; nothing a reader can press inside an aria-busy frame or the read-state
// line; an unheld step keeps the window drawn before it for 150 ms (frameFor), then shows its row's step bar and empty busy frames;
// an open row whose bytes are on the way is the sized preview box; the read-state line is there exactly while `pending` is.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildLanes, anchorLane } from '../../src/web/v2/replay/lanes.mjs'
import { stepOf } from '../../src/web/v2/replay/model.mjs'
import { ctxWindowUnits, ctxWindowHtml, renderContextWindow } from '../../src/web/v2/replay/ctxwin.mjs'
import { stepBarHtml } from '../../src/web/v2/replay/stepbar.mjs'
import { renderSessionHead } from '../../src/web/v2/replay/header.mjs'
import { renderRawPanel } from '../../src/web/v2/replay/rawpanel.mjs'
import { bodyCache } from '../../src/web/v2/replay/cell.mjs'
import { frameFor } from '../../src/web/v2/replay/replay.mjs'
import { world, deskFrom, readLane } from './desk-world.mjs'

const SEEDS = [2, 5, 11, 23]
const BUSY = 150 // 2.3 §车道未到手

const state = (desk, playhead) => {
  const lanes = buildLanes(desk), anchor = anchorLane(lanes)
  return { desk, lanes, anchor, meta: desk.meta, playhead: Math.min(playhead, anchor.calls.length - 1), follow: false, followLanding: false,
    diffRef: null, openBlocks: new Set(), navOpen: new Set(), turnFold: new Map(), turnLanded: new Set(), pricing: null, pricingErr: null, staleErr: null, viewPin: null }
}
const fake = (extra = {}) => ({ innerHTML: '', ...extra })

// the element regions an attribute pattern opens: from its start tag to the matching end tag
function regions(html, open) {
  const out = []
  for (const m of html.matchAll(new RegExp(`<(\\w+)\\b[^>]*${open.source}[^>]*>`, 'g'))) {
    const tag = m[1], re = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'g')
    re.lastIndex = m.index + m[0].length
    let depth = 1, end = html.length
    for (let x; depth && (x = re.exec(html));) { depth += x[1] ? -1 : 1; if (!depth) end = x.index }
    out.push(html.slice(m.index + m[0].length, end))
  }
  return out
}
const PRESSABLE = /<(button|a)\b|role="button"|\btabindex=/
const BUSY_ATTR = /aria-busy="true"/
const READ_STATE = /data-read-state/
function noControl(html, what) {
  assert.ok(!/data-load-step/.test(html), `${what}: a load-step control`)
  for (const r of [...regions(html, BUSY_ATTR), ...regions(html, READ_STATE)]) assert.ok(!PRESSABLE.test(r), `${what}: something to press inside a busy frame or the read-state line: ${r}`)
}
const text = (html) => html.replace(/<[^>]*>/g, '').trim()

async function variants(seed) {
  const w = world(seed), get = w.get(), held = await deskFrom(get, 'S')
  const key = anchorLane(buildLanes(held)).id
  const unheld = structuredClone(held); unheld.held.delete(key)
  const landed = await readLane(get, 'S', structuredClone(unheld), { lane: key })
  return { held, unheld, landed, key }
}

test('A15 (2.3 #10 #21 #24 · 1.4 ⑧): no load control in any desk state; unheld keeps 150 ms, then row + empty busy frames; in-flight bodies are sized boxes; read-state iff pending', async () => {
  let unheldSeen = 0, boxes = 0
  for (const seed of SEEDS) {
    const v = await variants(seed)
    const n = buildLanes(v.held).find((l) => l.id === v.key).calls.length
    for (const playhead of [0, Math.floor(n / 2), n - 1])
      for (const pending of [{ done: 2, total: 9 }, 'later', null])
        for (const truncated of [null, { shown: 3, total: 9, file_mb: 12 }])
          for (const body of ['flight', 'failed', 'read']) {
            const fix = (d) => {
              const x = structuredClone(d)
              x.pending = pending === 'later' ? { done: 7, total: 9 } : pending; x.firstPending = pending !== 'later'; x.truncated = truncated
              return x
            }
            // the reply bodies of the playhead's step: on the way (nothing cached), failed, or read
            const cache = (s) => {
              const st = stepOf(s.desk, s.anchor.calls[s.playhead].rid)
              for (const d of st.reply || []) {
                bodyCache.delete(d.ref)
                if (body === 'failed') bodyCache.set(d.ref, { status: 'error', error: 'HTTP 503' })
                if (body === 'read') bodyCache.set(d.ref, { status: 'ok', text: 'bytes', verbatim: true, fidelity: 'verbatim' })
              }
              return st
            }
            for (const which of ['held', 'unheld', 'landed']) {
              const s = state(fix(v[which]), playhead), call = s.anchor.calls[s.playhead]
              const st = cache(s)
              const what = `seed ${seed} step ${s.playhead} ${which} pending=${JSON.stringify(pending)} trunc=${!!truncated} body=${body}`
              const head = fake(); renderSessionHead(head, s)
              const raw = fake(); renderRawPanel(raw, s)
              const win = ctxWindowHtml(s), bar = stepBarHtml(s)
              for (const [h, part] of [[win, 'window'], [bar, 'step bar'], [head.innerHTML, 'session head'], [raw.innerHTML, 'raw panel']]) noControl(h, `${what} ${part}`)
              assert.equal(READ_STATE.test(head.innerHTML), pending != null, `${what}: the read-state line is there exactly while pending`)
              if (which === 'unheld') {
                unheldSeen++
                // < 150 ms: what was drawn stays (the previous step's window units are not replaced)
                assert.equal(frameFor({ held: st.held, since: 1000, now: 1000 }), 'keep', what)
                const prev = state(v.held, Math.max(0, s.playhead - 1)), drawn = ctxWindowUnits(prev), el = fake({ __units: drawn })
                renderContextWindow(el, s)
                assert.equal(el.__units, drawn, `${what}: the window changed before 150 ms`)
                // ≥ 150 ms: the step bar is the new row's; the rows are aria-busy frames with no text
                assert.equal(frameFor({ held: st.held, since: 1000, now: 1000 + BUSY + 50 }), 'busy', what)
                renderContextWindow(el, s, { busy: true })
                assert.ok(bar.includes(call.ts), `${what}: the step bar is not the new row's`)
                const frames = regions(el.innerHTML, BUSY_ATTR)
                assert.ok(frames.length > 0, `${what}: no busy frame`)
                for (const f of frames) assert.equal(text(f), '', `${what}: a busy frame says something`)
                continue
              }
              assert.equal(frameFor({ held: st.held, since: 0, now: 0 }), 'rows', what)
              // an open reply row whose bytes are on the way: the preview box, sized by its height style
              if (body === 'flight' && /data-rp=/.test(win)) {
                boxes++
                assert.match(win, /<pre class="cellpend"[^>]*style="--cl:\d+"/, `${what}: no sized preview box`)
              }
              if (body !== 'flight') assert.ok(!/class="cellpend"/.test(win), `${what}: a preview box for a body that answered`)
            }
          }
  }
  assert.ok(unheldSeen > 0 && boxes > 0, 'the generated states cover unheld steps and bodies in flight')
})
