// src/adapters/cc.mjs — CC (Anthropic / Claude Code) adapter (RFC 3.1).
// One captured unified-envelope record -> 3.2 canonical rows (session / call /
// blocks / resources). Provider-native field names are consumed HERE and never
// surface downstream (invariant 3).
//
// IMPORTS the already-built primitives — this file does NOT reimplement them:
//   • content-hash.mjs  → contentHash / scanJson / hashSpan / spanOf  (D19 byte-exact hashing)
//   • session-identity.mjs (3.4) → nativeId / classOf / controlKindFor / controlKind /
//                                  lane / entrypoint / parseSessionCC  (session/lane/control logic)
//   • model/schema.mjs (3.2) → mapUsage('cc', rawUsage)  (canonical usage mapping)
import { contentHash, scanJson, hashSpan, spanOf } from './content-hash.mjs';
import { collectExtra } from './contract.mjs';
import { mapUsage } from '../model/schema.mjs';
import {
  parseSessionCC,
  lane,
  classOf,
  controlKindFor,
  controlKind,
} from '../identity/session-identity.mjs';
// D25: the CC block model (assembly-order walk, volatile rule, resource linking, kind, faithfulness,
// bash-read parsing) lives in ONE dissector, shared with the board (analyze.linearContext). parseBlocks
// below is the ETL PROJECTION of that dissector's spine — adds the D19 verbatim byte spans + text_ref.
import { dissectBlocks, resourceRef, blockKind, faithfulness, parseBashReads, serverEdited } from '../dissect/cc.mjs';
import { contextStateOfRequest } from '../dissect/capture-labels.mjs';
export { parseBashReads }; // re-exported for back-compat (was defined here before the D25 extraction)

// ── req_body access ────────────────────────────────────────────────────────────
// D10: req_body is the VERBATIM captured request bytes (a string). parseBlocks hashes
// the raw string's byte spans (D19). The 3.4 identity layer, by contrast, expects
// req_body PARSED — so `withParsedBody` normalizes a record for those pure functions.
export function reqSource(record) {
  const b = record?.req_body;
  if (typeof b === 'string') return b;
  if (b == null) return '{}';
  // Fallback only (real D10 envelopes carry a string): if an already-parsed object
  // slips in, serialize it so spans still work — a documented degradation, NOT the norm.
  try {
    return JSON.stringify(b);
  } catch {
    return '{}';
  }
}
export function reqObj(record) {
  const b = record?.req_body;
  if (b && typeof b === 'object') return b;
  if (typeof b === 'string') {
    try {
      return JSON.parse(b);
    } catch {
      return {};
    }
  }
  return {};
}
function withParsedBody(record) {
  return { ...record, req_body: reqObj(record) };
}

function systemText(req) {
  const s = req?.system;
  if (typeof s === 'string') return s;
  if (Array.isArray(s)) {
    return s.map((b) => (b && typeof b === 'object' ? b.text || '' : String(b || ''))).join('\n');
  }
  return '';
}

// ── detect (RFC 3.1 / 3.4 online-stable signals) ────────────────────────────────
// The session header is the strongest signal; the claude UA covers control-plane
// calls (no session header, not /v1/messages) so they still get claimed & classified;
// system-prompt markers catch header-less CC records.
export function detect(record) {
  const h = record?.req_headers || {};
  if (h['x-claude-code-session-id'] || h['X-Claude-Code-Session-Id']) return true;
  const ua = String(h['user-agent'] || h['User-Agent'] || '');
  if (/claude-cli|claude-code|claude-desktop/i.test(ua)) return true;
  return /cc_is_subagent=|cc_entrypoint=|you are a security monitor|You are Claude Code/i.test(
    systemText(reqObj(record)),
  );
}

// ── usage (承 demo normResp; mapping delegated to 3.2 schema.mapUsage) ──────────
// ccUsage unifies the two response shapes into the raw Anthropic usage object: SSE
// capture reconstructs the terminal usage into resp.usage; non-streaming JSON keeps
// it in resp.body.usage. The canonical mapping itself lives in schema.mjs (imported).
export function ccUsage(resp = {}) {
  if (resp.kind === 'json' && resp.body && typeof resp.body === 'object') return resp.body.usage || {};
  return resp.usage || {};
}

