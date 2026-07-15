// src/adapters/content-hash.mjs — D19: content_hash = full sha-256 over a block's
// VERBATIM serialized bytes (the bytes exactly as captured in req_body), NOT a
// JSON.parse -> JSON.stringify re-serialization.
//
// WHY byte-exact (the moat): content_hash is BOTH the dedup PK (3.2) AND the
// cache-break divergence signal (3.3/D17①). Re-serializing would normalize
// whitespace, key order, number formatting, and unicode escaping — masking the
// exact wire-byte changes (json-key-reorder, tool-array-reorder, formatting
// drift) that D17① must DETECT. So we hash the raw substring of req_body that a
// block occupies. Key-order canonicalization is used ONLY for divergence_cause
// CLASSIFICATION (3.3), never for this hash.
import { createHash } from 'node:crypto';

// sha-256 hex of the UTF-8 bytes of a string.
export function contentHash(s) {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

// Hash the verbatim serialization of a scanned node (slice of the source text).
export function hashSpan(text, node) {
  return contentHash(text.slice(node.start, node.end));
}

// [start, end) offsets of a scanned node (for text_ref / byte-offset回源).
export function spanOf(node) {
  return [node.start, node.end];
}

// Minimal span-tracking JSON scanner. Parses `text` and returns a node tree where
// every value carries { start, end } string offsets into the ORIGINAL text, so a
// caller can slice the exact wire serialization of any sub-value.
//   node = { kind:'object', props:Map<key,node>, start, end }
//        | { kind:'array',  items:node[],        start, end }
//        | { kind:'string'|'literal',            start, end }
// Whitespace between tokens is excluded from a value's [start,end); the span is
// from the value's first non-ws char to just past its last char.
export function scanJson(text) {
  let i = 0;
  const N = text.length;

  const isWs = (c) => c === 32 || c === 9 || c === 10 || c === 13;
  const skipWs = () => { while (i < N && isWs(text.charCodeAt(i))) i++; };

  function parseString() {
    // precondition: text[i] === '"'
    i++; // opening quote
    while (i < N) {
      const ch = text[i];
      if (ch === '\\') { i += 2; continue; } // skip escaped char
      if (ch === '"') { i++; return; }
      i++;
    }
    throw new Error(`scanJson: unterminated string at ${i}`);
  }

  function parseLiteral() {
    // number | true | false | null — consume until a structural/ws boundary.
    const start = i;
    while (i < N) {
      const ch = text[i];
      if (ch === ',' || ch === '}' || ch === ']' || isWs(text.charCodeAt(i))) break;
      i++;
    }
    if (i === start) throw new Error(`scanJson: unexpected char '${text[i]}' at ${i}`);
    return { kind: 'literal' };
  }

  function parseObject() {
    i++; // {
    const props = new Map();
    skipWs();
    if (text[i] === '}') { i++; return { kind: 'object', props }; }
    for (;;) {
      skipWs();
      if (text[i] !== '"') throw new Error(`scanJson: expected object key at ${i}`);
      const keyStart = i;
      parseString();
      const key = JSON.parse(text.slice(keyStart, i));
      skipWs();
      if (text[i] !== ':') throw new Error(`scanJson: expected ':' at ${i}`);
      i++; // :
      props.set(key, parseValue());
      skipWs();
      if (text[i] === ',') { i++; continue; }
      if (text[i] === '}') { i++; break; }
      throw new Error(`scanJson: expected ',' or '}' at ${i}`);
    }
    return { kind: 'object', props };
  }

  function parseArray() {
    i++; // [
    const items = [];
    skipWs();
    if (text[i] === ']') { i++; return { kind: 'array', items }; }
    for (;;) {
      items.push(parseValue());
      skipWs();
      if (text[i] === ',') { i++; continue; }
      if (text[i] === ']') { i++; break; }
      throw new Error(`scanJson: expected ',' or ']' at ${i}`);
    }
    return { kind: 'array', items };
  }

  function parseValue() {
    skipWs();
    const start = i;
    const c = text[i];
    let node;
    if (c === '{') node = parseObject();
    else if (c === '[') node = parseArray();
    else if (c === '"') { parseString(); node = { kind: 'string' }; }
    else node = parseLiteral();
    node.start = start;
    node.end = i;
    return node;
  }

  const root = parseValue();
  skipWs();
  if (i !== N) throw new Error(`scanJson: trailing content at ${i}`);
  return root;
}
