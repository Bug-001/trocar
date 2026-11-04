// blockmeta — what a context block looks like ON THE WIRE, and everything the board can render
// about it WITHOUT its text.
//
// WHY THIS EXISTS AT ALL (RFC 1.4:35, 4.2:55, 1.5:32).
// The context window is specified as collapsible rows — 「头显 role · kind-tag · 短预览 · 字符数;
// 点开惰性填正文」 — and the storage rule is blunter still: 「表里不留全文(存 text_ref)……强制
// 『看全文=回源』」. /api/session did the opposite: it shipped every block's full text, plus a
// complete copy of every call's raw request body, in one JSON. Measured on a real 115-call session:
// 142.8 MB for a single page, of which ~120 MB was the request bodies. And because an append-only
// conversation re-sends its whole context every turn, 17,594 blocks carried only 494 distinct
// contents — 97% of that payload was the same bytes over and over. A 10-call window of a heavier
// session simply exceeds V8's 512 MB max string: HTTP 500 "Invalid string length", i.e. the board
// cannot open a real session at all.
//
// So the collapsed row needs its four fields computed HERE, from the block, once — and the body
// stays where it already is, in the raw NDJSON, addressed by a text_ref.
//
// WHY SERVER-SIDE, beyond payload size (invariant 3). The browser used to compute these itself, by
// branching on Anthropic wire shapes: `bl.type === 'tool_use'`, `bl.thinking`, `bl.content`. That is
// provider knowledge in the frontend, which the invariant forbids and which already cost us once —
// an OpenAI-Responses body has none of those keys, so every Codex/OpenCode call scored zero in every
// bucket and rendered as one flat colour. Computing it here, off the ONE cross-provider block
// vocabulary both dissectors emit, means a new harness never touches the browser again.

const enc = (s) => (s == null ? 0 : Buffer.byteLength(String(s), 'utf8'));

/**
 * The block's weight in context, in BYTES ON THE WIRE — the unit the timeline bars, the section
 * tax and the growth Δ are all denominated in. Ported verbatim from the browser's flatBytes(); the
 * numbers must not move, or every historical reading of a session silently changes meaning.
 */
// Memo by the PARSED source object (the message block, or the tool / system item a flat entry was made from; linearContext gives it
// as the non-enumerable `src`): a stitched context hands the same parsed items to every call of its chain, so a session's fold asked for
// the same block's bytes once per call that carries it. Parsed bodies are read-only (src/dissect/request-body.mjs; test/view/frozen-fold).
const bytesMemo = new WeakMap();
// tool_result and any `*_tool_result` kind (a server-run tool's result, named by the wire): read and bucketed alike.
const isResult = (k) => typeof k === 'string' && (k === 'tool_result' || k.endsWith('_tool_result'));
function blockBytes(b) {
  const src = b && (b.sec === 'tools' || b.sec === 'system' ? b.src : b.block);
  if (!src || typeof src !== 'object') return blockBytesOf(b);
  let n = bytesMemo.get(src);
  if (n === undefined) bytesMemo.set(src, (n = blockBytesOf(b)));
  return n;
}
function blockBytesOf(b) {
  if (!b) return 0;
  if (b.sec === 'tools') {
    // D15: a verbatim trace carries the real description + schema bytes; a v0 trace kept only a
    // char count, which is a fidelity boundary the板 labels rather than guesses past.
    return enc(b.name) + (b.verbatim
      ? enc(b.desc != null ? b.desc : '') + (b.schema !== undefined ? enc(JSON.stringify(b.schema)) : 0)
      : (b.descChars || 0));
  }
  if (b.sec === 'system') return enc(b.text);
  const bl = b.block;
  if (bl == null) return 0;
  if (typeof bl === 'string') return enc(bl);
  if (bl.type === 'text') return enc(bl.text);
  if (bl.type === 'thinking' || bl.type === 'redacted_thinking') return enc(bl.thinking || '');
  if (bl.type === 'tool_use' || bl.type === 'server_tool_use') return enc(bl.name) + enc(JSON.stringify(bl.input || {}));
  if (isResult(bl.type)) { const c = bl.content; return enc(typeof c === 'string' ? c : JSON.stringify(c ?? '')); }
  if (bl.type === 'json') return enc(JSON.stringify(bl.value));
  if (bl.type === 'image') return 800;   // no bytes on the wire to count; a nominal weight, as before
  return enc(JSON.stringify(bl));
}