// ccLane = 3.4 identity lane (per-CALL), delegating to the imported classifier. It is
// wrapped only to parse req_body first (identity.lane expects a parsed body).
export const ccLane = (record) => lane(withParsedBody(record));

// ccControlKind = 3.4 identity endpoint→control_kind classifier (re-exported so 3.3/4.2
// can import it from the adapter). NOT reimplemented here (avoids the plan's regex drift).
export { controlKind as ccControlKind };

// ── parseCall (class / control_kind / lane / usage / error / unmapped_count) ─────
// Every D10 envelope field this adapter recognizes. collectExtra diffs the record's
// actual keys against this set; the remainder -> calls.extra + unmapped_count (RFC 3.1
// unmapped invariant, D7 auto-evolution signal). B-env fix: this MUST include ALL D10
// observ-meta (ts_response_start/end, capture, auth_mode, …) or a real full envelope
// would falsely inflate unmapped_count on every call.
const ENVELOPE_CONSUMED = new Set([
  // core (4.1 § 统一原始信封)
  'ts', 'endpoint', 'method', 'req_headers', 'req_body', 'resp',
  // observ-meta (D10)
  'id', 'ts_request', 'ts_response_start', 'ts_response_end', 'duration_ms',
  'is_llm_call', 'capture', 'auth_mode',
  // interruption marker (D10: 中断也写 error:true 信封)
  'error',
  // transparent-capture fields appended after req_body (RFC 4.6 §记录 / D32): the process-collector
  // envelope carries these, so list them here or they would inflate unmapped_count on every call.
  'host', 'scheme', 'dst', 'proc', 'flow_id', 'seq', 'req_head_raw', 'resp_head_raw',
  // intervention fields reserved by RFC 5.1 (D33, implemented later) — consumed now so a transparent
  // envelope never surfaces them as unmapped.
  'origin', 'client_req_body', 'client_resp', 'intervention', 'resend_of',
  // NOT listed on purpose: req_truncated / req_body_bytes / req_partial (RFC 4.6 §记录). calls has no
  // column for them, so consuming them here would drop the invariant-4 label from the DuckDB row;
  // left unmapped, they land in calls.extra (and count, on the rare incomplete call).
]);

// req_body keys this adapter maps to canonical columns / blocks / identity. The remainder (real
// provider request fields — max_tokens / temperature / top_p / top_k / tool_choice / thinking /
// stop_sequences …) are UNMAPPED and MUST surface in calls.extra.req_body + unmapped_count (RFC
// 3.1:44 — canonical ∪ extra == all keys, per layer; D7 auto-evolution signal). The envelope-level
// collectExtra treats req_body as consumed-whole, so without this pass those fields silently vanish.
const REQ_BODY_CONSUMED = new Set([
  'model', 'stream', 'system', 'tools', 'messages', 'metadata',
  // demo-capture derived summaries (not provider wire fields; consumed so they don't inflate count)
  'system_chars', 'tool_count', 'message_count', 'context_chars',
]);

function stopReasonOf(resp = {}) {
  if (resp.kind === 'json' && resp.body && typeof resp.body === 'object') return resp.body.stop_reason ?? null;
  return resp.stop_reason ?? null;
}

