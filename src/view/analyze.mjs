// analyze.mjs — turn a session's captured /v1/messages NDJSON into the structures the
// dashboard renders. A single Claude session is NOT one stream of calls — transparent
// capture reveals several concurrent LANES sharing the wire:
//   • main        the ReAct conversation (the turns you actually see)
//   • subagent    each spawned Agent/Task — its own fresh context stream
//   • monitor     🛡 a background "security monitor" (prompt-injection guardrail): Claude
//                 Code feeds the running <transcript> to an opus with max_tokens=64 that
//                 replies <block>no</block> / <block>yes</block>. Always a NON-streaming
//                 JSON response, so its usage lives in response.body (see normResp).
//   • aux         warmup / quota / title-gen utility calls (0 tools, tiny)
// (count_tokens probes are a 5th lane, added by the UI from probes.ndjson.)
//
// Pure: analyze(records) -> { streams, steps, stats, lanes }. No I/O.
//
// D25: the CC block model (assembly-order walk, volatile rule, resource linking, system labels,
// bash-read parsing) lives in ONE dissector — src/dissect/cc.mjs — shared with the ETL adapter.
// linearContext (below) is now just the board's PROJECTION of that dissector's canonical spine.
import { dissectBlocks, sysLabel, parseBashReads } from '../dissect/cc.mjs'
import { reqIncompleteOf, wsIncompleteOf, respIncompleteOf } from '../dissect/capture-labels.mjs'
import { hintsOf } from '../dissect/harnesses.mjs'
import { sharesBody } from '../dissect/request-body.mjs'
import { failedOf } from '../dissect/endpoints.mjs'
import { compareStep } from './step-order.mjs'
import { compactionVerdict, hasCompactionPreamble } from '../identity/session-identity.mjs'
// Envelope drift guard (R1): the D10 envelope stores the response under `resp`, demo v0 under
// `response`. Reading `.response` directly is the bug class that silently killed every HTTP status
// on real captures — so go through the shared helper, never the raw key.
import { respOf } from '../dissect/record-fields.mjs'
import { HEAD, taskOf, shorten } from './blockmeta.mjs'
import { streamParts } from '../dissect/sse-spans.mjs'
import { num52, numTable } from '../query/projection.mjs'
import { mapUsage } from '../model/schema.mjs'
export { sysLabel } // re-exported for back-compat (was defined here before the D25 extraction)

const FILE_OPS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const DIR_OPS = new Set(['Glob', 'Grep', 'LS'])
const SPAWN_OPS = new Set(['Agent', 'Task'])

function hash(s) {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(16).padStart(8, '0')
}
const sysText = (r) => (r.request?.system || []).map((b) => b.text || '').join('\n')
const isSub = (sys) => /cc_is_subagent=true/.test(sys)
const isMonitor = (sys) => /you are a security monitor/i.test(sys)
const userTextOf = (r) => (r.request?.messages || [])
  .map((m) => Array.isArray(m.content) ? m.content.map((b) => (b.type === 'text' ? b.text || '' : '')).join('') : String(m.content || ''))
  .join(' ')

// The "aux" wire (0 tools, ≤2 msgs) is really THREE utilities with different fates for their output:
//   notify   = background activity summarizer (system: "…walked away. Read the tail…") → JSON status
//              that drives Claude Desktop's push notifications; output consumed by the client, never shown.
//   titlegen = "2-4 word lowercase label for this job" → becomes the session's human-readable name.
//   quota    = max_tokens:1 "quota" ping → liveness / keep-alive; the 1-token reply is discarded.
function auxSubkind(r, userText) {
  const mt = r.request?.max_tokens || 0
  if (mt <= 1 || /^\s*quota\s*$/i.test(userText)) return 'quota'
  if (/lowercase label for this job/i.test(userText)) return 'titlegen'
  if (/walked away|Read the tail of what the agent/i.test(sysText(r))) return 'notify'
  return 'aux'
}

// Unify the two response shapes: streamed SSE (already reconstructed into
// response.{usage,text,tool_calls}) and non-streaming JSON (raw body in response.body). The reply's tool calls leave
// under the neutral name `tools` (2.6 §A): `tool_calls` is a wire name the board does not read (invariant 3).
// Without this, JSON responses (all the security-monitor calls) read as ctx=0 / no text.
export function normResp(r) {
  const rs = respOf(r) || {}
  if (rs.kind === 'json' && rs.body && typeof rs.body === 'object') {
    const c = Array.isArray(rs.body.content) ? rs.body.content : []
    return {
      status: rs.status,
      usage: rs.body.usage || {},
      text: c.filter((b) => b.type === 'text').map((b) => b.text || '').join(''),
      thinking: c.filter((b) => b.type === 'thinking').map((b) => b.thinking || '').join('') || undefined,
      tools: c.filter((b) => b.type === 'tool_use' || b.type === 'server_tool_use')
        .map((b) => ({ id: b.id, name: b.name, input: b.input })),
      stop_reason: rs.body.stop_reason,
    }
  }
  return {
    status: rs.status, usage: rs.usage || {}, text: rs.text || '',
    thinking: rs.thinking, tools: rs.tool_calls || [], stop_reason: rs.stop_reason,
  }
}
// The reply's blocks as addressable parts (sse-spans.mjs): the wire key is content_block_*'s `index`; the block is the
// collector's own reconstruction (content_blocks: one per started index, in index order), a JSON reply's content as given.
const ANTHROPIC_REPLY = {
  keysOf: (e) => (/^content_block_/.test(e.type || '') && Number.isInteger(e.index) ? [String(e.index)] : []),
  build: (k, evts, all, part) => {
    const started = [...new Set(all.filter((e) => e && e.type === 'content_block_start' && Number.isInteger(e.index)).map((e) => e.index))].sort((a, b) => a - b)
    const b = Array.isArray(part.content_blocks) ? part.content_blocks[started.indexOf(Number(k))] : undefined
    return b ? [b] : 'the stream has no start event for this block, so the collector did not rebuild it'
  },
  jsonBlocks: (body) => (Array.isArray(body.content) ? body.content : []),
}
export const replyPartsAnthropic = (rec) => streamParts(rec, ANTHROPIC_REPLY)

// Pull a short readable label from a tool call's input.
export function toolArg(name, input = {}) {
  if (input.file_path || input.path || input.notebook_path)
    return String(input.file_path || input.path || input.notebook_path)
  if (name === 'Bash' && input.command) return String(input.command)
  if (name === 'Glob' && input.pattern) return String(input.pattern)
  if (name === 'Grep' && input.pattern) return String(input.pattern)
  if ((name === 'WebFetch' || name === 'WebSearch') && (input.url || input.query))
    return String(input.url || input.query)
  if (SPAWN_OPS.has(name)) return String(input.description || input.subagent_type || '')
  return ''
}

function textOfMessage(m) {
  if (typeof m.content === 'string') return m.content
  return (m.content || []).map((b) => (b.type === 'text' ? b.text : '')).join('\n')
}

// Which slice of a file entered context (from Read offset/limit), or how it was touched.
function rangeOf(name, input = {}) {
  if (name === 'Read') {
    const o = input.offset, l = input.limit
    if (o && l) return `L${o}–${o + l}`
    if (l) return `L1–${l}`
    if (o) return `L${o}–end`
    return 'full file'
  }
  if (name === 'Write') return 'written'
  if (name === 'Edit' || name === 'MultiEdit') return 'edited'
  if (name === 'NotebookEdit') return 'notebook edit'
  return null
}

// parseBashReads (bash read-target parsing) now lives in the shared CC dissector (src/dissect/cc.mjs,
// imported above) — a file dumped by cat/head/sed -n … IS resident in context like a Read.

