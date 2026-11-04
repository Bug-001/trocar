// core/vlist.mjs — a virtual list; rowHeight is a number (every row) or a function (i) → px (per row). Only the rows in (and just around) the viewport exist in the DOM.
//
//   const v = createVList(container, { rowHeight: 28, count, render: (i) => '<div>…</div>' })
//   v.update({ count, render, rowHeight })   // every key optional; repaints
//   v.scrollToIndex(i)            // brings row i into view
//   v.destroy()
//
// render(i) returns the HTML of row i; the list wraps it in an absolutely positioned `.vrow` (data-i = i), so a click
// handler can delegate on `.vrow` and read `dataset.i`. The container becomes position:relative; overflow:auto.
export function createVList(container, { rowHeight, count, render, overscan = 8 }) {
  let n = count, draw = render, hOf = rowHeight
  let off = [0] // off[i] = top of row i, off[n] = the full height: a prefix sum, rebuilt on every update
  function layout() {
    const f = typeof hOf === 'function' ? hOf : () => hOf
    off = new Array(n + 1); off[0] = 0
    for (let i = 0; i < n; i++) off[i + 1] = off[i] + f(i)
  }
  const rowAt = (y) => { let lo = 0, hi = n - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (off[mid] <= y) lo = mid; else hi = mid - 1 } return lo }
  layout()
  let first = -1, last = -1, raf = 0, dead = false
  container.style.position = 'relative'
  container.style.overflow = 'auto'
  const spacer = document.createElement('div')
  spacer.style.cssText = 'position:relative;width:100%;'
  container.replaceChildren(spacer)

  const viewH = () => container.clientHeight || 600 // a container that has not been laid out yet still gets some rows

  function paint(force) {
    if (dead) return
    spacer.style.height = off[n] + 'px'
    // a shrunk list leaves scrollTop past the new end until the browser clamps it, so clamp it here: no blank viewport
    const maxTop = Math.max(0, off[n] - viewH())
    if (container.scrollTop > maxTop) container.scrollTop = maxTop
    const top = Math.min(container.scrollTop, maxTop)
    const a = Math.max(0, rowAt(top) - overscan)
    const b = Math.min(n - 1, rowAt(top + viewH()) + overscan)
    if (!force && a === first && b === last) return
    first = a; last = b
    let html = ''
    for (let i = a; i <= b; i++) {
      html += `<div class="vrow" data-i="${i}" style="position:absolute;left:0;right:0;top:${off[i]}px;height:${off[i + 1] - off[i]}px">${draw(i)}</div>`
    }
    spacer.innerHTML = html
  }

  const onScroll = () => {
    if (raf || dead) return
    raf = requestAnimationFrame(() => { raf = 0; paint(false) })
  }
  container.addEventListener('scroll', onScroll, { passive: true })
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => paint(false)) : null
  if (ro) ro.observe(container)
  paint(true)

  return {
    update(next = {}) {
      if (next.count !== undefined) n = next.count
      if (next.render) draw = next.render
      if (next.rowHeight !== undefined) hOf = next.rowHeight
      layout(); paint(true)
    },
    scrollToIndex(i) {
      if (n === 0) return
      const idx = Math.max(0, Math.min(n - 1, i))
      const rowTop = off[idx], rowBot = off[idx + 1]
      if (rowTop < container.scrollTop) container.scrollTop = rowTop
      else if (rowBot > container.scrollTop + viewH()) container.scrollTop = rowBot - viewH()
      paint(false)
    },
    destroy() {
      dead = true
      if (raf) cancelAnimationFrame(raf)
      container.removeEventListener('scroll', onScroll)
      if (ro) ro.disconnect()
      container.replaceChildren()
    },
  }
}
