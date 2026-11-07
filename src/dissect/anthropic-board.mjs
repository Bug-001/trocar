// src/dissect/anthropic-board.mjs — the Anthropic Messages wire's row of the board table (./registry.mjs BOARD).
// Its board path folds lanes into a tree (fold: 'tree'); the parts of that path that must stay in src/view
// (the multi-lane analyzer) are looked up there by `fold`, so this row carries only leaf-safe data and hooks.
// Leaf module.
import { CC_SECTIONS, resourceRef, replyEnd } from './cc.mjs';
import { respOf } from './record-fields.mjs';
import { CC_THREADS } from './cc-threads.mjs';
import { streamParts } from './sse-spans.mjs';

// The reply's blocks as addressable parts (sse-spans.mjs): the wire key is content_block_*'s `index`; the block is the
// collector's own reconstruction (content_blocks: one per started index, in index order), a JSON reply's content as given.
const REPLY = {
  keysOf: (e) => (/^content_block_/.test(e.type || '') && Number.isInteger(e.index) ? [String(e.index)] : []),
  build: (k, evts, all, part) => {
    const started = [...new Set(all.filter((e) => e && e.type === 'content_block_start' && Number.isInteger(e.index)).map((e) => e.index))].sort((a, b) => a - b)
    const b = Array.isArray(part.content_blocks) ? part.content_blocks[started.indexOf(Number(k))] : undefined
    return b ? [b] : 'the stream has no start event for this block, so the collector did not rebuild it'
  },
  jsonBlocks: (body) => (Array.isArray(body.content) ? body.content : []),
};

export const ANTHROPIC = Object.freeze({
  id: 'anthropic', fold: 'tree',
  blockKeys: Object.freeze(CC_SECTIONS.map((x) => x.id)),
  replyParts: (rec) => streamParts(rec, REPLY),
  linker: CC_THREADS,
  rules: Object.freeze({
    links: true, resourceRef,
    faith: (bl) => ((bl.type === 'thinking' || bl.type === 'redacted_thinking') && bl.signature && !(bl.thinking || bl.text) ? 'opaque' : undefined),
  }),
  tsOf: (x) => (x.facts || {}).ts_request, // a call row's own ts on this wire
  usageOf: (x) => x.facts && x.facts.usage, // the provider usage a call row carries
  spawns: true, monitors: true, // its lanes have sub-agent spawns and a security monitor
  ended: (norm, rec) => replyEnd(respOf(rec)), // the reply's own terminal (3.1 `ended`), read from the stored reply: this row has no normResp
});
