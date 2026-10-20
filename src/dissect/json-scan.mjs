// src/dissect/json-scan.mjs — where each value sits in a JSON text, by byte offset: what a text_ref (4.2:40) points at and what
// content_hash (src/adapters/content-hash.mjs) hashes. Leaf module.

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

// Walk a scanJson tree by a JSON path (object keys / array indexes) → that value's node, or null when the path does not exist in
// the bytes (the caller then ships the block unaddressed and says so). spanAt → its [start, end).
export function nodeAt(root, path) {
  let n = root;
  for (const k of path || []) {
    if (!n) return null;
    if (n.kind === 'object') n = n.props.get(String(k));
    else if (n.kind === 'array' && Number.isInteger(k)) n = n.items[k];
    else return null;
  }
  return n || null;
}
export function spanAt(root, path) {
  const n = nodeAt(root, path);
  return n ? [n.start, n.end] : null;
}
// A node with what lies more than `depth` levels below it dropped (offsets stay absolute): what a locator keeps of a value whose
// blocks are addressed at most that deep, without holding the scan of everything inside it.
export function pruned(n, depth) {
  if (!n) return null;
  if (depth <= 0 || (n.kind !== 'object' && n.kind !== 'array')) return { kind: n.kind === 'object' || n.kind === 'array' ? 'leaf' : n.kind, start: n.start, end: n.end };
  return n.kind === 'object'
    ? { kind: 'object', start: n.start, end: n.end, props: new Map([...n.props].map(([k, v]) => [k, pruned(v, depth - 1)])) }
    : { kind: 'array', start: n.start, end: n.end, items: n.items.map((v) => pruned(v, depth - 1)) };
}
