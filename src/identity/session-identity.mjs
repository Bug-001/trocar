// src/identity/session-identity.mjs
// Session identity + lineage — PURE functions, no I/O, no DuckDB. Single authority for RFC 3.4
// judgment; the 3.1 adapters IMPORT these (do NOT inline them), and 4.2 ETL calls them to fill the
// `sessions` lineage columns + `calls` (session_id/class/control_kind/lane/compaction) columns.
//
// D37 ①: the session key, lane / parent / compaction HINTS and key aliases come from the ONE harness
// table (src/dissect/harnesses.mjs) the board and the sharder also read; the CC heuristics below
// (cc_is_subagent, security monitor, haiku aux, 认亲) run after it. Never pid or connection (3.4 关键区分).
//
// D10 unified-envelope field names consumed here (4.1): record.req_headers, record.req_body (PARSED:
// {system[], messages[], metadata, model}), record.endpoint, record.is_llm_call, record.proc,
// record.ts_request (fallback record.ts).
//
// Ported from the v0 prototype, following RFC 3.4 where they differ.
//
// DEFERRED / STUBBED (flagged, not implemented):
//   • CC /rewind online behavior = 待数据决策 R (RFC 3.4 Edge cases) — pending a real /rewind
//     capture; suspected to surface as a message_count drop, but NOT decided. Not handled here.
//   • Codex explicit fork (forkedFromId) — no online fork signal verified yet (3.4, lab).
//   • Hermes / Kimi synthesized session keys — src/dissect/synth-key.mjs (gate G11), applied by the ETL.
//   CC itself has NO explicit online fork signal (RFC 3.4 "无显式"), so forkOf() is a null stub.
import { sessionKeyOf, hintsOf } from '../dissect/harnesses.mjs'

// --- Task 1: native_id + confidence, class (llm/control), sessionIdFor -----------------------

// native_id: the harness's own session key (RFC 3.4 table, src/dissect/harnesses.mjs), with its
// confidence (header = high, body key = medium). A record whose harness is not identified by proc keeps
// the pre-D37 header keys (legacy captures). CC: the x-claude-code-session-id header only — body
// metadata.user_id is NOT a source (gate G3: in real CC traffic it is an opaque account hash, so parsing
// it would mint spurious ids). Never pid or connection (3.4 关键区分). Stored verbatim (a value column).
export function nativeId(record) {
  const k = sessionKeyOf(record)
  return k.key ? { native_id: k.key, native_id_confidence: k.confidence || 'low' } : { native_id: null, native_id_confidence: 'low' }
}

// D9 class ∈ {llm, control}. RFC 3.4 line 30 defines the control plane as *session-less* AND
// *non-LLM* traffic (telemetry / registry / account / feature-flag). So:
//   class='control'  ⟺  NOT is_llm_call  AND  no native_id   (session-less control-plane noise)
//   class='llm'      otherwise
// This MUST read record.is_llm_call (adversarial verify MINOR + task directive), not native_id
// alone: a genuine /v1/messages LLM call that is missing the session header (a non-real-CC curl
// test) is NOT reclassified as control. Conversely a count_tokens probe (is_llm_call=false) that
// DOES carry the session header is session-attributed → 'llm' (lane='probe' distinguishes it).
// In real CC traffic every inference call carries the header, so this matches the RFC 3.2 invariant
// (llm has session_id; control ⟺ session_id NULL) exactly; the header-less-LLM edge is documented
// and left with session_id NULL rather than synthesized (CC synth is out of scope — DeepSeek-only).
export function classOf(record) {
  const hasNative = !!nativeId(record).native_id
  return (record.is_llm_call || hasNative) ? 'llm' : 'control'
}

// The calls.session_id value: native_id for class='llm', NULL for class='control'.
// (A header-less genuine LLM call is class='llm' but has no native_id → session_id NULL, honest.)
export function sessionIdFor(record) {
  return classOf(record) === 'llm' ? nativeId(record).native_id : null
}

