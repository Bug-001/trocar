// test/web-v2/no-load-control.test.mjs — 2.3 #10 #21 #24 · 1.4 ⑧: no state of the replay desk has a load control. Over
// generated session worlds (desk-world.mjs) × {held, unheld at 0 ms / 200 ms, lane landed} × {pending first, pending later, none}
// × {truncated or not}, the step bar and the session head are rendered as the desk renders
// them: no [data-load-step]; nothing a reader can press inside an aria-busy frame or the read-state line; an unheld step keeps what
// was drawn for 150 ms (frameFor), then shows its row's step bar; the read-state line is there exactly while `pending` is. The
// window's half is the React window's DOM: Window.test.tsx '2.3 #10' (an unheld step's frames: aria-busy, nothing to press) and
// Cell.test.tsx '2.3 #21' (a body on the way is its sized preview box with no control).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildLanes, anchorLane } from '../../web/legacy/replay/lanes.mjs'
import { stepOf } from '../../web/legacy/replay/model.mjs'
import { stepBarHtml } from '../../web/legacy/replay/stepbar.mjs'
import { renderSessionHead } from '../../web/legacy/replay/header.mjs'
import { frameFor } from '../../web/legacy/replay/replay.mjs'
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

async function variants(seed) {
  const w = world(seed), get = w.get(), held = await deskFrom(get, 'S')
  const key = anchorLane(buildLanes(held)).id
  const unheld = structuredClone(held); unheld.held.delete(key)
  const landed = await readLane(get, 'S', structuredClone(unheld), { lane: key })
  return { held, unheld, landed, key }
}

test('2.3 #10 #21 #24 · 1.4 ⑧: no load control in any desk state; unheld keeps 150 ms, then the row\'s step bar; read-state iff pending', async () => {
  let unheldSeen = 0
  for (const seed of SEEDS) {
    const v = await variants(seed)
    const n = buildLanes(v.held).find((l) => l.id === v.key).calls.length
    for (const playhead of [0, Math.floor(n / 2), n - 1])
      for (const pending of [{ done: 2, total: 9 }, 'later', null])
        for (const truncated of [null, { shown: 3, total: 9, file_mb: 12 }]) {
            const fix = (d) => {
              const x = structuredClone(d)
              x.pending = pending === 'later' ? { done: 7, total: 9 } : pending; x.firstPending = pending !== 'later'; x.truncated = truncated
              return x
            }
            for (const which of ['held', 'unheld', 'landed']) {
              const s = state(fix(v[which]), playhead), call = s.anchor.calls[s.playhead]
              const st = stepOf(s.desk, call.rid)
              const what = `seed ${seed} step ${s.playhead} ${which} pending=${JSON.stringify(pending)} trunc=${!!truncated}`
              const head = fake(); renderSessionHead(head, s)
              const bar = stepBarHtml(s)
              for (const [h, part] of [[bar, 'step bar'], [head.innerHTML, 'session head']]) noControl(h, `${what} ${part}`)
              assert.equal(READ_STATE.test(head.innerHTML), pending != null, `${what}: the read-state line is there exactly while pending`)
              if (which === 'unheld') {
                unheldSeen++
                // < 150 ms: what was drawn stays; ≥ 150 ms: the step bar is the new row's (the window's busy frames: Window.test.tsx 2.3 #10)
                assert.equal(frameFor({ held: st.held, since: 1000, now: 1000 }), 'keep', what)
                assert.equal(frameFor({ held: st.held, since: 1000, now: 1000 + BUSY + 50 }), 'busy', what)
                assert.ok(bar.includes(call.ts), `${what}: the step bar is not the new row's`)
                continue
              }
              assert.equal(frameFor({ held: st.held, since: 0, now: 0 }), 'rows', what)
            }
          }
  }
  assert.ok(unheldSeen > 0, 'the generated states cover unheld steps')
})
