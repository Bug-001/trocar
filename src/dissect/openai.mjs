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
//     {type:'reasoning',summary[],content[](reasoning_text),encrypted_content}  (no text → opaque)
//   response = SSE; usage lives in the response.completed event: {input_tokens, input_tokens_details:
//     {cached_tokens, cache_write_tokens}, output_tokens, output_tokens_details:{reasoning_tokens}}

// ── declarative block categories + layout (parallels CC: tools → system → messages) ─────────
export const OPENAI_SECTIONS = [
  { id: 'tools', order: 1, category: 'tool-schema', role: 'tool' },
  { id: 'system', order: 2, category: 'system-prompt', role: 'system' }, // OpenAI `instructions`
  { id: 'messages', order: 3, category: 'conversation' },                // OpenAI `input[]`
];

import { parsedRequestBody } from './request-body.mjs';
import { endpointOf } from './endpoints.mjs';
import { streamParts } from './sse-spans.mjs';

// ── detection ───────────────────────────────────────────────────────────────────────────────
// D25 · detect on WIRE SHAPE, not the User-Agent. The old UA test (/codex|openai/) was unreliable in
// BOTH directions: OpenCode's real UA (`opencode/1.17.12 … ai-sdk/…`) contains no "openai" — only the
// endpoint fallback saved it — while any client with "openai" in its UA was claimed regardless of what
// it actually spoke. Shape is what the bytes ARE; the endpoint is corroboration.
//
// ⚠ Measured against the real captures, D25's recorded rule "input[] + instructions = Responses" is
// too strict as a CONJUNCTION:
//     codex-capture.ndjson     13/13 calls: input[] AND instructions
//     opencode-capture.ndjson  17/17 calls: input[] and NO instructions
// Requiring `instructions` would drop 100% of real OpenCode traffic. `input[]` alone is the
// discriminator (Anthropic has no top-level `input[]`); `instructions` is optional corroboration.
const headersOf = (rec) => (rec && (rec.request_headers || rec.req_headers)) || {};
// the wire the endpoint names by itself (the endpoint table, ./endpoints.mjs), or null
const pathWire = (rec) => { const row = endpointOf(rec && rec.endpoint); return (row && row.wire) || null; };
// the parsed request body, from either the D10 verbatim `req_body` string or a v0 `request` object — parsed once
// per record for every reader (src/dissect/request-body.mjs).
const bodyOf = (rec) => parsedRequestBody(rec);
// Hard guard, checked FIRST: Anthropic bodies also carry `messages[]`, so a naive "messages[] = Chat
// Completions" rule would let this dissector claim every Claude Code record. These markers are
// Anthropic-only and disjoint from OpenAI's chat wire.
function looksAnthropic(rec, body) {
  const h = headersOf(rec);
  if (h['anthropic-version'] || h['anthropic-beta']) return true;
  if (pathWire(rec) === 'anthropic') return true;
  if (!body || typeof body !== 'object') return false;
  if (body.system !== undefined) return true;                       // Anthropic: top-level system (OpenAI puts it in messages[])
  const tools = Array.isArray(body.tools) ? body.tools : [];
  if (tools.some((t) => t && t.input_schema !== undefined)) return true; // Anthropic tool schema key
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  if (msgs.some((m) => Array.isArray(m && m.content)
    && m.content.some((c) => c && (c.type === 'tool_use' || c.type === 'tool_result')))) return true;
  return false;
}
// Positive OpenAI-chat markers. The endpoint alone suffices; otherwise we need a shape signal that
// Anthropic cannot produce (system/tool/developer roles, tool_calls, or the `function` tool envelope).
function looksChat(rec, body) {
  if (!body || !Array.isArray(body.messages)) return false;
  if (pathWire(rec) === 'openai-chat') return true;
  const msgs = body.messages;
  if (msgs.some((m) => m && (m.role === 'system' || m.role === 'tool' || m.role === 'developer'))) return true;
  if (msgs.some((m) => m && (Array.isArray(m.tool_calls) || m.tool_call_id !== undefined))) return true;
  const tools = Array.isArray(body.tools) ? body.tools : [];
  if (tools.some((t) => t && t.function && typeof t.function === 'object')) return true;
  if (body.max_completion_tokens !== undefined || body.frequency_penalty !== undefined
    || body.presence_penalty !== undefined || body.logit_bias !== undefined) return true;
  return false;
}
// → 'responses' | 'chat' | null. null = this dissector does NOT claim the record (never a guess).
export function wireShape(rec) {
  if (!rec) return null;
  const body = bodyOf(rec);
  if (looksAnthropic(rec, body)) return null;                 // never claim Anthropic wire
  if (Array.isArray(body && body.input)) return 'responses';  // shape first
  if (pathWire(rec) === 'openai-responses') return 'responses'; // corroboration (also covers an unparseable body)
  // an unparseable body on the Chat path (e.g. a request the collector stored cut, #21): the path is all there
  // is, and the call must still be shown with its reason rather than as unrecognized traffic
  if (body == null && pathWire(rec) === 'openai-chat') return 'chat';
  if (looksChat(rec, body)) return 'chat';
  return null;
}
export function detect(rec) { return wireShape(rec) !== null; }

