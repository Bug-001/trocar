// test/web/req-incomplete.test.mjs — the browser shows the reason where the call is shown (invariant 4,
// RFC 4.6 §记录 「不完整的标注,各说一件事」). Product path, CC line: the collector's own tee + record store
// write a capture directory, `asight serve` (createServer) answers /api/session from it exactly as the
// board asks, and index.html renders that JSON. No session object below is built by hand.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { createServer } from '../../src/server.mjs';
import { cutRequestEnvelopes } from '../helpers/cut-requests.mjs';
import { loadIndex } from '../helpers/frontend.mjs';

const get = (port, p) => new Promise((resolve, reject) => {
  http.request({ host: '127.0.0.1', port, path: p }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve(JSON.parse(b))); })
    .on('error', reject).end();
});
// All real I/O happens here, before loadIndex() replaces the globals.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-reqcut-'));
await cutRequestEnvelopes({ root });
const { server } = await createServer({ dbPath: '/nonexistent-db-xyz', sourcePath: root });
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const { port } = server.address();
const FULL = await get(port, '/api/session?project=P&id=S&cursor=0&limit=60');   // what poll() asks for
const PAGED = await get(port, '/api/session?project=P&id=S&cursor=3&limit=1');   // calls #1–#2 paged out
server.close();
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

// steps in capture order: 0 complete · 1 capped (unparsed) · 2 early413 (unparsed) · 3 early401 (parsed)
async function at(session, i) {
  const t = await loadIndex(session, ['poll', 'setPlayhead']);
  await t.M.poll();
  t.M.setPlayhead(i, true);
  return { ctx: t.getEl('ctxwin').innerHTML, raw: t.getEl('rawpanel').innerHTML };
}

test('an unparsed call renders its reason, not an empty context window', async () => {
  assert.equal(FULL.analyzed.steps.length, 4, 'precondition: the server assembled all four captured calls');
  let v = await at(FULL, 1);
  assert.match(v.ctx, /无法呈现/);
  assert.match(v.ctx, /cut at the capture cap: only the first 40 bytes are stored/);
  assert.doesNotMatch(v.ctx, /cwmeta|corrupt|intact on disk/, 'no empty block window, no "corrupt", no claim the full body is on disk');
  assert.match(v.raw, /请求体已截断/);
  assert.doesNotMatch(v.raw, /请求体不完整/, 'a capped body finished uploading: only 已截断 applies');
  v = await at(FULL, 2);
  assert.match(v.ctx, /answered \(e\.g\. 413 \/ 401\) before it was fully sent/);
  assert.match(v.raw, /请求体不完整/);
  assert.doesNotMatch(v.raw, /请求体已截断/, 'a body that never finished was not cut at the cap');
});

test('a parsed call with a label shows the badge above its context; a complete call shows none', async () => {
  let v = await at(FULL, 3);
  assert.match(v.ctx, /^<div class="rpk"><span class="pobadge"[^>]*>请求体不完整/, 'the badge is the first thing in the window');
  assert.match(v.ctx, /cwmeta/, 'the parsed blocks still render below it');
  assert.match(v.ctx, /bytes stored \(not the whole request\)/);
  assert.match(v.ctx, /the stored part of the request/);
  assert.doesNotMatch(v.ctx, /the exact input to the model/, 'a 401 before the body was sent: the model got none of it');
  assert.doesNotMatch(v.ctx, /bytes on the wire/, 'a partial body is not "the bytes on the wire"');
  assert.match(v.raw, /bytes stored/);
  v = await at(FULL, 0);
  assert.doesNotMatch(v.ctx + v.raw, /请求体不完整|请求体已截断|bytes stored/);
  assert.match(v.ctx, /bytes on the wire/);
  assert.match(v.ctx, /the exact input to the model/);
});

test('a paged-out labelled call still says why, in the raw panel and the window', async () => {
  assert.equal(PAGED.analyzed.steps[1].paged_out, true, 'precondition: call #1 arrived without its body');
  let v = await at(PAGED, 1);
  assert.match(v.raw, /正文未随本页下发/);
  assert.match(v.raw, /请求体已截断/);
  assert.match(v.ctx, /^<div class="rpk"><span class="pobadge"[^>]*>请求体已截断/, 'the paged-out window says it too, first');
  assert.match(v.raw + v.ctx, /what was stored of it/);
  assert.doesNotMatch(v.raw + v.ctx, /— it is intact|<\/b>: it is intact/, 'only the stored prefix is on disk, not "it"');
  v = await at(PAGED, 0);
  assert.doesNotMatch(v.raw + v.ctx, /请求体|what was stored of it/, 'an unlabelled paged-out call keeps the old text');
});
