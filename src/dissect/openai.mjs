// src/dissect/openai.mjs — the OpenAI / Codex dissector (D25 · Phase 4). Same shape as the CC
// dissector (src/dissect/cc.mjs): declare block CATEGORIES + LAYOUT, WALK a raw OpenAI *Responses*
// request into canonical blocks, and map the provider's shapes into the ONE cross-provider block
// vocabulary the board already speaks (Anthropic-shaped: text / tool_use / tool_result / thinking +
// the tools/system sections). "唯有 block 是统一的" — so the board renders Codex with ZERO board
// changes; all OpenAI-specifics (Responses request layout, SSE event stream, usage names, session
// identity) live HERE (invariant 3). Built against a real captured /codex/responses envelope.
//
// Wire facts (captured 2026-07-16, codex_exec + gpt-5.5 via bestony):
//   request  = { model, instructions(system STRING), input[](conversation), tools[](fn defs + built-ins),
//                reasoning:{effort}, prompt_cache_key(=session id), include:['reasoning.encrypted_content'] }
//   input[] item kinds: {type:'message',role,content:[{type:'input_text'|'output_text',text}]} ·
//     {type:'function_call',name,arguments(str),call_id} · {type:'function_call_output',call_id,output} ·
//     {type:'reasoning',summary[],encrypted_content}  (encrypted → opaque, no plaintext on the wire)
//   response = SSE; usage lives in the response.completed event: {input_tokens, input_tokens_details:
//     {cached_tokens, cache_write_tokens}, output_tokens, output_tokens_details:{reasoning_tokens}}

// ── declarative block categories + layout (parallels CC: tools → system → messages) ─────────
export const OPENAI_SECTIONS = [
  { id: 'tools', order: 1, category: 'tool-schema', role: 'tool' },
  { id: 'system', order: 2, category: 'system-prompt', role: 'system' }, // OpenAI `instructions`
  { id: 'messages', order: 3, category: 'conversation' },                // OpenAI `input[]`
];

// ── detection ───────────────────────────────────────────────────────────────────────────────
const headersOf = (rec) => (rec && (rec.request_headers || rec.req_headers)) || {};
export function detect(rec) {
  const h = headersOf(rec);
  const ua = String(h['user-agent'] || h['originator'] || '').toLowerCase();
  if (/codex|openai/.test(ua)) return true;
  const ep = String(rec && rec.endpoint || '');
  return /(^|\/)responses$/.test(ep.split('?')[0]);
}

// ── small self-contained content hasher (a stable per-block key for prefix-diffing / cacheBreak;
// scheme is OpenAI-local — cacheBreak only ever compares blocks within one OpenAI session) ─────
function blockText(b) {
  if (b == null) return '';
  if (typeof b === 'string') return b;
  if (b.type === 'text') return b.text || '';
  if (b.type === 'thinking') return b.thinking || b.signature || '';
  if (b.type === 'tool_use') return (b.name || '') + '::' + JSON.stringify(b.input || {});
  if (b.type === 'tool_result') return (b.tool_use_id || '') + '::' + (typeof b.content === 'string' ? b.content : JSON.stringify(b.content));
  if (b.type === 'image') return 'image:' + (b.source && (b.source.media_type || b.source.type) || '');
  return JSON.stringify(b);
}
function hash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); }
const okey = (prefix, b) => prefix + hash(blockText(b).slice(0, 4096));
const safeJson = (s) => { if (typeof s !== 'string') return s || {}; try { return JSON.parse(s); } catch { return { _unparsed: s }; } };

// ── shared classifiers ────────────────────────────────────────────────────────────────────────
// faithfulness (invariant 4): Codex reasoning is replayed as ENCRYPTED content (no plaintext) → opaque.
export function faithfulness(block) {
  if (!block || typeof block !== 'object') return 'verbatim';
  if (block.type === 'thinking' && !(block.thinking && String(block.thinking).length)) return 'opaque'; // encrypted reasoning
  return 'verbatim';
}
// resource linking: a function_call whose args name a file → file::path (mirrors CC resourceRef labels).
export function resourceRef(block) {
  if (!block || typeof block !== 'object') return '';
  if (block.type !== 'tool_use') return '';
  const inp = block.input || {};
  const p = inp.file_path || inp.path || inp.notebook_path || inp.filename;
  if (p) return 'file::' + p;
  if ((block.name || '').startsWith('mcp')) return 'mcp::' + (String(block.name).split(/[._]/)[1] || block.name);
  return '';
}
// a short label for the (single) Codex instructions block.
export function sysLabel(text) {
  const t = text || '';
  if (/^You are Codex/.test(t)) return 'Codex instructions';
  if (/<skills_instructions>|<plugins_instructions>/.test(t)) return 'developer instructions';
  return 'instructions';
}

