// shell/pagehead.mjs — the page head every screen but the replay desk opens with. Exactly three parts may appear
// (1.2 §页头): the screen's name or a breadcrumb of links · the scope control, where the screen has one · 「数据读于
// HH:MM:SS」, the time of this screen's last successful read. Nothing else belongs to the head zone — no sentence, no
// number, no status: statistics live in the table or card they qualify.
//   spec = { name }                              → <h1>name</h1>
//   spec = { crumbs: [{label, href?}, …] }       → a trail of links, the last segment plain text
//   spec.scope = { label, options: [{value, label, href}], value }   → a segmented control of links
//   spec.readAt = Date | epoch ms                → 数据读于 HH:MM:SS (nothing drawn while the first read is out)
import { esc, fmtTime } from '../core/fmt.mjs'

export const READ_AT = 'Data read at'

const scopeHtml = ({ label, options = [], value } = {}) => options.length < 2 ? '' :
  `<nav class="seg" role="group" aria-label="${esc(label)}">${options.map((o) =>
    `<a href="${esc(o.href || '#')}"${o.value === value ? ' class="on" aria-current="true"' : ''}>${esc(o.label)}</a>`).join('')}</nav>`

export function pageHeadHtml(spec = {}) {
  const crumbs = Array.isArray(spec.crumbs) && spec.crumbs.length ? spec.crumbs : null
  const title = crumbs
    ? `<nav class="crumbs" aria-label="Breadcrumb">${crumbs.map((c, i) => (i === crumbs.length - 1 || !c.href
      ? `<span${i === crumbs.length - 1 ? ' aria-current="page"' : ''}>${esc(c.label)}</span>`
      : `<a href="${esc(c.href)}">${esc(c.label)}</a>`)).join('<span class="sep" aria-hidden="true">›</span>')}</nav>`
    : `<h1 class="pagename">${esc(spec.name)}</h1>`
  const tools = [
    scopeHtml(spec.scope),
    spec.readAt == null || spec.readAt === '' ? '' : `<span class="readat">${READ_AT} ${esc(fmtTime(spec.readAt))}</span>`,
  ].filter(Boolean).join('')
  return `<header class="pagehead">${title}${tools ? `<span class="tools">${tools}</span>` : ''}</header>`
}

// A screen that is its page head and nothing else: the honest state of a screen whose content is a later task's. spec may be a function
// of ctx (the host page names its host). → { mount(el, ctx) }
export function headOnly(spec) {
  return {
    mount(el, ctx) {
      el.innerHTML = `<div class="page">${pageHeadHtml(typeof spec === 'function' ? spec(ctx) : spec)}</div>`
      return { update() {}, unmount() { el.replaceChildren() } }
    },
  }
}