// ── small self-contained content hasher (a stable per-block key for prefix-diffing / cacheBreak;
// scheme is OpenAI-local — cacheBreak only ever compares blocks within one OpenAI session) ─────
function blockText(b) {
  if (b == null) return '';
  if (typeof b === 'string') return b;
  if (b.type === 'text') return b.text || '';
  if (b.type === 'thinking') return b.thinking || b.signature || '';
  if (b.type === 'tool_use') return (b.name || '') + '::' + JSON.stringify(b.input || {});
  if (b.type === 'tool_result') return (b.tool_use_id || '') + '::' + (typeof b.content === 'string' ? b.content : JSON.stringify(b.content));
  if (b.type === 'image') return 'image:' + (b.source && (b.source.url || b.source.data) || '');
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
const partsText = (s) => (Array.isArray(s) ? s.map((x) => (x && (x.text || x.summary_text)) || '').filter(Boolean).join('\n\n') : typeof s === 'string' ? s : '');
// a reasoning item's readable text: its summary, then its content (reasoning_text parts); '' when only ciphertext came
const reasoningText = (item) => [partsText(item.summary), partsText(item.content)].filter(Boolean).join('\n\n');
const TEXT_PARTS = new Set(['text', 'input_text', 'output_text']);
const IMAGE_PARTS = new Set(['image', 'image_url', 'input_image']);
// where an image's bytes are: a base64 data URL is its data, anything else stays the URL it is
function imageSource(url) {
  const comma = url.indexOf(',');
  const head = comma < 0 ? null : /^data:([^;,]*)(?:;[^;,]*)*;base64$/i.exec(url.slice(0, comma));
  return head ? { type: 'base64', media_type: head[1], data: url.slice(comma + 1) } : { type: 'url', url };
}
// one content part → its block, on either OpenAI wire and in a tool's result alike. A part of no known kind, or an image with no
// URL, is shown as the JSON it is, so nothing it carried is lost.
function partBlock(c) {
  if (!c || typeof c !== 'object') return { type: 'text', text: String(c ?? '') };
  if (TEXT_PARTS.has(c.type) || (c.type == null && c.text != null)) return { type: 'text', text: c.text || '' };
  if (c.type === 'refusal') return { type: 'text', text: c.refusal || '' };
  const url = IMAGE_PARTS.has(c.type) ? (c.image_url && c.image_url.url) || c.image_url : null;
  return typeof url === 'string' && url ? { type: 'image', source: imageSource(url) } : { type: 'text', text: JSON.stringify(c) };
}
// returns [{ role, block, sub }] — one per rendered block (a message may fan out to several content blocks, none without content).
// `sub` = the JSON path of the block's bytes WITHIN the item (the board's text_ref locator, 4.2:40).
export function itemToBlocks(item) {
  if (!item || typeof item !== 'object') return [{ role: 'user', block: { type: 'text', text: String(item ?? '') }, sub: [] }];
  const t = item.type;
  // a reasoning item is reasoning whatever keys it carries (a `content` key does not make it a message; RFC 3.1)
  if (t === 'reasoning') return [{ role: 'assistant', block: { type: 'thinking', thinking: reasoningText(item), signature: item.encrypted_content ? 'encrypted' : '' }, sub: [] }];
  if (t === 'message' || (item.content && !/_call(_output)?$/.test(t || ''))) {
    const role = item.role || 'user';
    const arr = Array.isArray(item.content);
    // no content (absent or null) is no block, as content: [] is: request and reply side alike (RFC 3.1)
    const content = arr ? item.content : item.content == null ? [] : [{ type: 'input_text', text: String(item.content) }];
    return content.map((c, ci) => ({ role, block: partBlock(c), sub: arr ? ['content', ci] : ['content'] }));
  }
  // tools, by the wire's own naming (no tool names): `*_call_output` is a call's result; `*_call` with a call_id is a call the
  // client runs, without one a call the server ran. Anything else is shown as the JSON it is, never as assistant text.
  const ty = typeof t === 'string' ? t : '';
  if (ty.endsWith('_call_output')) {
    const out = item.output;
    const content = typeof out === 'string' ? out : Array.isArray(out) ? out.map(partBlock) : (out && out.content) || JSON.stringify(out ?? '');
    return [{ role: 'tool', block: { type: 'tool_result', tool_use_id: item.call_id || '', content }, sub: [] }];
  }
  if (ty.endsWith('_call')) {
    const { type: _t, id: _i, status: _s, ...rest } = item;
    if (item.call_id == null) return [{ role: 'assistant', block: { type: 'server_tool_use', id: item.id || '', name: ty, input: rest }, sub: [] }];
    const input = item.arguments !== undefined ? safeJson(item.arguments) : item.input !== undefined ? item.input : rest;
    return [{ role: 'assistant', block: { type: 'tool_use', name: item.name ?? ty, id: item.call_id, input }, sub: [] }];
  }
  return [{ role: (item.role || 'assistant'), block: { type: 'json', value: item }, sub: [] }];
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
      key: 'T:' + name + ':' + desc.length + ':' + props.length, path: ['tools', i],
    });
  });
  const instr = typeof (req && req.instructions) === 'string' ? req.instructions : (req && req.instructions != null ? JSON.stringify(req.instructions) : '');
  if (instr) flat.push({ sec: 'system', kind: 'system', role: 'system', si: 0, label: sysLabel(instr), text: instr, chars: instr.length, volatile: false, cc: null, key: okey('S:', { type: 'text', text: instr }), path: ['instructions'] });
  if (typeof (req && req.input) === 'string') { // the Responses API accepts a bare string input: one user block
    const block = { type: 'text', text: req.input };
    flat.push({ sec: 'messages', kind: 'text', role: 'user', mi: 0, bi: 0, block, toolName: '', cc: null, resKey: '', key: okey('M:user:text:', block), path: ['input'] });
  }
  const input = Array.isArray(req && req.input) ? req.input : [];
  let mi = 0;
  for (const item of input) {
    let bi = 0;
    for (const { role, block, sub } of itemToBlocks(item)) {
      const type = block.type;
      const d = { sec: 'messages', kind: type, role, mi, bi, block, toolName: type === 'tool_use' || type === 'server_tool_use' ? (block.name || '') : '', cc: null, resKey: resourceRef(block), key: okey('M:' + role + ':' + type + ':', block), path: ['input', mi, ...sub] };
      if (type === 'thinking') d.faithfulness = faithfulness(block);
      flat.push(d);
      bi++;
    }
    mi++;
  }
  return flat;
}

