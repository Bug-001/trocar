// src/dissect/request-body.mjs — compressed request bodies, read side (RFC 4.6 §记录 「压缩的请求体」, 3.1 跨记录拼接与
// 「不完整」, 3.2:132). On an LLM endpoint the collector keeps the wire bytes in req_body_b64 and the header in
// req_content_encoding; it decodes what it can (gzip) into req_body and leaves req_body:null + req_encoding_error
// otherwise (zstd, always). The READER decodes first, then dissects as usual, and labels only what it cannot
// decode (capture-labels.mjs). A WebSocket envelope's req_body_b64 (a first client message that is not text)
// carries no req_content_encoding and is left alone.
//
// In memory only: the source line is never rewritten (invariant 2); provenance is a non-enumerable stamp, so the
// record still serializes as captured. The board loader, the ETL loader and the resolver all call this one
// function, so a text_ref's offsets mean the same decoded text everywhere. Imports node: built-ins and the leaf scanner only.
import zlib from 'node:zlib';
import { scanJson } from './json-scan.mjs';

const UTF8 = new TextDecoder('utf-8', { fatal: true });
// A body that decompresses past this is not expanded (a bomb, or not a request): it is labelled, not loaded.
export const MAX_DECODED_BYTES = 256 * 1024 * 1024;
// D40: any host of any agent can now send a compressed body, not only an inference endpoint, so a record that is not an inference call
// is expanded only up to this much (the board shows no more than 1 MiB of a body anyway, src/view/control-wire.mjs). Over it the wire
// bytes stay as stored and the call is labelled 「压缩请求体未解码」 — 12 records of 9 KB each measured 2.4 GB of heap at the old limit.
// The capture side imports both limits from here (src/capture/request-body.mjs).
export const NON_INFERENCE_MAX_DECODED_BYTES = 1024 * 1024;
export const decodeLimitOf = (rec) => (rec && rec.is_llm_call === true ? MAX_DECODED_BYTES : NON_INFERENCE_MAX_DECODED_BYTES);

// ONE parse per record, however many readers ask (D62 A2). A session's cold answer ran JSON.parse over the SAME
// request-body string three times — src/dissect/cc.mjs `detect`, src/dissect/openai.mjs `bodyOf` and
// src/view/assemble.mjs `hydrateForBoard` each parsed it — which on the reference dataset's 112-call session
// (42 MB of bodies) was 213 of the 434 ms the query cost locally. The cache is a WeakMap on the record OBJECT, so it
// lives exactly as long as the record the answer is being built from, and a record read back again (a new object) is
// parsed again — never a cache keyed by a record id, which could outlive or mis-name the bytes.
// READ-ONLY by contract: callers treat the parsed body as source truth and copy before changing anything (the v0
// `request` object was already shared this way).
// A copy of a record (the board's hydrated record, a flat lane's working copy) carries its source's `req_body`: sharesBody(copy, src)
// says so, and the copy's parse and scan are its source's. Keyed by object, like the memos; a copy whose req_body is no longer its
// source's string is its own source.
const parsedBodies = new WeakMap(), scans = new WeakMap(), sources = new WeakMap();
export function sharesBody(copy, src) {
  if (copy && src && copy !== src) sources.set(copy, sources.get(src) || src);
  return copy;
}
const originOf = (rec) => { const o = sources.get(rec); return o && o.req_body === rec.req_body ? o : rec; };
const memo = (map, rec, f) => {
  const o = originOf(rec);
  if (map.has(o)) return map.get(o);
  let v = null;
  const text = o.req_body;                       // read once: the stored body can be megabytes
  if (typeof text === 'string') { try { v = f(text); } catch { v = null; } }
  map.set(o, v);   // a body that did not parse is remembered as null: it will not parse next time either
  return v;
};
export function parsedRequestBody(rec) {
  if (!rec || typeof rec !== 'object') return null;
  if (rec.request && typeof rec.request === 'object') return rec.request;   // v0 shape / already hydrated
  return memo(parsedBodies, rec, JSON.parse);
}
/** storedRequestBody(rec) → the stored req_body parsed (never a hydrated `.request`), or null: the same object parsedRequestBody gave
 *  its source. scannedRequestBody(rec) → scanJson of the stored req_body (byte spans), or null. One of each per record, READ-ONLY. */
export const storedRequestBody = (rec) => (rec && typeof rec === 'object' ? memo(parsedBodies, rec, JSON.parse) : null);
export const scannedRequestBody = (rec) => (rec && typeof rec === 'object' ? memo(scans, rec, scanJson) : null);

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
export function expandRequestBody(rec, { maxBytes = decodeLimitOf(rec) } = {}) {
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