export function parseCall(record) {
  const norm = withParsedBody(record); // identity layer wants a parsed body
  const req = norm.req_body;
  const resp = record?.resp || {};
  const cls = classOf(norm); // 'llm' | 'control' (3.4)
  const isLlm = cls === 'llm';
  const env = collectExtra(record, ENVELOPE_CONSUMED);
  // ALSO diff req_body's inner keys — unmapped provider request fields flatten in with a `req_body.`
  // prefix (keeps the contract invariant unmapped_count == |extra keys|, and gives the D7
  // unmapped_fields view a precise path like `req_body.max_tokens` rather than an opaque `req_body`).
  const body = req && typeof req === 'object' ? collectExtra(req, REQ_BODY_CONSUMED) : { extra: {}, unmapped_count: 0 };
  const extra = { ...env.extra };
  for (const [k, v] of Object.entries(body.extra)) extra['req_body.' + k] = v;
  const unmapped_count = env.unmapped_count + body.unmapped_count;
  return {
    class: cls,
    control_kind: controlKindFor(norm), // NULL for llm; config|account|registry|telemetry|other for control
    lane: lane(norm), // per-CALL (B-lane): main|subagent|monitor|aux|probe
    endpoint: record?.endpoint || '',
    model: req.model || null,
    stream: req.stream === true,
    usage: isLlm ? mapUsage('cc', ccUsage(resp)) : mapUsage('cc', {}),
    stop_reason: isLlm ? stopReasonOf(resp) : null,
    duration_ms: record?.duration_ms ?? null,
    error: !!record?.error || resp.kind === 'error' || (resp.status || 0) >= 500,
    unmapped_count,
    extra,
    // D37 (3.2:49/52): this adapter speaks the Anthropic Messages wire. Only an inference call has a
    // context to judge; control / probe rows leave both NULL. An incomplete stored request is 'partial'
    // (gate G17, contextStateOfRequest); its req_* labels stay in calls.extra, unconsumed, saying why.
    wire_format: record?.is_llm_call === true ? 'anthropic' : null,
    context_state: record?.is_llm_call === true ? (contextStateOfRequest(record) ?? (serverEdited(record) ? 'server_edited' : 'complete')) : null,
    // compaction/compaction_from/to are a cross-call (message_count-drop) inference decided
    // by ETL/3.4 (markCompaction), NOT a single-record parse — left unset here on purpose.
  };
}

// ── parseBlocks — the D19 + AC-1 crux ───────────────────────────────────────────
// Do BOTH:
//   (a) JSON.parse(req_body) for STRUCTURE (section/role/kind, assembly order), AND
//   (b) scanJson(req_body) for the VERBATIM BYTE SPAN of the SAME element.
// content_hash = hashSpan(src, node) (sha-256 over the raw wire bytes, D19 — NEVER over
// JSON.stringify(parsedBlock), which would normalize whitespace/key-order/number/unicode
// and mask cache-breaks). text = src.slice(...span) (verbatim), text_ref = span (回源 locator).
const MSG_BLOCK_CONSUMED = [
  'type', 'text', 'thinking', 'signature', 'data', 'name', 'input', 'id',
  'content', 'tool_use_id', 'is_error', 'source', 'cache_control',
];

// faithfulness (invariant 4 · opaque signature-only reasoning), block kind, and resource linking now
// come from the shared CC dissector (src/dissect/cc.mjs, imported above) — one source for board + ETL.

// One 3.2 block_contents + call_blocks row. content_hash / text / text_ref ALL derive
// from the verbatim byte span (node); everything else from the parsed structure.
function mkBlock({ section, role, parsed, node, src, seq, volatile = false, resource_ref = null, extra = {} }) {
  const span = node ? spanOf(node) : null;
  const text = span
    ? src.slice(span[0], span[1])
    : typeof parsed === 'string'
      ? parsed
      : JSON.stringify(parsed); // fallback only when no span could be located (malformed src)
  const content_hash = node ? hashSpan(src, node) : contentHash(text);
  return {
    section,
    role,
    kind: blockKind(parsed),
    content_hash, // D19: sha-256 over the VERBATIM wire span, not a re-serialization
    text, // verbatim byte slice of req_body
    text_ref: span, // [start,end) byte span into req_body — the AC-1 回源 locator
    chars: text.length,
    preview: text.slice(0, 200),
    faithfulness: faithfulness(parsed),
    cache_control: (parsed && typeof parsed === 'object' && parsed.cache_control) || null,
    volatile: !!volatile,
    resource_ref,
    extra,
    seq,
  };
}