// ── Chat Completions (the OTHER OpenAI wire: OpenAI proper, DeepSeek, any openai-compatible client) ──
// D25 warns that claiming a shape in detect() while the assembler drops it renders a BLANK board, so
// everything detect() can now claim MUST be dissectable here. Mapped into the SAME cross-provider
// block vocabulary as Responses/CC, so the board needs zero changes.
//   messages[] item kinds: {role:'system'|'developer', content} → system section ·
//     {role:'user'|'assistant', content: string | part[]} → text/image · {role:'assistant', tool_calls[]}
//     → tool_use · {role:'tool', tool_call_id, content} → tool_result
//   tools[]: {type:'function', function:{name, description, parameters}} (nested, unlike Responses)
const chatText = (content) => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (c && typeof c === 'object' ? (c.text || '') : String(c ?? ''))).join('');
  return content == null ? '' : JSON.stringify(content);
};
// one chat message → [{role, block, sub}] (a message may fan out: assistant text + several tool_calls).
// `sub` = the JSON path of the block's bytes within the message (the board's text_ref locator).
export function chatMessageToBlocks(m) {
  if (!m || typeof m !== 'object') return [{ role: 'user', block: { type: 'text', text: String(m ?? '') }, sub: [] }];
  const role = m.role || 'user';
  if (role === 'tool') return [{ role: 'tool', block: { type: 'tool_result', tool_use_id: m.tool_call_id || '', content: Array.isArray(m.content) ? m.content.map(partBlock) : chatText(m.content) }, sub: ['content'] }];
  const out = [];
  // DeepSeek / Kimi / GLM thinking models: an assistant turn's reasoning travels as `reasoning_content` (plain
  // text), echoed back on later requests. It came before that turn's reply, so its block goes first. (Its exact
  // round-trip rules are a lab check, 0.0 待数据决策 DS; the bytes are shown verbatim either way.)
  if (typeof m.reasoning_content === 'string' && m.reasoning_content) {
    out.push({ role: 'assistant', block: { type: 'thinking', thinking: m.reasoning_content }, sub: ['reasoning_content'] });
  }
  if (Array.isArray(m.content)) {
    m.content.forEach((c, ci) => out.push({ role, block: partBlock(c), sub: ['content', ci] }));
  } else if (typeof m.content === 'string' && m.content.length) {
    out.push({ role, block: { type: 'text', text: m.content }, sub: ['content'] });
  }
  if (typeof m.refusal === 'string' && m.refusal) out.push({ role, block: { type: 'text', text: m.refusal }, sub: ['refusal'] });
  (Array.isArray(m.tool_calls) ? m.tool_calls : []).forEach((tc, k) => {
    const f = (tc && tc.function) || {};
    out.push({ role: 'assistant', block: { type: 'tool_use', name: f.name || '', id: (tc && tc.id) || '', input: safeJson(f.arguments) }, sub: ['tool_calls', k] });
  });
  // a genuinely empty message (e.g. {role:'assistant', content:null} with no tool_calls) still gets a
  // block, so the block count never silently under-reports what was on the wire.
  if (!out.length) out.push({ role, block: { type: 'text', text: '' }, sub: [] });
  return out;
}
export function boardFlatChat(req) {
  const flat = [];
  const tools = Array.isArray(req && req.tools) ? req.tools : [];
  tools.forEach((t, i) => {
    const fn = (t && t.function) || {};                       // chat nests the schema under `function`
    const name = fn.name || (t && t.name) || (t && t.type) || ('tool_' + i);
    const schema = fn.parameters !== undefined ? fn.parameters : (t && t.parameters !== undefined ? t.parameters : fn);
    const desc = typeof fn.description === 'string' ? fn.description : (typeof (t && t.description) === 'string' ? t.description : '');
    const props = schema && schema.properties ? Object.keys(schema.properties) : [];
    const mcp = /^mcp/.test(name);
    flat.push({
      sec: 'tools', kind: 'tool', role: 'tool', name, ttype: (t && t.type) || 'function',
      props, descChars: desc.length, cc: null, mcp, verbatim: true,
      desc, schema, resKey: mcp ? 'mcp::' + (name.split(/[._]/)[1] || name) : '',
      key: 'T:' + name + ':' + desc.length + ':' + props.length, path: ['tools', i],
    });
  });
  const msgs = Array.isArray(req && req.messages) ? req.messages : [];
  // Only LEADING system/developer messages are hoisted into the system section. A system message that
  // appears mid-conversation stays where it was — hoisting it would misreport its wire position.
  let lead = 0;
  while (lead < msgs.length && msgs[lead] && (msgs[lead].role === 'system' || msgs[lead].role === 'developer')) lead++;
  for (let i = 0; i < lead; i++) {
    const text = chatText(msgs[i].content);
    flat.push({ sec: 'system', kind: 'system', role: 'system', si: i, label: sysLabel(text), text, chars: text.length, volatile: false, cc: null, key: okey('S:', { type: 'text', text }), path: ['messages', i, 'content'] });
  }
  let mi = 0;
  for (let i = lead; i < msgs.length; i++) {
    let bi = 0;
    for (const { role, block, sub } of chatMessageToBlocks(msgs[i])) {
      const type = block.type;
      flat.push({ sec: 'messages', kind: type, role, mi, bi, block, toolName: type === 'tool_use' || type === 'server_tool_use' ? (block.name || '') : '', cc: null, resKey: resourceRef(block), key: okey('M:' + role + ':' + type + ':', block), path: ['messages', i, ...sub] });
      bi++;
    }
    mi++;
  }
  return flat;
}
// SSE chunks (or a non-streaming JSON body) → { model, usage, text, tools, stop_reason } (`tools`: the neutral name, 2.6 §A).
export function normRespChat(rec) {
  const resp = (rec && rec.resp) || (rec && rec.response) || {};
  const events = Array.isArray(resp.raw_sse) ? resp.raw_sse : [];
  const body = resp.body && typeof resp.body === 'object' ? resp.body : null;
  const frames = events.length ? events : (body ? [body] : []);
  let text = '', thinking = '', model = null, id = null, stop = null, usage = {};
  const acc = new Map();                                       // tool_calls arrive split across deltas
  for (const e of frames) {
    if (!e || typeof e !== 'object') continue;
    if (e.usage) usage = e.usage;
    if (e.model) model = e.model;
    if (e.id) id = e.id;
    for (const c of Array.isArray(e.choices) ? e.choices : []) {
      if (!c || typeof c !== 'object') continue;
      if (c.finish_reason) stop = c.finish_reason;
      if (c.usage) usage = c.usage;                             // Kimi reports usage inside the choice
      const d = c.delta || c.message || {};
      if (typeof d.reasoning_content === 'string') thinking += d.reasoning_content;
      if (typeof d.content === 'string') text += d.content;
      else if (Array.isArray(d.content)) text += chatText(d.content);
      for (const tc of Array.isArray(d.tool_calls) ? d.tool_calls : []) {
        const k = tc && tc.index !== undefined ? tc.index : ((tc && tc.id) || acc.size);
        const cur = acc.get(k) || { id: '', name: '', args: '' };
        const f = (tc && tc.function) || {};
        if (tc && tc.id) cur.id = tc.id;
        if (f.name) cur.name += f.name;
        if (typeof f.arguments === 'string') cur.args += f.arguments;
        acc.set(k, cur);
      }
    }
  }
  const tools = [...acc.values()].map((t) => ({ id: t.id, name: t.name, input: safeJson(t.args) }));
  return { model, id, stop_reason: stop, usage, text, thinking: thinking || undefined, tools };
}

