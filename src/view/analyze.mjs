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
import { compactionVerdict } from '../identity/session-identity.mjs'
// Envelope drift guard (R1): the D10 envelope stores the response under `resp`, demo v0 under
// `response`. Reading `.response` directly is the bug class that silently killed every HTTP status
// on real captures — so go through the shared helper, never the raw key. (assemble.mjs imports
// analyze.mjs too; the cycle is safe because respOf is only CALLED at runtime, after both modules
// have finished evaluating. test/view/analyze-admission.test.mjs pins both module load orders.)
import { respOf } from './assemble.mjs'
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
const isSub = (r) => /cc_is_subagent=true/.test(sysText(r))
const isMonitor = (r) => /you are a security monitor/i.test(sysText(r))
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
// response.{usage,text,tool_calls}) and non-streaming JSON (raw body in response.body).
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
      tool_calls: c.filter((b) => b.type === 'tool_use' || b.type === 'server_tool_use')
        .map((b) => ({ id: b.id, name: b.name, input: b.input })),
      stop_reason: rs.body.stop_reason,
    }
  }
  return {
    status: rs.status, usage: rs.usage || {}, text: rs.text || '',
    thinking: rs.thinking, tool_calls: rs.tool_calls || [], stop_reason: rs.stop_reason,
  }
}
const ctxTokens = (r) => {
  const u = normResp(r).usage
  return (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0)
}

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

