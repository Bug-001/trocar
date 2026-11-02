// src/dissect/cc-spans.mjs — the D19 verbatim byte span of every block of an Anthropic-wire request.
// Read by the board (src/view/assemble.mjs, src/view/extract.mjs) to mint each block's text_ref locator
// instead of shipping its body. The block walk itself is the CC dissector's (./cc.mjs dissectBlocks), so
// span[i] belongs to the same block as linearContext()[i]. Leaf module (0.1: src/dissect imports no other src).
import { scanJson } from './json-scan.mjs';
import { storedRequestBody, scannedRequestBody } from './request-body.mjs';
import { dissectBlocks } from './cc.mjs';

// D10: req_body is the VERBATIM captured request bytes (a string); spans are byte offsets into it.
function reqSource(record) {
  const b = record?.req_body;
  if (typeof b === 'string') return b;
  if (b == null) return '{}';
  // Fallback only (real D10 envelopes carry a string): if an already-parsed object
  // slips in, serialize it so spans still work — a documented degradation, NOT the norm.
  try {
    return JSON.stringify(b);
  } catch {
    return '{}';
  }
}

// SPANS ONLY — the dissector's block walk, stopping before the expensive part.
//
// The board needs each block's byte span so it can mint a text_ref and ship a LOCATOR instead of the
// body (RFC 4.2:55 「看全文=回源」). It does NOT need each block's verbatim text sliced out of
// req_body and hashed: materialising every block's text is the exact allocation the locator exists to avoid,
// so this returns the spans and nothing else. Same spine (dissectBlocks), so span[i] belongs to the
// same block as linearContext()[i], which is what makes indexing by position sound.
//
// A null entry is a block whose bytes could not be located (malformed source). It stays null rather
// than being filled with a guess: the row then says its body is unresolvable instead of showing
// someone else's bytes (invariant 2/4).
export function blockSpans(record) {
  let req, root = null;
  if (typeof record?.req_body === 'string') { // the record's one parse and one scan of its stored body (src/dissect/request-body.mjs)
    req = storedRequestBody(record) ?? {};
    root = scannedRequestBody(record);
  } else { // not a stored string (null, or an object that slipped in): no memo covers it; the object is its own parse
    const b = record?.req_body;
    req = b && typeof b === 'object' ? b : {};
    try { root = scanJson(reqSource(record)) } catch { root = null }
  }
  const props = root && root.kind === 'object' ? root.props : new Map();
  const toolsNode = props.get('tools');
  const sysNode = props.get('system');
  const msgsNode = props.get('messages');
  const nodeFor = (e) => {
    if (e.section === 'tools') return toolsNode && toolsNode.kind === 'array' ? toolsNode.items[e.path.i] : null;
    if (e.section === 'system') {
      if (e.path.str) return sysNode;
      return sysNode && sysNode.kind === 'array' ? sysNode.items[e.path.i] : null;
    }
    const mNode = msgsNode && msgsNode.kind === 'array' ? msgsNode.items[e.path.mi] : null;
    const contentNode = mNode && mNode.kind === 'object' ? mNode.props.get('content') : null;
    if (e.path.arrayContent) return contentNode && contentNode.kind === 'array' ? contentNode.items[e.path.bi] : null;
    return contentNode && contentNode.kind === 'string' ? contentNode : null;
  };
  return dissectBlocks(req).map((e) => { const n = nodeFor(e); return n ? [n.start, n.end] : null });
}
