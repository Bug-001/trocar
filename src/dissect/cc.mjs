// src/dissect/cc.mjs — the single CC (Anthropic / Claude Code) dissector (D25 · "Wireshark for
// agents"). ONE source for the CC block model, consumed by BOTH the board (analyze.linearContext)
// and the ETL (cc.parseBlocks) — retiring the twin parsers that had drifted (each re-derived the
// assembly order, the volatile rule, resource linking). A dissector
// DECLARES its block categories + layout and WALKS a raw request into canonical blocks in assembly
// order; provider-specifics live HERE, never in the shared schema or the frontend (invariant 3).
// Onboarding Codex/DeepSeek (Phase 4) = one more dissector module mirroring this shape — the board /
// ETL projections stay put. "唯有 block 是统一的" — block is the only cross-provider unit (D25).

import { parsedRequestBody } from './request-body.mjs';
import { endpointOf } from './endpoints.mjs';
import { parseBashReads } from './shell-reads.mjs';

// ── declarative block categories + layout ───────────────────────────────────────────────────
// Assembly order = what the model reads top-to-bottom = the Anthropic prompt-cache prefix order:
// tools → system → messages. The request JSON's own key order is an SDK detail and irrelevant.
export const CC_SECTIONS = [
  { id: 'tools', order: 1, category: 'tool-schema', role: 'tool' },
  { id: 'system', order: 2, category: 'system-prompt', role: 'system' },
  { id: 'messages', order: 3, category: 'conversation' }, // role is per-message
];

// ── shared leaf classifiers (single source; both projections import these) ───────────────────

// The billing-header system block carries a per-request nonce (cch=…, cc_prev_req=…) so its bytes
// change every call — yet cache-hit stays ~100%, i.e. the provider EXCLUDES it from the cache key.
// Only system blocks are ever volatile; flagging it keeps cache-break analysis from falsely tripping.
export function isVolatile(section, block) {
  if (section !== 'system') return false;
  const text = typeof block === 'string' ? block : (block && block.text) || '';
  return /^x-anthropic-billing-header/.test(text);
}

// Link a message block to its resource-ledger ids (file / skill / mcp / scaffold): resourceRefs all of them, resourceRef the first or ''.
// The board uses '' inline; the ETL maps '' → null. Labels MUST match extractResources'/addRes' keys
// so the ledger join works. (Unifies the twin msgResKey [board] / resourceRefOf [ETL].)
// `ctx`: what a shell read's path resolves against (harnesses.mjs pathContext); the key and the ledger label come from the one parse.
// Memo by the parsed block: a stitched context hands the same block to every call of its chain (parsed bodies are read-only).
const refMemo = new WeakMap();
export function resourceRefs(b, ctx = {}) {
  if (!b || typeof b !== 'object') return [];
  let r = refMemo.get(b);
  if (r === undefined) refMemo.set(b, (r = resourceRefOf(b, ctx)));
  return r;
}
export const resourceRef = (b, ctx) => resourceRefs(b, ctx)[0] || '';
// a spine entry's keys: `resourceRefs` only when a block has more than one (a shell read of several files)
const refsOf = (b, ctx) => { const r = resourceRefs(b, ctx); return r.length > 1 ? { resourceRef: r[0], resourceRefs: r } : { resourceRef: r[0] || '' }; };
function resourceRefOf(b, ctx) {
  if (b.type === 'text' && typeof b.text === 'string') {
    // the resident SKILL.md body block → link to its skill (basename of "Base directory" === skill)
    const sk = b.text.match(/^Base directory for this skill: (\S+)/);
    if (sk) return ['skill::' + sk[1].split('/').pop()];
    // scaffold (auto-loaded context) → link the verbatim system-reminder block to its ledger resource
    if (/<system-reminder>/.test(b.text)) {
      if (/CLAUDE\.md/i.test(b.text)) return ['scaffold::CLAUDE.md'];
      if (/\bMEMORY\.md\b|auto-memory|persists across conversations/i.test(b.text)) return ['scaffold::memory (MEMORY.md)'];
    }
    return [];
  }
  if (b.type !== 'tool_use') return [];
  if (Array.isArray(b.resKeys)) return b.resKeys; // a tool_use of an earlier record, standing in for its keys (extract.mjs linkStub)
  const p = b.input?.file_path || b.input?.path || b.input?.notebook_path;
  if (p) return ['file::' + p];
  // a Bash read (cat/head/…) makes the files it dumps resident: every one, in command order, once each
  if (b.name === 'Bash' && b.input?.command) { const rd = parseBashReads(b.input.command, ctx); if (rd.length) return [...new Set(rd.map((r) => 'file::' + r.path))]; }
  if (b.name === 'Skill') return ['skill::' + (b.input?.skill || b.input?.command || '')];
  if ((b.name || '').startsWith('mcp__')) return ['mcp::' + (String(b.name).split('__')[1] || '')];
  return [];
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
export function dissectBlocks(req, ctx = {}) {
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
        spine.push({ section: 'messages', seq: seq++, role: m.role, parsed: b, path: { mi, bi, arrayContent: true }, volatile: false, ...refsOf(b, ctx) });
      }
    } else {
      // whole content is a string (or missing) → ONE synthesized text block (matches both parsers)
      const parsed = { type: 'text', text: m.content };
      spine.push({ section: 'messages', seq: seq++, role: m.role, parsed, path: { mi, bi: 0, arrayContent: false }, volatile: false, ...refsOf(parsed, ctx) });
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
// body shape. Never from the UA or a harness session header: those name a harness, not a wire (a UA test
// would claim any Claude-UA traffic).
// `max_tokens` is deliberately NOT a signal: Chat Completions carries it too. An Anthropic body on an OpenAI
// path is still claimed (bytes beat path); openai.mjs `wireShape` refuses exactly these markers, so the two
// detectors stay disjoint.
export function detect(rec) {
  if (!rec) return false;
  const row = endpointOf(rec.endpoint); // the endpoint table (./endpoints.mjs)
  if (row && row.class === 'token-count') return false; // a probe, not an inference call (3.2:134)
  if (row && row.wire === 'anthropic') return true; // incl. relay prefixes (/anthropic, /coding, /api/anthropic)
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
