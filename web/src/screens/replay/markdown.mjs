// web/src/screens/replay/markdown.mjs — the Readable markdown (2.3 §两种模式): markdown-it with the rules that keep what the source
// wrote, registered with kinds.mjs (setMarkdown) by each build's entry, so web/legacy stays free of npm packages.
//   · Two readers with the same rules: a message's line breaks are the writer's, a file's are the paragraph's (fn's `file`). One
//     reader each, never `set({breaks})` on one: the tokens are cached and hold the choice.
//   · Reading is not rewriting: the five rules off would eat backslashes, decode entities, turn the line above --- into a heading,
//     turn an indented line into code and swallow definition lines; a URL is shown and linked as written.
//   · A link goes through the parser whatever its scheme, so its words survive; only an absolute http, https or mailto is an <a>.
//   · A slice is whole top-level blocks of one parse, so it renders exactly as it does inside the document.
import MarkdownIt from 'markdown-it'
import cjkFriendly from 'markdown-it-cjk-friendly'
import { setMarkdown } from '../../../legacy/replay/kinds.mjs'

const LINKED = /^(?:https?:\/\/|mailto:)/i
const TAG_LINE = /^<\/?[A-Za-z][\w:.-]*(?:\s[^<>]*)?\/?>\s*$/
const TAG_PAIR = /^<(([A-Za-z][\w:.-]*)(?:\s[^<>]*)?)>(.*)<\/\2>\s*$/
const KEPT = 4 // parsed documents kept per reader: a slice's next read finds its tokens

// `<tag attrs>` or `<tag>value</tag>` alone on a line. It ends a paragraph, list, quote or table like any block; its value is bytes
function tagLine(state, start, end, silent) {
  const at = state.bMarks[start] + state.tShift[start]
  if (state.src.charCodeAt(at) !== 0x3C || state.sCount[start] - state.blkIndent >= 4) return false
  const line = state.src.slice(at, state.eMarks[start]), pair = TAG_PAIR.exec(line)
  if (!pair && !TAG_LINE.test(line)) return false
  if (silent) return true
  const t = state.push('md_tag', '', 0)
  t.map = [start, start + 1]
  t.content = pair ? pair[1] : line.trimEnd()
  t.meta = pair ? pair[3] : null
  state.line = start + 1
  return true
}

// what the renderer's defaults would get wrong, set once on the tokens so a slice renders them as they are
function shape(state) {
  for (const t of state.tokens) {
    if (t.type === 'list_item_open' && t.info) t.attrSet('value', t.info)
    const align = t.attrGet('style') // only table cells have one: text-align:<side>
    if (align) t.attrs = [['class', `md-${align.split(':')[1]}`]]
    let plain = false
    for (const c of t.children ?? []) {
      if (c.type === 'link_open') {
        const href = c.attrGet('href')
        plain = !LINKED.test(href)
        c.attrs = plain ? [['class', 'md-link'], ['title', href]] : [['href', href], ['target', '_blank'], ['rel', 'noreferrer noopener'], ['title', href]]
      }
      if (plain && /^link_/.test(c.type)) c.tag = 'span'
    }
  }
}

function reader(breaks) {
  const md = new MarkdownIt({ html: false, linkify: true, breaks }).use(cjkFriendly)
  md.linkify.set({ fuzzyLink: false, fuzzyEmail: false })
  md.disable(['escape', 'entity', 'lheading', 'code', 'reference'])
  md.validateLink = () => true
  md.normalizeLink = md.normalizeLinkText = (url) => url
  md.block.ruler.before('paragraph', 'md_tag', tagLine, { alt: ['paragraph', 'list', 'blockquote', 'table'] })
  md.core.ruler.push('md_shape', shape)
  const esc = md.utils.escapeHtml, R = md.renderer.rules
  R.md_tag = (ts, i) => {
    const { content: tag, meta: value } = ts[i]
    return value == null ? `<div class="md-tag${tag[1] === '/' ? ' close' : ''}">${esc(tag)}</div>\n` : `<div class="md-tagv"><span class="md-tag">${esc(tag)}</span>${esc(value)}</div>\n`
  }
  R.image = (ts, i) => `<span class="md-img">${esc(ts[i].content)} ${esc(ts[i].attrGet('src'))}</span>`
  R.table_open = () => '<div class="md-table"><table>\n'
  R.table_close = () => '</table></div>\n'
  return { md, docs: new Map() }
}
const writing = reader(true), files = reader(false)

// src → its tokens and its top-level blocks ({i: first token, at: source offset}); block maps are in lines, as markdown-it counts them
function parsed({ md, docs }, src) {
  const doc = docs.get(src) ?? (() => {
    const tokens = md.parse(src, {}), lines = [0, ...[...src.matchAll(/\r\n?|\n/g)].map((m) => m.index + m[0].length)]
    return { tokens, blocks: tokens.flatMap((t, i) => (t.level === 0 && t.nesting >= 0 ? [{ i, at: lines[t.map[0]] }] : [])) }
  })()
  docs.delete(src)
  docs.set(src, doc)
  if (docs.size > KEPT) docs.delete(docs.keys().next().value)
  return doc
}

/** kinds.mjs's markdown renderer (7.4). → {html, more}: the blocks from source offset `from` that fit `budget` source characters, at
 *  least one; `more` is the offset to draw from next, null when all is drawn. */
export function draw(src, { from, budget, file }) {
  const r = file ? files : writing, { tokens, blocks } = parsed(r, src)
  const a = blocks.findIndex((b) => b.at >= from)
  if (a < 0) return { html: '', more: null }
  const startOf = (k) => blocks[k]?.at ?? src.length
  let b = a + 1
  while (b < blocks.length && startOf(b + 1) - from <= budget) b++
  return { html: r.md.renderer.render(tokens.slice(blocks[a].i, blocks[b]?.i), r.md.options, {}), more: blocks[b]?.at ?? null }
}

setMarkdown(draw)
