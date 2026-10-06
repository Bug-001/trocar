// test/server-unkeyed-source.test.mjs — RFC 3.4:21 (gate G12): a sharded source lists and opens sessions whose
// key is not a header (Kimi's body key, a synthesized key), read from `_unkeyed/`; `_unkeyed` is never a session.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server.mjs';
import { shardStream } from '../src/etl/shard.mjs';

const get = (port, p) => new Promise((res, rej) => http.get({ host: '127.0.0.1', port, path: p }, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res({ status: r.statusCode, body: b })); }).on('error', rej));
const rec = (id, agent, headers, body, sec = 0) => ({ id, ts_request: `2026-10-06T00:00:${String(sec).padStart(2, '0')}Z`, endpoint: '/v1/messages', method: 'POST', req_headers: headers,
  req_body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: id }], ...body }), resp: { status: 200, kind: 'sse', usage: {} },
  is_llm_call: true, capture: 'transparent', proc: { pid: 1, exe: '/x', agent } });

// control-plane record with no session: makes the shard root have a control/ dir, as a real one does
const TELE = { id: 'tl', ts_request: '2026-10-06T00:00:00Z', endpoint: '/api/event_logging/batch', method: 'POST', req_headers: {}, req_body: '{}',
  resp: { status: 200 }, is_llm_call: false, capture: 'transparent', proc: { pid: 1, exe: '/x', agent: 'claude-code' } };

async function serve(t, records, { flatInRoot = [] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-unk-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const src = path.join(dir, 'capture-2026-10-06.ndjson');
  fs.writeFileSync(src, [...records, TELE].map((r) => JSON.stringify(r)).join('\n') + '\n');
  const out = path.join(dir, 'sessions');
  await shardStream({ file: src, outDir: out });
  // a flat capture left in a shard root is not read in shard mode (it is reported: flat-file-in-shard-mode)
  if (flatInRoot.length) fs.writeFileSync(path.join(out, 'capture-old.ndjson'), flatInRoot.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const { server } = await createServer({ dbPath: '/nonexistent-db', sourcePath: [out], enrich: () => null });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => server.close());
  return server.address().port;
}

test('Kimi body-key sessions in _unkeyed are listed and open; _unkeyed itself is never a session', async (t) => {
  const port = await serve(t, [rec('d1', 'dsh', { 'x-deepseek-harness-session-id': 'D1' }, {}), rec('k1', 'kimi-code', {}, { metadata: { user_id: 'K1' } }, 1),
    rec('k2', 'kimi-code', {}, { metadata: { user_id: 'K1' } }, 2)], { flatInRoot: [rec('k0', 'kimi-code', {}, { metadata: { user_id: 'K1' } })] });
  const list = JSON.parse((await get(port, '/api/projects')).body);
  const sessions = list.projects.flatMap((p) => p.sessions);
  const ids = sessions.map((s) => s.session_id).sort();
  assert.deepEqual(ids, ['D1', 'K1']);
  assert.equal(sessions.find((s) => s.session_id === 'K1').calls, 2);
  assert.equal(sessions.find((s) => s.session_id === 'K1').harness, 'kimi');
  assert.equal(list.source.skipped.some((x) => x.name === '_unkeyed'), false, '_unkeyed is read, so it is not reported as skipped');
  const s = JSON.parse((await get(port, '/api/session?id=K1')).body);
  assert.equal(s.analyzed.steps.length, 2, 'opened from _unkeyed/ like it was listed — not by a whole-corpus read that also takes the flat file');
  const ctl = (await get(port, '/api/control?class=control')).body;
  assert.doesNotMatch(ctl, /"k1"|"k2"/, 'a keyed Kimi call is not control');
});

test('a keyless Hermes call in _unkeyed gets a synthesized session that lists and opens', async (t) => {
  const H = (id, sec) => rec(id, 'hermes', {}, { system: 'You are Hermes.' }, sec);
  const port = await serve(t, [rec('d1', 'dsh', { 'x-deepseek-harness-session-id': 'D1' }, {}), H('h1', 1), H('h2', 2)]);
  const sessions = JSON.parse((await get(port, '/api/projects')).body).projects.flatMap((p) => p.sessions);
  const syn = sessions.filter((s) => s.session_synthesized);
  assert.equal(syn.length, 1, 'one synthesized Hermes session');
  assert.equal(syn[0].calls, 2);
  const s = JSON.parse((await get(port, '/api/session?id=' + encodeURIComponent(syn[0].session_id))).body);
  assert.equal(s.analyzed.steps.length, 2);
  assert.doesNotMatch((await get(port, '/api/control?class=control')).body, /"h1"|"h2"/);
});

test('an _unkeyed record no key can be found for shows in the control view, never dropped', async (t) => {
  const port = await serve(t, [rec('d1', 'dsh', { 'x-deepseek-harness-session-id': 'D1' }, {}),
    { ...rec('x1', 'kimi-code', {}, {}), ts_request: undefined }]); // no body key, no timestamp: no synthesized key either
  const sessions = JSON.parse((await get(port, '/api/projects')).body).projects.flatMap((p) => p.sessions);
  assert.deepEqual(sessions.map((s) => s.session_id), ['D1']);
  assert.match((await get(port, '/api/control?class=control')).body, /"x1"/);
});

test('a shard root whose only sessions are in _unkeyed is still read in shard mode', async (t) => {
  const port = await serve(t, [rec('k1', 'kimi-code', {}, { metadata: { user_id: 'K1' } })], { flatInRoot: [rec('k9', 'kimi-code', {}, { metadata: { user_id: 'K9' } })] });
  const list = JSON.parse((await get(port, '/api/projects')).body);
  assert.deepEqual(list.projects.flatMap((p) => p.sessions.map((s) => s.session_id)), ['K1']);
  assert.ok(list.source.skipped.some((x) => x.name === 'capture-old.ndjson' && x.reason === 'flat-file-in-shard-mode'), 'shard mode says what it did not read');
});