export function parseBlocks(record) {
  const src = reqSource(record); // verbatim string (source of truth)
  let req;
  try {
    req = JSON.parse(src); // (a) structure — walked by the shared dissector
  } catch {
    req = {};
  }
  let root = null;
  try {
    root = scanJson(src); // (b) byte spans — the ETL-only overlay (the board needs no spans)
  } catch {
    root = null;
  }
  const props = root && root.kind === 'object' ? root.props : new Map();
  const toolsNode = props.get('tools');
  const sysNode = props.get('system');
  const msgsNode = props.get('messages');

  // Resolve the VERBATIM byte node for a dissector spine entry — scanJson indexed the SAME positions
  // the dissector walked (tools[i] / system[i] / messages[mi].content[bi]), so text_ref + the D19
  // content_hash stay byte-exact against req_body.
  const nodeFor = (e) => {
    if (e.section === 'tools') return toolsNode && toolsNode.kind === 'array' ? toolsNode.items[e.path.i] : null;
    if (e.section === 'system') {
      if (e.path.str) return sysNode; // system is a bare string → its own value node
      return sysNode && sysNode.kind === 'array' ? sysNode.items[e.path.i] : null;
    }
    const mNode = msgsNode && msgsNode.kind === 'array' ? msgsNode.items[e.path.mi] : null;
    const contentNode = mNode && mNode.kind === 'object' ? mNode.props.get('content') : null;
    if (e.path.arrayContent) return contentNode && contentNode.kind === 'array' ? contentNode.items[e.path.bi] : null;
    return contentNode && contentNode.kind === 'string' ? contentNode : null; // string content → the content string node
  };

  const out = [];
  for (const e of dissectBlocks(req)) {
    let extra = {};
    let resource_ref = null;
    // resource_ref + extra are ETL fidelity fields carried ONLY for array-content message blocks
    // (matches the pre-D25 parser exactly — tools/system/string-content messages stay null/{}).
    if (e.section === 'messages' && e.path.arrayContent) {
      const b = e.parsed;
      if (b && typeof b === 'object') ({ extra } = collectExtra(b, MSG_BLOCK_CONSUMED));
      resource_ref = e.resourceRef || null;
    }
    out.push(mkBlock({ section: e.section, role: e.role, parsed: e.parsed, node: nodeFor(e), src, seq: e.seq, volatile: e.volatile, resource_ref, extra }));
  }
  return out;
}

// SPANS ONLY — the same walk as parseBlocks, stopping before the expensive part.
//
// The board needs each block's byte span so it can mint a text_ref and ship a LOCATOR instead of the
// body (RFC 4.2:55 「看全文=回源」). It does NOT need what mkBlock does next: slicing the verbatim
// text out of req_body and sha-256'ing it. Calling parseBlocks for spans would materialise every
// block's text — the exact allocation the locator exists to avoid — so this returns the spans and
// nothing else. Same spine, same nodeFor, so span[i] belongs to the same block as
// linearContext()[i]; test/dissect/cc.test.mjs pins that the two projections stay block-for-block
// aligned, which is what makes indexing by position sound.
//
// A null entry is a block whose bytes could not be located (malformed source). It stays null rather
// than being filled with a guess: the row then says its body is unresolvable instead of showing
// someone else's bytes (invariant 2/4).
export function blockSpans(record) {
  const src = reqSource(record);
  let req;
  try { req = JSON.parse(src) } catch { req = {} }
  let root = null;
  try { root = scanJson(src) } catch { root = null }
  const props = root && root.kind === 'object' ? root.props : new Map();
  const toolsNode = props.get('tools');
  const sysNode = props.get('system');
  const msgsNode = props.get('messages');
  const nodeFor = (e) => {
    if (e.section === 'tools') return toolsNode && toolsNode.kind === 'array' ? toolsNode.items[e.path.i] : null;
    if (e.section === 'system') {
      if (e.path.str) return sysNode;
      return sysNode && sysNode.kind === 'array' ? sysNode.items[e.path.i] : null;
    }
    const mNode = msgsNode && msgsNode.kind === 'array' ? msgsNode.items[e.path.mi] : null;
    const contentNode = mNode && mNode.kind === 'object' ? mNode.props.get('content') : null;
    if (e.path.arrayContent) return contentNode && contentNode.kind === 'array' ? contentNode.items[e.path.bi] : null;
    return contentNode && contentNode.kind === 'string' ? contentNode : null;
  };
  return dissectBlocks(req).map((e) => { const n = nodeFor(e); return n ? spanOf(n) : null });
}

