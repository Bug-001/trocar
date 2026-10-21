// src/dissect/cc.mjs — the single CC (Anthropic / Claude Code) dissector (D25 · "Wireshark for
// agents"). ONE source for the CC block model, consumed by BOTH the board (analyze.linearContext)
// and the ETL (cc.parseBlocks) — retiring the twin parsers that had drifted (each re-derived the
// assembly order, the volatile rule, resource linking, block kind & faithfulness). A dissector
// DECLARES its block categories + layout and WALKS a raw request into canonical blocks in assembly
// order; provider-specifics live HERE, never in the shared schema or the frontend (invariant 3).
// Onboarding Codex/DeepSeek (Phase 4) = one more dissector module mirroring this shape — the board /
// ETL projections stay put. "唯有 block 是统一的" — block is the only cross-provider unit (D25).

import { parsedRequestBody } from './request-body.mjs';

// ── declarative block categories + layout ───────────────────────────────────────────────────
// Assembly order = what the model reads top-to-bottom = the Anthropic prompt-cache prefix order:
// tools → system → messages. The request JSON's own key order is an SDK detail and irrelevant.
export const CC_SECTIONS = [
  { id: 'tools', order: 1, category: 'tool-schema', role: 'tool' },
  { id: 'system', order: 2, category: 'system-prompt', role: 'system' },
  { id: 'messages', order: 3, category: 'conversation' }, // role is per-message
];

// ── shared leaf classifiers (single source; both projections import these) ───────────────────

