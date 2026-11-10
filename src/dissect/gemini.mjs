// src/dissect/gemini.mjs — the Gemini API dissector (D25, RFC 3.1 §3.3 item 5): `…:streamGenerateContent` / `…:generateContent`,
// relay prefixes included. Maps the wire into the ONE cross-provider block vocabulary (text / thinking / tool_use / tool_result /
// image + the tools and system sections), so the board needs no change (invariant 3).
//   request  = { contents[]{role:'user'|'model', parts[]}, systemInstruction{parts[]}, tools[]{functionDeclarations[]},
//                toolConfig, generationConfig }
//   part     = {text} · {text, thought:true} (a thought summary) · {functionCall{name, args, id?}} · {functionResponse{name, response, id?}}
//              · {inlineData{mimeType, data}} · anything else (fileData, executableCode, codeExecutionResult, a new key)
//   response = SSE, each data object {candidates[{content{parts[]}, finishReason?}], usageMetadata, modelVersion, responseId}; text
//              arrives split across chunks, a functionCall part whole in one; usage counts arrive with the last chunk.
//              A non-streaming reply is the same object as the JSON body (an array of them for streamGenerateContent without SSE).
import { REPLY_RULES } from './openai.mjs';
import { streamParts } from './sse-spans.mjs';
import { endOf } from './endpoints.mjs';
import { parsedRequestBody } from './request-body.mjs';

const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const asJson = (v) => (typeof v === 'string' ? v : JSON.stringify(v ?? {}));