// ── parseSession — delegates to 3.4 identity.parseSessionCC, adds the cwd column ──
// parseSessionCC gives {native_id, native_id_confidence, parent(null; ETL resolves),
// fork_of, forked_at, lane, entrypoint, title, extra}. The 3.1 shape also carries cwd,
// which is a request-body derivation (not part of the 3.4 identity contract) — added here.
function cwdOf(req) {
  const parts = Array.isArray(req.system)
    ? req.system.map((b) => (b && b.text) || '')
    : typeof req.system === 'string'
      ? [req.system]
      : [];
  for (const m of req.messages || []) {
    const c = m.content;
    if (typeof c === 'string') parts.push(c);
    else if (Array.isArray(c)) for (const b of c) if (b && b.type === 'text' && b.text) parts.push(b.text);
    if (parts.join('\n').length > 20000) break; // bound the scan
  }
  const mm = parts.join('\n').match(/working directory:\s*([^\n]+)/i);
  return mm ? mm[1].trim() : null;
}

export function parseSession(record) {
  const norm = withParsedBody(record);
  const base = parseSessionCC(norm); // 3.4 identity (imported, not reimplemented)
  return { ...base, cwd: cwdOf(norm.req_body) };
}

// ── parseResources — 3.2 resource_events (enter + names-only 'seen') ─────────────
// Ports the v0 prototype's PURE resource-extraction helpers VERBATIM (they
// take primitives — no rename needed); only the caller changes to reqObj(record), and
// the media branches emit the 3.2 enum kind 'image' (demo's 'capability' is not an enum value).
const FILE_OPS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const DIR_OPS = new Set(['Glob', 'Grep', 'LS']);
const SPAWN_OPS = new Set(['Agent', 'Task']);

export function toolArg(name, input = {}) {
  if (input.file_path || input.path || input.notebook_path)
    return String(input.file_path || input.path || input.notebook_path);
  if (name === 'Bash' && input.command) return String(input.command);
  if (name === 'Glob' && input.pattern) return String(input.pattern);
  if (name === 'Grep' && input.pattern) return String(input.pattern);
  if ((name === 'WebFetch' || name === 'WebSearch') && (input.url || input.query))
    return String(input.url || input.query);
  if (SPAWN_OPS.has(name)) return String(input.description || input.subagent_type || '');
  return '';
}

function rangeOf(name, input = {}) {
  if (name === 'Read') {
    const o = input.offset,
      l = input.limit;
    if (o && l) return `L${o}–${o + l}`;
    if (l) return `L1–${l}`;
    if (o) return `L${o}–end`;
    return 'full file';
  }
  if (name === 'Write') return 'written';
  if (name === 'Edit' || name === 'MultiEdit') return 'edited';
  if (name === 'NotebookEdit') return 'notebook edit';
  return null;
}

// parseBashReads (bash read-target parsing) now lives in the shared CC dissector (imported +
// re-exported above); extractResources below uses it to promote cat/head/… dumps into the ledger.