// ── shape-dispatched entry points (the shared view layer calls THESE, never a per-shape branch) ────
export function boardFlatFor(shape, req) { return shape === 'chat' ? boardFlatChat(req) : boardFlat(req); }
export function normRespFor(shape, rec) { return shape === 'chat' ? normRespChat(rec) : normResp(rec); }
// derived per-call counts the board header reads, per wire shape (Responses: input[]/instructions;
// Chat: messages[] with the leading system messages as the system text).
export function reqCountsFor(shape, req) {
  if (shape === 'chat') {
    const msgs = Array.isArray(req && req.messages) ? req.messages : [];
    let lead = 0;
    while (lead < msgs.length && msgs[lead] && (msgs[lead].role === 'system' || msgs[lead].role === 'developer')) lead++;
    const sysChars = msgs.slice(0, lead).reduce((a, m) => a + chatText(m.content).length, 0);
    return { message_count: Math.max(0, msgs.length - lead), tool_count: Array.isArray(req && req.tools) ? req.tools.length : 0, system_chars: sysChars };
  }
  return {
    message_count: Array.isArray(req && req.input) ? req.input.length : 0,
    tool_count: Array.isArray(req && req.tools) ? req.tools.length : 0,
    system_chars: typeof (req && req.instructions) === 'string' ? req.instructions.length : 0,
  };
}


