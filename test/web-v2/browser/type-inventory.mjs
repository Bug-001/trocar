// test/web-v2/browser/type-inventory.mjs — 1.5 #16 (D77 ② ⑤): the type every visible piece of text under `root` is drawn in, read in the
// real Chrome. The canonical values come from the page itself: probes styled var(--sans|--mono|--wordmark) and every --fs-* / --fw-*
// token of the :root blocks, read back through getComputedStyle — no literal here. Exports only.
//   typeFaults(page, {root}) → { faults: [{kind, text, value}], inventory: {families, sizes, weights, rendered} }
// Fault kinds (a closed set): family · size (not a --fs-* value; --fs-chart outside #saw / #rails) · weight · spacing · case · numerals ·
// rendered (Chrome drew the UI's Latin text, CDP CSS.getPlatformFontsForNode, in a face the --sans and --mono stacks are not drawn in at
// any --fw-* weight: a fallback, a third family; a weight the OS serves as its own face, Segoe UI Semibold, is the stack's own).
// The wordmark (.wordmark and inside it) is the one serif: it is left out of the family, spacing, case and rendered checks, not the
// size and weight ones. Text with a letter of another script than Latin (CJK) or an emoji (verbatim data: 1.5 #5) is left out of the
// rendered check only.

export async function typeFaults(page, { root = '#app' } = {}) {
  await page.evaluate(() => document.fonts.ready)
  const seen = await page.evaluate((root) => {
    const R = document.querySelector(root)
    const canon = (decl) => { // the computed value of one declaration on a probe kept out of `root`
      const p = document.createElement('span')
      p.style.cssText = `position:absolute;left:-9999px;${decl}`
      document.body.append(p)
      const cs = getComputedStyle(p)
      const v = { family: cs.fontFamily, size: cs.fontSize, weight: cs.fontWeight }
      p.remove()
      return v
    }
    const tokens = new Set()
    const scan = (rules) => { for (const r of rules) { if (r.cssRules && !r.selectorText) scan(r.cssRules); else if (r.selectorText?.startsWith(':root')) for (const k of r.style) if (/^--f[sw]-/.test(k)) tokens.add(k) } }
    for (const s of document.styleSheets) { try { scan(s.cssRules) } catch { /* a sheet we may not read holds no tokens of ours */ } }
    const fam = { sans: canon('font-family:var(--sans)').family, mono: canon('font-family:var(--mono)').family, wordmark: canon('font-family:var(--wordmark)').family }
    const sizes = new Set([...tokens].filter((k) => k.startsWith('--fs-')).map((k) => canon(`font-size:var(${k})`).size))
    const chart = canon('font-size:var(--fs-chart)').size
    const weights = new Set([...tokens].filter((k) => k.startsWith('--fw-')).map((k) => canon(`font-weight:var(${k})`).weight))
    const famName = (f) => Object.keys(fam).find((k) => fam[k] === f) || f
    const faults = [], inv = { families: new Set(), sizes: new Set(), weights: new Set() }
    const els = new Map()
    if (!R) return { faults, inventory: { families: [], sizes: [], weights: [] } }
    const w = document.createTreeWalker(R, NodeFilter.SHOW_TEXT)
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const t = n.textContent.replace(/\s+/g, ' ').trim()
      const el = n.parentElement
      if (!t || !el || !el.checkVisibility({ contentVisibilityAuto: true, opacityProperty: true, visibilityProperty: true })) continue
      const rg = document.createRange(); rg.selectNodeContents(n)
      const r = rg.getBoundingClientRect()
      if (r.width < 1 || r.height < 1 || r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) continue
      if (!els.has(el)) els.set(el, '')
      els.set(el, `${els.get(el)} ${t}`.trim())
    }
    for (const f of ['sans', 'mono']) for (const wt of weights) { // the two stacks' own platform faces at every token weight, read off probes
      const p = document.createElement('span')
      p.style.cssText = `position:absolute;left:-9999px;font-family:var(--${f});font-weight:${wt}`; p.textContent = 'Aa0'; p.setAttribute('data-type-canon', '')
      document.body.append(p); p.getBoundingClientRect() // laid out now: Chrome reports the fonts of laid-out text only
    }
    for (const [el, text] of els) {
      const cs = getComputedStyle(el)
      const wm = !!el.closest('.wordmark')
      const add = (kind, value) => faults.push({ kind, text: text.slice(0, 40), value })
      inv.families.add(famName(cs.fontFamily)); inv.sizes.add(cs.fontSize); inv.weights.add(cs.fontWeight)
      if (!wm && cs.fontFamily !== fam.sans && cs.fontFamily !== fam.mono) add('family', cs.fontFamily)
      if (!sizes.has(cs.fontSize) || (cs.fontSize === chart && !el.closest('#saw, #rails'))) add('size', cs.fontSize)
      if (!weights.has(cs.fontWeight)) add('weight', cs.fontWeight)
      if (!wm && cs.letterSpacing !== 'normal' && parseFloat(cs.letterSpacing) !== 0) add('spacing', cs.letterSpacing)
      if (!wm && cs.textTransform !== 'none') add('case', cs.textTransform)
      if (!cs.fontVariantNumeric.includes('tabular-nums')) add('numerals', cs.fontVariantNumeric)
      if (!wm && !/[^\P{L}\p{Script=Latin}]|\p{Extended_Pictographic}/u.test(text)) { el.setAttribute('data-type-probe', '') }
    }
    const sort = (s) => [...s].sort()
    return { faults, inventory: { families: sort(inv.families), sizes: sort(inv.sizes), weights: sort(inv.weights) } }
  }, root)
  // what Chrome actually drew those elements with: every platform font that drew at least one glyph
  const drawn = new Map() // familyName -> an example text
  const two = new Set()
  const cdp = await page.context().newCDPSession(page)
  try {
    await cdp.send('DOM.enable'); await cdp.send('CSS.enable')
    const { root: doc } = await cdp.send('DOM.getDocument', { depth: -1 })
    for (const nodeId of (await cdp.send('DOM.querySelectorAll', { nodeId: doc.nodeId, selector: '[data-type-canon]' })).nodeIds) {
      for (const f of (await cdp.send('CSS.getPlatformFontsForNode', { nodeId })).fonts) two.add(f.familyName)
    }
    const { nodeIds } = await cdp.send('DOM.querySelectorAll', { nodeId: doc.nodeId, selector: '[data-type-probe]' })
    for (const nodeId of nodeIds) {
      const { fonts } = await cdp.send('CSS.getPlatformFontsForNode', { nodeId })
      for (const f of fonts) if (f.glyphCount > 0 && !drawn.has(f.familyName)) drawn.set(f.familyName, (await cdp.send('DOM.getOuterHTML', { nodeId })).outerHTML.replace(/<[^>]*>/g, '').slice(0, 40))
    }
  } finally {
    await cdp.detach()
    await page.evaluate(() => { for (const e of document.querySelectorAll('[data-type-probe]')) e.removeAttribute('data-type-probe'); for (const e of document.querySelectorAll('[data-type-canon]')) e.remove() })
  }
  const faults = [...seen.faults]
  for (const [family, text] of drawn) if (!two.has(family)) faults.push({ kind: 'rendered', text, value: family })
  return { faults, inventory: { ...seen.inventory, rendered: [...drawn.keys()].sort(), two: [...two].sort() } }
}