function extractResources(messages, step, out) {
  for (const m of messages) {
    const content = Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content }];
    for (const b of content) {
      if (b.type === 'tool_use') {
        const arg = toolArg(b.name, b.input);
        if (FILE_OPS.has(b.name) && arg) addRes(out, 'file', arg, step, b.name, rangeOf(b.name, b.input));
        else if (b.name === 'Bash' && b.input?.command) {
          for (const rd of parseBashReads(b.input.command)) addRes(out, 'file', rd.path, step, 'Bash', rd.range);
        } else if (DIR_OPS.has(b.name) && arg) addRes(out, 'dir', arg, step, b.name);
        else if ((b.name === 'WebFetch' || b.name === 'WebSearch') && arg) addRes(out, 'link', arg, step, b.name);
        else if (b.name === 'Skill')
          addRes(out, 'skill', String(b.input?.skill || b.input?.command || '?').split(':').pop().split('/').pop(), step, 'Skill');
      } else if (b.type === 'image') {
        // 3.2 kind enum has no 'capability' — a media attachment enters as kind 'image'.
        addRes(out, 'image', 'image (' + (b.source?.media_type || '?') + ')', step, 'image');
      } else if (b.type === 'document') {
        // no 'document' enum value in 3.2 (CC-first: documents are absent); unify under the
        // 'image' media-capability kind, preserving the doc detail in the label.
        addRes(out, 'image', 'document (' + (b.source?.media_type || b.title || '?') + ')', step, 'document');
      } else if (b.type === 'text' && typeof b.text === 'string') {
        const sk = b.text.match(/^Base directory for this skill: (\S+)/);
        if (sk) addRes(out, 'skill', sk[1].split('/').pop(), step, 'skill', `${b.text.length} chars (verbatim body)`);
        if (/<system-reminder>/.test(b.text)) {
          if (/CLAUDE\.md/i.test(b.text)) addRes(out, 'scaffold', 'CLAUDE.md', step, 'auto-load');
          if (/\bMEMORY\.md\b|auto-memory|persists across conversations/i.test(b.text))
            addRes(out, 'scaffold', 'memory (MEMORY.md)', step, 'auto-load');
        }
        const urls = b.text.match(/https?:\/\/[^\s"'`<>)\]]+/g);
        if (urls)
          for (const raw of urls.slice(0, 3)) {
            const u = raw.replace(/[*_~.,;:!?)\]}>'"]+$/, '');
            if (/^https?:\/\/[^/]+\.[^/]/.test(u) || /^https?:\/\/[^/]+:\d/.test(u)) addRes(out, 'link', u, step, 'mention');
          }
      }
    }
  }
}
function addRes(map, kind, label, step, via, range) {
  const key = kind + '::' + label;
  let r = map.get(key);
  if (!r) {
    r = { kind, label, via, segments: [{ enter: step, evict: null }], loads: [], hits: 1 };
    map.set(key, r);
  } else {
    r.hits++;
    const last = r.segments[r.segments.length - 1];
    if (last.evict != null && step >= last.evict) r.segments.push({ enter: step, evict: null });
  }
  if (range) r.loads.push({ step, range, via });
}

const KNOWN_EXT =
  'mjs|js|ts|tsx|jsx|cjs|json|jsonl|ndjson|html|htm|css|scss|less|py|sh|bash|zsh|fish|md|mdx|rst|yaml|yml|toml|txt|rs|go|c|h|hpp|cpp|cc|java|kt|swift|rb|php|sql|xml|svg|lock|cfg|conf|ini|env|plist|log|csv|tsv|tif|png|jpg|jpeg|gif|webp|pdf|ipynb|proto|gradle|properties|map|patch|diff|sock';
const KNOWN_EXT_SET = new Set(KNOWN_EXT.split('|'));
const KNOWN_FILE = new Set([
  'Makefile', 'GNUmakefile', 'Dockerfile', 'Containerfile', 'LICENSE', 'COPYING', 'README', 'CHANGELOG',
  'Procfile', 'Rakefile', 'Gemfile', 'Vagrantfile', 'Jenkinsfile', '.gitignore', '.dockerignore',
  '.editorconfig', '.npmrc', '.env',
]);
// SEGMENT/DEPTH BOUNDS ARE LOAD-BEARING, not tidiness. With plain `+` quantifiers this pattern
// backtracks quadratically over any long run of word characters — a minified bundle, a base64 blob, a
// lockfile dump in a tool_result. Profiling one render: 25.4 of 25.5 seconds inside this regex, and the
// board is single-threaded, so one such block hangs every session's poll, not just its own. `{1,64}`
// per segment and `{1,16}` segments deep cap the backtracking to a constant per start offset, making
// the scan linear in the text. The cost is that a path segment longer than 64 chars, or nested deeper
// than 16, is not recognised as "seen" — both are far outside real repo paths, and this lane is a
// convenience index, never a fidelity claim.
const PATH_RE = new RegExp(
  '(?:[\\w.@\\-]{1,64}/){1,16}[\\w.@\\-]{1,64}\\.\\w{1,8}|\\b[\\w.@\\-]{1,64}\\.(?:' +
    KNOWN_EXT +
    ')\\b|\\b(?:Makefile|GNUmakefile|Dockerfile|Containerfile|Procfile|Rakefile|Gemfile|Vagrantfile|Jenkinsfile)\\b|(?:^|[\\s"\'(])(\\.(?:gitignore|dockerignore|editorconfig|npmrc|env))\\b',
  'gi',
);
const CODE_STEM =
  /^(process|console|import|module|exports|window|document|globalThis|self|Math|JSON|Object|Array|res|req|err|ctx|response|resp|reply|result|body|payload|data|obj|item|row|self)$/i;