// The body as the context window would render it. Used HERE only to derive chars/preview; the
// string itself is never shipped — that is the whole point.
function bodyTextOf(b) {
  if (!b) return '';
  if (b.sec === 'tools') return (b.desc || '') + (b.schema !== undefined ? JSON.stringify(b.schema) : '');
  if (b.sec === 'system') return b.text || '';
  const bl = b.block;
  if (bl == null) return '';
  if (typeof bl === 'string') return bl;
  if (bl.type === 'text') return bl.text || '';
  if (bl.type === 'thinking') return bl.thinking || '';
  if (bl.type === 'redacted_thinking') return '[redacted_thinking]';
  if (bl.type === 'tool_use' || bl.type === 'server_tool_use') return `${bl.name}(${JSON.stringify(bl.input ?? {})})`;
  if (isResult(bl.type)) {
    const c = bl.content;
    return typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => x.text || `[${x.type}]`).join('\n') : JSON.stringify(c ?? '');
  }
  if (bl.type === 'image') return `[image ${(bl.source && (bl.source.media_type || bl.source.type)) || ''}]`;
  if (bl.type === 'json') return JSON.stringify(bl.value);
  if (bl.type === 'document') return `[document ${(bl.source && (bl.source.media_type || bl.source.type)) || bl.title || ''}]`;
  return JSON.stringify(bl);
}

const PREVIEW_MAX = 90;
// `String(s).replace(/\s+/g, ' ').trim().slice(0, PREVIEW_MAX)`, BOUNDED: the regex form over the whole text built a second
// copy of every block body — a 200 KB tool_result collapsed in full to keep 90 chars of it. Squashing a prefix gives a prefix of
// the whole squash (a run cut at the prefix's end is still one space), so once the squashed, left-trimmed prefix is longer than
// `max` its first `max` characters are the answer (the right trim can only drop the whole squash's last character); a prefix too
// short to tell is read again four times longer. The answer is copied out (`' ' + x`, sliced) so it holds no larger string.
// (`\s` is exactly what String.trim removes)
const WS_RUN = /\s+/g;
export const shorten = (s, max = PREVIEW_MAX) => {
  const t = String(s || '');
  for (let n = 2 * max + 64; ; n *= 4) {
    const all = n >= t.length, q = (all ? t : t.slice(0, n)).replace(WS_RUN, ' ').trimStart();
    if (all || q.length > max) return (' ' + (all ? q.trimEnd() : q).slice(0, max)).slice(1);
  }
};

// Short arg preview for a tool_use header: the ONE field that says what the call is doing.
function argPreview(bl) {
  const inp = (bl && bl.input) || {};
  if (inp.file_path || inp.path || inp.notebook_path) return String(inp.file_path || inp.path || inp.notebook_path);
  if (inp.command) return String(inp.command);
  if (inp.pattern) return String(inp.pattern);
  if (inp.url || inp.query) return String(inp.url || inp.query);
  if (inp.description || inp.subagent_type) return String(inp.description || inp.subagent_type);
  if (inp.skill) return 'skill: ' + String(inp.skill || inp.command || '');
  return '';
}

/**
 * The collapsed row: { role, tag, label }. RAW strings — escaping is the renderer's job, and doing
 * it here would double-escape or, worse, ship markup. Ported from the browser's blockHead().
 */