// ── input[] item → canonical (Anthropic-shaped) blocks ─────────────────────────────────────────
function summaryText(item) {
  const s = item.summary;
  if (Array.isArray(s)) return s.map((x) => (x && (x.text || x.summary_text)) || '').join('');
  return typeof s === 'string' ? s : '';
}
// returns [{ role, block }] — one per rendered block (a message may fan out to several content blocks)
export function itemToBlocks(item) {
  if (!item || typeof item !== 'object') return [{ role: 'user', block: { type: 'text', text: String(item ?? '') } }];
  const t = item.type;
  if (t === 'message' || item.content) {
    const role = item.role || 'user';
    const content = Array.isArray(item.content) ? item.content : [{ type: 'input_text', text: String(item.content ?? '') }];
    return content.map((c) => {
      if (!c || typeof c !== 'object') return { role, block: { type: 'text', text: String(c ?? '') } };
      if (c.type === 'input_text' || c.type === 'output_text' || c.type === 'text') return { role, block: { type: 'text', text: c.text || '' } };
      if (c.type === 'input_image' || c.type === 'image') return { role, block: { type: 'image', source: { media_type: c.image_url || c.detail || 'image' } } };
      if (c.type === 'refusal') return { role, block: { type: 'text', text: c.refusal || '' } };
      return { role, block: { type: 'text', text: JSON.stringify(c) } };
    });
  }
  if (t === 'function_call') return [{ role: 'assistant', block: { type: 'tool_use', name: item.name || '', id: item.call_id || item.id || '', input: safeJson(item.arguments) } }];
  if (t === 'function_call_output') {
    const out = item.output;
    const content = typeof out === 'string' ? out : (out && out.content) || JSON.stringify(out ?? '');
    return [{ role: 'tool', block: { type: 'tool_result', tool_use_id: item.call_id || '', content } }];
  }
  if (t === 'reasoning') return [{ role: 'assistant', block: { type: 'thinking', thinking: summaryText(item), signature: item.encrypted_content ? 'encrypted' : '' } }];
  // fallback (item_reference / unknown): render verbatim JSON, marked non-standard.
  return [{ role: (item.role || 'assistant'), block: { type: 'text', text: JSON.stringify(item) } }];
}

// ── board projection: raw Responses request → flat block descriptors (same vocab as CC linearContext).
// Downstream board code (context window, callComp, flatBlockText, cacheBreak) reads sec/kind/role/name/
// desc/schema/text/block — identical to CC — so Codex renders with ZERO board changes.
export function boardFlat(req) {
  const flat = [];
  const tools = Array.isArray(req && req.tools) ? req.tools : [];
  tools.forEach((t, i) => {
    const name = t.name || t.type || ('tool_' + i);         // built-in tools (tool_search/web_search) have no name
    const schema = t.parameters !== undefined ? t.parameters : t;
    const desc = typeof t.description === 'string' ? t.description : '';
    const props = schema && schema.properties ? Object.keys(schema.properties) : [];
    const mcp = /^mcp/.test(name);
    flat.push({
      sec: 'tools', kind: 'tool', role: 'tool', name, ttype: t.type || 'function',
      props, descChars: desc.length, cc: null, mcp, verbatim: true,
      desc, schema, resKey: mcp ? 'mcp::' + (name.split(/[._]/)[1] || name) : '',
      key: 'T:' + name + ':' + desc.length + ':' + props.length,
    });
  });
  const instr = typeof (req && req.instructions) === 'string' ? req.instructions : (req && req.instructions != null ? JSON.stringify(req.instructions) : '');
  if (instr) flat.push({ sec: 'system', kind: 'system', role: 'system', si: 0, label: sysLabel(instr), text: instr, chars: instr.length, volatile: false, cc: null, key: okey('S:', { type: 'text', text: instr }) });
  const input = Array.isArray(req && req.input) ? req.input : [];
  let mi = 0;
  for (const item of input) {
    let bi = 0;
    for (const { role, block } of itemToBlocks(item)) {
      const type = block.type;
      const d = { sec: 'messages', kind: type, role, mi, bi, block, toolName: type === 'tool_use' ? (block.name || '') : '', cc: null, resKey: resourceRef(block), key: okey('M:' + role + ':' + type + ':', block) };
      if (type === 'thinking') d.faithfulness = faithfulness(block);
      flat.push(d);
      bi++;
    }
    mi++;
  }
  return flat;
}

// ── usage: OpenAI Responses usage → the board's NEUTRAL canonical {read, create, fresh, out} ─────
// OpenAI input_tokens is TOTAL input (incl cached); cached_tokens is the portion served from cache.
export function canonUsage(usage = {}) {
  const u = usage || {};
  const d = u.input_tokens_details || {};
  const read = d.cached_tokens || 0;
  const create = d.cache_write_tokens || 0;
  const input = u.input_tokens || 0;
  return { read, create, fresh: Math.max(0, input - read), out: u.output_tokens || 0 };
}

// ── normalize the SSE response → { model, usage, text, tool_calls, stop_reason } from resp.raw_sse.
// The reverse-proxy's reconstruction is Anthropic-shaped (empty for OpenAI), so we read raw_sse (kept
// via `asight capture --raw-sse`). This is the OpenAI dissector rebuilding blocks from raw events.
export function normResp(rec) {
  const resp = (rec && rec.resp) || (rec && rec.response) || {};
  const events = Array.isArray(resp.raw_sse) ? resp.raw_sse : [];
  let completed = null;
  for (const e of events) if (e && (e.type === 'response.completed' || e.type === 'response.incomplete')) completed = e.response || completed;
  const usage = (completed && completed.usage) || {};
  const output = Array.isArray(completed && completed.output) ? completed.output : [];
  let text = '';
  const toolCalls = [];
  for (const o of output) {
    if (o.type === 'message' && Array.isArray(o.content)) for (const c of o.content) if (c && (c.type === 'output_text' || c.type === 'text')) text += c.text || '';
    if (o.type === 'function_call') toolCalls.push({ id: o.call_id, name: o.name, input: safeJson(o.arguments) });
  }
  // fallback: if no response.completed (interrupted), stitch text from output_text.delta events
  if (!completed) for (const e of events) if (e && e.type === 'response.output_text.delta') text += e.delta || '';
  return { model: (completed && completed.model) || null, id: (completed && completed.id) || null, stop_reason: (completed && completed.status) || null, usage, canonUsage: canonUsage(usage), text, thinking: undefined, tool_calls: toolCalls };
}

// context-size proxy for the timeline bar (real: total input tokens from usage).
export function ctxTokens(norm) { return (norm && norm.usage && norm.usage.input_tokens) || 0; }