// ── normalize the SSE response → { model, usage, text, tools, stop_reason } from resp.raw_sse.
// The reverse-proxy's reconstruction is Anthropic-shaped (empty for OpenAI), so we read raw_sse (kept
// via `trocar capture --raw-sse`). This is the OpenAI dissector rebuilding blocks from raw events.
// normEvents is the event-list half, shared with the WebSocket dissector (openai-ws.mjs), whose events
// arrive as one server message each. A terminal response.completed / .incomplete / .failed carries the
// output and usage; an `error` event with no terminal response is stop_reason 'error'. (Before the split an HTTP
// stream ending in response.failed or an `error` event read as stop_reason null; it now says 'failed' / 'error',
// and the `failed` hook below makes such a call an error step that is never a cache baseline — as on WebSocket.)
export function normEvents(events) {
  let completed = null;
  for (const e of events || []) if (e && /^response\.(completed|incomplete|failed)$/.test(e.type)) completed = e.response || completed;
  const usage = (completed && completed.usage) || {};
  const output = Array.isArray(completed && completed.output) ? completed.output : [];
  let text = '';
  const toolCalls = [];
  for (const o of output) {
    if (o && o.type === 'message') {
      if (Array.isArray(o.content)) for (const c of o.content) if (c && (c.type === 'output_text' || c.type === 'text')) text += c.text || '';
    } else for (const { block: b } of itemToBlocks(o)) if (b.type === 'tool_use' || b.type === 'server_tool_use') toolCalls.push({ id: b.id, name: b.name, input: b.input });
  }
  // fallback: if no response.completed (interrupted), stitch text from output_text.delta events
  if (!completed) for (const e of events || []) if (e && e.type === 'response.output_text.delta') text += e.delta || '';
  const errored = !completed && (events || []).some((e) => e && e.type === 'error');
  return { model: (completed && completed.model) || null, id: (completed && completed.id) || null,
    stop_reason: (completed && completed.status) || (errored ? 'error' : null), usage, text, thinking: undefined, tools: toolCalls };
}
export function normResp(rec) {
  const resp = (rec && rec.resp) || (rec && rec.response) || {};
  return normEvents(Array.isArray(resp.raw_sse) ? resp.raw_sse : []);
}

