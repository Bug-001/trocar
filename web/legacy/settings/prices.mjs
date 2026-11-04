// settings/prices.mjs — the pure functions behind 设置 · 价格 (1.11 §价格), kept here while the legacy overview imports
// unpricedModels; the page itself is web/src/screens/settings/PricesScreen.tsx.
// 补单价 = 复制模板:four `null`s, not zeros — pasted verbatim the row stays invalid, so the model keeps having no
// price; a 0 would silently price it at $0 (「不知道不写 0」).
import { priceMatch } from '../core/metrics.mjs'

// priceRows(pricingDoc) → [{id, input, output, write, read}]: `pricing.models[]` in the server's own order; null when there is
// no models array (the table has the wrong shape — not guessed at)
export function priceRows(doc) {
  if (!doc || !Array.isArray(doc.models)) return null
  return doc.models.filter((m) => m && m.model).map((m) => ({ id: m.model, input: m.input, output: m.output, write: m.cache_write, read: m.cache_read }))
}

// the models `overview` usage.rows saw metered usage of that priceMatch() cannot price; `sessions` = the most sessions any one row
// of that model names — a floor, since one session can sit in several rows (lanes, harnesses). The same filter as O8 (1.7).
export function unpricedModels(rows, table) {
  const out = new Map()
  for (const r of rows || []) {
    if (!r || (r.calls || 0) - (r.failed || 0) - (r.no_usage || 0) <= 0) continue
    const model = r.model == null || r.model === '' ? null : String(r.model)
    if (model != null && priceMatch(table, model)) continue
    const k = model ?? '', m = out.get(k) || { model, sessions: 0 }
    m.sessions = Math.max(m.sessions, r.sessions || 0)
    out.set(k, m)
  }
  return [...out.values()]
}

// the paste-ready line: a member of the file's object when the file exists, the whole file when it does not.
export function templateText(model, source) {
  const row = `"${model}": [null, null, null, null]`
  return source && source !== 'default' ? row : `{ ${row} }`
}