function blockHead(b) {
  if (!b) return { role: '', tag: '', label: '' };
  if (b.sec === 'tools') return { role: 'tool', tag: 'def' + (b.mcp ? ' · MCP' : ''), label: b.name || '' };
  if (b.sec === 'system') return { role: 'system', tag: b.label || '', label: '' };
  const r = b.role, k = b.kind, bl = b.block;
  if (k === 'thinking' || k === 'redacted_thinking') return { role: 'assistant', tag: 'thinking', label: '' };
  if (k === 'tool_use' || k === 'server_tool_use') return { role: 'assistant', tag: 'action · ' + (b.toolName || ''), label: shorten(argPreview(bl)) };
  if (isResult(k)) return { role: r, tag: 'observation' + (bl && bl.is_error ? ' · error' : ''), label: '' };
  if (k === 'image') return { role: r, tag: 'image', label: '' };
  if (k === 'tool_addition' || k === 'tool_removal') { // a tool definition added / removed mid-conversation
    const t = bl && bl.tool, def = (t && (t.definition || t)) || {};
    return { role: r, tag: k === 'tool_addition' ? 'def · added' : 'def · removed', label: String(def.name || (t && t.name) || '') };
  }
  if (k === 'document') return { role: r, tag: 'document', label: '' };
  if (k === 'json') { const v = bl && bl.value; return { role: r, tag: String((v && v.type) || 'json'), label: shorten(JSON.stringify(v)) }; } // an unmapped item: its own type, its JSON
  const tag = r === 'user' ? 'user' : r === 'assistant' ? 'say' : r === 'system' ? 'system-reminder' : 'text';
  const txt = typeof bl === 'string' ? bl : (bl && typeof bl.text === 'string') ? bl.text : '';
  return { role: r, tag, label: shorten(txt) };
}

/** 短预览 for the row body — distinct from head.label, which previews the tool ARGUMENT. */
const blockPreview = (b) => shorten(bodyTextOf(b));

// ── composition: what this call's context is MADE OF, in nine buckets ────────────────────────────
//
// Ported verbatim from the browser's COMP_KIND / COMP_ROLE / compBucket / callComp (index.html:916).
// Same rule as blockBytes: the numbers must not move, or every historical reading of a session
// silently changes meaning.
//
// WHY IT MOVED SERVER-SIDE. Two reasons, and the second is the one that mattered to a user.
//   1. Invariant 3. Bucketing must read the ONE cross-provider block vocabulary, never a wire shape.
//      Computing it here means a new harness never touches the browser.
//   2. It is CHEAP — 125 bytes per call, ~72 KB for a 578-call session — and it belongs to the tier
//      that ships for every call, always. Paging withheld it along with the block bodies, and the
//      timeline then drew ~40 of a live session's calls as diagonal-hatched "composition unknown"
//      bars. Lazy belongs on bodies (87 KB/call), not on nine integers.
//
// Roles NOT in the table land in `other` rather than being folded into `user`: an unrecognized role
// must be VISIBLE, never mis-coloured as something we did not observe (invariant 4).
const COMP_KIND = { tool_addition: 'tools', tool_removal: 'tools', thinking: 'thinking', redacted_thinking: 'thinking', tool_use: 'tool_use', server_tool_use: 'tool_use', tool_result: 'tool_result', image: 'image' };
const COMP_ROLE = { assistant: 'assistant', user: 'user', system: 'system', developer: 'system', tool: 'tool_result' };
export const COMP_KEYS = ['tools', 'system', 'user', 'assistant', 'thinking', 'tool_use', 'tool_result', 'image', 'other'];

export function compBucket(b) {
  if (!b) return 'other';
  if (b.sec === 'tools') return 'tools';
  if (b.sec === 'system') return 'system';
  const k = isResult(b.kind) ? 'tool_result' : COMP_KIND[b.kind];
  if (k) return k;
  return COMP_ROLE[b.role] || 'other';
}