const BASH_READ = /^(cat|bat|head|tail|tac|nl|less|more|xxd|od|strings)$/;
// A Bash command's READ targets (cat/head/tail/sed -n …) — the files it makes resident in context.
// Skips output redirects (writing), flags, URLs, and globs. (Ported verbatim from the twin parsers.)
export function parseBashReads(command) {
  if (!command || typeof command !== 'string') return [];
  const out = [];
  for (const seg of command.split(/\||&&|;|\n/)) {
    if (/>/.test(seg)) continue; // an output redirect → writing, not reading into context
    const toks = seg.match(/"[^"]*"|'[^']*'|\S+/g);
    if (!toks || !toks.length) continue;
    const cmd = toks[0].replace(/^['"]|['"]$/g, '').split('/').pop();
    const isSed = cmd === 'sed';
    if (!BASH_READ.test(cmd) && !isSed) continue;
    let range = 'full file';
    if (isSed) {
      const sm = seg.match(/-n\s*['"]?(\d+),(\d+)\s*p/);
      if (sm) range = `L${sm[1]}–${sm[2]}`;
      else continue;
    } else {
      const hn = seg.match(/-n?\s*(\d+)\b/);
      if (cmd === 'head' && hn) range = `L1–${hn[1]}`;
      else if (cmd === 'tail' && hn) range = `tail ${hn[1]}`;
    }
    for (const t0 of toks.slice(1)) {
      const t = t0.replace(/^['"]|['"]$/g, '');
      if (t.startsWith('-') || /^[|&;<>]/.test(t) || /^https?:/i.test(t)) continue;
      if (!/[./]/.test(t) || /[*?{}]/.test(t)) continue; // needs a dot or slash; skip globs
      out.push({ path: t, range });
    }
  }
  return out;
}

// The billing-header system block carries a per-request nonce (cch=…, cc_prev_req=…) so its bytes
// change every call — yet cache-hit stays ~100%, i.e. the provider EXCLUDES it from the cache key.
// Only system blocks are ever volatile; flagging it keeps cache-break analysis from falsely tripping.
export function isVolatile(section, block) {
  if (section !== 'system') return false;
  const text = typeof block === 'string' ? block : (block && block.text) || '';
  return /^x-anthropic-billing-header/.test(text);
}

// Normalized block kind for the canonical schema (redacted_thinking folds into thinking). The BOARD
// keeps the raw type (it distinguishes redacted_thinking for its opaque badge) so it does NOT use this.
export function blockKind(block) {
  if (!block || typeof block !== 'object') return 'text';
  const t = block.type || 'text';
  return t === 'redacted_thinking' ? 'thinking' : t;
}

// After a compaction, Claude Code drops the earlier turns and injects a CLIENT-GENERATED summary as
// an ordinary user text block. Anchored at the START of the block: a user who merely QUOTES this
// sentence mid-message is sending real context and MUST stay verbatim. Both wordings below are real
// (fixture cc-session-real.ndjson + live capture); the stable part is the leading sentence, so the
// trailing "summary below…" / "conversation is summarized below" variants are matched loosely.
const COMPACTION_SUMMARY = /^\s*This session is being continued from a previous conversation/;

// Faithfulness (invariant 4): opaque = CC replays only a signature / ciphertext, not
// the reasoning plaintext. summarized = the bytes ARE verbatim, but what they CONTAIN is a client-side
// summary standing in for the original turns, not the original context (spec 2.3:45, enum 3.2:63) —
// unbadged it is indistinguishable from the real earlier conversation. Everything else on the wire is
// verbatim (tools D15, system, text, tool_use, tool_result, image, thinking-with-text).
//
// NOT produced here (honest gap, not an oversight): `truncated`. Per spec 2.3:46 显示剪裁 ≠ 源截断 —
// truncated means the SOURCE was not captured whole, and the CC capture path stores the whole
// req_body; a truncated/corrupt body fails to parse and surfaces at CALL level as the `_unparsed`
// sentinel (analyze.mjs), which yields no blocks at all. The board's ~20,000-char expand clip is
// DISPLAY clipping with the full text still recoverable from the NDJSON source, and 2.3:46 forbids
// conflating the two. `metadata` / `omitted` likewise have no CC producer (see the report).
export function faithfulness(block) {
  if (!block || typeof block !== 'object') return 'verbatim';
  if (block.type === 'redacted_thinking') return 'opaque'; // encrypted reasoning, no plaintext on the wire
  if (block.type === 'thinking' && !(block.thinking && String(block.thinking).length) && block.signature) return 'opaque';
  if (block.type === 'text' && typeof block.text === 'string' && COMPACTION_SUMMARY.test(block.text)) return 'summarized';
  return 'verbatim';
}

// Link a message block to a resource-ledger id (file / skill / mcp / scaffold), or '' when none.
// The board uses '' inline; the ETL maps '' → null. Labels MUST match extractResources'/addRes' keys
// so the ledger join works. (Unifies the twin msgResKey [board] / resourceRefOf [ETL].)
// Memo by the parsed block: a stitched context hands the same block to every call of its chain (parsed bodies are read-only).
const refMemo = new WeakMap();
export function resourceRef(b) {
  if (!b || typeof b !== 'object') return '';
  let r = refMemo.get(b);
  if (r === undefined) refMemo.set(b, (r = resourceRefOf(b)));
  return r;
}
function resourceRefOf(b) {
  if (b.type === 'text' && typeof b.text === 'string') {
    // the resident SKILL.md body block → link to its skill (basename of "Base directory" === skill)
    const sk = b.text.match(/^Base directory for this skill: (\S+)/);
    if (sk) return 'skill::' + sk[1].split('/').pop();
    // scaffold (auto-loaded context) → link the verbatim system-reminder block to its ledger resource
    if (/<system-reminder>/.test(b.text)) {
      if (/CLAUDE\.md/i.test(b.text)) return 'scaffold::CLAUDE.md';
      if (/\bMEMORY\.md\b|auto-memory|persists across conversations/i.test(b.text)) return 'scaffold::memory (MEMORY.md)';
    }
    return '';
  }
  if (b.type !== 'tool_use') return '';
  const p = b.input?.file_path || b.input?.path || b.input?.notebook_path;
  if (p) return 'file::' + p;
  // a Bash read (cat/head/…) makes its first dumped file resident — key the block to that file
  if (b.name === 'Bash' && b.input?.command) { const rd = parseBashReads(b.input.command); if (rd.length) return 'file::' + rd[0].path; }
  if (b.name === 'Skill') return 'skill::' + (b.input?.skill || b.input?.command || '');
  if ((b.name || '').startsWith('mcp__')) return 'mcp::' + (String(b.name).split('__')[1] || '');
  return '';
}

// Short structural label for a system block (Claude Code stacks several). Anchored on the opening
// line so a big prompt block that merely EMBEDS a <system-reminder> is named by its dominant content.
export function sysLabel(text) {
  const t = text || '';
  if (/^x-anthropic-billing-header/.test(t)) return 'billing header';
  if (/^You are (Claude Code|a Claude agent)/.test(t)) return 'identity';
  if (/^\s*You are an interactive agent/.test(t)) return 'agent instructions';
  if (/^\s*<system-reminder>/.test(t)) { // a block that is ITSELF just a reminder
    if (/CLAUDE\.md/i.test(t)) return 'CLAUDE.md';
    if (/\bMEMORY\.md\b|auto-memory|persists across conversations/i.test(t)) return 'memory';
    return 'system-reminder';
  }
  const carries = [];
  if (/CLAUDE\.md/i.test(t)) carries.push('CLAUDE.md');
  if (/\bMEMORY\.md\b|auto-memory|persists across conversations/i.test(t)) carries.push('memory');
  return 'system prompt' + (carries.length ? ' +' + carries.join(' +') : '');
}

// ── the single ordered walk: raw request object → canonical block spine (assembly order) ─────
// Each entry carries the parsed block + its index PATH (so the ETL can resolve the VERBATIM byte
// node via scanJson at the same position) + shared classifications. The board / ETL projections map
// over this spine; neither re-walks. `path`: {i} for tools/system (str:true when system is a bare
// string), {mi, bi, arrayContent} for messages. Order MUST stay tools→system→messages (cache prefix).
export function dissectBlocks(req) {
  const spine = [];
  let seq = 0;
  const tools = Array.isArray(req?.tools) ? req.tools : [];
  for (let i = 0; i < tools.length; i++)
    spine.push({ section: 'tools', seq: seq++, role: 'tool', parsed: tools[i], path: { i }, volatile: false, resourceRef: '' });
  const sys = req?.system;
  if (typeof sys === 'string')
    spine.push({ section: 'system', seq: seq++, role: 'system', parsed: sys, path: { i: 0, str: true }, volatile: isVolatile('system', sys), resourceRef: '' });
  else if (Array.isArray(sys))
    for (let i = 0; i < sys.length; i++)
      spine.push({ section: 'system', seq: seq++, role: 'system', parsed: sys[i], path: { i }, volatile: isVolatile('system', sys[i]), resourceRef: '' });
  const messages = Array.isArray(req?.messages) ? req.messages : [];
  for (let mi = 0; mi < messages.length; mi++) {
    const m = messages[mi];
    if (Array.isArray(m.content)) {
      for (let bi = 0; bi < m.content.length; bi++) {
        const b = m.content[bi]; // raw element (usually an object, rarely a bare string)
        spine.push({ section: 'messages', seq: seq++, role: m.role, parsed: b, path: { mi, bi, arrayContent: true }, volatile: false, resourceRef: resourceRef(b) });
      }
    } else {
      // whole content is a string (or missing) → ONE synthesized text block (matches both parsers)
      const parsed = { type: 'text', text: m.content };
      spine.push({ section: 'messages', seq: seq++, role: m.role, parsed, path: { mi, bi: 0, arrayContent: false }, volatile: false, resourceRef: resourceRef(parsed) });
    }
  }
  return spine;
}

// 3.2:52 context_state 'server_edited': the RESPONSE reports that the server edited the context it was
// given (Anthropic context management, `context_management.applied_edits`), so the request bytes are not
// exactly what the model saw. Read from a JSON body or any streamed event carrying it. The wire shape is
// still to be confirmed against a real capture; until then a response without the field reads 'complete'.
export function serverEdited(rec) {
  const resp = (rec && (rec.resp || rec.response)) || {};
  const hit = (o) => !!(o && typeof o === 'object' && o.context_management
    && Array.isArray(o.context_management.applied_edits) && o.context_management.applied_edits.length > 0);
  if (resp.body && typeof resp.body === 'object' && hit(resp.body)) return true;
  for (const e of Array.isArray(resp.raw_sse) ? resp.raw_sse : []) if (hit(e) || hit(e && e.message) || hit(e && e.delta)) return true;
  return false;
}

// D37 ① / 3.1:23 — the Anthropic Messages WIRE, read from the endpoint, the wire-protocol headers and the
// body shape. Never from the UA or a harness session header: those name a harness, not a wire. (Moved
// from src/view/assemble.mjs `looksCC`, which used both and so claimed any Claude-UA traffic.)
// `max_tokens` is deliberately NOT a signal: Chat Completions carries it too. An Anthropic body on an OpenAI
// path is still claimed (bytes beat path); openai.mjs `wireShape` refuses exactly these markers, so the two
// detectors stay disjoint.
const epPath = (rec) => String((rec && rec.endpoint) || '').split('?')[0];
export function detect(rec) {
  if (!rec) return false;
  const ep = epPath(rec);
  if (ep.includes('count_tokens')) return false; // a probe, not an inference call (3.2:134)
  if (/(^|\/)v1\/messages$/.test(ep)) return true; // incl. relay prefixes (/anthropic, /coding, /api/anthropic)
  const h = (rec.req_headers || rec.request_headers) || {};
  if (h['anthropic-version'] || h['anthropic-beta']) return true;
  let body = parsedRequestBody(rec);   // parsed once per record, for every reader (./request-body.mjs)
  if (body && typeof body !== 'object') body = null;
  if (!body || !Array.isArray(body.messages) || Array.isArray(body.input)) return false;
  if (body.system !== undefined) return true;
  const tools = Array.isArray(body.tools) ? body.tools : [];
  if (tools.some((t) => t && t.input_schema !== undefined)) return true;
  return body.messages.some((m) => Array.isArray(m && m.content)
    && m.content.some((c) => c && (c.type === 'tool_use' || c.type === 'tool_result')));
}
