// replay/layout.mjs — the two draggable boundaries: board vs right page (#divider) and outline vs context window (#maindiv).
// Each drives a root CSS custom property (never an inline width: that would beat the narrow-screen @media rule), is clamped, is
// remembered per boundary in localStorage, and resets on a double click. Storage may be missing or throw: it is a convenience.
const SPLITS = [
  { div: '#divider', host: '#pages', prop: '--rightpage-w', key: 'asight.v2.split.rightpage', def: 320, min: 220, max: 720, margin: 380, width: (host, e) => host.getBoundingClientRect().right - e.clientX },
  { div: '#maindiv', host: 'main', prop: '--outline-w', key: 'asight.v2.split.outline', def: 270, min: 160, max: 560, margin: 360, width: (host, e) => e.clientX - host.getBoundingClientRect().left },
]
const ls = {
  get: (k) => { try { return localStorage.getItem(k) } catch { return null } },
  set: (k, v) => { try { localStorage.setItem(k, v) } catch { /* ignore */ } },
  del: (k) => { try { localStorage.removeItem(k) } catch { /* ignore */ } },
}
export const clampWidth = (w, { min, max, margin }, hostWidth) => {
  let hi = hostWidth ? Math.min(max, hostWidth - margin) : max
  if (!(hi > min)) hi = min
  return Math.max(min, Math.min(hi, Number.isFinite(w) ? w : min))
}

// → dispose(): removes the listeners and the custom properties this set
export function initLayout(root) {
  const docEl = document.documentElement, offs = []
  for (const sp of SPLITS) {
    const div = root.querySelector(sp.div), host = root.querySelector(sp.host)
    const setW = (w) => docEl.style.setProperty(sp.prop, w + 'px')
    const saved = parseFloat(ls.get(sp.key))
    let cur = sp.def
    if (saved > 0) { cur = clampWidth(saved, sp, host && host.getBoundingClientRect().width); setW(cur) }
    if (!div || !host) continue
    let dragging = false
    const down = (e) => { dragging = true; try { div.setPointerCapture(e.pointerId) } catch { /* ignore */ } document.body.classList.add('resizing'); e.preventDefault() }
    const move = (e) => { if (!dragging) return; cur = clampWidth(sp.width(host, e), sp, host.getBoundingClientRect().width); setW(cur) }
    const end = () => { if (!dragging) return; dragging = false; document.body.classList.remove('resizing'); ls.set(sp.key, String(Math.round(cur))) }
    const reset = () => { cur = sp.def; setW(cur); ls.del(sp.key) }
    div.addEventListener('pointerdown', down); div.addEventListener('pointermove', move)
    div.addEventListener('pointerup', end); div.addEventListener('pointercancel', end); div.addEventListener('dblclick', reset)
    offs.push(() => {
      div.removeEventListener('pointerdown', down); div.removeEventListener('pointermove', move)
      div.removeEventListener('pointerup', end); div.removeEventListener('pointercancel', end); div.removeEventListener('dblclick', reset)
      docEl.style.removeProperty(sp.prop)
    })
  }
  return () => { document.body.classList.remove('resizing'); for (const f of offs) f() }
}
