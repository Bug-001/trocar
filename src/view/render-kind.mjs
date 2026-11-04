// src/view/render-kind.mjs — the Readable render spec of one distinct block (RFC 2.3, 3.5).
// renderOf(flat) → r = {as, tone?, title?, guess?, f, kids?}. Pure and harness-neutral: it reads the dissector's neutral vocabulary
// (sec / kind / block / desc / schema / text / faithfulness) and generic input keys, never a tool name and never a position
// (mi / bi / si, cache marks and keys do not change r). It is worked out when a block is read, never stored in the projection.
//   as     the closed set of 2.3: text markdown code shell diff json kv media opaque parts tool
//   f      paths (arrays) into viewOf's body, and into the child value inside kids, so the browser holds no key name of its own:
//          body; cmd note (shell); old new patch (diff); desc schema (tool); data mime url (media); and the switches gutter wrap file.
//          A top-level r always has f.body: it is what marks this shape
//   guess  the content was guessed at (text, markdown, numbered code): a tool_result's `reads` may replace it, json and diff never
//   kids   {key or index: r} for each child value that is not plain text
// Every scan is bounded (a long block must not stall the board, test/view/path-scan-blowup.test.mjs): sniffing reads the first
// 64 KB, JSON is parsed only when the whole value is ≤ 256 KB, and kv / parts stop at MAX entries.

const HEAD = 64 * 1024, JSON_MAX = 256 * 1024, MAX = 64
const isObj = (v) => v !== null && typeof v === 'object'
const str = (v) => typeof v === 'string'
const cap = (s) => String(s).slice(0, 256)

/** The keys of a flat block that hold its parsed body: viewOf's `body`, a definition's `inline`. */
export const BODY = ['text', 'block', 'desc', 'schema']