// Detect resources introduced by a set of (new) messages.
function extractResources(messages, step, out) {
  for (const m of messages) {
    const content = Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content }]
    for (const b of content) {
      if (b.type === 'tool_use') {
        const arg = toolArg(b.name, b.input)
        if (FILE_OPS.has(b.name) && arg) addRes(out, 'file', arg, step, b.name, rangeOf(b.name, b.input))
        else if (b.name === 'Bash' && b.input?.command) {
          for (const rd of parseBashReads(b.input.command)) addRes(out, 'file', rd.path, step, 'Bash', rd.range)
        } else if (DIR_OPS.has(b.name) && arg) addRes(out, 'dir', arg, step, b.name)
        else if ((b.name === 'WebFetch' || b.name === 'WebSearch') && arg)
          addRes(out, 'link', arg, step, b.name)
        // Skill invocation: fine-grained kind:'skill' (schema 3.2 kind enum / D8 — no `capability` umbrella).
        // The tool_use is the point-marker + args source; the resident SKILL.md body is caught below.
        // normalize to the bare skill name (basename) so a namespaced invocation
        // (`plugin:skill`) keys to the SAME resource as its resident SKILL.md body
        // (whose "Base directory" basename is unqualified) — else the card splits in two.
        else if (b.name === 'Skill') addRes(out, 'skill', String(b.input?.skill || b.input?.command || '?').split(':').pop().split('/').pop(), step, 'Skill')
      } else if (b.type === 'image') {
        addRes(out, 'capability', 'image (' + (b.source?.media_type || '?') + ')', step, 'image')
      } else if (b.type === 'document') {
        addRes(out, 'capability', 'document (' + (b.source?.media_type || b.title || '?') + ')', step, 'document')
      } else if (b.type === 'text' && typeof b.text === 'string') {
        // Skill residency: a skill enters context as a bare `user` `text` block carrying the
        // verbatim SKILL.md, prefixed "Base directory for this skill: <dir>" — NOT a Read of a
        // file (so it never lands in "files opened"). basename(dir) = skill name. The body IS
        // verbatim on the wire, so its length is the resident size (fine kind:'skill', schema 3.2).
        const sk = b.text.match(/^Base directory for this skill: (\S+)/)
        if (sk) addRes(out, 'skill', sk[1].split('/').pop(), step, 'skill', `${b.text.length} chars (verbatim body)`)
        if (/<system-reminder>/.test(b.text)) {
          if (/CLAUDE\.md/i.test(b.text)) addRes(out, 'scaffold', 'CLAUDE.md', step, 'auto-load')
          if (/\bMEMORY\.md\b|auto-memory|persists across conversations/i.test(b.text))
            addRes(out, 'scaffold', 'memory (MEMORY.md)', step, 'auto-load')
        }
        // only genuine URLs — strip trailing markdown/punctuation so `**http://x**` or `http://x,`
        // don't leak the surrounding prose into the label
        const urls = b.text.match(/https?:\/\/[^\s"'`<>)\]]+/g)
        if (urls) for (const raw of urls.slice(0, 3)) {
          const u = raw.replace(/[*_~.,;:!?)\]}>'"]+$/, '')
          if (/^https?:\/\/[^/]+\.[^/]/.test(u) || /^https?:\/\/[^/]+:\d/.test(u)) addRes(out, 'link', u, step, 'mention')
        }
      }
    }
  }
}
function addRes(map, kind, label, step, via, range) {
  const key = kind + '::' + label
  let r = map.get(key)
  if (!r) {
    r = { kind, label, via, segments: [{ enter: step, evict: null }], loads: [], hits: 1 }
    map.set(key, r)
  } else {
    r.hits++
    const last = r.segments[r.segments.length - 1]
    if (last.evict != null && step >= last.evict) r.segments.push({ enter: step, evict: null })
  }
  if (range) r.loads.push({ step, range, via })
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
function extractSeenPaths(text, step, seen, cap) {
  if (!text || typeof text !== 'string') return
  text = text.replace(/https?:\/\/[^\s"'`<>)\]]+/g, ' ') // drop URLs so remote asset paths aren't "seen files"
  PATH_RE.lastIndex = 0
  let m, n = 0
  while ((m = PATH_RE.exec(text)) && n < cap) {
    const raw = m[1] || m[0] // group 1 = the dotfile capture; else whole match
    const end = m.index + m[0].length
    if (text[end] === '(') continue // response.json() etc. — a method call, not a file
    const p = raw.replace(/^[\s"'(]+/, '').replace(/[.,;:!?)\]}>'"`]+$/, '')
    if (p.length < 3 || p.endsWith('/') || !acceptPath(p)) continue
    const ex = seen.get(p)
    if (ex) ex.count++
    else { seen.set(p, { path: p, firstStep: step, count: 1 }); n++ } // cap counts DISTINCT paths
  }
}
function textOfResult(b) {
  const c = b.content
  return typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => x.text || '').join('\n') : ''
}

// Classify the assistant turn a call PRODUCED into ReAct events (uses normResp).
function responseEvents(r, step, streamId) {
  const rs = normResp(r)
  const ev = []
  if (rs.thinking) ev.push({ type: 'thought', step, streamId, text: rs.thinking })
  if (rs.text) ev.push({ type: 'say', step, streamId, text: rs.text })
  for (const c of rs.tool_calls || []) {
    const spawn = SPAWN_OPS.has(c.name)
    ev.push({
      type: spawn ? 'spawn' : 'action',
      step, streamId, tool: c.name, id: c.id,
      arg: toolArg(c.name, c.input), input: c.input,
    })
  }
  return ev
}

function observationEvents(newMessages, step, streamId, toolNameById) {
  const ev = []
  for (const m of newMessages) {
    if (m.role !== 'user' || !Array.isArray(m.content)) continue
    for (const b of m.content) {
      if (b.type !== 'tool_result') continue
      const src = toolNameById.get(b.tool_use_id) || 'tool'
      const c = b.content
      const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => x.text || `[${x.type}]`).join('\n') : JSON.stringify(c)
      ev.push({ type: 'observation', step, streamId, source: src, tool_use_id: b.tool_use_id, text })
    }
  }
  return ev
}

function userEvents(newMessages, step, streamId) {
  const ev = []
  for (const m of newMessages) {
    if (m.role !== 'user') continue
    const content = Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content }]
    const hasToolResult = content.some((b) => b.type === 'tool_result')
    if (hasToolResult) continue
    const text = content.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
    const human = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
    if (human) ev.push({ type: 'user', step, streamId, text: human })
  }
  return ev
}

// The board's message-count drop rule for compaction (the last step of the shared verdict, compactionVerdict): a
// big collapse, or any drop that carries Claude Code's own "continued from a previous conversation" preamble. A
// small drop alone is not enough here — on a real CC session the main lane goes 58 → 55 (no compaction) before the
// real 55 → 4. The ETL's rule (markCompaction: any drop) differs; that divergence is the user's call (3.4 「骤降」).
export function boardCompactionDrop(from, to, cur = {}) {
  const drop = to < from
  const bigDrop = drop && to < from - 5 && to < from * 0.7
  return bigDrop || (drop && cur.preamble) ? { compaction: true, compaction_from: from, compaction_to: to }
    : { compaction: false, compaction_from: null, compaction_to: null }
}
// What a compaction verdict says about itself on the board (1.5:38 / 1.5:79: the UI tells confirmed from inferred).
// A harness header hint is the harness's own word (high, not inferred); a text marker and a count drop are inferred
// (medium, 3.4). `preamble` only refines the wording of a drop.
export function compactionMeta(v, preamble = false) {
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

// ── admission (audit 2026-07-19 · invariant 4) ──────────────────────────────────────────
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
// A call is "failed" if it carries an error key, a non-200 status, or is an unparsed sentinel.
// (Status-less records — an in-flight capture with no response yet — are NOT failures.)
function failedCall(r) {
  if (r.error) return true
  if (r._unparsed || isUnparsed(r)) return true // `_unparsed` = already stubbed by admission
  const st = respOf(r)?.status
  return st != null && st !== 200
}

// opts.giOf(rec) → the call's GLOBAL step index when this analyzer sees only part of a session (a session
// that mixes wire formats, src/view/assemble.mjs); undefined → the local index. It is asked about the
// record as passed in, before any sentinel stub is made of it.
export function analyze(records, opts = {}) {
  // Admit on `is_llm_call` alone. Non-LLM records stay out (they carry only a response body by
  // design — 保真边界, not a loss). Sentinels get an empty request stub so the downstream walkers
  // never dereference a missing `.request`; `rec` here is already a view-side hydrated clone, so
  // stubbing does not touch the raw NDJSON source truth (invariant 2).
  const giGiven = new Map()
  const llm = records.filter((r) => r && r.is_llm_call).map((r) => {
    const out = isUnparsed(r)
      ? { ...r, request: { messages: [], tools: [], system: [], message_count: 0, tool_count: 0 }, _unparsed: true }
      : r
    // the stub keeps the non-enumerable source-stream stamp a spread drops: its reply still needs a locator
    if (out !== r && r._stream) Object.defineProperty(out, '_stream', { value: r._stream, enumerable: false, configurable: true })
    const g = opts.giOf ? opts.giOf(r) : undefined
    if (g != null) giGiven.set(out, g)
    return out
  })
  llm.sort((a, b) => String(a.ts_request).localeCompare(String(b.ts_request)) || String(a.id).localeCompare(String(b.id)))

  // ── segment into streams/lanes by lineage + role marker ─────────────────────
  const streams = []
  let mainStream = null, curSub = null, monitorStream = null
  const auxStreams = new Map()
  let prevKind = null
  const stepList = []

  let probeStream = null
  for (const r of llm) {
    const msgCount = r.request.message_count
    const tools = r.request.tool_count || 0
    // 3.4 lane precedence probe > monitor > aux > subagent > main, the ETL's (session-identity.mjs::lane): inside each
    // tier the harness table's hint decides first (Z-Code x-zcode-session-type, dsh origin, CC x-claude-code-agent-id,
    // a request-kind warm-up), then Claude Code's own markers
    const hint = hintsOf(r).lane
    const sub = hint === 'subagent' || isSub(r)
    // The main conversation runs on the primary (opus) model; utility calls run on a small model
    // (haiku). A tiny haiku call (≤2 msgs) is background util REGARDLESS of tool count — otherwise
    // a burst of failed haiku retries (tools≥1) during a network drop pollutes the conversation lane.
    const small = /haiku/i.test(r.request.model || '')
    let stream
    if (r._unparsed) {
      // An unparsed sentinel has no system text / message count to classify on. Every lane guess
      // would be a fabrication; route it to `main` — the lane the user is actually watching — so the
      // gap is VISIBLE. The alternative (0 msgs / 0 tools → the aux heuristic) would file a broken
      // conversation turn under "quota / keep-alive", asserting a lane we do not know (invariant 4).
      if (!mainStream) mainStream = mkStream('main')
      stream = mainStream
    } else if (hint === 'probe') {
      stream = probeStream || (probeStream = mkStream('probe'))
    } else if (isMonitor(r)) {
      stream = monitorStream || (monitorStream = mkStream('monitor'))
    } else if (hint === 'aux' || (msgCount <= 2 && !sub && (tools === 0 || small))) {
      const sk = auxSubkind(r, userTextOf(r))
      stream = auxStreams.get(sk) || auxStreams.set(sk, mkStream(sk)).get(sk)
    } else if (sub) {
      const fresh = !curSub || msgCount <= (curSub._lastMsg ?? 0) || prevKind === 'main'
      if (fresh) curSub = mkStream('subagent')
      stream = curSub
    } else {
      if (!mainStream) mainStream = mkStream('main')
      stream = mainStream
    }
    stream._lastMsg = msgCount
    prevKind = stream.kind
    const rs = respOf(r) || {}
    const status = rs.status ?? null
    const failed = failedCall(r)
    // #21: the collector's own word on WHY the stored body is incomplete (null when it is complete).
    const reqIncomplete = reqIncompleteOf(r)
    const step = { gi: giGiven.has(r) ? giGiven.get(r) : stepList.length, id: r.id, streamId: stream.id, rec: r, norm: normResp(r),
      msgCount, tools, ctx: ctxTokens(r), status,
      ts: r.ts_request, compaction: false,
      unparsed: !!r._unparsed,
      reqIncomplete,
      wsIncomplete: wsIncompleteOf(r), // D38 a WebSocket call's labels (4.6 各说一件事)
      respIncomplete: respIncompleteOf(r), // a response body not decoded / not JSON / empty / partly parsed / cut
      // `error` now covers EVERY non-200 (was: only 5xx — so a 401/429 rendered as a normal call).
      error: failed,
      errMsg: r._unparsed ? unparsedErrMsg(reqIncomplete)
        : (rs.error?.message || (status != null && status !== 200 ? `HTTP ${status}` : (r.error ? String(r.error.message || r.error) : null))),
      // Cache-prefix chaining (audit 2026-07-19). A call that FAILED did not establish a new cache
      // prefix at the provider — a 401/429/502 never got far enough to write one — so the next call's
      // prefix diff must be taken against the last SUCCESSFUL call, not against the failure. This flag
      // makes that skip EXPLICIT and inspectable; the call still APPEARS on the timeline (that was the
      // whole bug). Consumers that chain `prevFlat` MUST advance it only when chainsPrefix is true.
      chainsPrefix: !failed }
    stream.calls.push(step)
    stepList.push(step)
  }
  function mkStream(kind) {
    const s = { id: 's' + streams.length, kind, calls: [], events: [], resources: [], parent: null, spawnArg: null }
    streams.push(s)
    return s
  }

  // ── per stream: deltas → events + resources ─────────────────────────────────
  const toolNameById = new Map()
  for (const s of streams) {
    // monitor + aux-family lanes: no ReAct/resource extraction — just one event per call
    if (EVENT_ONLY_KINDS.has(s.kind)) {
      let prevCtx = 0
      for (const step of s.calls) {
        step.dCtx = step.ctx - prevCtx; prevCtx = step.ctx
        if (step.error) { s.events.push({ type: 'error', step: step.gi, streamId: s.id, msg: step.errMsg }); continue }
        if (s.kind === 'monitor') {
          const v = (step.norm.text || '').replace(/<\/?block>/g, '').trim()
          step.flagged = !/^no\b/i.test(v)
          step.verdict = v
          s.events.push({ type: 'monitor', step: step.gi, streamId: s.id, verdict: v, flagged: step.flagged })
        } else {
          s.events.push({ type: 'aux', subkind: s.kind, step: step.gi, streamId: s.id, text: step.norm.text || '', model: step.rec.request?.model })
        }
      }
      continue
    }
    // main / subagent lanes
    const resMap = new Map()
    const seenMap = new Map() // filenames the agent saw (in results/prose) but never opened
    let prevCount = 0, prevCtx = 0
    let prevInfo = null // { msgCount, marker } of the last renderable call in this lane: the compaction verdict's predecessor
    for (let k = 0; k < s.calls.length; k++) {
      const step = s.calls[k]
      // Unparsed sentinel: no context to diff. Emit the visible error marker and leave prevCount /
      // prevCtx anchored to the last RENDERABLE call — its empty stub would otherwise read as a
      // message-count collapse and fabricate a compaction event out of a capture defect.
      if (step.unparsed) {
        step.dCtx = 0
        s.events.push({ type: 'error', step: step.gi, streamId: s.id, msg: step.errMsg, unparsed: true })
        continue
      }
      step.dCtx = step.ctx - prevCtx
      prevCtx = step.ctx
      const msgs = step.rec.request.messages
      for (const m of msgs) {
        if (Array.isArray(m.content))
          for (const b of m.content) if (b.type === 'tool_use') toolNameById.set(b.id, b.name)
      }
      for (const c of step.norm.tool_calls || []) toolNameById.set(c.id, c.name)
      for (const t of step.rec.request.tools || []) {
        if (/^mcp__/.test(t.name || '')) addRes(resMap, 'capability', 'MCP: ' + (String(t.name).split('__')[1] || t.name), step.gi, 'mcp')
      }

      const drop = msgs.length < prevCount
      const hasPreamble = msgs.slice(0, 4).some((m) => /continued from a previous conversation/i.test(textOfMessage(m)))
      const isSummarize = /^\s*<analysis>/.test(step.norm.text || '')
      // 3.4, the ETL's verdict (compactionVerdict): a harness header hint first (x-cc-compaction-request, dsh's compact
      // header), a text marker on its rising edge, then the board's drop rule.
      // 保真边界 (invariant 4 · spec 1.5:37 / 3.4:16,21): a drop or a marker is INFERRED from observed shape, never
      // confirmed by the harness, and says so (medium, `compactionInferred`); a header hint is the harness's own word.
      // `basis` names WHICH evidence fired: CC's own "continued from a previous conversation" preamble (the stronger
      // drop signal) vs. a bare message-count collapse (a number going down — the weaker guess).
      const h = hintsOf(step.rec)
      const marker = h.compactionMarker === true
      // 3.4: a request stored in part (the collector's req_* labels, the ETL's context_state 'partial') shows what arrived,
      // not the context the model saw: its message count is no observation, so no verdict and no new baseline
      const verdict = step.reqIncomplete ? { compaction: false }
        : compactionVerdict(prevInfo, { hint: h.compaction === true, marker, msgCount: msgs.length, preamble: hasPreamble }, boardCompactionDrop)
      if (!step.reqIncomplete) prevInfo = { msgCount: msgs.length, marker }
      let newMsgs
      if (verdict.compaction) {
        Object.assign(step, compactionMeta(verdict, hasPreamble))
        for (const res of resMap.values()) {
          const last = res.segments[res.segments.length - 1]
          if (last.evict == null) last.evict = step.gi
        }
        newMsgs = msgs
      } else if (drop) {
        newMsgs = []
      } else {
        newMsgs = msgs.slice(prevCount)
      }
      if (step.compaction)
        s.events.push({ type: 'compaction', step: step.gi, streamId: s.id, from: step.evictedFrom, to: step.evictedTo,
          // the event travels to the UI on its own — it MUST carry the inference marker with it,
          // otherwise the timeline re-asserts as fact what the step knows is a guess (invariant 4).
          inferred: step.compactionInferred, confidence: step.compactionConfidence, basis: step.compactionBasis })
      if (isSummarize) {
        step.summarizing = true
        s.events.push({ type: 'summarize', step: step.gi, streamId: s.id, out: step.norm.usage?.output_tokens })
      }
      extractResources(newMsgs, step.gi, resMap)
      // seen-but-not-opened filenames: scan tool-result text (bigger cap) + prose (smaller)
      for (const m of newMsgs) {
        const content = Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content }]
        for (const b of content) {
          if (b.type === 'tool_result') extractSeenPaths(textOfResult(b), step.gi, seenMap, 80)
          else if (b.type === 'text') extractSeenPaths(b.text, step.gi, seenMap, 40)
        }
      }
      extractSeenPaths(step.norm.text || '', step.gi, seenMap, 40)
      s.events.push(...userEvents(newMsgs, step.gi, s.id))
      s.events.push(...observationEvents(newMsgs, step.gi, s.id, toolNameById))
      if (step.error) s.events.push({ type: 'error', step: step.gi, streamId: s.id, msg: step.errMsg })
      else if (!isSummarize) s.events.push(...responseEvents(step.rec, step.gi, s.id))
      prevCount = msgs.length
    }
    s.resources = [...resMap.values()]
    // "only seen" = matched paths minus anything actually opened. Dedupe absolute-vs-relative
    // spellings of the SAME opened file (path-boundary suffix), but keep distinct-directory
    // files that merely share a basename (src/index.js opened ≠ test/index.js seen).
    const openedArr = [...new Set([...resMap.values()].filter((r) => r.kind === 'file').map((r) => r.label))]
    const sameFile = (a, b) => a === b || a.endsWith('/' + b) || b.endsWith('/' + a)
    s.seenFiles = [...seenMap.values()]
      .filter((sf) => !openedArr.some((o) => sameFile(o, sf.path)))
      .sort((a, b) => a.firstStep - b.firstStep || b.count - a.count)
      .slice(0, 200)
  }

  // ── link subagents to their spawning Agent/Task call ────────────────────────
  for (const s of streams.filter((x) => x.kind === 'subagent')) {
    const firstUser = s.calls[0]?.rec.request.messages.find((m) => m.role === 'user')
    const firstText = firstUser ? textOfMessage(firstUser).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '') : ''
    let best = null
    for (const st of streams) {
      for (const e of st.events) {
        if (e.type !== 'spawn') continue
        const p = (e.input?.prompt || '').slice(0, 60)
        if (p && firstText.includes(p.slice(0, 40))) best = e
      }
    }
    if (best) {
      s.parent = best.streamId
      s.spawnArg = best.arg
      s.spawnStep = best.step
      best.childStreamId = s.id
    }
  }

  // ── events keep their SHAPE, not a second copy of the session's text ─────────
  //
  // userEvents() / observationEvents() above build each event around the FULL user message or the
  // FULL tool_result. That text is the heaviest thing in a session and it is already carried, once,
  // as blocks — so every event was a verbatim second copy, uncapped and with no locator. Measured on
  // a 40-call fixture it was 7.8 MB of a 10.1 MB response; and because events are not indexed by the
  // page window, paging did not shrink them at all (a 10-wide window came out 1.04× a 5-wide one).
  //
  // Nothing reads that text after this point. Inside analyze() the only event field consulted later
  // is `input.prompt`, for subagent spawn-linking above — which is why this runs AFTER that loop.
  // The board renders one event kind (`grep -n '\.events' src/web/index.html` → :1739, filtered to
  // compaction / summarize) and those carry no `text` at all.
  //
  // Invariant 4: the body is not silently emptied. `preview` + `chars` are what the collapsed row
  // shows anyway, and `text_omitted` states in place that the full text lives on this step's blocks —
  // an event is derived from them and owns no byte span of its own, so there is no honest locator to
  // mint here.
  for (const s of streams) {
    for (const e of s.events) {
      if (typeof e.text !== 'string') continue
      const full = e.text
      delete e.text
      e.preview = full.replace(/\s+/g, ' ').trim().slice(0, 200)
      e.chars = full.length
      e.text_omitted = 'derived event — full text is not shipped here; read it from this step\'s blocks'
    }
  }

  // ── lanes: a per-session view model the UI can tab between ───────────────────
  const lanes = streams.slice()
    .sort((a, b) => (LANE_ORDER[a.kind] - LANE_ORDER[b.kind]) || String(a.id).localeCompare(String(b.id)))
    .map((s) => {
      const giLocal = new Map(s.calls.map((c, i) => [c.gi, i]))
      const laneId = s.kind === 'subagent' ? s.id : s.kind
      return {
        id: laneId, streamId: s.id, kind: s.kind, icon: LANE_META[s.kind].icon,
        label: s.kind === 'subagent' ? `subagent: ${s.spawnArg || 'task'}` : LANE_META[s.kind].label,
        ...(LANE_META[s.kind].note ? { note: LANE_META[s.kind].note } : null),
        calls: s.calls, events: s.events, resources: s.resources, seenFiles: s.seenFiles || [], giLocal,
        peakCtx: s.calls.reduce((m, c) => Math.max(m, c.ctx), 1),
        spawnStep: s.spawnStep ?? null, parent: s.parent,
        flagged: s.kind === 'monitor' ? s.events.filter((e) => e.flagged).length : 0,
      }
    })

  // NOTE: the true-order linear context (linearContext) + per-step cache-break (cacheBreak) are
  // computed lazily by the UI for just the current + previous call — NOT precomputed for every
  // call here — since analyze() re-runs on every poll and a session has hundreds of calls.

  const stats = {
    calls: stepList.length,
    streams: streams.length,
    subagents: streams.filter((s) => s.kind === 'subagent').length,
    monitors: (streams.find((s) => s.kind === 'monitor')?.calls.length) || 0,
    compactions: stepList.filter((s) => s.compaction).length,
    totalIn: llm.reduce((a, r) => a + (normResp(r).usage.input_tokens || 0), 0),
    totalOut: llm.reduce((a, r) => a + (normResp(r).usage.output_tokens || 0), 0),
    peakCtx: stepList.reduce((a, s) => Math.max(a, s.ctx), 0),
  }
  return { streams, steps: stepList, stats, lanes }
}

// ── the linear context: the exact tools → system → messages sequence the model assembles ──
// The request body is a JSON object with three SEPARATE top-level fields; its byte/key order is
// an SDK detail and is irrelevant to the model. What the model actually reads top-to-bottom — and
// what the Anthropic prompt cache uses as its prefix — is tools, then system, then messages.
// So THIS is "the original order of the context", not the JSON key order.
function blkHashText(b) {
  if (typeof b === 'string') return b
  if (!b || typeof b !== 'object') return String(b)
  if (b.type === 'text') return b.text || ''
  if (b.type === 'thinking') return b.thinking || ''
  if (b.type === 'redacted_thinking') return 'redacted_thinking'
  if (b.type === 'tool_use' || b.type === 'server_tool_use') return (b.name || '') + '::' + JSON.stringify(b.input || {})
  if (b.type === 'tool_result') {
    const c = b.content
    const t = typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => x.text || `[${x.type}]`).join('\n') : JSON.stringify(c)
    return (b.tool_use_id || '') + '::' + t + (b.is_error ? '::ERR' : '')
  }
  if (b.type === 'image') return 'image:' + (b.source?.media_type || b.source?.type || '')
  if (b.type === 'document') return 'document:' + (b.source?.media_type || b.title || '')
  return JSON.stringify(b)
}
// hash a bounded prefix — plenty to distinguish blocks, and O(1) per block regardless of size
const blkKey = (prefix, b) => prefix + hash(blkHashText(b).slice(0, 4096))

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

export function linearContext(request) {
  const flat = []
  // ── resource ↔ RESULT linking (audit 2026-07-19) ────────────────────────────────────────
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
      flat.push({
        sec: 'tools', kind: 'tool', role: 'tool', name: t.name || '', ttype: t.type || '',
        props, descChars, cc: t.cache_control || null, mcp,
        verbatim, desc: hasDesc ? t.description : undefined, schema: hasSchema ? t.input_schema : undefined,
        resKey: mcp ? 'mcp::' + (String(t.name).split('__')[1] || '') : '',
        key: 'T:' + (t.name || e.path.i) + ':' + descChars + ':' + props.length,
      })
    } else if (e.section === 'system') {
      const b = e.parsed, text = b?.text || ''
      flat.push({ sec: 'system', kind: 'system', role: 'system', si: e.path.i, label: sysLabel(text), text, chars: text.length, volatile: e.volatile, cc: b?.cache_control || null, key: blkKey('S:', { type: 'text', text }) })
    } else {
      const b = e.parsed, type = typeof b === 'string' ? 'text' : (b?.type || 'text')
      const d = {
        sec: 'messages', kind: type, role: e.role, mi: e.path.mi, bi: e.path.bi, block: b,
        toolName: type === 'tool_use' || type === 'server_tool_use' ? (b.name || '') : '',
        cc: (b && b.cache_control) || null,
        resKey: e.resourceRef, key: blkKey('M:' + e.role + ':' + type + ':', b),
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
// and the verbatim byte source for the D17④ prefix SHA-256 (exported; used by the server-side assembler).
export function flatBlockText(b) {
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
  if (!prevFlat || !prevFlat.length)
    return { idx: 0, rawIdx: 0, prefixLen: 0, total: curFlat.length, firstCall: true, cause: 'first-call', causeLabel: 'first captured call', attribution: 'harmless', fixHint: '', byteOffset: null, byteContext: '' }
  const n = Math.min(prevFlat.length, curFlat.length)
  let rawIdx = -1, idx = -1
  for (let i = 0; i < n; i++) {
    if (prevFlat[i].key === curFlat[i].key) continue
    if (rawIdx < 0) rawIdx = i
    if (curFlat[i].volatile) continue // billing nonce — differs but cache-irrelevant
    idx = i; break
  }
  if (idx < 0) idx = n // no meaningful divergence within the shared region → new content is the appended tail (idx===prevLen) or nothing
  if (rawIdx < 0) rawIdx = idx
  const out = { idx, rawIdx, prefixLen: idx, total: curFlat.length, firstCall: false, cause: 'append', causeLabel: '', attribution: 'harmless', fixHint: '', byteOffset: null, byteContext: '' }
  // classify WHY (structural inference — labelled as such in the UI; numeric truth stays with usage)
  if (idx >= n) {
    // shared prefix fully reused; only a volatile block changed, or new content was appended
    out.cause = (curFlat.length <= prevFlat.length && rawIdx < n) ? 'volatile-nonce-only' : 'append'
  } else {
    const cur = curFlat[idx], prev = prevFlat[idx]
    // a bare "first messages block changed" is NOT reliable for compaction (real traces over-fire:
    // CC re-injects scaffolding into the first user turn, forks, etc.). Compaction is decided by
    // analyze()'s authoritative drop verdict (opts.compaction) below, not by structure.
    if (cur.sec === 'tools') {
      const ps = prevFlat.filter((b) => b.sec === 'tools').map((b) => b.name)
      const cs = curFlat.filter((b) => b.sec === 'tools').map((b) => b.name)
      const sameSet = ps.length === cs.length && ps.slice().sort().join('\u0001') === cs.slice().sort().join('\u0001')
      if (sameSet && ps.join('\u0001') !== cs.join('\u0001')) out.cause = 'tool-array-reorder'
      else out.cause = keyReorder(prev, cur) ? 'json-key-reorder' : 'content-changed'
    } else {
      out.cause = keyReorder(prev, cur) ? 'json-key-reorder' : 'content-changed'
    }
    // byte-level localization within the first diverging block (structural estimate)
    const off = firstDiffOffset(flatBlockText(prev), flatBlockText(cur))
    if (off >= 0) { out.byteOffset = off; out.byteContext = flatBlockText(cur).slice(off, off + 48) }
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
