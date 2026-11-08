// src/dissect/anthropic-board.mjs — the Anthropic Messages wire's row of the board table (./registry.mjs BOARD).
// Its board path folds lanes into a tree (fold: 'tree'); the parts of that path that must stay in src/view
// (the multi-lane analyzer) are looked up there by `fold`, so this row carries only leaf-safe data and hooks.
// Leaf module.
import { CC_SECTIONS, resourceRef, resourceRefs } from './cc.mjs';
import { CC_THREADS } from './cc-threads.mjs';
import { streamParts } from './sse-spans.mjs';

// The reply's blocks as addressable parts (sse-spans.mjs): the wire key is content_block_*'s `index`; the block is the block
// its start event carried under the collector's own reconstruction (content_blocks: one per started index, in index order),
// which keeps only some types' fields, plus what only this key's deltas hold: citations, and streamed input of any block type
// (the reconstruction spoils it for a type it does not know). A JSON reply's content is as given.
const parsedInput = (json) => { try { return json ? JSON.parse(json) : {} } catch { return { _unparsed: json } } };
const REPLY = {
  keysOf: (e) => (/^content_block_/.test(e.type || '') && Number.isInteger(e.index) ? [String(e.index)] : []),
  build: (k, evts, all, part) => {
    const started = [...new Set(all.filter((e) => e && e.type === 'content_block_start' && Number.isInteger(e.index)).map((e) => e.index))].sort((a, b) => a - b)
    const b = Array.isArray(part.content_blocks) ? part.content_blocks[started.indexOf(Number(k))] : undefined
    if (!b) return 'the stream has no start event for this block, so the collector did not rebuild it'
    const out = { ...evts.find((e) => e.type === 'content_block_start').content_block, ...b }
    const deltas = evts.flatMap((e) => (e.type === 'content_block_delta' && e.delta ? [e.delta] : []))
    const cited = deltas.filter((d) => d.type === 'citations_delta').map((d) => d.citation)
    if (cited.length) out.citations = [...(out.citations || []), ...cited]
    const json = deltas.filter((d) => d.type === 'input_json_delta')
    if (json.length) out.input = parsedInput(json.map((d) => d.partial_json || '').join(''))
    return [out]
  },
  jsonNodes: (body) => (Array.isArray(body.content) ? body.content : []).map((block, i) => ({ block, path: ['content', i] })),
};
// reasoning with no plaintext on the wire: a thinking block with its signature only, a redacted block with its data
export const sealedThinking = (bl) => (bl.type === 'redacted_thinking' || (bl.type === 'thinking' && bl.signature)) && !(bl.thinking || bl.text);

export const ANTHROPIC = Object.freeze({
  id: 'anthropic', fold: 'tree',
  blockKeys: Object.freeze(CC_SECTIONS.map((x) => x.id)),
  replyParts: (rec) => streamParts(rec, REPLY),
  linker: CC_THREADS,
  rules: Object.freeze({
    links: true, resourceRef, resourceRefs,
    faith: (bl) => (sealedThinking(bl) ? 'opaque' : undefined),
  }),
  tsOf: (x) => (x.facts || {}).ts_request, // a call row's own ts on this wire
  usageOf: (x) => x.facts && x.facts.usage, // the provider usage a call row carries
  spawns: true, monitors: true, // its lanes have sub-agent spawns and a security monitor
});