const PATCH = /^(?:\*\*\* Begin Patch|diff --git |@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@)/m
const NUMBERED = /^\s*\d+(?:→|\t)/
const MD = /^(?:#{1,6}\s|\s*[-*+]\s|\s*\d+\.\s|\s*```|>\s?|\|.*\|\s*$)/
const TAG_LINE = /^\s*<([A-Za-z][\w:.-]*)(?:\s[^<>]*)?>(?:[^<>]*<\/\1>)?\s*$/ // a whole line: <tag attrs> or <tag>value</tag>
const MD_FILE = /\.(?:md|markdown|mdx)$/i

const isPatch = (s) => PATCH.test(s.slice(0, HEAD))

function parsesAsJson(s) {
  const t = s.slice(0, HEAD).trimStart()
  if (t[0] !== '{' && t[0] !== '[') return false
  if (s.length > JSON_MAX || Buffer.byteLength(s) > JSON_MAX) return false
  try { JSON.parse(s); return true } catch { return false }
}

const lineParses = (l) => { const c = l.trimStart()[0]; if (c !== '{' && c !== '[') return false; try { JSON.parse(l); return true } catch { return false } }

/** One JSON value on every non-empty line of the first 64 KB; a line the head cuts is not judged. */
function isNdjson(s, head) {
  const lines = head.split('\n').filter((l) => l.trim())
  if (lines.length < 2) return false
  if (s.length > HEAD) lines.pop()
  return lines.every(lineParses)
}

/** What a string looks like, from its first 64 KB. `human`: written to be read, so markdown is the default. */
function sniff(s, at, human) {
  if (parsesAsJson(s)) return { as: 'json', f: { body: at } }
  const head = s.slice(0, HEAD)
  if (isNdjson(s, head)) return { as: 'code', guess: true, f: { body: at, wrap: true } }
  if (PATCH.test(head)) return { as: 'diff', f: { body: at, patch: at } }
  const lines = head.split('\n', 51)
  if (lines.length > 50 || lines[lines.length - 1] === '') lines.pop()
  if (lines.length && lines.filter((l) => NUMBERED.test(l)).length >= 0.8 * lines.length) return { as: 'code', guess: true, f: { body: at, gutter: true } }
  if (human) return { as: 'markdown', guess: true, f: { body: at } }
  let md = 0
  for (const l of head.split('\n')) if ((MD.test(l) || TAG_LINE.test(l)) && ++md >= 3) return { as: 'markdown', guess: true, f: { body: at } }
  return { as: 'text', guess: true, f: { body: at } }
}

const valueR = (v, at) => (str(v) ? sniff(v, at, false) : { as: isObj(v) ? 'json' : 'text', f: { body: at } })

/** kv over an object's own keys: a child's r is kept only when it is not plain text (text is every renderer's default). */
function kv(obj, at) {
  const kids = {}
  for (const k of Object.keys(isObj(obj) ? obj : {}).slice(0, MAX)) {
    const r = valueR(obj[k], [])
    if (r.as !== 'text') kids[k] = r
  }
  return { as: 'kv', f: { body: at }, ...(Object.keys(kids).length ? { kids } : null) }
}

// Generic keys are matched by spelling alone: `file_path`, `filePath` and `file-path` are one key. `f` names the real one.
const spelling = (k) => k.replace(/[_-]/g, '').toLowerCase()
const keysOf = (o) => new Map(Object.keys(o).slice(0, MAX).map((k) => [spelling(k), k]))
const keyIn = (keys, names, ok) => { for (const n of names) { const k = keys.get(n); if (k !== undefined && ok(k)) return k } }
const pathKey = (inp, keys) => keyIn(keys, ['filepath', 'path', 'notebookpath', 'filename'], (k) => str(inp[k]))

/** A tool call's input, by generic keys. */
function inputR(inp, at) {
  if (str(inp)) return sniff(inp, at, false)
  if (!isObj(inp) || Array.isArray(inp)) return valueR(inp, at)
  if (str(inp._unparsed)) return { as: 'code', f: { body: [...at, '_unparsed'], wrap: true } }
  const keys = keysOf(inp), text = (...names) => keyIn(keys, names, (k) => str(inp[k]))
  const path = pathKey(inp, keys), named = path ? { title: cap(inp[path]) } : null
  const oldK = text('oldstring'), newK = text('newstring')
  if (oldK && newK) return { as: 'diff', ...named, f: { body: at, old: [...at, oldK], new: [...at, newK] } }
  for (const k of keys.values()) if (str(inp[k]) && isPatch(inp[k])) return { as: 'diff', f: { body: at, patch: [...at, k] } }
  const cmd = keyIn(keys, ['command'], (k) => str(inp[k]) || (Array.isArray(inp[k]) && inp[k].every(str))) ?? text('cmd')
  if (cmd) { const note = text('description'); return { as: 'shell', f: { body: at, cmd: [...at, cmd], ...(note ? { note: [...at, note] } : null) } } }
  const content = text('content')
  if (path && content) return MD_FILE.test(inp[path]) ? { as: 'markdown', ...named, f: { body: [...at, content], file: true } } : { as: 'code', ...named, f: { body: [...at, content] } }
  return kv(inp, at)
}

const isUse = (k) => k === 'tool_use' || /_tool_use$/.test(k)
const isResult = (k) => k === 'tool_result' || /_tool_result$/.test(k)

function mediaR(bl, at) {
  const s = isObj(bl) && isObj(bl.source) ? bl.source : {}, f = { body: at }
  for (const [name, key] of [['data', 'data'], ['mime', 'media_type'], ['url', 'url']]) if (str(s[key])) f[name] = [...at, 'source', key]
  return { as: 'media', f }
}

function toolR(bl, at) {
  const t = isObj(bl) ? bl.tool : null, def = isObj(t) ? t.definition || t : {}
  const to = isObj(t) ? [...at, 'tool', ...(t.definition ? ['definition'] : [])] : at
  const keys = keysOf(def), desc = keyIn(keys, ['description'], (k) => str(def[k])), schema = keyIn(keys, ['inputschema', 'parameters'], (k) => isObj(def[k]))
  if (!desc && !schema) return kv(def, to)
  return { as: 'tool', f: { body: to, desc: [...to, desc ?? 'description'], schema: [...to, schema ?? 'input_schema'] } }
}

function resultR(bl, at) {
  const c = isObj(bl) ? bl.content : undefined, to = [...at, 'content']
  if (!Array.isArray(c)) return valueR(c ?? '', to)
  if (c.length === 1 && isObj(c[0]) && (c[0].type ?? 'text') === 'text' && str(c[0].text)) return sniff(c[0].text, [...to, 0, 'text'], false)
  const kids = {}
  c.slice(0, MAX).forEach((x, i) => {
    const r = specOf(isObj(x) ? String(x.type || '') : 'text', x, null, [], false)
    if (r.as !== 'text' || r.f.body.length) kids[i] = r
  })
  return { as: 'parts', f: { body: to }, ...(Object.keys(kids).length ? { kids } : null) }
}

function blockR(kind, bl, flat, at, human) {
  if (kind === 'image' || kind === 'document') return mediaR(bl, at)
  if (kind === 'json') return { as: 'json', f: { body: at } }
  if (kind === 'thinking' || kind === 'redacted_thinking') {
    const key = isObj(bl) ? ['thinking', 'text'].find((k) => bl[k] && str(bl[k])) : undefined
    if (kind === 'redacted_thinking' || (flat && flat.faithfulness === 'opaque') || !key) return { as: 'opaque', f: { body: at } }
    return { ...sniff(bl[key], [...at, key], true), tone: 'quiet' }
  }
  if (kind === 'tool_addition' || kind === 'tool_removal') return toolR(bl, at)
  if (kind === 'tool_reference' || kind === 'item_reference') return kv(bl, at)
  if (isUse(kind)) return inputR(isObj(bl) ? bl.input : undefined, [...at, 'input'])
  if (isResult(kind)) return resultR(bl, at)
  if (str(bl)) return sniff(bl, at, human)
  if (isObj(bl) && str(bl.text)) return sniff(bl.text, [...at, 'text'], human)
  return { as: 'json', f: { body: at } }
}

function specOf(kind, bl, flat, at, human) {
  const r = blockR(kind, bl, flat, at, human)
  return isObj(bl) && bl.is_error ? { ...r, tone: 'error' } : r
}

/** The render spec of one flat block (or one reply part: the same shape, kind = block.type). */
export function renderOf(flat) {
  if (!isObj(flat)) return { as: 'text', f: { body: [] } }
  if (flat.sec === 'tools') return flat.desc != null || flat.schema != null ? { as: 'tool', f: { body: [], desc: ['desc'], schema: ['schema'] } } : kv(flat.src, ['schema'])
  if (flat.sec === 'system') return sniff(String(flat.text ?? ''), ['text'], true)
  const bl = flat.block
  return specOf(String(flat.kind || (isObj(bl) && bl.type) || 'text'), bl, flat, ['block'], true)
}

/** A block's Readable view: {r, body}, r's paths read on body. Null when nothing readable was kept: a tool definition kept only as
 *  metadata, or a block with no body. A tool definition with no description and no schema reads its own definition (`src`, which
 *  is not enumerable: only a block read from its record has it). */
export function viewOf(flat) {
  if (!isObj(flat) || flat.verbatim === false) return null
  const body = {}
  for (const k of BODY) if (flat[k] !== undefined) body[k] = flat[k]
  if (flat.sec === 'tools' && !Object.keys(body).length && flat.src !== undefined) body.schema = flat.src
  return Object.keys(body).length ? { r: renderOf(flat), body } : null
}

/** How a tool call's result reads, for a result whose content only guesses: a command's output is code, what a call with a Markdown
 *  path and no content of its own returns is Markdown. Calls that carry their content (an edit, a write) return a mere ack. */
export function readsOf(block) {
  if (!isObj(block) || !isUse(String(block.type))) return undefined
  const inp = block.input, r = inputR(inp, [])
  if (r.as === 'shell') return 'code'
  if (r.as !== 'kv') return undefined
  const path = pathKey(inp, keysOf(inp))
  return path && MD_FILE.test(inp[path]) ? 'markdown' : undefined
}
