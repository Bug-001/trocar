// src/view/render-kind.mjs — the Readable render spec of one distinct block (RFC 2.3, 3.5).
// renderOf(flat) → r = {as, tone?, title?, f?, parts?}. Pure and harness-neutral: it reads the dissector's neutral vocabulary
// (sec / kind / block / desc / schema / text / faithfulness) and generic input keys, never a tool name and never a position
// (mi / bi / si, cache marks and keys do not change r). Extraction calls it once per distinct definition and persists r, so r stays small.
//   as     the closed set of §4.3: text markdown code shell diff json kv media sections opaque parts
//   f      the value's key paths a renderer reads (shell {command}, edit pair {old,new,path}, patch {patch}, file {path,content},
//          code {gutter:true}), so the browser holds no key name of its own
//   parts  kv: [{k, ...r}] for each key whose value is not plain text · parts: one r per child · sections: [{tag?, span, ...r}]
// Every scan is bounded (a long block must not stall the board, test/view/path-scan-blowup.test.mjs): sniffing reads the first
// 64 KB, JSON is parsed only when the whole value is ≤ 256 KB, and kv / sections / parts stop at MAX entries.

const HEAD = 64 * 1024, JSON_MAX = 256 * 1024, MAX = 64
const isObj = (v) => v !== null && typeof v === 'object'
const str = (v) => typeof v === 'string'
const cap = (s) => String(s).slice(0, 256)

