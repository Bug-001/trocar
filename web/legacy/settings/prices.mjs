// settings/prices.mjs — 设置 · 价格 (1.11 §价格): what an estimate is priced with, and which models have no price.
// Read-only: the page only ever GETs (`pricing`, and `overview` with no `since`); there is no write-a-price endpoint and none
// is drawn (D14's price config is a file the operator edits — the page hands out the exact line to paste).
// 补单价 = 复制模板:four `null`s, not zeros — pasted verbatim the row stays invalid, so the model keeps having no
// price; a 0 would silently price it at $0 (「不知道不写 0」).
import { pageHeadHtml } from '../shell/pagehead.mjs'
import { SCREEN_NAME } from '../labels/shell.mjs'
import { esc } from '../core/fmt.mjs'
import { priceMatch } from '../core/metrics.mjs'
import { techDetailsHtml, readFailure } from '../core/ui.mjs'
import * as W from '../labels/settings.mjs'

// priceRows(pricingDoc) → [{id, input, output, write, read}]: `pricing.models[]` in the server's own order; null when there is
// no models array (the table has the wrong shape — not guessed at)
export function priceRows(doc) {
  if (!doc || !Array.isArray(doc.models)) return null
  return doc.models.filter((m) => m && m.model).map((m) => ({ id: m.model, input: m.input, output: m.output, write: m.cache_write, read: m.cache_read }))
}
const tableOf = (rows) => rows && Object.fromEntries(rows.map((r) => [r.id, [r.input, r.output, r.write, r.read]]))

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

// the 来源 line: the file the prices came from, or the built-in defaults
export const sourceHtml = (doc) => (doc && doc.source && doc.source !== 'default'
  ? `<p class="cap from mono">${esc(W.PRICE_FROM(doc.source))}</p>`
  : `<p class="cap from">${W.PRICE_DEFAULT}</p>`)

// the paste-ready line: a member of the file's object when the file exists, the whole file when it does not.
export function templateText(model, source) {
  const row = `"${model}": [null, null, null, null]`
  return source && source !== 'default' ? row : `{ ${row} }`
}

const num = (v) => String(v)

function priceTable(rows) {
  return `<div class="hscroll"><table class="ptable">` +
    `<thead><tr><th class="k">${W.COL_KEY}</th><th class="n">${W.COL_IN}</th><th class="n">${W.COL_OUT}</th><th class="n">${W.COL_WRITE}</th><th class="n">${W.COL_READ}</th></tr></thead>` +
    `<tbody>${rows.map((r) =>
      `<tr><td class="k mono">${esc(r.id)}</td><td class="n">${esc(num(r.input))}</td><td class="n">${esc(num(r.output))}</td><td class="n">${esc(num(r.write))}</td><td class="n">${esc(num(r.read))}</td></tr>`).join('')}</tbody>` +
    `</table></div>`
}

export function mount(el, ctx) {
  const { api } = ctx
  let dead = false, readAt = null, error = null

  function paintHead() {
    el.querySelector('#phead').innerHTML = pageHeadHtml({ name: SCREEN_NAME['settings-prices'], readAt })
  }

  async function read() {
    const [p, o] = await Promise.all([api.get('pricing'), api.get('overview')])
    if (dead) return
    error = p.ok ? null : { status: p.status, error: p.error }
    paint({ pricing: p.ok ? p.data : null, overview: o.ok ? o.data : null })
    if (p.ok) { readAt = api.now(); paintHead() }
  }

  const failHtml = (f, href) => `<p class="err">${esc(f.line)} · <a href="${href}">${W.RETRY}</a></p>${f.tech}`

  function paint({ pricing, overview }) {
    const rows = priceRows(pricing)
    const cards = []
    // 单价 — the table, read-only; its caption names the arithmetic and the unit
    cards.push(`<div class="scard"><h2>${W.CARD_PRICE}</h2>` +
      `<p class="cap">${W.PRICE_NOTE}</p>` +
      `<p class="cap" data-note="read-only">${W.PRICE_READ_ONLY}</p>` +
      (pricing ? sourceHtml(pricing) : '') +
      (error ? failHtml(readFailure(W.PRICE_TABLE, error, { id: 'ptech-fail' }), '#/settings/prices')
        : rows ? priceTable(rows) : `<p class="err">${W.PRICE_BAD_SHAPE}</p>`) +
      techDetailsHtml([[W.COL_KEY, W.TECH_MATCH], [W.COL_WRITE, W.TECH_WRITE_ONE], ['price table', W.TECH_PRICING_PATH]], { id: 'ptech' }) +
      `</div>`)
    // 没有单价的模型 — only while `overview` answers (not there: the card is not drawn; a missing source is not "all priced")
    const usage = overview && overview.usage
    if (usage && Array.isArray(usage.rows)) {
      const asOf = overview.as_of ? `<p class="cap">${W.UNPRICED_AS_OF} ${esc(fmtAsOf(overview.as_of))}</p>` : ''
      const un = unpricedModels(usage.rows, tableOf(rows))
      cards.push(`<div class="scard"><h2>${W.CARD_UNPRICED}</h2>` + asOf +
        (un.length ? un.map((m) => {
          const tmpl = m.model == null ? null : templateText(m.model, pricing && pricing.source)
          return `<div class="umodel">` +
            `<span class="mono um">${m.model == null ? W.UNPRICED_NO_MODEL : esc(m.model)}</span>` +
            `<span class="cap">${W.UNPRICED_SESSIONS(m.sessions)}</span>` +
            (tmpl ? `<div class="tmpl"><code class="well mono" tabindex="0">${esc(tmpl)}</code><button type="button" class="copybtn" data-copy="${esc(tmpl)}">${W.COPY_TEMPLATE}</button></div>` : '') +
            `</div>`
        }).join('') + `<p class="cap hint">${W.TEMPLATE_HINT}</p>`
          : `<p class="cap">${W.UNPRICED_NONE}</p>`) +
        `</div>`)
    }
    el.querySelector('#pmain').innerHTML = cards.join('')
  }

  el.innerHTML = `<div class="page">` +
    `<div id="phead"></div>` +
    `<div id="pmain"></div>` +
    `</div>`
  paintHead()
  read()
  return { update() {}, unmount() { dead = true; el.replaceChildren() } }
}

// an S5 as_of is an ISO string; the caption shows HH:MM:SS like every 「截至」 on the board
function fmtAsOf(iso) {
  const d = new Date(iso)
  return isNaN(d) ? String(iso) : d.toTimeString().slice(0, 8)
}
