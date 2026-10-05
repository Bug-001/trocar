// test/server-live-append.test.mjs — 4.4 #10, the live board: a call the collector writes AFTER
// `asight serve` started is listed, and its blocks open with the exact captured bytes. The server is
// built the way `asight serve` builds it (serveSource → createServer) and the new call is appended by
// the collector's REAL record store, which stays open across the server's start like a running daemon.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { createServer } from '../src/server.mjs';
import { serveSource, collectorHome } from '../src/paths.mjs';
import { createRecordStore } from '../src/collector/core/record/store.mjs';
import { etlFile } from '../src/etl/cli.mjs';

const env = (id, ts, text) => ({
  ts, endpoint: '/v1/messages?beta=true', method: 'POST',
  req_headers: { 'x-claude-code-session-id': 'LIVE', 'user-agent': 'claude-cli/2.1.0 (external, cli)' },
  req_body: JSON.stringify({ model: 'claude-x', system: [{ type: 'text', text: 'sys' }], messages: [{ role: 'user', content: [{ type: 'text', text }] }] }),
  resp: { status: 200, kind: 'sse', usage: { input_tokens: 1, output_tokens: 1 } },
  id, ts_request: ts, is_llm_call: true, capture: 'transparent', proc: { pid: 7, exe: '/x/claude', agent: 'claude-code' },
});
const get = (port, p) => new Promise((res, rej) => http.get({ host: '127.0.0.1', port, path: p },
  (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res({ status: r.statusCode, body: b })); }).on('error', rej));

test('a call captured after `asight serve` started opens with its exact bytes (4.4 #10)', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-live-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const store = createRecordStore({ root: collectorHome(home), onError: (e) => { throw e; } });
  t.after(() => store.close());
  store.envelope(env('req_x-00001', '2026-10-06T10:00:00.000Z', 'before the board started'));
  const { server } = await createServer({ dbPath: path.join(home, 'none.duckdb'), sourcePath: serveSource({ home, legacyExists: false }) });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => server.close());
  const port = server.address().port;

  const late = env('req_x-00002', '2026-10-06T10:00:05.000Z', 'captured while the board is up — ünïcode');
  store.envelope(late);
  const view = JSON.parse((await get(port, '/api/session?id=LIVE')).body);
  const step = view.analyzed.steps.find((s) => s.id === late.id);
  assert.ok(step, 'the late call is listed');
  assert.ok(step.flat.length >= 2);
  for (const b of step.flat) {
    const r = await get(port, '/api/block?ref=' + encodeURIComponent(b.text_ref));
    assert.equal(r.status, 200, r.body);
    const got = JSON.parse(r.body);
    const [s, e] = b.text_ref.split('::').at(-1).split('-').map(Number);
    assert.deepEqual([got.status, got.fidelity, got.text], ['ok', 'verbatim', late.req_body.slice(s, e)]);
  }
});

test('the SQL replay (/api/call/:id/context) also refreshes: a call ETL\'d from bytes the board indexed late resolves', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-live-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const early = env('req_y-00001', '2026-10-06T11:00:00.000Z', 'early'), late = env('req_y-00002', '2026-10-06T11:00:05.000Z', 'late');
  const line = (e) => JSON.stringify(e) + '\n';
  // the store is built from the whole capture; the board starts while its copy holds only `early`
  const full = path.join(home, 'etl-src'); fs.mkdirSync(full);
  fs.writeFileSync(path.join(full, 'capture-2026-10-06.ndjson'), line(early) + line(late));
  const dbPath = path.join(home, 'x.duckdb');
  await etlFile(full, { dbPath });
  const col = collectorHome(home); fs.mkdirSync(col);
  fs.writeFileSync(path.join(col, 'capture-2026-10-06.ndjson'), line(early));
  const { server } = await createServer({ dbPath, sourcePath: serveSource({ home, legacyExists: false }) });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => server.close());
  fs.appendFileSync(path.join(col, 'capture-2026-10-06.ndjson'), line(late));
  const r = JSON.parse((await get(server.address().port, `/api/call/${late.id}/context`)).body);
  assert.ok(r.blocks.length >= 2);
  for (const b of r.blocks) {
    assert.deepEqual([b.source_status, b.source_fidelity], ['ok', 'verbatim']);
    assert.ok(late.req_body.includes(b.text));
  }
});
