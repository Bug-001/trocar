// core/harness-switch.mjs — an agent row's ONE control (1.9 §开关 · D65; 1.5 K-25..K-27): the switch, or Set up when the harness still
// lacks install-stage carriers, or nothing when the board cannot act (no control plane, the daemon runs as root, not installed, residue,
// or the document names no switch for this agent). The 采集 page and the overview's agent rows use it. Every write goes through
// core/control.mjs planConfirm (4.4 先计划后确认); this file never calls fetch.
import { harnessKey } from './chips.mjs'
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
