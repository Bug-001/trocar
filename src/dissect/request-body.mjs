// src/dissect/request-body.mjs — compressed request bodies, read side (RFC 4.6 §记录 「压缩的请求体」, 3.1 跨记录拼接与
// 「不完整」, 3.2:132). On an LLM endpoint the collector keeps the wire bytes in req_body_b64 and the header in
// req_content_encoding; it decodes what it can (gzip) into req_body and leaves req_body:null + req_encoding_error
// otherwise (zstd, always). The READER decodes first, then dissects as usual, and labels only what it cannot
// decode (capture-labels.mjs). A WebSocket envelope's req_body_b64 (a first client message that is not text)
// carries no req_content_encoding and is left alone.
//
// In memory only: the source line is never rewritten (invariant 2); provenance is a non-enumerable stamp, so the
// record still serializes as captured. The board loader, the ETL loader and the resolver all call this one
// function, so a text_ref's offsets mean the same decoded text everywhere. Leaf module (node: built-ins only).
import zlib from 'node:zlib';

const UTF8 = new TextDecoder('utf-8', { fatal: true });
// A body that decompresses past this is not expanded (a bomb, or not a request): it is labelled, not loaded.
export const MAX_DECODED_BYTES = 256 * 1024 * 1024;

// The wire content-encoding of the request body, or null (no encoding, or `identity`).
export function requestEncodingOf(rec) {
  const e = rec && rec.req_content_encoding;
  if (typeof e !== 'string') return null;
  const codings = e.split(',').map((s) => s.trim().toLowerCase()).filter((s) => s && s !== 'identity');
  return codings.length ? e.trim() : null;
}

function decode(buf, encoding, maxBytes) {
  let cur = buf;
  const o = { maxOutputLength: maxBytes };
  const codings = String(encoding).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  for (let i = codings.length - 1; i >= 0; i--) { // applied left to right on the wire, so undone right to left
    const c = codings[i];
    if (c === 'gzip' || c === 'x-gzip') cur = zlib.gunzipSync(cur, o);
    else if (c === 'deflate') cur = zlib.inflateSync(cur, o);
    else if (c === 'br') cur = zlib.brotliDecompressSync(cur, o);
    else if (c === 'zstd' && typeof zlib.zstdDecompressSync === 'function') cur = zlib.zstdDecompressSync(cur, o);
    else if (c !== 'identity') throw new Error(`the reader cannot decode content-encoding "${c}" (Node ${process.versions.node})`);
  }
  try { return UTF8.decode(cur); } catch { throw new Error(`the decoded body (${encoding}) is not UTF-8 text`); }
}

const stamp = (rec, k, v) => Object.defineProperty(rec, k, { value: v, enumerable: false, configurable: true, writable: true });

// → rec (the same object). Idempotent. Sets rec.req_body to the decoded text and stamps _reqBodyFrom =
// 'reader-decoded'; on failure leaves req_body as it was and stamps _reqBodyDecodeError = <reason>.
export function expandRequestBody(rec, { maxBytes = MAX_DECODED_BYTES } = {}) {
  if (!rec || typeof rec !== 'object' || typeof rec.req_body === 'string') return rec;
  if (rec._reqBodyFrom || rec._reqBodyDecodeError) return rec; // already tried
  if (typeof rec.req_body_b64 !== 'string' || !requestEncodingOf(rec)) return rec;
  try {
    rec.req_body = decode(Buffer.from(rec.req_body_b64, 'base64'), rec.req_content_encoding, maxBytes);
    stamp(rec, '_reqBodyFrom', 'reader-decoded');
  } catch (e) {
    const m = String((e && e.message) || e);
    stamp(rec, '_reqBodyDecodeError', /maxOutputLength|output length/i.test(m) || (e && e.code === 'ERR_BUFFER_TOO_LARGE')
      ? `the decoded body is over the reader's ${maxBytes}-byte limit` : m);
  }
  return rec;
}
