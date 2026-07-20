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
export function blockBytes(b) {
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
  if (bl.type === 'tool_result') { const c = bl.content; return enc(typeof c === 'string' ? c : JSON.stringify(c ?? '')); }
  if (bl.type === 'image') return 800;   // no bytes on the wire to count; a nominal weight, as before
  return enc(JSON.stringify(bl));
}

/** Character count of the block's rendered body — the 「字符数」 on the collapsed row. */
export function blockChars(b) {
  const t = bodyTextOf(b);
  return t == null ? 0 : String(t).length;
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
  if (bl.type === 'tool_result') {
    const c = bl.content;
    return typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => x.text || `[${x.type}]`).join('\n') : JSON.stringify(c ?? '');
  }
  if (bl.type === 'image') return `[image ${(bl.source && (bl.source.media_type || bl.source.type)) || ''}]`;
  if (bl.type === 'document') return `[document ${(bl.source && (bl.source.media_type || bl.source.type)) || bl.title || ''}]`;
  return JSON.stringify(bl);
}

const PREVIEW_MAX = 90;
const shorten = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, PREVIEW_MAX);

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
export function blockHead(b) {
  if (!b) return { role: '', tag: '', label: '' };
  if (b.sec === 'tools') return { role: 'tool', tag: 'def' + (b.mcp ? ' · MCP' : ''), label: b.name || '' };
  if (b.sec === 'system') return { role: 'system', tag: b.label || '', label: '' };
  const r = b.role, k = b.kind, bl = b.block;
  if (k === 'thinking' || k === 'redacted_thinking') return { role: 'assistant', tag: 'thinking', label: '' };
  if (k === 'tool_use' || k === 'server_tool_use') return { role: 'assistant', tag: 'action · ' + (b.toolName || ''), label: shorten(argPreview(bl)) };
  if (k === 'tool_result') return { role: r, tag: 'observation' + (bl && bl.is_error ? ' · error' : ''), label: '' };
  if (k === 'image') return { role: r, tag: 'image', label: '' };
  if (k === 'document') return { role: r, tag: 'document', label: '' };
  const tag = r === 'user' ? 'user' : r === 'assistant' ? 'say' : r === 'system' ? 'system-reminder' : 'text';
  const txt = typeof bl === 'string' ? bl : (bl && typeof bl.text === 'string') ? bl.text : '';
  return { role: r, tag, label: shorten(txt) };
}

/** 短预览 for the row body — distinct from head.label, which previews the tool ARGUMENT. */
export const blockPreview = (b) => shorten(bodyTextOf(b));

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
  if (!b || b.sec !== 'messages' || b.role !== 'user' || b.kind !== 'text') return null;
  const raw = bodyTextOf(b);
  const human = String(raw || '').replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  return human ? shorten(human) : null;
}

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
 * JSON, so the original bytes are genuinely gone (see src/etl/ingest.mjs) and no span can honestly
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
export function slimBlock(b, textRef) {
  const out = { ...b };
  out.bytes = blockBytes(b);
  out.chars = blockChars(b);
  out.head = blockHead(b);
  out.preview = blockPreview(b);
  const q = blockQuery(b);
  if (q) out.query = q;   // turn boundary + outline row; see blockQuery for why it is not the browser's job
  if (textRef) {
    // Addressable: drop the body, ship the locator. The browser fetches it on expand.
    for (const k of HEAVY) delete out[k];
    out.text_ref = textRef;
    return out;
  }
  // NOT addressable → keep the body exactly as it was, so the row renders as it always did, and say
  // why it was inlined. Stripping HEAVY here is what produced an unreadable, unfetchable row.
  out.unaddressable = 'no verbatim byte span for this block (re-serialized / v0-converted source) — '
    + 'body inlined as-is, NOT resolved from the raw capture';
  return out;
}