const TECH_STEM =
  /^(node|vue|next|nuxt|react|angular|svelte|d3|three|express|jquery|ember|backbone|preact|solid|remix|astro|webpack|rollup|vite)$/i;
function acceptPath(p) {
  const base = p.split('/').pop();
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return KNOWN_FILE.has(base);
  const stem = base.slice(0, dot),
    ext = base.slice(dot + 1).toLowerCase();
  if (!KNOWN_EXT_SET.has(ext)) return false;
  if (!p.includes('/')) {
    if (stem.length <= 2) return false;
    if (CODE_STEM.test(stem)) return false;
    if (TECH_STEM.test(stem)) return false;
    if (ext === 'log' || ext === 'env') return false;
  }
  return true;
}
function extractSeenPaths(text, step, seen, cap) {
  if (!text || typeof text !== 'string') return;
  text = text.replace(/https?:\/\/[^\s"'`<>)\]]+/g, ' '); // drop URLs so remote asset paths aren't "seen files"
  PATH_RE.lastIndex = 0;
  let m,
    n = 0;
  while ((m = PATH_RE.exec(text)) && n < cap) {
    const raw = m[1] || m[0];
    const end = m.index + m[0].length;
    if (text[end] === '(') continue; // response.json() etc. — a method call, not a file
    const p = raw.replace(/^[\s"'(]+/, '').replace(/[.,;:!?)\]}>'"`]+$/, '');
    if (p.length < 3 || p.endsWith('/') || !acceptPath(p)) continue;
    const ex = seen.get(p);
    if (ex) ex.count++;
    else {
      seen.set(p, { path: p, firstStep: step, count: 1 });
      n++;
    }
  }
}
function textOfResult(b) {
  const c = b.content;
  return typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => x.text || '').join('\n') : '';
}

export function parseResources(record) {
  const req = reqObj(record);
  const resMap = new Map();
  const seenMap = new Map();
  extractResources(req.messages || [], 0, resMap);
  for (const t of req.tools || []) {
    if (/^mcp__/.test(t.name || '')) addRes(resMap, 'mcp', 'MCP: ' + (String(t.name).split('__')[1] || t.name), 0, 'mcp');
  }
  for (const m of req.messages || []) {
    const content = Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content }];
    for (const b of content) {
      if (b.type === 'tool_result') extractSeenPaths(textOfResult(b), 0, seenMap, 80);
      else if (b.type === 'text') extractSeenPaths(b.text, 0, seenMap, 40);
    }
  }
  const opened = new Set([...resMap.values()].filter((r) => r.kind === 'file').map((r) => r.label));
  const sameFile = (a, b) => a === b || a.endsWith('/' + b) || b.endsWith('/' + a);
  const out = [];
  let seq = 0;
  for (const r of resMap.values())
    out.push({
      seq: seq++,
      resource_id: r.kind + '::' + r.label,
      kind: r.kind,
      label: r.label,
      event: 'enter',
      via: r.via,
      range: r.loads?.[0]?.range || null,
      extra: {},
    });
  for (const sf of seenMap.values()) {
    if ([...opened].some((o) => sameFile(o, sf.path))) continue;
    out.push({
      seq: seq++,
      resource_id: 'file::' + sf.path,
      kind: 'file',
      label: sf.path,
      event: 'seen', // names-only (metadata faithfulness) — RFC 3.1 / D8
      via: 'mention',
      range: null,
      extra: {},
    });
  }
  return out;
}

// ── the registered adapter object (RFC 3.1 interface) ────────────────────────────
// priority high so CC wins over a future auto-detect adapter (RFC 3.1 auto-adapt reserved).
export const ccAdapter = {
  name: 'cc-anthropic',
  priority: 100,
  detect,
  parseSession,
  parseCall,
  parseBlocks,
  parseResources,
};