/**
 * Is this block a HUMAN QUERY — the thing that opens a turn?
 *
 * The context window groups messages into turns: a turn opens at a user text message the human
 * actually typed and runs until the next one, carrying the assistant's thinking / tool_use / text and
 * the tool_results that answer it. What makes it "human" is that something survives after stripping
 * the harness's injected <system-reminder> blocks — a message that is ONLY reminders is scaffolding,
 * not a turn boundary.
 *
 * Computed HERE because the browser used to do it by reading `b.block.text`, which a slimmed block no
 * longer carries: every message then landed in one turn, the outline's query rows went blank, and the
 * D17② section tax booked the whole conversation as `task` with `history` = 0 — a number the board
 * presents as a research finding. It also belongs here on principle (invariant 3): `<system-reminder>`
 * is Claude-Code-shaped knowledge, and the browser must not branch on a harness's wire shape.
 */
export function blockQuery(b) {
  return isUserText(b) ? queryOf(b, bodyTextOf(b)) : null; // only a user text has one: no body text built for the rest
}
// …over a body text the caller already has (slimBlock builds it once for chars, preview and this).
const isUserText = (b) => !!b && b.sec === 'messages' && b.role === 'user' && b.kind === 'text';
function queryOf(b, raw, max = PREVIEW_MAX) {
  if (!isUserText(b)) return null;
  const human = String(raw || '').replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  return human ? shorten(human, max) : null;
}
// How long a lane's task is (4.4 §看板 v2 需要的补充 `lanes[].task`; the session title is the main lane's), and how much of a lane's first
// prompt is kept to tell sibling sub-agents apart (their prompts often share a long preamble: a workflow's own instructions).
export const TASK_MAX = 80;
export const TASK_HEAD = 16384;
/** taskOf(text) → the text squashed (whitespace runs → one space, trimmed), ≤ TASK_MAX characters, or null. */
export const taskOf = (text) => (text ? shorten(text, TASK_MAX) || null : null);
/** firstHuman(flat) → the first human prompt of a context (blockQuery's rule: a user text block, <system-reminder> stripped, not empty),
 *  trimmed, its first TASK_HEAD characters, as a string of its own (a slice would keep the block's whole text alive) — or null. */
export function firstHuman(flat) {
  for (const b of flat || []) {
    if (!isUserText(b)) continue;
    const human = String(bodyTextOf(b) || '').replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
    if (human) return (' ' + human.slice(0, TASK_HEAD)).slice(1);
  }
  return null;
}
/** A lane's first prompt (firstHuman of its first call), kept on the lane under a symbol key: no document carries it. */
export const HEAD = Symbol('first prompt');
// Sub-agents a spawn does not name are told apart by their first prompts (4.4 §看板 v2 需要的补充 `lanes[].task`): a lane's task starts at the
// line where its prompt departs from the sibling it shares the longest prefix with (an identical prompt is no sibling to depart from).
// Sorted, that sibling is a neighbour of its distinct prompts: n lanes cost a sort, not n² comparisons, and a prompt that comes or
// goes moves the offsets of its two neighbours only (departer).
const common = (a, b) => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; };
const departOf = (h, p, n) => { const d = Math.max(p == null ? 0 : common(h, p), n == null ? 0 : common(h, n)); return d > 0 && d < h.length ? h.lastIndexOf('\n', d - 1) + 1 : 0; };
/** departer(heads?) → the offsets of a set of first prompts that changes a prompt at a time: add(h) / remove(h) (equal prompts
 *  counted, one entry) → the prompts whose offset changed; offset(h) → where h departs from its siblings (0: from the start). */
