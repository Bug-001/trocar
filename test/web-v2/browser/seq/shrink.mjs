// test/web-v2/browser/seq/shrink.mjs — Zeller's delta debugging (ddmin) over a failing step list. Each trial is one call of
// `fails(sub)` (for the browser suite: a fresh board from the same world seed, failing only when the same signature recurs).
// Exports only; nothing runs at import.

/**
 * ddmin(steps, fails, {budgetMs, maxTrials}) → steps. `steps` must be a failing list (the caller reproduced it first).
 * With budget left the answer is 1-minimal (dropping any one step no longer fails); otherwise it is the smallest failing list found
 * so far. It never returns a list that did not fail. Identical sub-lists are tried once.
 */
export async function ddmin(steps, fails, { budgetMs = Infinity, maxTrials = Infinity } = {}) {
  const end = Date.now() + budgetMs
  const seen = new Map()
  let trials = 0
  const spent = () => trials >= maxTrials || Date.now() >= end
  const test = async (sub) => {
    const key = JSON.stringify(sub)
    if (!seen.has(key)) { trials++; seen.set(key, !!(await fails(sub))) }
    return seen.get(key)
  }
  let cur = steps, n = 2
  while (cur.length >= 2 && !spent()) {
    const size = Math.ceil(cur.length / n)
    const chunks = []
    for (let i = 0; i < cur.length; i += size) chunks.push(cur.slice(i, i + size))
    let next = null
    for (const c of chunks) { if (spent()) break; if (await test(c)) { next = c; n = 2; break } }
    if (!next && chunks.length > 2) {
      for (let i = 0; i < chunks.length && !spent(); i++) {
        const rest = chunks.filter((_, j) => j !== i).flat()
        if (await test(rest)) { next = rest; n = Math.max(n - 1, 2); break }
      }
    }
    if (next) { cur = next; continue }
    if (spent() || n >= cur.length) break
    n = Math.min(cur.length, n * 2)
  }
  return cur
}
