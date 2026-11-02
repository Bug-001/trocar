// core/units.mjs — keyed units and the patch between two lists of them (2.3 §读与画 · 三个面板按键打补丁). A panel draws a
// step as units; a step change applies only the ops between the last units and the new ones, so a node whose unit is
// unchanged is never touched (an open row, a selection or a focused control in it stays).
// A unit is {key, html, kids?, set?}: `html` is ONE element; a unit with kids carries `KIDS` inside its one [data-kids]
// element, where the kids go; `set` = attributes written on placement (positions), kept out of `html`. Keys are unique per level.
//   serialize(units) → html   keyed(units) → units   patchUnits(prev, next) → ops   applyOps(units, ops) → units   patchInto(el, units[, ops])
import { esc } from './fmt.mjs'

export const KIDS = '<!--kids-->'
const withSet = (h, set) => (set ? h.replace('>', Object.entries(set).map(([k, v]) => ` ${k}="${esc(String(v))}"`).join('') + '>') : h)
const serialOne = (u) => { const h = withSet(u.html, u.set); return u.kids ? h.replace(KIDS, () => serialize(u.kids)) : h }
export const serialize = (units) => units.map(serialOne).join('')
// keys made unique within one level: key + '#' + its occurrence (the same name may stand twice)
export function keyed(units) {
  const seen = new Map()
  return units.map((u) => { const n = seen.get(u.key) || 0; seen.set(u.key, n + 1); return { ...u, key: `${u.key}#${n}` } })
}

// ── the patch: ops over keyed units (pure) ────────────────────────────────────────────────────────────────────────────
// ['del', key] · ['put', key, unit, after] (a new node after sibling `after`, null = first) · ['move', key, after] ·
// ['wrap', key, html] (a container's own html; its kids stay) · ['set', key, set|null] · ['kids', key, ops]. A unit whose key
// survives with the same html and set, in its order, gets no op at all.
const sameSet = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
function stableKeys(prev, next) { // the survivors that keep their relative order: a longest increasing run of prev positions
  const at = new Map(prev.map((u, i) => [u.key, i])), seq = next.map((u) => at.get(u.key)).filter((i) => i != null)
  const tails = [], link = new Array(seq.length)
  seq.forEach((v, i) => {
    let lo = 0, hi = tails.length
    while (lo < hi) { const m = (lo + hi) >> 1; if (seq[tails[m]] < v) lo = m + 1; else hi = m }
    link[i] = lo ? tails[lo - 1] : -1; tails[lo] = i
  })
  const keep = new Set()
  for (let i = tails.at(-1) ?? -1; i >= 0; i = link[i]) keep.add(prev[seq[i]].key)
  return keep
}
export function patchUnits(prev, next) {
  const P = new Map(prev.map((u) => [u.key, u])), N = new Set(next.map((u) => u.key)), keep = stableKeys(prev, next), ops = []
  for (const u of prev) if (!N.has(u.key)) ops.push(['del', u.key])
  let after = null
  for (const u of next) {
    const p = P.get(u.key)
    if (!p || !!p.kids !== !!u.kids || (!u.kids && p.html !== u.html)) { if (p) ops.push(['del', u.key]); ops.push(['put', u.key, u, after]) }
    else {
      if (!keep.has(u.key)) ops.push(['move', u.key, after])
      if (u.kids && p.html !== u.html) ops.push(['wrap', u.key, u.html])
      if (!sameSet(p.set, u.set)) ops.push(['set', u.key, u.set ?? null])
      if (u.kids) { const k = patchUnits(p.kids, u.kids); if (k.length) ops.push(['kids', u.key, k]) }
    }
    after = u.key
  }
  return ops
}
const placeAfter = (arr, x, after) => { const i = after == null ? 0 : arr.findIndex((u) => u.key === after) + 1; arr.splice(i, 0, x) }
export function applyOps(tree, ops) {
  const arr = tree.slice(), find = (k) => arr.findIndex((u) => u.key === k)
  for (const [op, key, a, b] of ops) {
    const i = find(key)
    if (op === 'del') arr.splice(i, 1)
    else if (op === 'put') placeAfter(arr, a, b)
    else if (op === 'move') { const [x] = arr.splice(i, 1); placeAfter(arr, x, a) }
    else if (op === 'wrap') arr[i] = { ...arr[i], html: a }
    else if (op === 'set') { const { set, ...x } = arr[i]; arr[i] = a == null ? x : { ...x, set: a } }
    else if (op === 'kids') arr[i] = { ...arr[i], kids: applyOps(arr[i].kids, a) }
  }
  return arr
}

// ── the DOM applier: a node whose unit is unchanged is never touched ─────────────────────────────────────────────────
const slotOf = (n) => (n.matches('[data-kids]') ? n : n.querySelector('[data-kids]'))
function build(u) {
  const t = document.createElement('template')
  t.innerHTML = withSet(u.kids ? u.html.replace(KIDS, '') : u.html, u.set)
  const n = t.content.firstElementChild
  n.__k = u.key
  if (u.kids) slotOf(n).append(...u.kids.map(build))
  return n
}
function domApply(box, ops) {
  const at = new Map([...box.children].map((c) => [c.__k, c]))
  for (const [op, key, a, b] of ops) {
    const n = at.get(key)
    if (op === 'del') { n.remove(); at.delete(key) }
    else if (op === 'put' || op === 'move') { const x = op === 'put' ? build(a) : n, p = at.get(op === 'put' ? b : a); box.insertBefore(x, p ? p.nextSibling : box.firstChild); at.set(key, x) }
    else if (op === 'set') for (const [k, v] of Object.entries(a || {})) n.setAttribute(k, String(v))
    else if (op === 'wrap') morph(n, build({ key, html: a, kids: [] }))
    else if (op === 'kids') domApply(slotOf(n), a)
  }
}
// a container takes its new html in place (2.3 §读与画「长对话的窗口」 rule 3): its attributes become x's (the placed `set` data-*
// attributes stay), every child outside the path to its slot is replaced, and the slot's children are never moved
function morph(n, x) {
  for (const k of n.getAttributeNames()) if (!x.hasAttribute(k) && !k.startsWith('data-')) n.removeAttribute(k)
  for (const k of x.getAttributeNames()) if (n.getAttribute(k) !== x.getAttribute(k)) n.setAttribute(k, x.getAttribute(k))
  if (n.hasAttribute('data-kids')) return
  const ns = [...n.children], xs = [...x.children]
  xs.forEach((c, i) => { const m = ns[i]; if (!m) n.append(c); else if (m.matches('[data-kids]') || m.querySelector('[data-kids]')) morph(m, c); else m.replaceWith(c) })
  for (const m of ns.slice(xs.length)) m.remove()
}
// tag a freshly written box's nodes with their unit keys (the first paint is one innerHTML)
function tag(box, units) { [...box.children].forEach((c, i) => { const u = units[i]; if (!u) return; c.__k = u.key; if (u.kids) tag(slotOf(c), u.kids) }) }

/** Draw `units` into `el`: patched from the units it holds when this module drew it last (`ops` when the caller has them),
 * else one innerHTML (a box anyone else wrote since gets a fresh paint). Without a DOM (`document`) it is the innerHTML. */
export function patchInto(el, units, ops = null) {
  const dom = typeof document !== 'undefined' && !!el.children
  const live = dom && el.__units && el.children.length === el.__units.length && el.__units.every((u, i) => el.children[i].__k === u.key)
  if (live) domApply(el, ops || patchUnits(el.__units, units))
  else { el.innerHTML = serialize(units); if (dom) tag(el, units) }
  el.__units = units
}