const PATCH = /^(?:\*\*\* Begin Patch|diff --git |@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@)/m
const NUMBERED = /^\s*\d+(?:→|\t)/
const MD = /^(?:#{1,6}\s|\s*[-*+]\s|\s*\d+\.\s|\s*```|>\s?|\|.*\|\s*$)/
const OPEN = /(?:^|\n)[ \t]*<([A-Za-z][\w:.-]*)(?:\s[^>\n]*)?>/g

const isPatch = (s) => PATCH.test(s.slice(0, HEAD))

function parsesAsJson(s) {
  const t = s.slice(0, HEAD).trimStart()
  if (t[0] !== '{' && t[0] !== '[') return false
  if (s.length > JSON_MAX || Buffer.byteLength(s) > JSON_MAX) return false
  try { JSON.parse(s); return true } catch { return false }
}

// Top-level tag pairs: an opening tag at a line start whose matching close ends a line. Each section body is sniffed one level deeper.
function sectionsOf(head, depth) {
  const parts = []
  let at = 0, tries = 0
  OPEN.lastIndex = 0
  for (let m; parts.length < MAX && tries++ < MAX && (m = OPEN.exec(head));) {
    const name = m[1], bodyAt = m.index + m[0].length, close = head.indexOf(`</${name}>`, bodyAt)
    if (close < 0) continue
    const end = close + name.length + 3, rest = head.slice(end, head.indexOf('\n', end) < 0 ? head.length : head.indexOf('\n', end))
    if (rest.trim()) continue
    const tagAt = m.index + (m[0].length - m[0].trimStart().length)
    const before = head.slice(at, tagAt)
    if (before.trim()) parts.push({ span: [at, tagAt], ...sniff(before, depth + 1) })
    parts.push({ tag: name, span: [bodyAt, close], ...sniff(head.slice(bodyAt, close), depth + 1) })
    at = end; OPEN.lastIndex = end
  }
  if (!parts.length) return null
  if (head.slice(at).trim()) parts.push({ span: [at, head.length], ...sniff(head.slice(at), depth + 1) })
  return parts
}

/** Layer 3: what a string looks like, from its first 64 KB. */
function sniff(s, depth = 0) {
  if (parsesAsJson(s)) return { as: 'json' }
  const head = s.slice(0, HEAD)
  if (PATCH.test(head)) return { as: 'diff' }
  const lines = head.split('\n', 51)
  if (lines.length > 50 || lines[lines.length - 1] === '') lines.pop()
  if (lines.length && lines.filter((l) => NUMBERED.test(l)).length >= 0.8 * lines.length) return { as: 'code', f: { gutter: true } }
  const sections = depth === 0 ? sectionsOf(head, depth) : null
  if (sections) return { as: 'sections', parts: sections }
  let md = 0
  for (const l of head.split('\n')) if (MD.test(l) && ++md >= 3) return { as: 'markdown' }
  return { as: 'text' }
}

const valueR = (v) => (str(v) ? sniff(v) : isObj(v) ? { as: 'json' } : { as: 'text' })

/** kv over an object's own keys: a child r is kept only when it is not plain text (text is every renderer's default). */
function kv(obj) {
  const parts = []
  for (const k of Object.keys(isObj(obj) ? obj : {}).slice(0, MAX)) {
    const r = valueR(obj[k])
    if (r.as !== 'text') parts.push({ k, ...r })
  }
  return parts.length ? { as: 'kv', parts } : { as: 'kv' }
}

/** Layer 2: a tool call's input, by generic keys. */
function inputR(inp) {
  if (str(inp)) return sniff(inp)
  if (!isObj(inp) || Array.isArray(inp)) return valueR(inp)
  const path = str(inp.file_path) ? 'file_path' : str(inp.path) ? 'path' : null
  const withPath = (r) => (path ? { ...r, title: cap(inp[path]), f: { ...r.f, path } } : r)
  if (str(inp.old_string) && str(inp.new_string)) return withPath({ as: 'diff', f: { old: 'old_string', new: 'new_string' } })
  for (const k of Object.keys(inp).slice(0, MAX)) if (str(inp[k]) && isPatch(inp[k])) return { as: 'diff', f: { patch: k } }
  const c = inp.command
  if (str(c) || (Array.isArray(c) && c.every(str))) return { as: 'shell', f: { command: 'command' } }
  if (str(inp.cmd)) return { as: 'shell', f: { command: 'cmd' } }
  if (path && str(inp.content)) return withPath({ as: 'code', f: { content: 'content' } })
  return kv(inp)
}

const isResult = (k) => k === 'tool_result' || /_tool_result$/.test(k)

function blockR(kind, bl, flat) {
  if (kind === 'image' || kind === 'document') return { as: 'media' }
  if (kind === 'json') return { as: 'json' }
  if (kind === 'thinking' || kind === 'redacted_thinking') {
    const t = isObj(bl) ? bl.thinking || bl.text : ''
    return kind === 'redacted_thinking' || (flat && flat.faithfulness === 'opaque') || !(str(t) && t.length) ? { as: 'opaque' } : { as: 'text' }
  }
  if (kind === 'tool_addition' || kind === 'tool_removal') { const t = isObj(bl) ? bl.tool : null; return kv(isObj(t) ? t.definition || t : {}) }
  if (kind === 'tool_reference' || kind === 'item_reference') return { as: 'kv' }
  if (kind === 'tool_use' || kind === 'server_tool_use') return inputR(isObj(bl) ? bl.input : undefined)
  if (isResult(kind)) {
    const c = isObj(bl) ? bl.content : undefined
    if (Array.isArray(c)) return { as: 'parts', parts: c.slice(0, MAX).map(childR) }
    return valueR(c ?? '')
  }
  if (str(bl)) return sniff(bl)
  if (isObj(bl) && str(bl.text)) return sniff(bl.text)
  return { as: 'json' }
}

const childR = (c) => renderOf({ kind: isObj(c) ? String(c.type || '') : 'text', block: c })

/** The render spec of one flat block (or one reply part: the same shape, kind = block.type). */
export function renderOf(flat) {
  if (!isObj(flat)) return { as: 'text' }
  if (flat.sec === 'tools') return kv({ desc: flat.desc, schema: flat.schema })
  if (flat.sec === 'system') return sniff(String(flat.text ?? ''))
  const bl = flat.block
  const r = blockR(String(flat.kind || (isObj(bl) && bl.type) || 'text'), bl, flat)
  return isObj(bl) && bl.is_error ? { ...r, tone: 'error' } : r
}

/** What a tool_result whose own sniff is plain text takes from its tool_use's r: a command's output is code, an edit's or write's ack is text. */
export function inheritedRender(useR) {
  const as = useR && useR.as
  return as === 'shell' ? { as: 'code' } : as === 'diff' || as === 'code' ? { as: 'text' } : null
}