// --- Task 2: control_kind endpoint classification -------------------------------------------

// Endpoint-level control-plane classification (RFC canonical: config|account|registry|telemetry|
// other). Ported from demo controlClass; demo's `control` bucket renamed `config` per 3.2.
export function controlKind(endpoint) {
  const e = String(endpoint || '')
  if (/event_logging/.test(e)) return 'telemetry'
  if (/mcp[-_]registry|mcp_servers/.test(e)) return 'registry'
  if (/oauth|account/.test(e)) return 'account'
  if (/bootstrap|grove|penguin|eval|triggers|code\//.test(e)) return 'config'
  return 'other'
}

// control_kind column value: NULL unless class='control' (llm calls carry no control_kind).
export function controlKindFor(record) {
  return classOf(record) === 'control' ? controlKind(record.endpoint) : null
}

// --- Task 3: lane classification (main/subagent/probe; monitor/aux reserved) ----------------

// The system prompt's text. The Anthropic wire allows `system` as a string or as an array of text blocks;
// mapping over a string threw and aborted the whole ETL run.
function systemText(record) {
  const sys = record.req_body?.system
  if (typeof sys === 'string') return sys
  return Array.isArray(sys) ? sys.map((b) => b?.text || '').join('') : ''
}

// Subagent marker in the CC system prompt (ported from demo isSub; request.system → req_body.system).
export function isSubagent(record) {
  const sys = systemText(record)
  return /cc_is_subagent=true/.test(sys)
}

// Security-monitor marker (demo v6: CC's built-in prompt-injection / autonomous-agent
// guardrail — system prompt "You are a security monitor for autonomous AI coding agents…",
// a distinct always-on lane, ~1 per 2 turns, non-streaming JSON, tools=0).
export function isMonitor(record) {
  const sys = systemText(record)
  return /you are a security monitor/i.test(sys)
}

// lane ∈ main|subagent|monitor|aux|probe (per-CALL, per B-lane the ETL reads call.lane not
// session.lane). Precedence probe > monitor > aux > subagent > main (3.4 涉及源文件). Within it a
// harness HINT (src/dissect/harnesses.mjs: a header or body field the harness itself sets, high) decides
// first at its own level — a Codex prewarm is a probe, a dsh `origin:"subagent"` / Codex
// x-openai-subagent / CC x-claude-code-agent-id is a subagent — and the CC heuristics follow: probe =
// count_tokens endpoint; monitor = security-monitor system marker; aux = a small background model
// (haiku) with a tiny message array ("classify lanes by MODEL, not tool-count" — demo v10 lesson);
// subagent = cc_is_subagent marker. (A count_tokens under a subagent is still a probe; subagents run
// the main model, not haiku.)
export function lane(record) {
  if (/\/messages\/count_tokens/.test(String(record.endpoint || ''))) return 'probe'
  const hinted = hintsOf(record).lane
  if (hinted === 'probe') return 'probe'
  if (isMonitor(record)) return 'monitor'
  if (hinted === 'aux') return 'aux'
  if (/haiku/i.test(String(record.req_body?.model || '')) && messageCount(record) <= 2) return 'aux'
  if (hinted === 'subagent' || isSubagent(record)) return 'subagent'
  return 'main'
}

// --- Task 4: entrypoint + messageCount + parseSessionCC assembler ---------------------------

// Entrypoint (ported from demo entrypoint; request_headers/request → req_headers/req_body).
// Precedence: desktop UA > x-app header > cc_entrypoint= system marker > '?'.
export function entrypoint(record) {
  const h = record.req_headers || {}
  const ua = String(h['user-agent'] || '')
  if (/claude-desktop/i.test(ua)) return 'desktop'
  if (h['x-app']) return String(h['x-app'])
  const sys = systemText(record)
  const m = sys.match(/cc_entrypoint=([^;]+)/)
  return m ? m[1] : '?'
}

export function messageCount(record) {
  const m = record.req_body?.messages
  return Array.isArray(m) ? m.length : 0
}

// CC has NO explicit online fork signal (RFC 3.4 "无显式"). /rewind online behavior = 待数据决策 R
// (pending real capture). Codex forkedFromId / DeepSeek synth-key live in their adapters (Phase 4).
// So CC fork_of is always null; subagents are parent lineage (Task 5), NOT fork. Also — compaction
// is NOT a fork (RFC 3.4 "关键区分"): a message-count drop MUST NOT populate sessions.fork_of.
export function forkOf(record) {
  void record
  return { fork_of_session_id: null, forked_at_seq: null }
}

// Per-record parseSession delegate (3.1 shape {native_id, parent, fork_of, forked_at, lane,
// entrypoint, title, extra} + native_id_confidence forwarded by cc.mjs). `parent` = the RAW parent id a
// harness declares on this record (dsh body parentSession, OpenCode / Codex parent header; high), else
// null; `aliases` = this record's other header keys (e.g. Codex thread-id). The ETL resolves `parent`
// through every session's aliases (gate G4) and falls back to the CC 认亲 pass (resolveParent).
export function parseSessionCC(record) {
  const { native_id, native_id_confidence } = nativeId(record)
  const f = forkOf(record)
  return {
    native_id,
    native_id_confidence,
    parent: hintsOf(record).parent?.id ?? null, // harness-declared, raw; resolved through aliases by the ETL
    aliases: sessionKeyOf(record).aliases,
    fork_of: f.fork_of_session_id, // CC has no online fork signal (deferred) → null
    forked_at: f.forked_at_seq,
    lane: lane(record),
    entrypoint: entrypoint(record),
    title: null,            // CC has no online session title at parse time (titlegen = aux side-call)
    extra: {},
  }
}

// --- Task 5: subagent 认亲 — parent_session_id via first-user-msg ↔ parent Agent/Task prompt ---

export function normPrompt(s) {
  return String(s || '').replace(/\s+/g, ' ').trim()
}

// The sub-agent's first user message = the Task prompt the parent handed it. CC appends an env
// <system-reminder> after it, so callers match by PREFIX, not equality.
export function subagentFirstPrompt(record) {
  for (const m of record.req_body?.messages || []) {
    if (m.role !== 'user') continue
    const c = m.content
    if (typeof c === 'string') return c
    if (Array.isArray(c)) {
      for (const b of c) if (b?.type === 'text' && typeof b.text === 'string') return b.text
    }
  }
  return null
}

// Parent-side: assistant tool_use blocks that launch a sub-agent (CC tool name Task/Agent).
export function parentTaskPrompts(record) {
  const out = []
  for (const m of record.req_body?.messages || []) {
    if (m.role !== 'assistant' || !Array.isArray(m.content)) continue
    for (const b of m.content) {
      if (b?.type === 'tool_use' && /^(Task|Agent)$/i.test(b.name || '') && b.input?.prompt) {
        out.push(String(b.input.prompt))
      }
    }
  }
  return out
}

// Flatten parent (non-subagent) records into dedup'd {session_id, ts, prompt} candidates for 认亲.
export function buildParentIndex(records) {
  const seen = new Set()
  const candidates = []
  for (const r of records || []) {
    const sid = nativeId(r).native_id
    if (!sid || isSubagent(r)) continue // subagents don't launch subagents in the parent sense
    const ts = r.ts_request ?? r.ts
    for (const prompt of parentTaskPrompts(r)) {
      const key = sid + '\x00' + normPrompt(prompt)
      if (seen.has(key)) continue
      seen.add(key)
      candidates.push({ session_id: sid, ts, prompt })
    }
  }
  return candidates
}

// Resolve a sub-agent's parent. Match = parent prompt is a prefix of the sub's first user message
// (after norm), parent prompt >= 8 chars (avoid trivial matches), and parent session != sub session.
// Tie-break: nearest parent whose ts precedes the sub (else globally latest). confidence: high if a
// single distinct parent session matched, medium if several (ambiguous), null if none.
export function resolveParent(subRecord, candidates) {
  const NONE = { parent_session_id: null, forked_at_seq: null, confidence: null }
  const selfId = nativeId(subRecord).native_id
  const sp = normPrompt(subagentFirstPrompt(subRecord))
  if (!sp) return NONE
  const subTs = subRecord.ts_request ?? subRecord.ts
  const matches = (candidates || []).filter((c) => {
    if (c.session_id === selfId) return false
    const pp = normPrompt(c.prompt)
    return pp.length >= 8 && (sp === pp || sp.startsWith(pp))
  })
  if (matches.length === 0) return NONE
  const preceding = matches.filter((c) => c.ts <= subTs)
  const pool = preceding.length ? preceding : matches
  const best = pool.reduce((a, b) => (b.ts > a.ts ? b : a))
  const distinct = new Set(matches.map((c) => c.session_id)).size
  return { parent_session_id: best.session_id, forked_at_seq: null, confidence: distinct > 1 ? 'medium' : 'high' }
}

// --- Task 6: compaction marking (drop-count authoritative; compaction ≠ fork) ---------------

// Compaction = a *shrink* of the messages array between consecutive same-session calls (换血),
// NOT a fork. Authority for the drop is 3.3's leading-prefix divergence (structural_divergence_seq):
// the ETL MUST only call this after 3.3 confirms a prefix drop (not append/reorder). The rule here
// is the count drop (drop-count authoritative), explicitly NOT the "message[0] changed" heuristic.
// It fills calls.compaction / compaction_from / compaction_to and MUST NOT touch sessions.fork_of.
export function markCompaction(prevMsgCount, curMsgCount) {
  const from = prevMsgCount | 0
  const to = curMsgCount | 0
  if (from - to > 0) return { compaction: true, compaction_from: from, compaction_to: to }
  return { compaction: false, compaction_from: null, compaction_to: null }
}

// The compaction verdict of ONE call against its in-lane predecessor (3.4), one rule for the ETL and the board.
// prev = { msgCount, marker } of the previous call in the same session lane, or null when there is none;
// cur = { hint, marker, msgCount }. In order:
//   1. a harness header / request-kind hint (high) — compaction even on a lane's first call;
//   2. a harness text marker (medium) on its RISING edge only: the marker stays in the history afterwards, and a
//      lane's first call has no edge (the capture may have started after the compaction, or a new synthesized
//      session may still carry an old marker);
//   3. the message-count drop (medium, markCompaction). `drop(prevCount, curCount, cur)` replaces this last step
//      only: the board passes its own threshold (analyze.mjs::boardCompactionDrop) — the two drop rules differ, a
//      known divergence left to the user.
// compaction_from is the predecessor's message count, NULL when the lane has none — never an invented 0
// (invariant 4). `basis` names the evidence that fired, so a reader can say how sure it is.
export function compactionVerdict(prev, cur, drop = markCompaction) {
  const NONE = { compaction: false, compaction_from: null, compaction_to: null, basis: null }
  const from = prev ? prev.msgCount | 0 : null
  const to = cur.msgCount | 0
  if (cur.hint) return { compaction: true, compaction_from: from, compaction_to: to, basis: 'hint' }
  if (cur.marker && prev && !prev.marker) return { compaction: true, compaction_from: from, compaction_to: to, basis: 'marker' }
  if (!prev) return NONE
  const m = drop(prev.msgCount | 0, to, cur)
  return m.compaction ? { compaction: true, compaction_from: m.compaction_from, compaction_to: m.compaction_to, basis: 'msg-count-drop' } : NONE
}
