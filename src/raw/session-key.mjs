// src/raw/session-key.mjs — which session a raw line belongs to, for the D35 per-session layout.
//
// D20 的 D35 修订: the raw layer may read the dissector-declared REQUEST-HEADER
// session key and nothing else — no body parse, no identity or lineage judgement (that stays in ETL,
// 3.4). So this cuts out exactly the envelope's header object and parses only that. The envelope
// writes `req_headers` before `req_body` (src/capture/envelope.mjs; 4.6 §记录 appends new fields after
// `req_body`), so a match that comes after the first `"req_body":` is inside the body and is ignored —
// the same bound `src/etl/shard.mjs::sessionIdOfLine` uses.
import { sessionKeyOfHeaders } from '../dissect/session-headers.mjs';

const KEYS = [Buffer.from('"req_headers":{'), Buffer.from('"request_headers":{')];
const BODY = [Buffer.from('"req_body":'), Buffer.from('"request":')];

// From the '{' at `start`, the index just past its matching '}' (string- and escape-aware), or -1.
function objectEnd(buf, start) {
  let depth = 0, inStr = false;
  for (let i = start; i < buf.length; i++) {
    const c = buf[i];
    if (inStr) { if (c === 0x5c) i++; else if (c === 0x22) inStr = false; continue; }
    if (c === 0x22) inStr = true;
    else if (c === 0x7b) depth++;
    else if (c === 0x7d && --depth === 0) return i + 1;
  }
  return -1;
}

export function sessionKeyOfLine(line) {
  for (let k = 0; k < KEYS.length; k++) {
    const at = line.indexOf(KEYS[k]);
    if (at < 0) continue;
    if (BODY.some((b) => { const p = line.indexOf(b); return p >= 0 && p < at; })) continue;   // inside a body
    const open = at + KEYS[k].length - 1;
    const end = objectEnd(line, open);
    if (end < 0) return null;
    let h;
    try { h = JSON.parse(line.toString('utf8', open, end)); } catch { return null; }
    const key = sessionKeyOfHeaders(h);
    return key == null ? null : String(key);
  }
  return null;
}
