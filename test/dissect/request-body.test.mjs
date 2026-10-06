// test/dissect/request-body.test.mjs — the reader decodes what the collector stored compressed and labels only
// what it cannot decode (RFC 3.1 跨记录拼接与「不完整」, 3.2:132, 4.6 §记录 「压缩的请求体」, 4.6 T #16 read half).
import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { expandRequestBody, requestEncodingOf } from '../../src/dissect/request-body.mjs';
import { captureLabelsOf } from '../../src/dissect/capture-labels.mjs';

const TEXT = '{"model":"m","messages":[{"role":"user","content":"héllo"}]}';
const compress = (enc, s = TEXT) => (enc === 'br' ? zlib.brotliCompressSync(s) : enc === 'deflate' ? zlib.deflateSync(s) : zlib.gzipSync(s));
const zipped = (enc) => ({ id: 'r', is_llm_call: true, endpoint: '/v1/messages', req_body: null, req_content_encoding: enc,
  req_body_b64: compress(enc).toString('base64'), req_encoding_error: 'collector did not decode' });
const ids = (r) => captureLabelsOf(r).map((l) => l.id);

test('a body the collector left compressed is decoded by the reader, invisibly to serialization', () => {
  for (const enc of ['br', 'deflate', 'gzip']) {
    const r = expandRequestBody(zipped(enc));
    assert.equal(r.req_body, TEXT, enc);
    assert.equal(r._reqBodyFrom, 'reader-decoded');
    assert.equal(requestEncodingOf(r), enc);
    assert.equal(Object.keys(r).includes('_reqBodyFrom'), false, 'provenance is not a field of the record');
    assert.deepEqual(ids(r), [], 'decoded by the reader → not labelled undecoded (3.1)');
  }
});

test('stacked codings are undone right to left', () => {
  const b64 = zlib.gzipSync(zlib.deflateSync(TEXT)).toString('base64'); // "deflate, gzip": deflate first, then gzip
  assert.equal(expandRequestBody({ req_body: null, req_body_b64: b64, req_content_encoding: 'deflate, gzip' }).req_body, TEXT);
});

test('an encoding the reader cannot decode stays null and is labelled with the reader\'s reason', () => {
  const r = expandRequestBody({ ...zipped('gzip'), req_content_encoding: 'x-unknown' });
  assert.equal(r.req_body, null);
  assert.match(r._reqBodyDecodeError, /x-unknown/);
  assert.deepEqual(ids(r), ['req-undecoded']);
  assert.match(captureLabelsOf(r)[0].text, /cannot decode content-encoding "x-unknown"/, 'the reader\'s reason, not only the collector\'s');
  const bad = expandRequestBody({ req_body: null, req_body_b64: Buffer.from('not gzip').toString('base64'), req_content_encoding: 'gzip' });
  assert.deepEqual([bad.req_body, ids(bad)], [null, ['req-undecoded']], 'corrupt bytes: labelled, never a crash');
  const latin = expandRequestBody({ req_body: null, req_body_b64: zlib.gzipSync(Buffer.from([0xff, 0xfe, 0x41])).toString('base64'), req_content_encoding: 'gzip' });
  assert.deepEqual([latin.req_body, ids(latin)], [null, ['req-undecoded']], 'not UTF-8 after decoding: no lossy text');
  assert.match(latin._reqBodyDecodeError, /not UTF-8/);
});

test('a body that decodes past the limit is not loaded, and says so', () => {
  const r = expandRequestBody(zipped('gzip'), { maxBytes: 16 });
  assert.equal(r.req_body, null);
  assert.match(r._reqBodyDecodeError, /over the reader's 16-byte limit/);
});

test('zstd: decoded where node:zlib has it, labelled where it does not', () => {
  const has = typeof zlib.zstdCompressSync === 'function' && typeof zlib.zstdDecompressSync === 'function';
  const rec = { id: 'z', is_llm_call: true, req_body: null, req_content_encoding: 'zstd', req_encoding_error: 'zstd not decoded by the collector',
    req_body_b64: has ? zlib.zstdCompressSync(Buffer.from(TEXT)).toString('base64') : Buffer.from('not zstd').toString('base64') };
  const r = expandRequestBody(rec);
  if (has) assert.deepEqual([r.req_body, ids(r)], [TEXT, []]);
  else assert.deepEqual([r.req_body, ids(r)], [null, ['req-undecoded']]);
});

test('a plain body, a collector-decoded body and a WebSocket binary message are left exactly as they are', () => {
  const plain = { id: 'p', req_body: TEXT };
  assert.equal(expandRequestBody(plain).req_body, TEXT);
  assert.equal(requestEncodingOf(plain), null);
  const gz = { id: 'g', req_body: TEXT, req_body_b64: zlib.gzipSync(TEXT).toString('base64'), req_content_encoding: 'gzip' };
  assert.equal(expandRequestBody(gz).req_body, TEXT);
  assert.equal(gz._reqBodyFrom, undefined, 'the collector decoded it; the reader did nothing');
  assert.equal(requestEncodingOf(gz), 'gzip');
  const ws = { id: 'w', transport: 'ws', req_body: null, req_body_b64: zlib.gzipSync(TEXT).toString('base64') }; // no req_content_encoding
  assert.equal(expandRequestBody(ws).req_body, null, '4.6: a WS req_body_b64 is a message, not a compressed body');
  assert.equal(requestEncodingOf({ req_content_encoding: 'identity' }), null);
});

test('the label: only when no text is left; the collector\'s reason when the reader never ran', () => {
  assert.deepEqual(ids({ req_body: TEXT, req_encoding_error: 'zstd', req_content_encoding: 'zstd' }), [], 'decoded somewhere → no label');
  const never = { req_body: null, req_body_b64: 'AAAA', req_content_encoding: 'zstd', req_encoding_error: 'zstd not decoded at capture' };
  assert.deepEqual(ids(never), ['req-undecoded']);
  assert.match(captureLabelsOf(never)[0].text, /zstd not decoded at capture/);
  assert.deepEqual(ids({ req_body: null, req_encoding_error: 'lost' }), ['req-undecoded'], 'the collector said so: labelled even with no bytes');
});
