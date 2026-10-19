// core/vlist.mjs — a fixed-row-height virtual list. Only the rows in (and just around) the viewport exist in the DOM.
//
//   const v = createVList(container, { rowHeight: 28, count, render: (i) => '<div>…</div>' })
//   v.update({ count, render })   // either key optional; repaints
//   v.scrollToIndex(i)            // brings row i into view
//   v.destroy()
//
// render(i) returns the HTML of row i; the list wraps it in an absolutely positioned `.vrow` (data-i = i), so a click
// handler can delegate on `.vrow` and read `dataset.i`. The container becomes position:relative; overflow:auto.
export function createVList(container, { rowHeight, count, render, overscan = 8, after = null }) {
  let n = count, draw = render
  let first = -1, last = -1, raf = 0, dead = false
  container.style.position = 'relative'
  container.style.overflow = 'auto'
  const spacer = document.createElement('div')
  spacer.style.cssText = 'position:relative;width:100%;'
  container.replaceChildren(spacer)

  const viewH = () => container.clientHeight || 600 // a container that has not been laid out yet still gets some rows

  function paint(force) {
    if (dead) return
    spacer.style.height = n * rowHeight + 'px'
    // a shrunk list leaves scrollTop past the new end until the browser clamps it, so clamp it here: no blank viewport
    const maxTop = Math.max(0, n * rowHeight - viewH())
    if (container.scrollTop > maxTop) container.scrollTop = maxTop
    const top = Math.min(container.scrollTop, maxTop)
    const a = Math.max(0, Math.floor(top / rowHeight) - overscan)
    const b = Math.min(n - 1, Math.ceil((top + viewH()) / rowHeight) + overscan)
    if (!force && a === first && b === last) return
    first = a; last = b
    let html = ''
    for (let i = a; i <= b; i++) {
      html += `<div class="vrow" data-i="${i}" style="position:absolute;left:0;right:0;top:${i * rowHeight}px;height:${rowHeight}px">${draw(i)}</div>`
    }
    spacer.innerHTML = html
    if (after) after(spacer)
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
      paint(true)
    },
    scrollToIndex(i) {
      if (n === 0) return
      const idx = Math.max(0, Math.min(n - 1, i))
      const rowTop = idx * rowHeight, rowBot = rowTop + rowHeight
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
