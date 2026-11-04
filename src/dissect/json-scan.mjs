// src/dissect/json-scan.mjs — where each value sits in a JSON text, by byte offset: what a text_ref (4.2:40) points at and what
// blockSpans (src/dissect/cc-spans.mjs) reads. Leaf module.

// Minimal span-tracking JSON scanner. Parses `text` and returns a node tree where
// every value carries { start, end } string offsets into the ORIGINAL text, so a
// caller can slice the exact wire serialization of any sub-value.
//   node = { kind:'object', props:Map<key,node>, shadowed?:node[], start, end }
//        | { kind:'array',  items:node[],        start, end }
//        | { kind:'string'|'literal',            start, end }
// Whitespace between tokens is excluded from a value's [start,end); the span is
// from the value's first non-ws char to just past its last char. `props` holds the
// last value of a repeated key, as JSON.parse does; `shadowed`, only on an object that
// repeats one, holds the values it hid, which a reader that takes the first one still sees.
// Object keys, each a copy of its own: never a slice of the text, which would keep the whole text (a multi-MB request body) alive
// for as long as the tree or a key of it is kept (V8 slices strings of 13+ chars). Keys repeat across bodies, so each distinct
// short one (the API's names: cache_control, input_schema) is copied once and shared; the table is bounded in entries and in each
// entry's length, so it never holds more than a few hundred KB however long the keys of a tool's input are (a long key is copied
// afresh every time and goes with its tree), and starts over when full.
const KEYS = new Map();
const KEYS_MAX = 4096;
const KEY_SHARED_CHARS = 64;
function keyOf(text, open, close) {
  const raw = text.slice(open + 1, close - 1);   // a temporary: looked up, never kept
  if (raw.length > KEY_SHARED_CHARS || raw.includes('\\')) return JSON.parse(text.slice(open, close));
  let key = KEYS.get(raw);
  if (key === undefined) {
    if (KEYS.size >= KEYS_MAX) KEYS.clear();
    key = JSON.parse(text.slice(open, close));   // a fresh flat string
    KEYS.set(key, key);
  }
  return key;
}

export function scanJson(text) {
  let i = 0;
  const N = text.length;

  const isWs = (c) => c === 32 || c === 9 || c === 10 || c === 13;
  const skipWs = () => { while (i < N && isWs(text.charCodeAt(i))) i++; };

  // A string ends at the first '"' preceded by an EVEN run of backslashes (the run never reaches back past the opening quote):
  // indexOf jumps over the body instead of stepping it char by char — request bodies are megabytes of string (3.5 #21).
  function parseString() {
    // precondition: text[i] === '"'
    const open = i;
    for (let from = i + 1; ;) {
      const q = text.indexOf('"', from);
      if (q === -1) { i = N; throw new Error(`scanJson: unterminated string at ${i}`); }
      let b = q - 1;
      while (b > open && text.charCodeAt(b) === 92) b--;
      if ((q - 1 - b) % 2 === 0) { i = q + 1; return; }
      from = q + 1;
    }
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
    let shadowed = null;
    skipWs();
    if (text[i] === '}') { i++; return { kind: 'object', props }; }
    for (;;) {
      skipWs();
      if (text[i] !== '"') throw new Error(`scanJson: expected object key at ${i}`);
      const keyStart = i;
      parseString();
      const key = keyOf(text, keyStart, i);
      skipWs();
      if (text[i] !== ':') throw new Error(`scanJson: expected ':' at ${i}`);
      i++; // :
      const value = parseValue();
      if (props.has(key)) (shadowed ??= []).push(props.get(key));
      props.set(key, value);
      skipWs();
      if (text[i] === ',') { i++; continue; }
      if (text[i] === '}') { i++; break; }
      throw new Error(`scanJson: expected ',' or '}' at ${i}`);
    }
    return shadowed ? { kind: 'object', props, shadowed } : { kind: 'object', props };
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
