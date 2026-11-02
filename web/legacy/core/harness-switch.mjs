// core/harness-switch.mjs — an agent row's ONE control (1.9 §开关 · D65; 1.5 K-25..K-27): the switch, or Set up when the harness still
// lacks install-stage carriers, or nothing when the board cannot act (no control plane, the daemon runs as root, not installed, residue,
// or the document names no switch for this agent). The 采集 page and the overview's agent rows use it. Every write goes through
// core/control.mjs planConfirm (4.4 先计划后确认); this file never calls fetch.
import { esc } from './fmt.mjs'
import { harnessKey, harnessName } from './chips.mjs'
import { planConfirm } from './control.mjs'
import { CTL } from '../labels/capture.mjs'

const NO_CONTROL_HEALTH = Object.freeze(['not-installed', 'residue'])

// controlFor({control, status}, id) → {kind:'switch'|'setup'|null, cliId, on, why}. `control` is api.controlStatus()'s answer, `status`
// the polled C.3 document, `id` the read-side id. `why` names the rule that drew no control (null when there is one).
export function controlFor({ control, status }, id) {
  const no = (why, cliId = null) => ({ kind: null, cliId, on: false, why })
  if (!control || !control.ok) return no('control-unreadable')
  if (!control.data || control.data.control !== true) return no(control.data && control.data.root ? 'root' : 'no-control')
  const st = status && status.health && status.health.state
  if (NO_CONTROL_HEALTH.includes(st)) return no(st)
  const hs = status && status.harnesses && typeof status.harnesses === 'object' ? status.harnesses : {}
  const cliId = Object.keys(hs).find((k) => harnessKey(k) === id)
  if (cliId == null) return no('no-harness')
  const h = hs[cliId] || {}
  if (h.setup && h.setup.state === 'needed') return { kind: 'setup', cliId, on: false, why: null }
  return { kind: 'switch', cliId, on: h.desired === 'on' || h.desired === 'mixed', why: null }
}

// controlHtml(model, ui) → the one element (or ''), then its receipt. `ui` = {busy, receipt} of this row (the state map's entry).
export function controlHtml(model, ui = {}) {
  if (!model || !model.kind) return ''
  const busy = ui && ui.busy ? ' aria-busy="true"' : ''
  const attrs = `data-hctl="${model.kind}" data-cli="${esc(model.cliId)}" data-h="${esc(harnessKey(model.cliId))}"${busy}`
  const el = model.kind === 'setup'
    ? `<button type="button" class="hsetup" ${attrs}>${esc(CTL.setup)}</button>`
    : `<button type="button" class="hswitch" role="switch" aria-checked="${model.on}" aria-label="${esc(CTL.switchLabel(harnessName(model.cliId)))}" ${attrs}><span class="knob" aria-hidden="true"></span></button>`
  const rc = ui && ui.receipt ? `<span class="hrcpt${ui.receipt.bad ? ' bad' : ''}">${esc(ui.receipt.text)}</span>` : ''
  return `<span class="hctl">${el}${rc}</span>`
}

// the confirm dialog's options for one plan (core/ui.mjs confirmDialog): the consequence first, one line per plan entry, the new-plan
// line when the machine changed between the two requests
export function dialogFor({ kind, on, name, plan, stale }) {
  const lines = (Array.isArray(plan) ? plan : []).map((p) => {
    const paths = [].concat((p && (p.path ?? p.paths)) ?? []).join(', ')
    const how = p && (p.how ?? p.kind ?? p.change ?? p.detail)
    return [paths, how].filter((x) => x != null && x !== '').join(' · ')
  }).filter(Boolean)
  const q = kind === 'setup' ? CTL.askSetup(name) : on ? CTL.askOn(name) : CTL.askOff(name)
  return { q, impact: stale ? CTL.stale : '', lines: lines.length ? lines : [CTL.noFiles], confirmLabel: kind === 'setup' ? CTL.setup : on ? CTL.turnOn : CTL.turnOff }
}

// the outcome of planConfirm → the receipt this row shows (null for a cancel: nothing happened)
export function receiptOf(kind, on, out) {
  if (out.outcome === 'cancelled') return null
  if (out.outcome === 'refused') {
    const e = out.receipt && out.receipt.error
    const notes = out.receipt && Array.isArray(out.receipt.notes) ? out.receipt.notes : []
    return { bad: true, text: (e && (e.message || (typeof e === 'string' ? e : null))) || notes[0] || CTL.refused }
  }
  if (out.outcome === 'failed') return { bad: true, text: CTL.failed(out.status, out.error) }
  return { bad: false, text: kind === 'setup' ? CTL.doneSetup : on ? CTL.doneOn : CTL.doneOff }
}

// one delegated click handler on `root`. `ask(opts)` → Promise<boolean> (core/ui.mjs confirmDialog); `state` is the page's Map read-side
// id → {busy, receipt}, baked into every repaint; `onDone(out)` runs after each write (the page re-reads status). → off()
export function wireHarnessControls(root, { api, ask, state, onDone = () => {} }) {
  const onClick = async (e) => {
    const b = e.target && e.target.closest ? e.target.closest('[data-hctl]') : null
    if (!b) return
    e.preventDefault()
    const h = b.getAttribute('data-h'), cliId = b.getAttribute('data-cli'), kind = b.getAttribute('data-hctl')
    const cur = state.get(h) || {}
    if (cur.busy) return
    const on = kind === 'switch' ? b.getAttribute('aria-checked') !== 'true' : undefined
    state.set(h, { busy: true, receipt: null })
    b.setAttribute('aria-busy', 'true')
    const name = harnessName(cliId)
    const body = kind === 'setup' ? { harness: cliId } : { harness: cliId, on }
    let out
    try {
      out = await planConfirm({ api, verb: kind === 'setup' ? 'setup' : 'harness', body, ask: ({ plan, stale }) => ask(dialogFor({ kind, on, name, plan, stale })) })
    } catch (err) { out = { outcome: 'failed', status: 0, error: String((err && err.message) || err) } }
    state.set(h, { busy: false, receipt: receiptOf(kind, on, out) })
    if (b.isConnected !== false) b.removeAttribute('aria-busy')
    try { onDone(out) } catch { /* a repaint that throws must not leave the row busy */ }
  }
  root.addEventListener('click', onClick)
  return () => root.removeEventListener('click', onClick)
}
