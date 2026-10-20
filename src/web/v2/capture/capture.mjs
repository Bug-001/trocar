// capture/capture.mjs — 采集 · agent (1.9): the page a person opens to learn whether every agent of theirs is being
// recorded — and when one is not, why and what to do about it. The 采集服务 row plus one row per detected agent, the
// 改动 block. Everything is read from the C.3 `status` document through the shared store; the page polls while visible (1.5 §采集状态 轮询) and re-paints WITHOUT disturbing the
// reader: an expanded row stays expanded, a row the reader folded stays folded, the scroll does not move.
// Read-only by design (N-01): no switch, no restart / install / undo control anywhere — the desired state is text and
// the command that changes it sits in 技术细节.
import { pageHeadHtml } from '../shell/pagehead.mjs'
import { SCREEN_NAME } from '../labels/shell.mjs'
import { harnessName, ensureHarnessIcons } from '../core/chips.mjs'
import { captureVerdict, pollCaptureHealth } from '../core/capture-verdict.mjs'
import { pageHtml } from './capture-view.mjs'

export function mount(el, ctx) {
  const { api, store, router, toast } = ctx
  // the expand memory: harness → the reader's own choice. A row the reader never touched follows its default (a
  // problem row opens, the rest stay folded); a row the reader touched keeps their choice across every re-read.
  const openByReader = new Map()
  let lastH = null, landed = null, poll = null
  // the 最近采到 column reads the 24 h `overview` document (1.9): on open, then with the status poll at most every OV_MS
  const OV_MS = 30e3
  let ov = null, ovAt = 0, ovBusy = false
  function readOv() {
    if (ovBusy || Date.now() - ovAt < OV_MS) return
    ovBusy = true; ovAt = Date.now()
    api.get('overview', { since: '24h' }).then((r) => { if (r && r.ok && r.data) { ov = r.data; paint() } }, () => {}).finally(() => { ovBusy = false })
  }

  el.innerHTML = `<div class="page capage"><div id="caphead"></div><div class="cap-main" id="capmain"></div></div>`
  const headEl = el.querySelector('#caphead'), mainEl = el.querySelector('#capmain')

  // ── painting ────────────────────────────────────────────────────────────────────────────────────────────────────
  // one string per paint (capture-view pageHtml): the expand state is baked into the row strings — the reader's choice
  // first, then the default (a problem row opens) — so a re-read never disturbs an open row
  function paint() {
    const { capH, capHOkAt, capHErr } = store.get()
    const v = captureVerdict(capH, { okAt: capHOkAt, err: capHErr })
    headEl.innerHTML = pageHeadHtml({ name: SCREEN_NAME.capture, readAt: capHOkAt })
    mainEl.innerHTML = pageHtml(capH, v, { openByReader, ov })
    if (mainEl.querySelectorAll) ensureHarnessIcons(mainEl)
  }

  // ── ?h= : land on that row, opened (1.9 §从别处进来); an agent with no row is a toast, never head-zone text ───────
  // `landed` remembers the h this visit already handled (row opened, or the toast said there is none), so the poll's
  // re-land after the first answer neither scrolls twice nor toasts twice; the first answer still on its way waits.
  function land(h) {
    lastH = h
    if (!h || landed === h) return
    const q = mainEl.querySelector ? (sel) => mainEl.querySelector(sel) : () => null
    const rowEl = q(`.crow[data-h="${h.replace(/["\\]/g, '')}"]`) // a read-side id after the router's harnessKey
    if (!rowEl) {
      if (store.get().capH != null) { toast(`${harnessName(h)} is not on the capture page now`); landed = h }
      return
    }
    landed = h
    // the arrival opens the row through the same memory the reader's own clicks use, and repaints: the row string
    // itself then carries aria-expanded="true" (no second DOM-mutation path to keep in step)
    openByReader.set(h, true)
    paint()
    const again = q(`.crow[data-h="${h.replace(/["\\]/g, '')}"]`)
    try { if (again && again.scrollIntoView) again.scrollIntoView({ block: 'center' }) } catch { /* no options */ }
  }

  // ── wiring ──────────────────────────────────────────────────────────────────────────────────────────────────────
  // the row head (the name button) toggles; a click anywhere else on the row — outside a link, a button, a disclosure
  // or a popover — toggles too
  el.addEventListener('click', (e) => {
    if (!e.target.closest) return
    const rowEl = e.target.closest('.crow')
    if (!rowEl) return
    if (!e.target.closest('[data-caprow]') && e.target.closest('a, button, [data-disc], [data-pop], [data-menu]')) return
    const target = e.target.closest('[data-caprow]') || rowEl.querySelector('[data-caprow]')
    if (!target) return
    e.preventDefault()
    const exp = el.querySelector('#' + target.getAttribute('aria-controls'))
    if (!exp) return
    const open = exp.hasAttribute('hidden')
    openByReader.set(rowEl.dataset.h, open)
    target.setAttribute('aria-expanded', String(open))
    const chev = target.querySelector('.chev'); if (chev) chev.textContent = open ? '▾' : '▸'
    if (open) exp.removeAttribute('hidden'); else exp.setAttribute('hidden', '')
  })

  paint()
  readOv()
  poll = pollCaptureHealth({ api, store, doc: el.ownerDocument, onAnswer: () => { paint(); land(lastH); readOv() } })
  land(router.current().params.h || null)

  return {
    update(route) { land(route.params.h || null) },
    unmount() {
      if (poll) poll.stop()
      el.replaceChildren()
    },
  }
}