// A call and its result pair by `id`. With no id (the Gemini API sends none by default) both sides key by the function's name and its
// place among that name's calls in the turn (results come back in the calls' order), so the 2nd read_file result pairs with the 2nd
// read_file call: the board pairs a tool_result with the first tool_use of its tool_use_id (src/query/named/lane.mjs readsIn), so a bare
// name would send every result to the first call. The place counts per turn `t` (a model content and the user contents right after it:
// the API puts results right after the turn that made the calls), so a call left with no result shifts no other turn; `t` is in the key,
// so equal places in two turns stay apart. A reply is the turn after its request's model turns (one per candidate): the next request
// carries it as its last model turn and keys its calls the same.
// shortcut: two model contents in a row are two turns, so a result after them pairs with the second's call of that name; no captured pi
// request has such a run (186 of 186 alternate) — count a run of model contents as one turn when a harness sends them.
const newTurn = (t) => ({ t, seen: new Map() });
const pairKey = (turn, side, f) => {
  if (f.id) return f.id;
  if (!turn) return '';
  const k = `${side}:${f.name}`, n = turn.seen.get(k) || 0;
  turn.seen.set(k, n + 1);
  return `${f.name || ''}#${turn.t}.${n}`;
};
// one part → [role, block]; a part of no known kind is a text block holding its JSON, never dropped
function partBlock(p, role, turn = null) {
  if (!isObj(p)) return [role, { type: 'text', text: String(p ?? '') }];
  if (isObj(p.functionCall)) { const f = p.functionCall; return ['assistant', { type: 'tool_use', id: pairKey(turn, 'call', f), name: f.name || '', input: isObj(f.args) ? f.args : {} }]; }
  if (isObj(p.functionResponse)) { const f = p.functionResponse; return ['tool', { type: 'tool_result', tool_use_id: pairKey(turn, 'result', f), content: asJson(f.response) }]; }
  if (typeof p.text === 'string') return p.thought === true ? ['assistant', { type: 'thinking', thinking: p.text }] : [role, { type: 'text', text: p.text }];
  const d = p.inlineData;
  if (isObj(d) && typeof d.data === 'string' && /^image\//.test(d.mimeType || '')) return [role, { type: 'image', source: { type: 'base64', media_type: d.mimeType, data: d.data } }];
  return [role, { type: 'text', text: JSON.stringify(p) }];
}
const roleOf = (c) => (c && c.role === 'model' ? 'assistant' : (c && c.role) || 'user');
const partsOf = (c) => (isObj(c) && Array.isArray(c.parts) ? c.parts : []);
const sysParts = (req) => partsOf(req && req.systemInstruction);
const partText = (p) => (isObj(p) && typeof p.text === 'string' ? p.text : JSON.stringify(p ?? null));

// every tool definition and where it stands: each functionDeclarations entry; a tool of another kind (googleSearch, codeExecution) is one
function toolEntries(req) {
  const out = [];
  (Array.isArray(req && req.tools) ? req.tools : []).forEach((t, i) => {
    if (isObj(t) && Array.isArray(t.functionDeclarations)) t.functionDeclarations.forEach((f, j) => out.push({ f: isObj(f) ? f : {}, path: ['tools', i, 'functionDeclarations', j] }));
    else out.push({ f: { name: isObj(t) ? Object.keys(t)[0] || '' : '', schema: t }, path: ['tools', i], builtin: true });
  });
  return out;
}

export function boardFlatGemini(req) {
  const flat = [];
  for (const { f, path, builtin } of toolEntries(req)) {
    const name = f.name || 'tool_' + path[1];
    const schema = builtin ? f.schema : f.parametersJsonSchema !== undefined ? f.parametersJsonSchema : f.parameters;
    const desc = typeof f.description === 'string' ? f.description : '';
    const props = isObj(schema) && isObj(schema.properties) ? Object.keys(schema.properties) : [];
    const mcp = /^mcp/.test(name);
    flat.push({ sec: 'tools', kind: 'tool', role: 'tool', name, ttype: builtin ? name : 'function', props, descChars: desc.length, cc: null, mcp, verbatim: true,
      desc, schema, resKey: mcp ? 'mcp::' + (name.split(/[._]/)[1] || name) : '', key: 'T:' + name + ':' + desc.length + ':' + props.length, path });
  }
  sysParts(req).forEach((p, si) => {
    const text = partText(p);
    flat.push({ sec: 'system', kind: 'system', role: 'system', si, label: 'system instruction', text, chars: text.length, volatile: false, cc: null, path: ['systemInstruction', 'parts', si] });
  });
  let turn = newTurn(0);
  (Array.isArray(req && req.contents) ? req.contents : []).forEach((c, mi) => {
    if (isObj(c) && c.role === 'model') turn = newTurn(turn.t + 1);
    const parts = partsOf(c);
    // a content with no parts still gets a block, so the count never under-reports what was on the wire
    const blocks = parts.length ? parts.map((p, k) => [...partBlock(p, roleOf(c), turn), ['contents', mi, 'parts', k]]) : [[roleOf(c), { type: 'text', text: '' }, ['contents', mi]]];
    blocks.forEach(([role, block, path], bi) => {
      const type = block.type;
      const d = { sec: 'messages', kind: type, role, mi, bi, block, toolName: type === 'tool_use' ? block.name : '', cc: null, resKey: REPLY_RULES.resourceRef(block), path };
      if (type === 'thinking') d.faithfulness = REPLY_RULES.faith(block);
      flat.push(d);
    });
  });
  return flat;
}

// the stream's data objects, or a JSON body's (one object, or an array of them)
function framesOf(rec) {
  const resp = (rec && (rec.resp || rec.response)) || {};
  if (Array.isArray(resp.raw_sse) && resp.raw_sse.length) return resp.raw_sse;
  return Array.isArray(resp.body) ? resp.body : isObj(resp.body) ? [resp.body] : [];
}
const COUNTED = ['promptTokenCount', 'candidatesTokenCount', 'totalTokenCount'];
// a reply's turns (pairKey): one per candidate `ci`, numbered after the model turns of the request it answers
const replyTurns = (rec) => {
  const req = parsedRequestBody(rec), t = 1 + (Array.isArray(req && req.contents) ? req.contents : []).filter((c) => isObj(c) && c.role === 'model').length;
  const turns = new Map();
  return (ci) => turns.get(ci) || turns.set(ci, newTurn(t)).get(ci);
};
const candidatesOf = (e) => (Array.isArray(e.candidates) ? e.candidates : []).map((c, n) => [isObj(c) && Number.isInteger(c.index) ? c.index : n, isObj(c) ? c : {}]);
// → { model, id, stop_reason, usage, text, thinking, tools, error?, unfinished? }: usage = the last usageMetadata that carries counts
// (earlier chunks may carry only trafficType)
export function normRespGemini(rec) {
  let text = '', thinking = '', model = null, id = null, stop = null, usage = {}, error = false, blocked = null;
  const tools = [], open = new Set(), done = new Set(), turnOf = replyTurns(rec);
  for (const e of framesOf(rec)) {
    if (!isObj(e)) continue;
    if (e.error) error = true;
    if (isObj(e.promptFeedback) && e.promptFeedback.blockReason) blocked = e.promptFeedback.blockReason; // the prompt was refused: no candidate
    if (isObj(e.usageMetadata) && COUNTED.some((k) => e.usageMetadata[k] != null)) usage = e.usageMetadata;
    if (e.modelVersion) model = e.modelVersion;
    if (e.responseId) id = e.responseId;
    for (const [ci, c] of candidatesOf(e)) {
      if (c.finishReason) { stop = c.finishReason; open.delete(ci); done.add(ci); } else if (!done.has(ci)) open.add(ci);
      for (const p of partsOf(c.content)) {
        const [, b] = partBlock(p, 'assistant', turnOf(ci));
        if (b.type === 'thinking') thinking += b.thinking;
        else if (b.type === 'text' && typeof p.text === 'string') text += b.text;
        else if (b.type === 'tool_use') tools.push({ id: b.id, name: b.name, input: b.input });
      }
    }
  }
  return { model, id, stop_reason: stop, usage, text, thinking: thinking || undefined, tools, ...(error ? { error } : {}), ...(blocked ? { blocked } : {}), ...(open.size ? { unfinished: open.size } : {}) };
}

// reply parts (sse-spans.mjs): text and thought text key by candidate and kind, an event range each; a functionCall part arrives whole,
// so it is its own JSON node in its chunk. Keys come in stream order (`n` numbers the calls), hence one describer per reply read.
const replyKind = (p) => (isObj(p.functionCall) ? 'call' : typeof p.text === 'string' && p.text ? (p.thought === true ? 'thinking' : 'text') : null);
function geminiReply(rec) {
  let n = 0;
  const calls = new Map(), turnOf = replyTurns(rec); // key → [candidate position, part position, block]
  return {
    keysOf: (e) => (Array.isArray(e.candidates) ? e.candidates : []).flatMap((c, cn) => partsOf(isObj(c) ? c.content : null).flatMap((p, k) => {
      const kind = isObj(p) ? replyKind(p) : null, ci = isObj(c) && Number.isInteger(c.index) ? c.index : cn;
      if (kind !== 'call') return kind ? [`${ci}:${kind}`] : [];
      const key = `${ci}:call:${n++}`;
      calls.set(key, [cn, k, partBlock(p, 'assistant', turnOf(ci))[1]]);
      return [key];
    })),
    build: (key, evts) => {
      const [ci, kind] = key.split(':');
      if (kind === 'call') {
        const [cn, k, block] = calls.get(key);
        return { evt: evts[0], nodes: [{ block, path: ['candidates', cn, 'content', 'parts', k] }] };
      }
      let text = '';
      for (const e of evts) for (const [c, cand] of candidatesOf(e)) if (String(c) === ci) for (const p of partsOf(cand.content)) if (isObj(p) && replyKind(p) === kind) text += p.text;
      return [kind === 'thinking' ? { type: 'thinking', thinking: text } : { type: 'text', text }];
    },
    jsonNodes: (body) => (Array.isArray(body) ? body.map((b, i) => [b, [i]]) : [[body, []]]).flatMap(([b, at]) => (isObj(b) ? candidatesOf(b) : [])
      .flatMap(([ci, c], cn) => partsOf(c.content).map((p, k) => ({ block: partBlock(p, 'assistant', turnOf(ci))[1], path: [...at, 'candidates', cn, 'content', 'parts', k] })))),
  };
}

// 3.1 `ended`: the model's own stop (STOP, MAX_TOKENS) is ok; a stop the service imposed or a failed generation is failed; anything not
// named is null. An error chunk or a blocked prompt fails the reply; a candidate with no finishReason is an unfinished stream (null).
const GEMINI_ENDS = Object.freeze({ ok: ['STOP', 'MAX_TOKENS'], failed: ['SAFETY', 'RECITATION', 'LANGUAGE', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII',
  'MALFORMED_FUNCTION_CALL', 'IMAGE_SAFETY', 'UNEXPECTED_TOOL_CALL', 'TOO_MANY_TOOL_CALLS', 'IMAGE_PROHIBITED_CONTENT', 'IMAGE_OTHER', 'IMAGE_RECITATION',
  'NO_IMAGE', 'OTHER'] });
const num = (x) => Number(x) || 0;
export const GEMINI = Object.freeze({
  id: 'gemini', provider: 'gemini', blockKeys: ['tools', 'systemInstruction', 'contents'], fold: 'flat', rules: REPLY_RULES,
  boardFlat: (req) => boardFlatGemini(req), normResp: (rec) => normRespGemini(rec),
  reqCounts: (req) => ({ message_count: Array.isArray(req && req.contents) ? req.contents.length : 0, tool_count: toolEntries(req).length,
    system_chars: sysParts(req).reduce((a, p) => a + partText(p).length, 0) }),
  ctxTokens: (norm) => num(norm && norm.usage && norm.usage.promptTokenCount) + num(norm && norm.usage && norm.usage.toolUsePromptTokenCount),
  ended: (norm) => (norm.error || norm.blocked ? 'failed' : norm.unfinished ? null : endOf(GEMINI_ENDS, [norm.stop_reason])),
  replyParts: (rec) => streamParts(rec, geminiReply(rec)),
  messageCount: (req) => (Array.isArray(req && req.contents) ? req.contents.length : 0),
});
