// settings/prices.mjs — 设置 · 价格 (1.11 §价格): what an estimate is priced with, and which models have no price.
// Read-only: the page only ever GETs (`/api/pricing`, S5 `window=all`); there is no write-a-price endpoint and none
// is drawn (D14's price config is a file the operator edits — the page hands out the exact line to paste).
// 补单价 = 复制模板:four `null`s, not zeros — pasted verbatim the row stays invalid, so the model keeps having no
// price; a 0 would silently price it at $0 (「不知道不写 0」).
import { pageHeadHtml } from '../shell/pagehead.mjs'
import { SCREEN_NAME } from '../labels/shell.mjs'
import { esc } from '../core/fmt.mjs'
import { priceMatch } from '../core/metrics.mjs'
import { techDetailsHtml } from '../core/ui.mjs'
import * as W from '../labels/settings.mjs'

// priceRows(pricing) → [{key, in, out, write, read}] in the server's own order; a malformed row is not guessed at.
export function priceRows(pricing) {
  const t = pricing && typeof pricing === 'object' ? pricing : null
  if (!t) return null
  return Object.entries(t).map(([key, v]) =>
    Array.isArray(v) && v.length === 4 ? { key, in: v[0], out: v[1], write: v[2], read: v[3] } : { key, bad: true, raw: v })
}

// the models S5 saw metered usage of that priceMatch() cannot price; N = the distinct sessions of each. The same
// filter the overview page's O8 item uses (1.7). rows = S5's rows (window=all); pricing = /api/pricing's table.
export function unpricedModels(rows, pricing) {
  const out = new Map() // model → Set(session_id)
  for (const r of rows || []) {
    if (!r || r.calls == null) continue
    const metered = (r.calls || 0) - (r.failed || 0) - (r.no_usage || 0)
    if (metered <= 0) continue // no usage read: the price never enters any estimate
    const model = r.model == null || r.model === '' ? null : String(r.model)
    if (model != null && pricing && priceMatch(pricing, model)) continue // priced, exactly or by a family key
    const key = model == null ? '' : model
    if (!out.has(key)) out.set(key, { model, sessions: new Set() })
    if (r.session_id != null) out.get(key).sessions.add(r.session_id)
  }
  return [...out.values()].map((m) => ({ model: m.model, sessions: m.sessions.size }))
}

// the paste-ready line: a member of the file's object when the file exists, the whole file when it does not.
export function templateText(model, source) {
  const row = `"${model}": [null, null, null, null]`
  return source && source !== 'default' ? row : `{ ${row} }`
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? String(v) : String(v))

function priceTable(rows, source) {
  return `<div class="hscroll"><table class="ptable">` +
    `<thead><tr><th class="k">${W.COL_KEY}</th><th class="n">${W.COL_IN}</th><th class="n">${W.COL_OUT}</th><th class="n">${W.COL_WRITE}</th><th class="n">${W.COL_READ}</th></tr></thead>` +
    `<tbody>${rows.map((r) => r.bad
      ? `<tr><td class="k mono">${esc(r.key)}</td><td colspan="4" class="bad-shape">${esc(JSON.stringify(r.raw))}</td></tr>`
      : `<tr><td class="k mono">${esc(r.key)}</td><td class="n">${esc(num(r.in))}</td><td class="n">${esc(num(r.out))}</td><td class="n">${esc(num(r.write))}</td><td class="n">${esc(num(r.read))}</td></tr>`).join('')}</tbody>` +
    `</table></div>`
}

export function mount(el, ctx) {
  const { api } = ctx
  let dead = false, readAt = null, error = null

  function paintHead() {
    el.querySelector('#phead').outerHTML = pageHeadHtml({ name: SCREEN_NAME['settings-prices'], readAt })
  }

  async function read() {
    const [p, s5] = await Promise.all([api.get('pricing'), api.get('overview')])
    if (dead) return
    error = null
    let data = null
    if (p.ok) data = p.data
    else if (p.absent) data = null
    else error = { status: p.status, error: p.error }
    paint({ pricing: data, s5: s5.ok ? s5.data : (s5.absent ? null : { error: s5.error }) })
    if (p.ok) { readAt = api.now(); paintHead() }
  }

  function paint({ pricing, s5 }) {
    const cards = []
    // 单价 — the table, read-only; its caption names the arithmetic and the unit
    cards.push(`<div class="scard"><h2>${W.CARD_PRICE}</h2>` +
      `<p class="cap">${W.PRICE_NOTE}</p>` +
      (pricing ? (pricing.source && pricing.source !== 'default'
        ? `<p class="cap from mono">${esc(W.PRICE_FROM(pricing.source))}</p>`
        : `<p class="cap from">${W.PRICE_DEFAULT}</p>`) : '') +
      (error ? `<p class="err">${esc(W.PRICE_READ_FAIL)}:${esc(error.error || ('HTTP ' + error.status))} · <a href="#/settings/prices">${W.RETRY}</a></p>`
        : pricing && pricing.pricing && typeof pricing.pricing === 'object' ? priceTable(priceRows(pricing.pricing), pricing.source)
        : pricing ? `<p class="err">${W.PRICE_BAD_SHAPE}</p>` : '') +
      techDetailsHtml([[W.COL_KEY, W.TECH_MATCH], ['写缓存', W.TECH_WRITE_ONE], ['单价文件', W.TECH_PRICING_PATH]], { id: 'ptech' }) +
      `</div>`)
    // 没有单价的模型 — only while S5 is there (404 absent: the whole card is not drawn, an absent source is not "all priced")
    if (s5 && !s5.error) {
      const rows = s5.rows
      const asOf = s5.as_of ? `<p class="cap">${W.UNPRICED_AS_OF} ${esc(fmtAsOf(s5.as_of))}</p>` : ''
      if (rows == null) {
        cards.push(`<div class="scard"><h2>${W.CARD_UNPRICED}</h2>` + asOf + `</div>`)
      } else {
        const un = pricing && pricing.pricing ? unpricedModels(rows, pricing.pricing) : unpricedModels(rows, null)
        cards.push(`<div class="scard"><h2>${W.CARD_UNPRICED}</h2>` + asOf +
          (un.length ? un.map((m) => {
            const tmpl = m.model == null ? null : templateText(m.model, pricing && pricing.source)
            return `<div class="umodel">` +
              `<span class="mono um">${m.model == null ? W.UNPRICED_NO_MODEL : esc(m.model)}</span>` +
              `<span class="cap">${W.UNPRICED_SESSIONS(m.sessions)}</span>` +
              (tmpl ? `<span class="trow"><code class="well mono" tabindex="0">${esc(tmpl)}</code><button type="button" class="copybtn" data-copy="${esc(tmpl)}">${W.COPY_TEMPLATE}</button></span>` : '') +
              `</div>`
          }).join('') + `<p class="cap hint">${W.TEMPLATE_HINT}</p>`
            : `<p class="cap">${W.UNPRICED_NONE}</p>`) +
          `</div>`)
      }
    }
    el.querySelector('#pmain').innerHTML = cards.join('')
  }

  el.innerHTML = `<div class="page">` +
    `<header class="pagehead" id="phead"></header>` +
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