// context-size proxy for the timeline bar (real: total input tokens from usage). Responses names it
// `input_tokens`, Chat Completions names it `prompt_tokens` — both are the same quantity.
export function ctxTokens(norm) {
  const u = (norm && norm.usage) || {};
  return u.input_tokens || u.prompt_tokens || 0;
}

// ── D25 dissector objects: what the board's extraction and reduction (src/view/extract.mjs, src/view/reduce.mjs) call, so they never
// branches on a wire. Registered by wire format in src/dissect/registry.mjs (`boardDissectorFor`).
// `provider` is the pre-D37 board label (analyzed.provider), kept for readers of old payloads; `blockKeys`
// are the request's top-level keys that become context blocks (everything else is a non-block key).
// `messageCount` — the message count compaction compares (3.4).
// ── reply parts (sse-spans.mjs): each reply block addressed as a span of resp.raw. Responses keys an event by its
// `output_index` and takes the event that delivers the item whole: its output_item.done, else the terminal's output, so each
// block is its own node in that event's data. Chat keys
// a chunk by choice index and what its delta carries (reasoning, text, a refusal, or tool call `index`).
// an output item's blocks as JSON nodes, the item standing at `path` (RFC 3.1 回复块也回源: the request side's rule for the same item)
export const itemNodes = (item, path) => itemToBlocks(item).map(({ block, sub }) => ({ block, path: [...path, ...sub] }));
const RESPONSES_REPLY = {
  keysOf: (e) => (Number.isInteger(e.output_index) ? [String(e.output_index)] : []),
  build: (k, evts, all) => {
    const done = evts.find((e) => e.type === 'response.output_item.done' && e.item && typeof e.item === 'object');
    if (done) return { evt: done, nodes: itemNodes(done.item, ['item']) };
    const term = all.find((e) => e && /^response\.(completed|incomplete|failed)$/.test(e.type) && e.response);
    const item = term && Array.isArray(term.response.output) ? term.response.output[Number(k)] : null;
    return item ? { evt: term, nodes: itemNodes(item, ['response', 'output', Number(k)]) } : 'this output item did not finish before the stream ended';
  },
  jsonNodes: (body) => (Array.isArray(body.output) ? body.output : []).flatMap((it, i) => itemNodes(it, ['output', i])),
};
const chatDeltas = (e) => (Array.isArray(e.choices) ? e.choices : []).map((c, i) => [c && c.index !== undefined ? c.index : i, (c && (c.delta || c.message)) || {}]);
const CHAT_TEXT_FIELDS = { thinking: 'reasoning_content', text: 'content', refusal: 'refusal' }; // key kind → the delta field its text comes in
const CHAT_REPLY = {
  keysOf: (e) => chatDeltas(e).flatMap(([ci, d]) => [
    ...Object.entries(CHAT_TEXT_FIELDS).flatMap(([kind, f]) => (typeof d[f] === 'string' && d[f] ? [`${ci}:${kind}`] : [])),
    ...(Array.isArray(d.tool_calls) ? d.tool_calls.map((tc, n) => `${ci}:tool:${tc && tc.index !== undefined ? tc.index : n}`) : []),
  ]),
  build: (k, evts) => {
    const [ci, kind, ti] = k.split(':');
    let text = '', id = '', name = '', args = '';
    for (const e of evts) for (const [c, d] of chatDeltas(e)) {
      if (String(c) !== ci) continue;
      if (typeof d[CHAT_TEXT_FIELDS[kind]] === 'string') text += d[CHAT_TEXT_FIELDS[kind]];
      if (kind === 'tool') (Array.isArray(d.tool_calls) ? d.tool_calls : []).forEach((tc, n) => {
        if (String(tc && tc.index !== undefined ? tc.index : n) !== ti) return;
        const f = tc.function || {};
        if (tc.id) id = tc.id;
        if (f.name) name += f.name;
        if (typeof f.arguments === 'string') args += f.arguments;
      });
    }
    return [kind === 'tool' ? { type: 'tool_use', id, name, input: safeJson(args) } : kind === 'thinking' ? { type: 'thinking', thinking: text } : { type: 'text', text }];
  },
  jsonNodes: (body) => (Array.isArray(body.choices) ? body.choices : []).flatMap((c, i) => (c && c.message ? chatMessageToBlocks(c.message).map(({ block, sub }) => ({ block, path: ['choices', i, 'message', ...sub] })) : [])),
};

export const RESPONSES = Object.freeze({
  id: 'openai-responses', provider: 'openai', blockKeys: ['tools', 'instructions', 'input'],
  boardFlat: (req) => boardFlat(req), normResp: (rec) => normResp(rec),
  reqCounts: (req) => reqCountsFor('responses', req), ctxTokens,
  // the stream's terminal says the response failed, or an `error` event arrived with no terminal (normEvents)
  failed: (norm) => norm.stop_reason === 'failed' || norm.stop_reason === 'error',
  replyParts: (rec) => streamParts(rec, RESPONSES_REPLY),
  messageCount: (req) => (Array.isArray(req && req.input) ? req.input.length : typeof (req && req.input) === 'string' ? 1 : 0),
});
export const CHAT = Object.freeze({
  id: 'openai-chat', provider: 'openai', blockKeys: ['tools', 'messages'],
  boardFlat: (req) => boardFlatChat(req), normResp: (rec) => normRespChat(rec),
  reqCounts: (req) => reqCountsFor('chat', req), ctxTokens,
  replyParts: (rec) => streamParts(rec, CHAT_REPLY),
  messageCount: (req) => (Array.isArray(req && req.messages) ? req.messages.length : 0),
});