// The resources one block brings into context, as [kind, label, via, range?] (the lane adds them with addRes at the call that brought
// the block in). Labels are strings of their own (own): a slice of a command or a text would keep it alive in the lane's ledger.
function resourcesOf(b) {
  const out = []
  const add = (kind, label, via, range) => out.push(range ? [kind, own(label), via, range] : [kind, own(label), via])
  if (b.type === 'tool_use') {
    const arg = toolArg(b.name, b.input)
    if (FILE_OPS.has(b.name) && arg) add('file', arg, b.name, rangeOf(b.name, b.input))
    else if (b.name === 'Bash' && b.input?.command) {
      for (const rd of parseBashReads(b.input.command)) add('file', rd.path, 'Bash', rd.range)
    } else if (DIR_OPS.has(b.name) && arg) add('dir', arg, b.name)
    else if ((b.name === 'WebFetch' || b.name === 'WebSearch') && arg) add('link', arg, b.name)
    // Skill invocation: fine-grained kind:'skill' (schema 3.2 kind enum / D8 — no `capability` umbrella).
    // The tool_use is the point-marker + args source; the resident SKILL.md body is caught below.
    // normalize to the bare skill name (basename) so a namespaced invocation
    // (`plugin:skill`) keys to the SAME resource as its resident SKILL.md body
    // (whose "Base directory" basename is unqualified) — else the card splits in two.
    else if (b.name === 'Skill') add('skill', String(b.input?.skill || b.input?.command || '?').split(':').pop().split('/').pop(), 'Skill')
  } else if (b.type === 'image') {
    add('capability', 'image (' + (b.source?.media_type || '?') + ')', 'image')
  } else if (b.type === 'document') {
    add('capability', 'document (' + (b.source?.media_type || b.title || '?') + ')', 'document')
  } else if (b.type === 'text' && typeof b.text === 'string') {
    // Skill residency: a skill enters context as a bare `user` `text` block carrying the
    // verbatim SKILL.md, prefixed "Base directory for this skill: <dir>" — NOT a Read of a
    // file (so it never lands in "files opened"). basename(dir) = skill name. The body IS
    // verbatim on the wire, so its length is the resident size (fine kind:'skill', schema 3.2).
    const sk = b.text.match(/^Base directory for this skill: (\S+)/)
    if (sk) add('skill', sk[1].split('/').pop(), 'skill', `${b.text.length} chars (verbatim body)`)
    if (/<system-reminder>/.test(b.text)) {
      if (/CLAUDE\.md/i.test(b.text)) add('scaffold', 'CLAUDE.md', 'auto-load')
      if (/\bMEMORY\.md\b|auto-memory|persists across conversations/i.test(b.text)) add('scaffold', 'memory (MEMORY.md)', 'auto-load')
    }
    // only genuine URLs — strip trailing markdown/punctuation so `**http://x**` or `http://x,`
    // don't leak the surrounding prose into the label
    const urls = b.text.match(/https?:\/\/[^\s"'`<>)\]]+/g)
    if (urls) for (const raw of urls.slice(0, 3)) {
      const u = raw.replace(/[*_~.,;:!?)\]}>'"]+$/, '')
      if (/^https?:\/\/[^/]+\.[^/]/.test(u) || /^https?:\/\/[^/]+:\d/.test(u)) add('link', u, 'mention')
    }
  }
  return out
}
// A label or range is a match or split piece of a block's text or a Bash command (links, skills, read paths): kept as a copy of its
// own, else it would keep the whole text alive for the life of the spine (3.5 §内存有界).
function addRes(map, kind, label, step, via, range) {
  const key = kind + '::' + label
  let r = map.get(key)
  if (!r) {
    r = { kind, label: own(label), via, segments: [{ enter: step, evict: null }], loads: [], hits: 1 }
    map.set(own(key), r)
  } else {
    r.hits++
    const last = r.segments[r.segments.length - 1]
    if (last.evict != null && step >= last.evict) r.segments.push({ enter: step, evict: null })
  }
  if (range) r.loads.push({ step, range: own(range), via })
}

// "Seen but never opened" filenames: path-like tokens the agent saw in tool RESULTS
// (Grep/LS/Glob/Bash output) or in prose, but never Read/Wrote/Edited. Answers
// "did the agent actually use file X, or just see its name?". A single grep can spray
// hundreds of paths, so: strict token (must have a '/' OR a known code extension),
// trailing punctuation stripped, and a per-text cap so one huge result can't dominate.
const KNOWN_EXT = 'mjs|js|ts|tsx|jsx|cjs|json|jsonl|ndjson|html|htm|css|scss|less|py|sh|bash|zsh|fish|md|mdx|rst|yaml|yml|toml|txt|rs|go|c|h|hpp|cpp|cc|java|kt|swift|rb|php|sql|xml|svg|lock|cfg|conf|ini|env|plist|log|csv|tsv|tif|png|jpg|jpeg|gif|webp|pdf|ipynb|proto|gradle|properties|map|patch|diff|sock'
const KNOWN_EXT_SET = new Set(KNOWN_EXT.split('|'))
// well-known extensionless files (PATH_RE requires a dot, so match these as whole tokens)
const KNOWN_FILE = new Set(['Makefile', 'GNUmakefile', 'Dockerfile', 'Containerfile', 'LICENSE', 'COPYING', 'README', 'CHANGELOG', 'Procfile', 'Rakefile', 'Gemfile', 'Vagrantfile', 'Jenkinsfile', '.gitignore', '.dockerignore', '.editorconfig', '.npmrc', '.env'])
// SEGMENT/DEPTH BOUNDS ARE LOAD-BEARING, not tidiness. With plain `+` quantifiers this pattern
// backtracks quadratically over any long run of word characters — a minified bundle, a base64 blob, a
// lockfile dump in a tool_result. Profiling one render: 25.4 of 25.5 seconds inside this regex, and the
// board is single-threaded, so one such block hangs every session's poll, not just its own. `{1,64}`
// per segment and `{1,16}` segments deep cap the backtracking to a constant per start offset, making
// the scan linear in the text. The cost is that a path segment longer than 64 chars, or nested deeper
// than 16, is not recognised as "seen" — both are far outside real repo paths, and this lane is a
// convenience index, never a fidelity claim.
const PATH_RE = new RegExp('(?:[\\w.@\\-]{1,64}/){1,16}[\\w.@\\-]{1,64}\\.\\w{1,8}|\\b[\\w.@\\-]{1,64}\\.(?:' + KNOWN_EXT + ')\\b|\\b(?:Makefile|GNUmakefile|Dockerfile|Containerfile|Procfile|Rakefile|Gemfile|Vagrantfile|Jenkinsfile)\\b|(?:^|[\\s"\'(])(\\.(?:gitignore|dockerignore|editorconfig|npmrc|env))\\b', 'gi')
const CODE_STEM = /^(process|console|import|module|exports|window|document|globalThis|self|Math|JSON|Object|Array|res|req|err|ctx|response|resp|reply|result|body|payload|data|obj|item|row|self)$/i
const TECH_STEM = /^(node|vue|next|nuxt|react|angular|svelte|d3|three|express|jquery|ember|backbone|preact|solid|remix|astro|webpack|rollup|vite)$/i
// Precision filter: reject version strings (HTTP/1.1), code identifiers (process.env, response.json())
// and technology names (Node.js), while keeping real files. Runs on tokens the loose regex grabbed.
function acceptPath(p) {
  const base = p.split('/').pop()
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return KNOWN_FILE.has(base) // extensionless / dotfile → only well-known names
  const stem = base.slice(0, dot), ext = base.slice(dot + 1).toLowerCase()
  if (!KNOWN_EXT_SET.has(ext)) return false // "extensions" like test/length/toString/1 → not a file (kills slash-bypass noise)
  if (!p.includes('/')) { // bare tokens are ambiguous with code identifiers & tech names; a slash implies a real path
    if (stem.length <= 2) return false // r.json, e.env → almost always code
    if (CODE_STEM.test(stem)) return false // process.env, response.json, payload.yaml (bare)
    if (TECH_STEM.test(stem)) return false // Node.js, Vue.js in prose
    if (ext === 'log' || ext === 'env') return false // console.log without a path
  }
  return true
}
// A string the fold keeps (a seen path, a byte context, a subagent's first text) in bytes of its own: a slice of a block's text, or
// a cons string over one, would keep that whole text alive for as long as the fold lives (3.5 §内存有界).
const own = (s) => (' ' + s).slice(1)
// What a subagent lane keeps of its first user text to find the spawn that opened it (finish: the spawn's prompt opens that text).
const FIRST_TEXT_CHARS = 4096
// ── THE ANALYZER'S FACTS (RFC 4.3 §3 · §4) ─────────────────────────────────────────────────────────────────────────────────────────
// Everything the fold reads of a call comes from two pure producers whose results are plain JSON (the context projection persists
// them, src/query/projection.mjs): blockFacts(block) for one message block, callFacts(record) for the call itself. The fold reads a
// CALL VIEW { facts, messages: [{ role, uses, blocks }] } — `uses` the [id, name] of the message's tool_use blocks, `blocks` its
// blockFacts — and nothing else, so a view built from persisted facts folds to the same document as one built from the record.
// Every string a fact keeps is its own (own): a fact outlives its record.

// A text as an event shows it: whitespace runs squashed, trimmed, its first 200 characters, and its length.
const PREVIEW_CHARS = 200
// (shorten: the same squash, read only as far as the preview needs; a tool result's whole text is never copied for 200 chars of it)
const evText = (s) => ({ preview: own(shorten(s, PREVIEW_CHARS)), chars: s.length })

// SEEN PATHS. A block's path-like tokens (the lane's "seen but never opened" files), in text order as runs [i, n] over its distinct
// paths `p`: the lane replays them against its own ledger with its per-block cap of NEW paths (seeIn), which is where the scan of
// one text used to stop. At most SEEN_RUNS runs are kept: past them a lane would see a block's later tokens only if fewer than its
// cap of the first SEEN_RUNS runs were new to it — a convenience index, never a fidelity claim (see PATH_RE).
const SEEN_RUNS = 400
function seenRuns(text) {
  if (!text || typeof text !== 'string') return undefined
  text = text.replace(/https?:\/\/[^\s"'`<>)\]]+/g, ' ') // drop URLs so remote asset paths aren't "seen files"
  PATH_RE.lastIndex = 0
  const p = [], at = new Map(), r = []
  let m
  while ((m = PATH_RE.exec(text))) {
    const raw = m[1] || m[0] // group 1 = the dotfile capture; else whole match
    const end = m.index + m[0].length
    if (text[end] === '(') continue // response.json() etc. — a method call, not a file
    const path = raw.replace(/^[\s"'(]+/, '').replace(/[.,;:!?)\]}>'"`]+$/, '')
    if (path.length < 3 || path.endsWith('/') || !acceptPath(path)) continue
    let i = at.get(path)
    if (i === undefined) { i = p.length; at.set(path, i); p.push(own(path)) }
    const last = r[r.length - 1]
    if (last && last[0] === i) last[1]++
    else if (r.length === SEEN_RUNS) break
    else r.push([i, 1])
  }
  return r.length ? { p, r } : undefined
}
// a block's seen paths into the lane's ledger: occurrences of known paths counted, at most `cap` new paths taken (the scan stops there)
function seeIn(seen, s, step, cap) {
  if (!s) return
  let n = 0
  for (const [i, k] of s.r) {
    const ex = seen.get(s.p[i])
    if (ex) { ex.count += k; continue }
    const e = { path: s.p[i], firstStep: step, count: 1 }
    seen.set(e.path, e)
    if (++n >= cap) return
    e.count += k - 1
  }
}

// USER TEXT. A user message's event text is its text blocks joined with '\n', the <system-reminder>s taken out, trimmed — a
// per-MESSAGE text. Each text block keeps what that join needs of it: its text without reminders as a piece (length, leading and
// trailing whitespace, squashed head), and how it reads when a reminder left open by an earlier block runs into it.
const REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g
const R_OPEN = '<system-reminder>', R_CLOSE = '</system-reminder>'
function piece(s) {
  const t = s.trim()
  return { len: s.length, lead: s.length - s.trimStart().length, trail: t ? s.length - s.trimEnd().length : s.length, head: own(shorten(t, PREVIEW_CHARS)) }
}
// s without its reminders as a piece `m`, and, when a reminder in it never closes, `o`: the piece up to that reminder (what is left of
// s when a later block closes it)
function stripped(s) {
  let out = '', at = 0, m
  REMINDER.lastIndex = 0
  while ((m = REMINDER.exec(s))) { out += s.slice(at, m.index); at = m.index + m[0].length }
  const k = s.indexOf(R_OPEN, at)
  out += s.slice(at)
  return k < 0 ? { m: piece(out) } : { m: piece(out), o: piece(out.slice(0, out.length - (s.length - k))) }
}
function userText(text) {
  const s = text == null ? '' : String(text)
  const c = s.indexOf(R_CLOSE)
  // entering inside a reminder an earlier block opened: it ends at this block's first close
  return c < 0 ? { u: stripped(s) } : { u: stripped(s), ui: stripped(s.slice(c + R_CLOSE.length)) }
}
const NL = { len: 1, lead: 1, trail: 1, head: '' }
// a user message's event text { preview, chars } from its blocks' facts, or null when there is none
function userEventOf(blocks) {
  if (blocks.some((b) => b.type === 'tool_result')) return null
  const parts = blocks.filter((b) => b.type === 'text'), pieces = []
  let inside = false
  parts.forEach((b, i) => {
    if (i && !inside) pieces.push(NL)
    const v = inside ? b.ui : b.u
    if (!v) return // still inside: the reminder swallows this block
    const cut = !!v.o && parts.slice(i + 1).some((x) => x.ui) // an open reminder closes only if a later block has a close
    pieces.push(cut ? v.o : v.m)
    inside = cut
  })
  const len = pieces.reduce((a, p) => a + p.len, 0)
  const edge = (ps, side) => { let w = 0; for (const p of ps) { if (p[side] === p.len) { w += p.len; continue } return w + p[side] } return w }
  const chars = len - edge(pieces, 'lead') - edge([...pieces].reverse(), 'trail')
  if (chars <= 0) return null
  let preview = '', gap = false
  for (const p of pieces) {
    if (p.lead === p.len) { if (p.len) gap = true; continue }
    if (preview && (gap || p.lead)) preview += ' '
    preview += p.head
    gap = p.trail > 0
    if (preview.length >= PREVIEW_CHARS) break
  }
  return { preview: preview.slice(0, PREVIEW_CHARS), chars }
}

function textOfResult(b) {
  const c = b.content
  return typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => x.text || '').join('\n') : ''
}
// What a block an omitted text names in an event says in its place (invariant 4: preview + chars, never silently emptied).
const TEXT_OMITTED = 'derived event — full text is not shipped here; read it from this step\'s blocks'

// blockFacts(block) → the facts of one message block: its type; a tool_use's id and name; a tool_result's tool_use_id and its
// observation text (`obs`, absent when it has none); the resources it brings in (`res`); the paths it shows (`seen`); a text's
// user-event pieces (`u`, `ui`).
export function blockFacts(b) {
  const f = { type: b.type }
  if (b.type === 'tool_use') { f.id = b.id; f.name = b.name }
  if (b.type === 'tool_result') {
    f.tool_use_id = b.tool_use_id
    const c = b.content
    const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => x.text || `[${x.type}]`).join('\n') : JSON.stringify(c)
    if (typeof text === 'string') f.obs = evText(text)
    f.seen = seenRuns(textOfResult(b))
  } else if (b.type === 'text') {
    f.seen = seenRuns(b.text)
    Object.assign(f, userText(b.text))
  }
  const res = resourcesOf(b)
  if (res.length) f.res = res
  return defined(f)
}
// a fact object without its undefined keys: what a JSON round trip gives back
const defined = (o) => { for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k]; return o }

// callFacts(record) → the facts of one call (an admitted, hydrated record): its place in step order, what puts it in a lane, its
// status and labels, its usage, and its reply's events — never a block's text.
export function callFacts(r) {
  const req = r.request, rs = respOf(r) || {}, nr = normResp(r), h = hintsOf(r)
  const status = rs.status ?? null
  const reqIncomplete = reqIncompleteOf(r)
  const sys = sysText(r), sub = h.lane === 'subagent' || isSub(sys), monitor = isMonitor(sys)
  const u = nr.usage, text = nr.text || ''
  const firstUser = sub ? req.messages.find((m) => m.role === 'user') : null
  return defined({
    id: r.id, ts_request: r.ts_request, unparsed: !!r._unparsed,
    hints: { lane: h.lane, laneKey: h.laneKey, compaction: h.compaction, compactionMarker: h.compactionMarker },
    sub, monitor, small: /haiku/i.test(req.model || ''), model: req.model,
    msgCount: req.message_count, tools: req.tool_count || 0,
    // which utility a small call is (only a call that can land in an aux lane is asked)
    aux: h.lane === 'aux' || req.message_count <= 2 ? auxSubkind(r, userTextOf(r)) : undefined,
    continued: !!(r._ctx && r._ctx.continued), lineage: r._ctx ? r._ctx.lineage : undefined,
    ctxPartial: !!(r._ctx && r._ctx.contextState === 'partial'),
    status, failed: failedCall(r),
    reqIncomplete, wsIncomplete: wsIncompleteOf(r), respIncomplete: respIncompleteOf(r),
    errMsg: r._unparsed ? unparsedErrMsg(reqIncomplete)
      : (rs.error?.message || (r.error ? String(r.error.message || r.error) : null)
        || (!failedCall(r) ? null : status == null ? 'no HTTP status' : status >= 400 ? `HTTP ${status}` : null)),
    ctx: mapUsage('anthropic', u || {}).total_input,
    usage: u,
    preamble: hasCompactionPreamble(req.messages),
    mcp: (req.tools || []).filter((t) => /^mcp__/.test(t.name || '')).map((t) => 'MCP: ' + (String(t.name).split('__')[1] || t.name)),
    // a subagent's first user text, its head only: a spawn's prompt opens it (finish)
    firstText: sub ? (firstUser ? own(textOfMessage(firstUser).replace(REMINDER, '').slice(0, FIRST_TEXT_CHARS)) : '') : undefined,
    reply: defined({
      text: evText(text), thinking: nr.thinking ? evText(nr.thinking) : undefined,
      tools: (nr.tools || []).map((c) => defined({ id: c.id, name: c.name, input: c.input })),
      summarize: /^\s*<analysis>/.test(text),
      verdict: monitor ? text.replace(/<\/?block>/g, '').trim() : undefined,
      seen: seenRuns(text),
    }),
  })
}
// The call view of an admitted, hydrated record: its facts, and its messages' block facts worked out only when the fold reads them
// (it reads the blocks and the tool uses of the messages new to the lane).
class MessageView {
  constructor(m) {
    this.role = m.role
    this.content = Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content }]
    this.uses = Array.isArray(m.content) ? this.content.filter((b) => b.type === 'tool_use').map((b) => [b.id, b.name]) : []
  }
  get blocks() { return this.memo || (this.memo = this.content.map(blockFacts)) }
}
const viewOf = (r) => ({ facts: callFacts(r), messages: r.request.messages.map((m) => new MessageView(m)) })

// What a compaction verdict says about itself on the board (1.5:38 / 1.5:79: the UI tells confirmed from inferred).
// A harness header hint is the harness's own word (high, not inferred); a text marker and a count drop are inferred
// (medium, 3.4). `preamble` only refines the wording of a drop. A verdict that `lands` a harness's request says only that: the
// context was rewritten here, and nothing is counted or inferred.
export function compactionMeta(v, preamble = false) {
  if (v && v.lands) return { compaction: false, lands: true }
  if (!v || !v.compaction) return { compaction: false }
  const byHint = v.basis === 'hint'
  return { compaction: true, compactionInferred: !byHint, compactionConfidence: byHint ? 'high' : 'medium',
    compactionBasis: byHint ? 'harness-header' : v.basis === 'marker' ? 'harness-marker' : (preamble ? 'preamble+msg-count-drop' : 'msg-count-drop'),
    evictedFrom: v.compaction_from, evictedTo: v.compaction_to }
}

const LANE_META = {
  main: { icon: '💬', label: 'conversation' },
  subagent: { icon: '🧬', label: 'subagent' },
  monitor: { icon: '🛡', label: 'security-monitor' },
  notify: { icon: '📣', label: 'activity → notification' },
  titlegen: { icon: '🏷', label: 'session title-gen' },
  quota: { icon: '🔌', label: 'quota / keep-alive' },
  aux: { icon: '⚙', label: 'other util' },
  // only a harness hint puts an inference call here (count_tokens probes are no inference call: the page draws them)
  probe: { icon: '👁', label: 'warm-up / probe requests',
    note: 'A request the harness itself marks as a warm-up or probe: it primes the cache and is not a conversation turn. Its body is kept verbatim like any call, and a later call may build on it.' },
}
const LANE_ORDER = { main: 0, subagent: 1, monitor: 2, notify: 3, titlegen: 4, quota: 5, aux: 6, probe: 7 }
const AUX_KINDS = new Set(['aux', 'notify', 'titlegen', 'quota'])
const EVENT_ONLY_KINDS = new Set(['monitor', 'probe', ...AUX_KINDS]) // one event per call, no ReAct / resource walk

// ── admission (invariant 4) ──────────────────────────────────────────
// EVERY captured LLM call is admitted, whatever its HTTP status. The old filter demanded a
// parsed 200, which made the spec's `status≠200 → 红柱` unreachable BY CONSTRUCTION (the call
// never reached the timeline) while the board's errStats() counted the same failures straight
// off the raw records — the stats bar printed "401×1 502×1" over a timeline with no such bars.
// Silently dropping a call the user genuinely captured is exactly what invariant 4 forbids.
//
// A record whose req_body never parsed (truncated / corrupt capture — hydrateForBoard leaves it
// without a `.request`) is admitted as a SENTINEL: it has no renderable context, so it gets an
// empty request stub plus `unparsed:true`, and the view shows an explicit "unrenderable" call
// rather than a hole in the numbering. Marked, never invented.
const isUnparsed = (r) => !(r.request && Array.isArray(r.request.messages))
// The reason an unparsed call shows in place of its context, one wording for every assembly path (the flat-lane
// wires use it too). A labelled body says exactly what happened; with no label (v0, legacy MITM) truncation and
// corruption cannot be told apart.
export const unparsedErrMsg = (reqIncomplete) => (reqIncomplete
  ? `unrenderable: req_body could not be parsed — ${reqIncomplete.text}`
  : 'unrenderable: req_body could not be parsed (truncated / corrupt capture)')
// The call-row failed rule (3.5 §访问模式 ②, endpoints.mjs failedOf): an error key, an unparsed sentinel (`_unparsed` = already
// stubbed by admission), or an HTTP status that is absent or ≥ 400 on a call that is not a WebSocket logical call.
const failedCall = (r) => failedOf({ status: respOf(r)?.status, ws: r.transport === 'ws', error: !!r.error || !!r._unparsed || isUnparsed(r) })

// analyze()'s step order (ts_request, then id): every assembler folds a session in it, so a session's global step index is one sort
// whichever wires it mixes.
export const stepOrder = (a, b) => compareStep(a.ts_request, a.id, b.ts_request, b.id)
// The record analyze() reads in place of one whose request did not parse (see isUnparsed above): an empty request stub,
// `_unparsed`, and the non-enumerable source-stream stamp a spread drops (its reply still needs a locator). The stub is a
// view-side clone, so the raw NDJSON source truth is untouched (invariant 2). Every other record is itself.
export function admitted(r) {
  if (!isUnparsed(r)) return r
  const out = { ...r, request: { messages: [], tools: [], system: [], message_count: 0, tool_count: 0 }, _unparsed: true }
  if (r._stream) Object.defineProperty(out, '_stream', { value: r._stream, enumerable: false, configurable: true })
  // the stub is not the stored body: the labels (bodyUnparsedOf → context 'partial', G17) read the body as stored, through r's parse
  return sharesBody(out, r)
}

// The batch form: every LLM record (non-LLM records stay out: they carry only a response body by design — 保真边界,
// not a loss) folded in step order.
export function analyze(records) {
  const a = createAnalyzer()
  for (const r of records.filter((x) => x && x.is_llm_call).sort(stepOrder)) a.push(r)
  return a.finish()
}
// A lane whose calls are told apart only by the order they arrive in (a subagent the harness names neither by agent id nor by
// thread): when a record arrives before one already folded, no lane can be folded again alone — the session is folded from scratch.
export class OrderBound extends Error {}

// createAnalyzer() → { push(rec, gi) → step | null, laneOf(step), drop(lane), ask(lane, text), calls(), finish() → {streams, steps, stats, lanes} }: a
// session folded ONE record at a time (3.5 §内存有界). push() segments the call into its lane and derives the lane's events and
// resources from it right away, so the caller may let go of the record's body once push() returned. What the fold remembers between records is per lane and small: the message count and context size of the
// lane's last call, its resource and seen-file ledgers, its tool names by id, and a subagent's first user text (for spawn linking).
// Records go in in step order WITHIN EACH LANE; lanes may interleave in any order (a call is written when it ends, so a subagent's
// call that ended late arrives after calls that started after it). Nothing a lane derives reads another lane, and what names the
// order across lanes — each call's global index `gi` (the caller's, set before finish), the stream ids (in the order of each
// stream's first call) — is given at finish(): events and resources name their call by the fold's own counter until then. A
// record that sorts before its lane's last call is the caller's to fold again: drop(lane) forgets the lane, and its records go
// in again in step order. finish() builds the document WITHOUT changing the fold (it renumbers only the calls' gi-ordered
// `streamId`), so a fold can go on (push more) after it.
// keep: false (src/view/reduce.mjs, which writes each call out as it is folded): no call, step or event is kept: pushView's step
// carries its events (`step.ev`) and its ledger delta (`step.ld`, replayLedger below), a spawn event its prompt's head (`head`, 60
// characters, for linking) instead of the tool's input, and what its push did to the lane's tool names (`step.undo`); finish() is
// not on that path. A lane goes back to an earlier state (rewind: what save() gave right after a push, the undo of every push after
// it): what a fold of the lane's calls up to that push from the start would have left.
// from (keep: false): what snapshot() gave, through v8.serialize and back (src/view/reduce.mjs REDUCE_V): the fold goes on from it.
export function createAnalyzer({ keep = true, from = null } = {}) {
  if (from && keep) throw new Error('only a fold that keeps nothing resumes from a snapshot')
  const o = from || {}
  const streams = o.streams || []
  let mainStream = o.mainStream ?? null, curSub = o.curSub ?? null, monitorStream = o.monitorStream ?? null, probeStream = o.probeStream ?? null, prevKind = o.prevKind ?? null
  const auxStreams = o.auxStreams || new Map()
  const subByKey = o.subByKey || new Map() // one subagent stream per agent the harness names (3.4 agent-id), else per server-held thread
  // (keep: false needs neither across pushes: no step is kept, and the reducer asks laneOf right after pushView)
  const steps = new Map() // the fold's own counter → its step (events and resources name a step by it until finish)
  const laneOfStep = new WeakMap() // step → its stream
  const usageOf = new WeakMap() // step → its call's usage (callFacts)
  let n = o.n ?? 0, top = o.top ?? null, late = o.late ?? false, byOrder = o.byOrder ?? false
  const state = o.state || new Map() // stream → { resMap, seenMap, prevCount, prevCtx, prevInfo, firstText, ask, tools }
  // a fold that keeps nothing keeps a lane's tool names (tool use id → name) in one table of numbers for all its lanes, keyed by the
  // lane state's generation `g` and the id (num52: two ids of one number would share a name, odds about n² / 2⁵³), a name as an index
  let toolT = null, toolGen = o.toolGen ?? 0
  if (o.toolT) { toolT = numTable(); toolT.load(o.toolT) }
  const toolNames = o.toolNames || [], toolIx = o.toolIx || new Map()
  const toolsOf = () => (keep ? new Map() : { g: toolGen++ + ':' })
  const setTool = (t, id, name) => {
    if (keep) { t.set(id, name); return }
    let i = toolIx.get(name)
    if (i === undefined) { i = toolNames.length; toolNames.push(name); toolIx.set(name, i) }
    if (!toolT) toolT = numTable()
    const key = num52(t.g + id)
    if (undo) undo.push(key, toolT.get(key))
    toolT.set(key, i)
  }
  let undo = null // the tool names the push being folded set: [key, the index it had (undefined: none)], …
  // an index whose name is none: a tool name a rewind takes back
  const none = () => { let i = toolIx.get(undefined); if (i === undefined) { i = toolNames.length; toolNames.push(undefined); toolIx.set(undefined, i) } return i }
  const getTool = (t, id) => { if (keep) return t.get(id); const i = toolT ? toolT.get(num52(t.g + id)) : undefined; return i === undefined ? undefined : toolNames[i] }
  const fresh = () => ({ resMap: new Map(), seenMap: new Map(), prevCount: 0, prevCtx: 0, prevInfo: null, firstText: '', ask: null, tools: toolsOf() })
  function mkStream(kind) {
    const s = { id: 's' + streams.length, kind, calls: [], events: [], n: 0 }
    streams.push(s)
    state.set(s, fresh())
    return s
  }
  function drop(s) {
    for (const c of s.calls) steps.delete(c.at)
    s.calls = []; s.events = []; s.n = 0
    state.set(s, fresh())
  }

  // push(rec, gi): the record's call view folded in; the step keeps the record and its reply (`rec`, `norm`) for the caller
  function push(rec, gi) {
    if (!rec || !rec.is_llm_call) return null
    // Admit on `is_llm_call` alone; an unparsed record is admitted as its sentinel stub (admitted() above)
    const r = admitted(rec)
    return pushView(viewOf(r), gi, r)
  }
  // pushView(view, gi, rec?): one call view folded in (the call's facts and its messages' block facts, see viewOf)
  function pushView(view, gi, rec = null) {
    const f = view.facts
    if (top && stepOrder(f, top) < 0) late = true
    else top = { ts_request: f.ts_request, id: f.id }
    // ── segment into streams/lanes by lineage + role marker ─────────────────────
    const msgCount = f.msgCount
    const tools = f.tools
    // 3.4 lane precedence probe > monitor > aux > subagent > main: inside each
    // tier the harness table's hint decides first (Z-Code x-zcode-session-type, dsh origin, CC x-claude-code-agent-id,
    // a request-kind warm-up), then Claude Code's own markers
    const hints = f.hints, hint = hints.lane
    const sub = f.sub
    // The main conversation runs on the primary (opus) model; utility calls run on a small model
    // (haiku). A tiny haiku call (≤2 msgs) is background util REGARDLESS of tool count — otherwise
    // a burst of failed haiku retries (tools≥1) during a network drop pollutes the conversation lane.
    const small = f.small
    const compacts = hints.compaction === true || hints.compactionMarker === true
    let stream
    if (f.unparsed) {
      // An unparsed sentinel has no system text / message count to classify on. Every lane guess
      // would be a fabrication; route it to `main` — the lane the user is actually watching — so the
      // gap is VISIBLE. The alternative (0 msgs / 0 tools → the aux heuristic) would file a broken
      // conversation turn under "quota / keep-alive", asserting a lane we do not know (invariant 4).
      if (!mainStream) mainStream = mkStream('main')
      stream = mainStream
    } else if (hint === 'probe') {
      stream = probeStream || (probeStream = mkStream('probe'))
    } else if (f.monitor) {
      stream = monitorStream || (monitorStream = mkStream('monitor'))
    } else if (hint === 'aux' || (msgCount <= 2 && !sub && (tools === 0 || small) && !f.continued && !compacts)) {
      // (a call that continues a server-held thread is a turn of that thread, however small its own delta; a call carrying its
      // harness's compaction hint is a turn of the conversation it compacts, however small — pi's summary request, 3.4)
      const sk = f.aux
      stream = auxStreams.get(sk) || auxStreams.set(sk, mkStream(sk)).get(sk)
    } else if (sub && (hints.laneKey || f.lineage)) {
      // the agent's own id, or failing that the thread's chain, names the stream: interleaved subagents never share one,
      // and an agent that starts a new thread midway stays one stream
      const k = hints.laneKey ? 'agent:' + hints.laneKey : 'thread:' + f.lineage
      stream = subByKey.get(k) || subByKey.set(k, mkStream('subagent')).get(k)
    } else if (sub) {
      byOrder = true
      const anew = !curSub || msgCount <= (curSub._lastMsg ?? 0) || prevKind === 'main'
      if (anew) curSub = mkStream('subagent')
      stream = curSub
    } else {
      if (!mainStream) mainStream = mkStream('main')
      stream = mainStream
    }
    if (late && byOrder) throw new OrderBound('a record arrived out of step order in a session whose subagents are told apart by order')
    stream._lastMsg = msgCount
    prevKind = stream.kind
    const at = n++
    const step = { gi: gi != null ? gi : at, id: f.id, streamId: stream.id, ...(rec ? { rec, norm: normResp(rec) } : null),
      msgCount, tools, ctx: f.ctx, status: f.status,
      ts: f.ts_request, compaction: false,
      unparsed: f.unparsed,
      // #21: the collector's own word on WHY the stored body is incomplete (null when it is complete).
      reqIncomplete: f.reqIncomplete,
      // a context stitched across records with a predecessor missing: what is shown is not what the model saw
      ctxPartial: f.ctxPartial,
      wsIncomplete: f.wsIncomplete, // D38: a WebSocket call's labels (4.6 各说一件事)
      respIncomplete: f.respIncomplete, // a response body not decoded / not JSON / empty / partly parsed / cut
      // `error` now covers EVERY non-200 (was: only 5xx — so a 401/429 rendered as a normal call).
      error: f.failed,
      errMsg: f.errMsg,
      // Cache-prefix chaining. A call that FAILED did not establish a new cache
      // prefix at the provider — a 401/429/502 never got far enough to write one — so the next call's
      // prefix diff must be taken against the last SUCCESSFUL call, not against the failure. This flag
      // makes that skip EXPLICIT and inspectable; the call still APPEARS on the timeline (that was the
      // whole bug). Consumers that chain `prevFlat` MUST advance it only when chainsPrefix is true.
      chainsPrefix: !f.failed }
    Object.defineProperty(step, 'at', { value: at })
    stream.n++
    if (keep) { stream.calls.push(step); steps.set(at, step) }
    laneOfStep.set(step, stream)
    usageOf.set(step, f.usage)
    const st = state.get(stream)
    if (stream.kind === 'subagent' && stream.n === 1) st.firstText = f.firstText || ''
    // ── events keep their SHAPE, not a second copy of the session's text ─────────
    //
    // A user message or a tool_result is the heaviest thing in a session and it is already carried, once, as blocks — so an event
    // carrying it verbatim was a second copy, uncapped and with no locator (7.8 MB of a 10.1 MB response on a 40-call fixture, and
    // not shrunk by paging). Nothing reads that text afterwards: spawn linking (finish) reads `input.prompt`, the board renders
    // compaction / summarize events, which carry no `text`. Invariant 4: the body is not silently emptied — `preview` + `chars` are
    // what the collapsed row shows anyway, and `text_omitted` states in place that the full text lives on this step's blocks (an
    // event is derived from them and owns no byte span of its own, so there is no honest locator to mint here).
    const E = keep ? stream.events : []
    if (!keep) { Object.defineProperty(step, 'ev', { value: E }); Object.defineProperty(step, 'ld', { value: [] }); Object.defineProperty(step, 'undo', { value: (undo = []) }) }
    eventsOf(stream, st, step, view, E)
    undo = null
    return step
  }
  const shown = (m) => ({ preview: own(m.preview), chars: m.chars, text_omitted: TEXT_OMITTED })

  // ── per stream: deltas → events + resources ─────────────────────────────────
  function eventsOf(s, st, step, view, E) {
    // the lane's ledger, and what this step did to it (step.ld, when the fold keeps no step: replayLedger)
    const D = keep ? null : step.ld
    // a fold that keeps nothing keeps no ledger either: its deltas do not depend on it, and replayLedger rebuilds it from them
    const addR = (kind, label, via, range) => { if (D) D.push(['r', kind, label, via, range ?? null]); else addRes(st.resMap, kind, label, step.at, via, range) }
    const see = (s, cap) => { if (D) { if (s) D.push(['s', s, cap]) } else seeIn(st.seenMap, s, step.at, cap) }
    const f = view.facts, reply = f.reply
    // monitor + aux-family lanes: no ReAct/resource extraction — just one event per call
    if (EVENT_ONLY_KINDS.has(s.kind)) {
      step.dCtx = step.ctx - st.prevCtx; st.prevCtx = step.ctx
      if (step.error) { E.push({ type: 'error', step: step.at, streamId: s.id, msg: step.errMsg }); return }
      if (s.kind === 'monitor') {
        const v = reply.verdict
        step.flagged = !/^no\b/i.test(v)
        step.verdict = v
        E.push({ type: 'monitor', step: step.at, streamId: s.id, verdict: v, flagged: step.flagged })
      } else {
        E.push({ type: 'aux', subkind: s.kind, step: step.at, streamId: s.id, model: f.model, ...shown(reply.text) })
      }
      return
    }
    // main / subagent lanes
    // Unparsed sentinel: no context to diff. Emit the visible error marker and leave prevCount /
    // prevCtx anchored to the last RENDERABLE call — its empty stub would otherwise read as a
    // message-count collapse and fabricate a compaction event out of a capture defect.
    if (step.unparsed) {
      step.dCtx = 0
      E.push({ type: 'error', step: step.at, streamId: s.id, msg: step.errMsg, unparsed: true })
      return
    }
    step.dCtx = step.ctx - st.prevCtx
    st.prevCtx = step.ctx
    const msgs = view.messages
    for (const label of f.mcp) addR('capability', label, 'mcp')

    const drop = msgs.length < st.prevCount
    const hasPreamble = f.preamble
    const isSummarize = reply.summarize
    // 3.4, the ETL's verdict (compactionVerdict): a harness header hint first (x-cc-compaction-request, dsh's compact
    // header), a text marker on its rising edge, then a sharp drop — the same shared rule the ETL runs.
    // 保真边界 (invariant 4 · spec 1.5:37 / 3.4:16,21): a drop or a marker is INFERRED from observed shape, never
    // confirmed by the harness, and says so (medium, `compactionInferred`); a header hint is the harness's own word.
    // `basis` names WHICH evidence fired: CC's own "continued from a previous conversation" preamble (the stronger
    // drop signal) vs. a bare message-count collapse (a number going down — the weaker guess).
    const h = f.hints
    const marker = h.compactionMarker === true
    // the preamble is evidence on its rising edge only (compactionVerdict): once a compaction has put it in the history
    // every later call of the lane carries it, and a carried one neither makes a drop a compaction nor names its basis
    const preambleNew = hasPreamble && !(st.prevInfo && st.prevInfo.preamble)
    // 3.4: a request stored in part (the collector's req_* labels, the ETL's context_state 'partial') shows what arrived,
    // not the context the model saw: its message count is no observation, so no verdict and no new baseline
    const blindCount = step.reqIncomplete || step.ctxPartial
    const verdict = blindCount ? { compaction: false }
      : compactionVerdict(st.prevInfo, { hint: h.compaction === true, marker, msgCount: msgs.length, preamble: hasPreamble })
    if (!blindCount) st.prevInfo = { msgCount: msgs.length, marker, preamble: hasPreamble, hinted: verdict.basis === 'hint' }
    let newMsgs
    if (verdict.compaction || verdict.lands) {
      Object.assign(step, compactionMeta(verdict, preambleNew))
      if (D) D.push(['x'])
      else for (const res of st.resMap.values()) {
        const last = res.segments[res.segments.length - 1]
        if (last.evict == null) last.evict = step.at
      }
      newMsgs = msgs
    } else if (drop) {
      newMsgs = []
    } else {
      newMsgs = msgs.slice(st.prevCount)
    }
    // tool uses from the messages new to the lane (the rest were new once: a lane's state is O(new), not O(context)), then the reply's
    for (const m of newMsgs) for (const [id, name] of m.uses) setTool(st.tools, id, name)
    for (const c of reply.tools) setTool(st.tools, c.id, c.name)
    if (step.compaction)
      E.push({ type: 'compaction', step: step.at, streamId: s.id, from: step.evictedFrom, to: step.evictedTo,
        // the event travels to the UI on its own — it MUST carry the inference marker with it,
        // otherwise the timeline re-asserts as fact what the step knows is a guess (invariant 4).
        inferred: step.compactionInferred, confidence: step.compactionConfidence, basis: step.compactionBasis })
    if (isSummarize) {
      step.summarizing = true
      E.push({ type: 'summarize', step: step.at, streamId: s.id, out: f.usage?.output_tokens })
    }
    for (const m of newMsgs) for (const b of m.blocks) for (const e of b.res || []) addR(e[0], e[1], e[2], e[3])
    // seen-but-not-opened filenames: tool-result text (bigger cap) + prose (smaller)
    for (const m of newMsgs) for (const b of m.blocks) see(b.seen, b.type === 'tool_result' ? 80 : 40)
    see(reply.seen, 40)
    for (const m of newMsgs) {
      if (m.role !== 'user') continue
      const e = userEventOf(m.blocks)
      if (e) E.push({ type: 'user', step: step.at, streamId: s.id, ...shown(e) })
    }
    for (const m of newMsgs) {
      if (m.role !== 'user') continue
      for (const b of m.blocks) {
        if (b.type !== 'tool_result') continue
        E.push({ type: 'observation', step: step.at, streamId: s.id, source: getTool(st.tools, b.tool_use_id) || 'tool', tool_use_id: b.tool_use_id,
          ...(b.obs ? shown(b.obs) : { text: undefined }) })
      }
    }
    if (step.error) E.push({ type: 'error', step: step.at, streamId: s.id, msg: step.errMsg })
    else if (!isSummarize) {
      // the turn the call PRODUCED, as ReAct events
      if (reply.thinking) E.push({ type: 'thought', step: step.at, streamId: s.id, ...shown(reply.thinking) })
      if (reply.text.chars) E.push({ type: 'say', step: step.at, streamId: s.id, ...shown(reply.text) })
      for (const c of reply.tools) {
        const e = { type: SPAWN_OPS.has(c.name) ? 'spawn' : 'action', step: step.at, streamId: s.id, tool: c.name, id: c.id, arg: toolArg(c.name, c.input) }
        if (keep) e.input = c.input
        else if (e.type === 'spawn') Object.defineProperty(e, 'head', { value: own(((c.input && c.input.prompt) || '').slice(0, 60)) })
        E.push(e)
      }
    }
    st.prevCount = msgs.length
  }

  function finish() {
    // the order across lanes: each call's gi (set by now), the streams numbered in the order of their first call — what a fold
    // in step order numbers them by — and what names a call by the fold's counter renamed to its gi
    const live = streams.filter((s) => s.calls.length).sort((a, b) => a.calls[0].gi - b.calls[0].gi)
    const idOf = new Map(live.map((s, i) => [s, 's' + i]))
    const sid = new Map(live.map((s) => [s.id, idOf.get(s)]))
    for (const s of live) for (const c of s.calls) c.streamId = idOf.get(s)
    const gi = (at) => (at == null ? at : steps.get(at).gi)
    // ── link subagents to their spawning Agent/Task call (the last spawn event whose prompt opens the subagent's first user text)
    const spawnOf = new Map(), childOf = new Map()
    const spawns = live.flatMap((st) => st.events.filter((e) => e.type === 'spawn'))
    for (const s of live) {
      if (s.kind !== 'subagent') continue
      const firstText = state.get(s).firstText
      let best = null
      for (const e of spawns) {
        const p = (e.input?.prompt || '').slice(0, 60)
        if (p && firstText.includes(p.slice(0, 40))) best = e
      }
      if (best) { spawnOf.set(s, best); childOf.set(best, idOf.get(s)) }
    }
    const view = live.map((s) => {
      const id = idOf.get(s), st = state.get(s), b = spawnOf.get(s)
      const events = s.events.map((e) => ({ ...e, step: gi(e.step), streamId: id, ...(childOf.has(e) ? { childStreamId: childOf.get(e) } : null) }))
      const resources = EVENT_ONLY_KINDS.has(s.kind) ? [] : [...st.resMap.values()].map((r) => ({ ...r,
        segments: r.segments.map((g) => ({ enter: gi(g.enter), evict: gi(g.evict) })), loads: r.loads.map((l) => ({ ...l, step: gi(l.step) })) }))
      const out = { id, kind: s.kind, calls: [...s.calls], events, resources, parent: b ? sid.get(b.streamId) : null, spawnArg: b ? b.arg : null,
        // a spawned lane says its spawn's argument; the rest, their first prompt, said by the reduction (src/view/reduce.mjs, blockmeta.mjs departer) once every wire's lanes are in (4.4 §看板 v2 需要的补充)
        ...(b ? { task: b.arg || taskOf(st.ask) } : { task: null, [HEAD]: st.ask ?? null }) }
      if (!EVENT_ONLY_KINDS.has(s.kind)) {
        // "only seen" = matched paths minus anything actually opened. Dedupe absolute-vs-relative
        // spellings of the SAME opened file (path-boundary suffix), but keep distinct-directory
        // files that merely share a basename (src/index.js opened ≠ test/index.js seen).
        const openedArr = [...new Set(out.resources.filter((r) => r.kind === 'file').map((r) => r.label))]
        const sameFile = (a, c) => a === c || a.endsWith('/' + c) || c.endsWith('/' + a)
        out.seenFiles = [...st.seenMap.values()]
          .filter((sf) => !openedArr.some((o) => sameFile(o, sf.path)))
          .map((sf) => ({ ...sf, firstStep: gi(sf.firstStep) }))
          .sort((a, c) => a.firstStep - c.firstStep || c.count - a.count)
          .slice(0, 200)
      }
      if (b) out.spawnStep = gi(b.step)
      return out
    })

    // ── lanes: a per-session view model the UI can tab between ───────────────────
    const lanes = view.slice()
      .sort((a, b) => (LANE_ORDER[a.kind] - LANE_ORDER[b.kind]) || String(a.id).localeCompare(String(b.id)))
      .map((s) => {
        const giLocal = new Map(s.calls.map((c, i) => [c.gi, i]))
        const laneId = s.kind === 'subagent' ? s.id : s.kind
        return {
          id: laneId, streamId: s.id, kind: s.kind, icon: LANE_META[s.kind].icon,
          label: LANE_META[s.kind].label, task: s.task, ...(HEAD in s ? { [HEAD]: s[HEAD] } : null),
          ...(LANE_META[s.kind].note ? { note: LANE_META[s.kind].note } : null),
          calls: s.calls, events: s.events, resources: s.resources, seenFiles: s.seenFiles || [], giLocal,
          peakCtx: s.calls.reduce((m, c) => Math.max(m, c.ctx), 1),
          spawnStep: s.spawnStep ?? null, parent: s.parent,
          flagged: s.kind === 'monitor' ? s.events.filter((e) => e.flagged).length : 0,
        }
      })

    const stepList = [...steps.values()].sort((a, b) => a.gi - b.gi)
    const stats = {
      calls: stepList.length,
      streams: live.length,
      subagents: live.filter((s) => s.kind === 'subagent').length,
      monitors: (live.find((s) => s.kind === 'monitor')?.calls.length) || 0,
      compactions: stepList.filter((s) => s.compaction).length,
      totalIn: stepList.reduce((a, s) => a + (usageOf.get(s).input_tokens || 0), 0),
      totalOut: stepList.reduce((a, s) => a + (usageOf.get(s).output_tokens || 0), 0),
      peakCtx: stepList.reduce((a, s) => Math.max(a, s.ctx), 0),
    }
    return { streams: view, steps: stepList, stats, lanes }
  }
  // ask(lane, text): the lane's first prompt, said by the caller that holds the first call's blocks (src/view/blockmeta.mjs firstHuman)
  const ask = (s, text) => { state.get(s).ask = text }
  // snapshot() (keep: false) → the fold's state as plain data, its streams shared by identity (the caller's lanes name them): to be
  // serialised before the next push
  const snapshot = () => {
    if (keep) throw new Error('only a fold that keeps nothing snapshots')
    return { streams, mainStream, curSub, monitorStream, probeStream, prevKind, auxStreams, subByKey, n, top, late, byOrder, state,
      toolT: toolT && toolT.dump(), toolGen, toolNames, toolIx }
  }
  // save(lane) → the lane's state as a push left it (its first text is set by its first push and stays: a rewind keeps that push);
  // rewind(lane, saved, undos): back to it, `undos` the steps' `undo` of every push of the lane after it, oldest first
  const save = (s) => { const st = state.get(s); return { n: s.n, last: s._lastMsg, prevInfo: st.prevInfo, prevCount: st.prevCount, prevCtx: st.prevCtx } }
  function rewind(s, saved, undos) {
    for (let u = undos.length - 1; u >= 0; u--) for (let i = undos[u].length - 2; i >= 0; i -= 2) toolT.set(undos[u][i], undos[u][i + 1] ?? none())
    const { n, last, ...st } = saved
    s.n = n; s._lastMsg = last; Object.assign(state.get(s), st)
  }
  return { push, pushView, finish, drop, ask, snapshot, save, rewind, laneOf: (step) => laneOfStep.get(step), calls: () => [...steps.values()], firstText: (s) => state.get(s).firstText }
}

/** laneMeta(kind) → {icon, label, note?} of an analyzer lane's kind; eventOnly(kind): no ReAct events, resources or seen paths. */
export const laneMeta = (kind) => LANE_META[kind]
export const eventOnly = (kind) => EVENT_ONLY_KINDS.has(kind)
/** replayLedger(steps, after?, maps?, touch?) → {resources, seen} of a lane from its steps' ledger deltas (`step.ld` of a keep:false
 *  analyzer), `steps` [[n, ld]] in the lane's order (n increasing): what the analyzer's own ledger holds then, a step named by its `n`.
 *  `after(n, resources, seen)`: called after each step with the ledger's maps as they stand then (resources by `kind::label`, seen by
 *  path). `maps: {resources, seen, units}`: the maps to go on from (a replay up to the step before the first of `steps`), changed in place;
 *  `units` = how many entries they hold (a resource, each of its segments and loads, a seen path), kept as they change.
 *  `touch(kind, key, entry)`: called before an op may change an entry (`r` a resource, `s` a seen path; `entry` undefined: none yet). */
export function replayLedger(steps, after, maps = {}, touch = null) {
  const resMap = (maps.resources ??= new Map()), seenMap = (maps.seen ??= new Map())
  let units = maps.units || 0
  for (const [n, ld] of steps) {
    for (const op of ld) {
      if (op[0] === 'r') {
        const key = op[1] + '::' + op[2], r = resMap.get(key), was = r ? r.segments.length + r.loads.length : -1
        if (touch) touch('r', key, r)
        addRes(resMap, op[1], op[2], n, op[3], op[4] ?? undefined)
        const now = resMap.get(key)
        units += now.segments.length + now.loads.length - was
      } else if (op[0] === 's') {
        if (touch && op[1]) for (const [i] of op[1].r) touch('s', op[1].p[i], seenMap.get(op[1].p[i]))
        const was = seenMap.size
        seeIn(seenMap, op[1], n, op[2])
        units += seenMap.size - was
      } else {
        for (const [k, r] of resMap) {
          const last = r.segments[r.segments.length - 1]
          if (last.evict == null) { if (touch) touch('r', k, r); last.evict = n }
        }
      }
    }
    if (after) after(n, resMap, seenMap)
  }
  maps.units = units
  return { resources: [...resMap.values()], seen: [...seenMap.values()] }
}

// ── the linear context: the exact tools → system → messages sequence the model assembles ──
// The request body is a JSON object with three SEPARATE top-level fields; its byte/key order is
// an SDK detail and is irrelevant to the model. What the model actually reads top-to-bottom — and
// what the Anthropic prompt cache uses as its prefix — is tools, then system, then messages.
// So THIS is "the original order of the context", not the JSON key order.
// The block's canonical text for hashing/diffing. `cap` BOUNDS IT WHILE IT IS BUILT, because the
// block key below is hash(text.slice(0, cap)): building a 200 KB tool_result (or JSON.stringify-ing a
// whole tool input) only to throw all but its first 4 096 chars away is the "O(1) per block" claim
// being false. Capping produces the SAME chars — every branch below is a prefix-stable concatenation,
// so slicing a part before joining and slicing the join after it are the same string.
function blkHashText(b, cap = Infinity) {
  if (typeof b === 'string') return b.slice(0, cap)
  if (!b || typeof b !== 'object') return String(b).slice(0, cap)
  if (b.type === 'text') return (b.text || '').slice(0, cap)
  if (b.type === 'thinking') return (b.thinking || '').slice(0, cap)
  if (b.type === 'redacted_thinking') return 'redacted_thinking'
  if (b.type === 'tool_use' || b.type === 'server_tool_use') {
    const head = (b.name || '') + '::'
    return head.length >= cap ? head.slice(0, cap) : (head + JSON.stringify(b.input || {})).slice(0, cap)
  }
  if (b.type === 'tool_result') {
    const head = (b.tool_use_id || '') + '::'
    if (head.length >= cap) return head.slice(0, cap)
    const c = b.content
    let t
    if (typeof c === 'string') t = c.slice(0, cap)
    else if (Array.isArray(c)) { t = ''; for (let i = 0; i < c.length && t.length < cap; i++) t += (i ? '\n' : '') + (c[i].text || `[${c[i].type}]`) }
    else t = JSON.stringify(c)
    return (head + t + (b.is_error ? '::ERR' : '')).slice(0, cap)
  }
  if (b.type === 'image') return 'image:' + (b.source?.media_type || b.source?.type || '')
  if (b.type === 'document') return 'document:' + (b.source?.media_type || b.title || '')
  return JSON.stringify(b).slice(0, cap)
}
// hash a bounded prefix — plenty to distinguish blocks, and O(1) per block regardless of size
const BLK_KEY_CAP = 4096
// `memo` (get / set, from the caller: one per lane of a session assembly) is NOT a cache of results across queries: an
// append-only conversation re-sends its whole context every turn, so one session asks for the key of the
// SAME block text once per call — measured 17 594 block keys over 494 distinct contents. Hashing the 17 100
// repeats was 89 ms of a 115-call session's 305 ms. Same text in, same key out; the map dies with the call.
// A block OBJECT's hash is also kept by the object itself (a WeakMap: a stitched context hands the same parsed block to every call of
// its chain, and the text would be built again for each); the per-lane text memo stays for the contents that arrive as new objects.
// A memo's `null` is a miss, as `undefined` is: the fold's lane memo answers `null` for a lane with no baseline yet
// (`keys.get(t) ?? (was && was.get(t))`), and a key must be the block's hash, whichever fold asked first.
const keyOfBlock = new WeakMap()
const blkKey = (prefix, b, memo) => {
  const obj = b && typeof b === 'object'
  let h = obj ? keyOfBlock.get(b) : undefined
  if (h === undefined) {
    const t = blkHashText(b, BLK_KEY_CAP)
    if (!memo) h = hash(t)
    else if ((h = memo.get(t)) == null) memo.set(t, (h = hash(t)))
    if (obj) keyOfBlock.set(b, h)
  }
  return prefix + h
}

// Flatten a captured request into ordered block descriptors — the board's PROJECTION of the shared
// CC dissector's canonical spine (src/dissect/cc.mjs · D25). Each descriptor carries a stable content
// `key` (for prefix-diffing vs the previous call), its `cache_control` if Claude Code set one, and
// enough metadata for the view to render + link it to the resource ledger. sysLabel / resourceRef /
// the volatile rule now come from the dissector, so board & ETL never drift.
// A tool_result's own truncation notice, QUOTED from the harness — never inferred. Claude Code /
// Desktop write their cut in the block text itself (observed verbatim on the wire as
// "[truncated to 3000 chars]"). We surface only that literal: length is NOT evidence of truncation
// (invariant 4 — a marker we invented would be exactly the "plausible but wrong" failure), and a
// display clip is a different thing entirely (spec 2.3:46).
const TRUNC_NOTE = /\[truncated[^\]\n]{0,80}\]/g
function truncNote(text) {
  const m = String(text || '').match(TRUNC_NOTE)
  return m ? m[m.length - 1] : null
}

// A tools / system entry's parsed source item, the key of the per-block memos (blockBytes, flatBlockText). NON-enumerable: flat entries
// ship inside page bodies, and the item must never serialize with them. A bare string has no identity to key by: it is left out.
const withSrc = (d, src) => (src && typeof src === 'object' ? Object.defineProperty(d, 'src', { value: src }) : d)
export function linearContext(request, keyMemo = null) {
  const flat = []
  // ── resource ↔ RESULT linking ────────────────────────────────────────
  // The 📂 resource explorer promises "the bytes that entered the context". The dissector keys a
  // file resource to its `tool_use` (that is where the path is), but a tool_use carries only the
  // ARGUMENTS the model sent — the file's bytes live in the sibling `tool_result`. The board's
  // resolver prefers a non-tool_use block with the same resKey and falls back to the tool_use, so
  // with nothing else carrying the key it previewed the request JSON as if it were the file.
  // Mirror the file resKey onto its sibling result here, and mark BOTH ends' role, so the request
  // JSON is never silently passed off as content. Scoped to `file::` on purpose: skill/mcp/scaffold
  // resources already resolve to their own verbatim body block, and stealing that is a regression.
  const spine = dissectBlocks(request)
  const fileKeyByUseId = new Map()  // tool_use_id → 'file::<path>'
  const answered = new Set()        // tool_use_ids that have a result IN THIS request
  for (const e of spine) {
    const b = e.parsed
    if (!b || typeof b !== 'object') continue
    if (b.type === 'tool_use' && b.id && String(e.resourceRef || '').startsWith('file::')) fileKeyByUseId.set(b.id, e.resourceRef)
    else if (b.type === 'tool_result' && b.tool_use_id) answered.add(b.tool_use_id)
  }
  for (const e of spine) {
    if (e.section === 'tools') {
      const t = e.parsed
      const mcp = /^mcp__/.test(t.name || '')
      // D15: capture stores tools VERBATIM (full description + input_schema). Derive display metadata
      // here. Back-compat: old v0 traces only have description_chars / input_schema_props — fall back
      // and mark the block non-verbatim so the UI keeps the honest "metadata only" badge for them.
      const hasSchema = t.input_schema !== undefined && t.input_schema !== null
      const hasDesc = typeof t.description === 'string'
      const verbatim = hasSchema || hasDesc
      const props = hasSchema ? (t.input_schema?.properties ? Object.keys(t.input_schema.properties) : []) : (t.input_schema_props || [])
      const descChars = hasDesc ? t.description.length : (t.description_chars || 0)
      flat.push(withSrc({
        sec: 'tools', kind: 'tool', role: 'tool', ti: e.path.i, name: t.name || '', ttype: t.type || '',
        props, descChars, cc: t.cache_control || null, mcp,
        verbatim, desc: hasDesc ? t.description : undefined, schema: hasSchema ? t.input_schema : undefined,
        resKey: mcp ? 'mcp::' + (String(t.name).split('__')[1] || '') : '',
        key: 'T:' + (t.name || e.path.i) + ':' + descChars + ':' + props.length,
      }, t))
    } else if (e.section === 'system') {
      const b = e.parsed, text = b?.text || ''
      flat.push(withSrc({ sec: 'system', kind: 'system', role: 'system', si: e.path.i, label: sysLabel(text), text, chars: text.length, volatile: e.volatile, cc: b?.cache_control || null, key: blkKey('S:', { type: 'text', text }, keyMemo) }, b))
    } else {
      const b = e.parsed, type = typeof b === 'string' ? 'text' : (b?.type || 'text')
      const d = {
        sec: 'messages', kind: type, role: e.role, mi: e.path.mi, bi: e.path.bi, block: b,
        toolName: type === 'tool_use' || type === 'server_tool_use' ? (b.name || '') : '',
        cc: (b && b.cache_control) || null,
        resKey: e.resourceRef, key: blkKey('M:' + e.role + ':' + type + ':', b, keyMemo),
      }
      // `key` above is UNCHANGED — the cache-prefix chain diffs on it, so the linking below only
      // ever ADDS descriptive fields.
      if (type === 'tool_use' && d.resKey && d.resKey.startsWith('file::')) {
        d.resRole = 'request'
        // No sibling result in THIS request: the call that ISSUED the tool_use gets its result in
        // the NEXT one. The honest render is "result not in this call's context yet" — showing the
        // arguments as though they were the file is the bug this flag exists to prevent.
        d.resPending = !answered.has(b.id)
      } else if (type === 'tool_result' && b && b.tool_use_id && fileKeyByUseId.has(b.tool_use_id)) {
        d.resKey = fileKeyByUseId.get(b.tool_use_id)
        d.resRole = 'result'
        // An error result IS what entered the context — link it, but flag it so the panel says
        // "the tool failed" instead of presenting the error text as the file's contents.
        if (b.is_error) d.resError = true
        const tn = truncNote(textOfResult(b))
        if (tn) d.resTruncNote = tn
      }
      flat.push(d)
    }
  }
  return flat
}

// ── D17① prefix-divergence localization (RFC 3.3 前缀分叉定位 + 分叉成因分类) ──
// canonicalize (sort object keys, recurse) so a pure key-reorder can be told apart from a real
// content change. Used ONLY for cause classification — never for dedup/hashing (that stays byte-exact).
function canonJSON(v) {
  if (Array.isArray(v)) return v.map(canonJSON)
  if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v).sort()) o[k] = canonJSON(v[k]); return o }
  return v
}
// a flat block's canonical text — for byte-level divergence localization within the first diverging block,
// and the verbatim byte source for the D17④ prefix SHA-256 (exported; src/view/extract.mjs fhOf hashes it).
// Memo by the parsed source object, as blockBytes (src/view/blockmeta.mjs): fhOf asks it of every block of every call.
const textOfSrc = new WeakMap()
export function flatBlockText(b) {
  const src = b.sec === 'tools' ? b.src : b.sec === 'system' ? null : b.block
  if (!src || typeof src !== 'object') return flatBlockTextOf(b)
  let t = textOfSrc.get(src)
  if (t === undefined) textOfSrc.set(src, (t = flatBlockTextOf(b)))
  return t
}
function flatBlockTextOf(b) {
  if (b.sec === 'tools') return 'T:' + (b.name || '') + '\u0001' + (b.desc != null ? b.desc : '') + '\u0001' + (b.schema !== undefined ? JSON.stringify(b.schema) : '')
  if (b.sec === 'system') return b.text || ''
  return blkHashText(b.block)
}
// first differing char offset between two strings (structural estimate of the byte where the prefix broke).
function firstDiffOffset(a, b) {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i
  return a.length === b.length ? -1 : n
}
// the reorderable structure of a block (tool input_schema / tool_use input), or null if plain text.
function structForReorder(b) {
  if (b.sec === 'tools') return b.schema !== undefined ? b.schema : null
  const bl = b.block
  if (bl && typeof bl === 'object' && (bl.type === 'tool_use' || bl.type === 'server_tool_use')) return bl.input || {}
  return null
}
// same content up to JSON key/array ordering, but different raw bytes → nondeterministic serialization.
function keyReorder(prev, cur) {
  const pj = structForReorder(prev), cj = structForReorder(cur)
  if (pj == null || cj == null) return false
  if (JSON.stringify(pj) === JSON.stringify(cj)) return false // byte-identical structure → not why it diverged
  return JSON.stringify(canonJSON(pj)) === JSON.stringify(canonJSON(cj))
}
// canonical divergence_cause → display label + attribution + fix hint (RFC 3.3 分叉成因分类 table).
// attribution: harmless | provider-excluded | harness | yours | review. Only the causes cleanly
// detectable from two flat block sequences are emitted here; provider/usage/model-dependent causes
// (breakpoint-out-of-window, mid-turn-retry, model-or-route-change) are left to the product's adapter.
const CAUSE_META = {
  'first-call': { label: 'first captured call', attr: 'harmless', fix: '' },
  'append': { label: 'normal append', attr: 'harmless', fix: '' },
  'volatile-nonce-only': { label: 'only a per-call nonce changed', attr: 'provider-excluded', fix: 'confirm the block is cache-excluded (marked volatile)' },
  'compaction': { label: 'compaction rewrote history', attr: 'harness', fix: 'compaction always discards the prefix — review its trigger threshold / timing' },
  'tool-array-reorder': { label: 'tools array reordered', attr: 'yours', fix: 'emit the tools array in a stable order (kill the nondeterminism)' },
  'json-key-reorder': { label: 'JSON keys reordered', attr: 'yours', fix: 'serialize JSON object keys in a stable order' },
  'content-changed': { label: 'a shared-prefix block changed in place', attr: 'review', fix: 'a historical block changed — check for in-place edits / nondeterministic serialization' },
}

// Where does this call's context first diverge from the previous call's? Everything before the
// break is a stable prefix the KV cache can reuse; from the break on it's genuinely new content.
// We SKIP volatile blocks (the billing-header nonce) because they differ every call yet don't
// break the cache. `rawIdx` keeps the naive first-byte divergence for the "why" annotation.
//   • pure append (a normal turn)  → break at the first appended block (end of prev context)
//   • compaction (history rewritten) → break at the first message block (only tools+system survive)
//   • first call                    → break at 0 (nothing cached yet)
// D17① deepens this: beyond WHERE the prefix broke, it classifies WHY (cause) + names the byte inside
// the diverging block. All of it is a STRUCTURAL inference — the numeric hit truth stays with usage
// (RFC 3.3 真相规则), and the UI MUST label the cause "结构估计, 非 provider 真实边界" (invariant 4).
// `opts.compaction` = analyze()'s authoritative compaction verdict (message-count drop): a real
// compaction can PRESERVE the first user turn and rewrite the middle, so the structural break lands
// mid-history — the hint makes the cause say "compaction" while byteOffset still localizes the rewrite.
export function cacheBreak(prevFlat, curFlat, opts = {}) {
  const seq = (f) => f && { n: f.length, key: (i) => f[i].key, vol: (i) => !!f[i].volatile, sec: (i) => f[i].sec, name: (i) => f[i].name }
  return breakOf(seq(prevFlat), seq(curFlat), { ...opts, detail: (i) => blockDiff(prevFlat[i], curFlat[i]) })
}
// What cacheBreak reads of two blocks that diverge at the same place: whether only their JSON key order differs, and the first
// differing character of their frames with the text from it on. A function of the two blocks' bytes alone (src/view/reduce.mjs
// keeps it per pair of block ids).
export function blockDiff(prev, cur) {
  const curText = flatBlockText(cur), off = firstDiffOffset(flatBlockText(prev), curText)
  return { reorder: keyReorder(prev, cur), byteOffset: off >= 0 ? off : null, byteContext: off >= 0 ? own(curText.slice(off, off + 48)) : '' }
}
// cacheBreak over two block sequences given by accessors: { n, key(i), vol(i), sec(i), name(i) }; `opts.detail(i)` → blockDiff of
// the blocks at the break (asked only when the break is inside both sequences).
export function breakOf(prev, cur, opts = {}) {
  if (!prev || !prev.n)
    return { idx: 0, rawIdx: 0, prefixLen: 0, total: cur.n, firstCall: true, cause: 'first-call', causeLabel: 'first captured call', attribution: 'harmless', fixHint: '', byteOffset: null, byteContext: '' }
  const n = Math.min(prev.n, cur.n)
  let rawIdx = -1, idx = -1
  for (let i = 0; i < n; i++) {
    if (prev.key(i) === cur.key(i)) continue
    if (rawIdx < 0) rawIdx = i
    if (cur.vol(i)) continue // billing nonce — differs but cache-irrelevant
    idx = i; break
  }
  if (idx < 0) idx = n // no meaningful divergence within the shared region → new content is the appended tail (idx===prevLen) or nothing
  if (rawIdx < 0) rawIdx = idx
  const out = { idx, rawIdx, prefixLen: idx, total: cur.n, firstCall: false, cause: 'append', causeLabel: '', attribution: 'harmless', fixHint: '', byteOffset: null, byteContext: '' }
  // classify WHY (structural inference — labelled as such in the UI; numeric truth stays with usage)
  if (idx >= n) {
    // shared prefix fully reused; only a volatile block changed, or new content was appended
    out.cause = (cur.n <= prev.n && rawIdx < n) ? 'volatile-nonce-only' : 'append'
  } else {
    // a bare "first messages block changed" is NOT reliable for compaction (real traces over-fire:
    // CC re-injects scaffolding into the first user turn, forks, etc.). Compaction is decided by
    // analyze()'s authoritative drop verdict (opts.compaction) below, not by structure.
    const d = opts.detail(idx)
    out.cause = d.reorder ? 'json-key-reorder' : 'content-changed'
    if (cur.sec(idx) === 'tools') {
      const names = (s) => { const o = []; for (let i = 0; i < s.n; i++) if (s.sec(i) === 'tools') o.push(s.name(i)); return o }
      const ps = names(prev), cs = names(cur)
      const sameSet = ps.length === cs.length && ps.slice().sort().join('\u0001') === cs.slice().sort().join('\u0001')
      if (sameSet && ps.join('\u0001') !== cs.join('\u0001')) out.cause = 'tool-array-reorder'
    }
    // byte-level localization within the first diverging block (structural estimate)
    if (d.byteOffset != null) { out.byteOffset = d.byteOffset; out.byteContext = d.byteContext }
    // analyze()'s drop-based compaction verdict is authoritative — a compaction that kept the first
    // user turn breaks mid-history; without the hint that reads as 'content-changed'.
    if (opts.compaction) out.cause = 'compaction'
  }
  const meta = CAUSE_META[out.cause] || CAUSE_META['content-changed']
  out.causeLabel = meta.label; out.attribution = meta.attr; out.fixHint = meta.fix
  return out
}

// ── D17④ ground-truth verification (RFC 3.3 地面真相验证) ──
// With a reusable structural prefix (idx>0), cross-check what the provider's usage actually credited:
//   read>0            → prefix genuinely reused              → null (normal)
//   read=0 & write>0  → cache entry expired (TTL), re-cached → 'ttl-rebuild' (not a contradiction)
//   read=0 & write=0  → prefix was reusable yet NEITHER read NOR written → suspect PROVIDER
//                       mis-cache/mis-bill (research pain #9: SHA256-identical prefix, cached_tokens=0)
// The prefix match here is STRUCTURAL (content_hash sequence — demo proxy). The product proves it with
// an independent `prefix_sha256` over verbatim source bytes (RFC 3.3); the claim is strictly "MY
// outbound prefix is identical ⇒ the suspicion points at the provider" — never "the provider is wrong".
export function groundTruth(brk, read, create) {
  if (!brk || brk.firstCall || brk.idx <= 0) return null // no reusable prefix to reason about
  if (read > 0) return null
  return create > 0 ? 'ttl-rebuild' : 'provider-contradiction'
}