export function departer(heads = []) {
  const U = [...new Set(heads)].sort(), cnt = new Map(), off = new Map();
  for (const h of heads) cnt.set(h, (cnt.get(h) || 0) + 1);
  U.forEach((h, i) => off.set(h, departOf(h, U[i - 1], U[i + 1])));
  const find = (h) => { let lo = 0, hi = U.length; while (lo < hi) { const m = (lo + hi) >> 1; if (U[m] < h) lo = m + 1; else hi = m; } return lo; };
  const redo = (out, ...is) => { for (const i of is) if (i >= 0 && i < U.length) { const h = U[i], o = departOf(h, U[i - 1], U[i + 1]); if (off.get(h) !== o) { off.set(h, o); out.push(h); } } return out; };
  return {
    add(h) { const c = cnt.get(h) || 0; cnt.set(h, c + 1); if (c) return []; const i = find(h); U.splice(i, 0, h); return redo([], i - 1, i, i + 1); },
    remove(h) { const c = cnt.get(h) || 0; if (c > 1) { cnt.set(h, c - 1); return []; } if (!c) return []; cnt.delete(h); off.delete(h); const i = find(h); U.splice(i, 1); return redo([], i - 1, i); },
    offset: (h) => off.get(h) || 0,
  };
}
/** departs(lane) → whether a lane's first prompt is told apart from its siblings': a sub-agent's that no spawn named. */
export const departs = (l) => l.kind === 'subagent' && !!l[HEAD];

// Fields that carry the block's CONTENT. These are what must not cross the wire; everything else on
// a block is metadata the collapsed row, the diff and the timeline need on every call.
const HEAVY = ['text', 'block', 'desc', 'schema', 'props'];

/**
 * The wire shape of a block: metadata + a locator, never the body.
 *
 * `text_ref` is the same locator the DuckDB projection persists (RFC 4.2:40,
 * `<session>/<stream>#<recordId>::<start>-<end>`), so ONE resolver serves both the board and the
 * analysis path, and the bytes the browser eventually shows are resolved by 「定位源记录 →
 * slice(start,end)」 — the AC-1 algorithm, not a second copy that can drift.
 *
 * WHEN THE BYTES CANNOT BE ADDRESSED, INLINE THE TEXT — never ship neither.
 * A locator only exists if the verbatim wire body does. A D10 record carries one (`req_body`, a
 * string) so every block is addressable; a v0/demo-converted record does not — it stored parsed
 * JSON, so the original bytes are genuinely gone (see src/raw/ingest.mjs) and no span can honestly
 * be computed. Dropping the text as well would leave a row that can be neither read nor fetched:
 * content that is sitting in the capture file becomes invisible in the product, permanently. That is
 * not a transport bound the user can recover from by expanding a row — it is loss on the display
 * path, and strictly worse than before blocks were slimmed at all.
 *
 * So the rule is: ADDRESS IT, OR INLINE IT — and say which, because the two are not equally
 * trustworthy. An addressed block's body is resolved verbatim from the capture by 「定位源记录 →
 * slice(start,end)」 (the AC-1 algorithm); an inlined one is re-serialized text that was already
 * badged `v0-converted` upstream. Leaving them indistinguishable would let re-serialized content
 * pass as byte-verbatim (invariant 4), so `unaddressable` states the reason in place.
 */
export function slimBlock(b, textRef, why = null) {
  const out = { ...b };
  const body = bodyTextOf(b); // built ONCE: chars, the preview and the turn test all read this one string
  out.bytes = blockBytes(b);
  out.chars = body == null ? 0 : String(body).length;
  out.head = blockHead(b);
  out.preview = shorten(body);
  const q = queryOf(b, body);
  if (q) out.query = q;   // turn boundary + outline row; see blockQuery for why it is not the browser's job
  if (textRef) {
    // Addressable: drop the body, ship the locator. The browser fetches it on expand.
    for (const k of HEAVY) delete out[k];
    out.text_ref = textRef;
    return out;
  }
  // NOT addressable → keep the body exactly as it was, so the row renders as it always did, and say
  // why it was inlined. Stripping HEAVY here is what produced an unreadable, unfetchable row.
  // `why`: the caller's specific reason, when it knows one (e.g. a block rebuilt from a streamed reply).
  out.unaddressable = why || 'the capture holds this block only as parsed JSON, so no byte range names it';
  return out;
}
