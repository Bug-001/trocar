// Seal v2 cut points (4.2 §封存格式 · 编码器, SHOULD). cutPoints(line) is a pure function of the line
// bytes: it knows JSON syntax only — no field names, providers or harnesses. The points only steer how
// well repeated content dedupes across records; any tiling is correct, so every failure degrades to CDC.
//   · a JSON container spanning > MAX bytes is cut at each member / element start, recursively;
//   · a string whose content starts with { or [ is descended one level through an escape-aware view
//     (level-0 \" is a level-1 quote, \\ a level-1 backslash) — envelopes carry bodies as JSON strings;
//   · long plain strings, spans nested deeper than DEPTH and anything that does not tokenize: gear CDC.

const MAX = 1024, DEPTH = 64;
const CMIN = 512, CMAX = 16384, MASK = (1 << 11) - 1; // CDC: ≥ 512 B, ~2 KB average, ≤ 16 KB
const GEAR = new Uint32Array(256);
{ let s = 0x9e3779b9; for (let i = 0; i < 256; i++) { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; GEAR[i] = s >>> 0; } }

const LBRACE = 0x7b, LBRACK = 0x5b, RBRACE = 0x7d, RBRACK = 0x5d, QUOTE = 0x22, BSLASH = 0x5c;
const isWs = (c) => c === 32 || c === 10 || c === 13 || c === 9;

// The character at byte p in view lvl (0 = bytes as is; 1 = inside a level-0 string, escapes decoded),
// and the byte where the next character starts — clamped to the span end e, so a truncated \u or a
// trailing backslash never moves past it.
function ch(b, p, lvl) {
  const c = b[p];
  if (lvl === 0 || c !== BSLASH) return c;
  const d = b[p + 1];
  return d === QUOTE || d === BSLASH ? d : d === 0x6e ? 10 : d === 0x74 ? 9 : d === 0x72 ? 13 : 0x61;
}
function nx(b, p, e, lvl) {
  if (lvl === 0 || b[p] !== BSLASH) return p + 1;
  const q = p + (b[p + 1] === 0x75 ? 6 : 2);
  return q < e ? q : e;
}
function skipWs(b, p, e, lvl) { while (p < e && isWs(ch(b, p, lvl))) p = nx(b, p, e, lvl); return p; }
function skipString(b, p, e, lvl) {
  for (p = nx(b, p, e, lvl); p < e;) {
    const d = ch(b, p, lvl);
    p = nx(b, p, e, lvl);
    if (d === QUOTE) return p;
    if (d === BSLASH && p < e) p = nx(b, p, e, lvl);
  }
  return e;
}
// End of the value starting at (or after whitespace from) p; never before p + 1 when p < e.
function skipValue(b, p, e, lvl) {
  p = skipWs(b, p, e, lvl);
  if (p >= e) return e;
  const c = ch(b, p, lvl);
  if (c === QUOTE) return skipString(b, p, e, lvl);
  if (c === LBRACE || c === LBRACK) {
    for (let depth = 0; p < e;) {
      const d = ch(b, p, lvl);
      if (d === QUOTE) { p = skipString(b, p, e, lvl); continue; }
      p = nx(b, p, e, lvl);
      if (d === LBRACE || d === LBRACK) depth++;
      else if ((d === RBRACE || d === RBRACK) && --depth === 0) return p;
    }
    return e;
  }
  const s = p;
  while (p < e) { const d = ch(b, p, lvl); if (d === 0x2c || d === RBRACE || d === RBRACK || d === 0x3a || isWs(d)) break; p = nx(b, p, e, lvl); }
  return p > s ? p : nx(b, s, e, lvl);
}

function cdc(b, s, e, cuts) {
  let h = 0, last = s;
  for (let p = s; p < e; p++) {
    h = ((h << 1) + GEAR[b[p]]) >>> 0;
    const len = p + 1 - last;
    if ((len >= CMIN && (h & MASK) === 0) || len >= CMAX) { cuts.push(p + 1); last = p + 1; h = 0; }
  }
}

// The value occupying bytes [s, e) in view lvl.
function split(b, s, e, lvl, cuts, depth) {
  if (e - s <= MAX) return;
  if (depth >= DEPTH) return cdc(b, s, e, cuts);
  const c = ch(b, s, lvl);
  if (c === LBRACE || c === LBRACK) return container(b, s, e, lvl, cuts, depth + 1);
  if (c === QUOTE) {
    const is = nx(b, s, e, lvl);
    if (lvl === 0) {
      const k = skipWs(b, is, e, 1);
      const d = k < e ? ch(b, k, 1) : -1;
      if (d === LBRACE || d === LBRACK) return container(b, k, e, 1, cuts, depth + 1);
    }
    return cdc(b, is, e, cuts);
  }
  cdc(b, s, e, cuts);
}

// Container starting at s (after whitespace) within [s, e): cut at each member / element start.
function container(b, s, e, lvl, cuts, depth) {
  let p = skipWs(b, s, e, lvl);
  const open = p < e ? ch(b, p, lvl) : -1;
  if (open !== LBRACE && open !== LBRACK) return cdc(b, s, e, cuts);
  e = skipValue(b, p, e, lvl);
  p = nx(b, p, e, lvl);
  while (p < e) {
    const d = ch(b, p, lvl);
    if (isWs(d) || d === 0x2c) { p = nx(b, p, e, lvl); continue; }
    if (d === RBRACE || d === RBRACK) break;
    cuts.push(p);
    let vs = p;
    if (open === LBRACE) {
      vs = skipValue(b, p, e, lvl);
      while (vs < e && (ch(b, vs, lvl) === 0x3a || isWs(ch(b, vs, lvl)))) vs = nx(b, vs, e, lvl);
      if (vs >= e) break;
    }
    const ve = skipValue(b, vs, e, lvl);
    split(b, skipWs(b, vs, ve, lvl), ve, lvl, cuts, depth);
    p = ve > p ? ve : nx(b, p, e, lvl);
  }
}

/** Cut points of one raw line: strictly increasing, first 0, last line.length ([0] for an empty line). */
export function cutPoints(line) {
  const n = line.length;
  if (n === 0) return [0];
  let cuts = [];
  try { container(line, 0, n, 0, cuts, 0); } catch { cuts = []; cdc(line, 0, n, cuts); }
  const sorted = Float64Array.from(cuts).sort();
  const out = [0];
  for (const c of sorted) if (c > out[out.length - 1] && c < n) out.push(c);
  out.push(n);
  return out;
}
