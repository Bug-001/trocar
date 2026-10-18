// test/serve-collector-source.test.mjs — 4.4:129 / 4.6 §记录: the collector's top-level
// capture-<date>.ndjson is a default board source, and nothing it writes under flows/, audit/ or
// replays/ is ever read as an envelope. The subdirectory records are written by the collector's REAL
// record store, so a change to where it puts them is caught here, not discovered on a live board.
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

const env = (id, sid) => ({
  ts: '2026-10-06T00:00:00.000Z', endpoint: '/v1/messages', method: 'POST',
  req_headers: { 'x-claude-code-session-id': sid, 'user-agent': 'claude-cli/2.1.0 (external, cli)' },
  req_body: JSON.stringify({ model: 'claude-x', system: [{ type: 'text', text: 's' }], messages: [{ role: 'user', content: 'hi' }] }),
  resp: { status: 200, kind: 'json', body: { usage: { input_tokens: 1, output_tokens: 1 } } },
  id, ts_request: '2026-10-06T00:00:00.000Z', is_llm_call: true, capture: 'transparent',
  host: 'api.anthropic.com', scheme: 'https', dst: '1.2.3.4:443', proc: { pid: 9, exe: '/x/claude', agent: 'claude-code' },
  flow_id: 'f1', seq: 0, req_head_raw: 'POST /v1/messages HTTP/1.1\r\n\r\n', resp_head_raw: 'HTTP/1.1 200 OK\r\n\r\n',
});
const get = (port, p) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port, path: p }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b })); }).on('error', reject);
});

test('capture-<date>.ndjson under ~/.asight/collector is listed; flows/, audit/ and replays/ are not', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-home-'));
  try {
    const col = collectorHome(home);
    const store = createRecordStore({ root: col, raw: col });
    store.envelope(env('req_a-00001', 'COL'));
    // envelope-shaped look-alikes, each where the collector puts that stream: none may become a session
    store.flow(env('flow-1', 'FLOWS'));
    store.audit(env('audit-1', 'AUDIT'));
    store.replay(env('replay-1', 'REPLAY'));
    store.close();
    assert.equal(store.errors, 0);
    const roots = serveSource({ home, legacyExists: false }); // what `asight serve` uses with no --source
    assert.deepEqual(roots, [home, col]);
    const { server } = await createServer({ dbPath: path.join(home, 'none.duckdb'), sourcePath: roots });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    try {
      const r = await get(server.address().port, '/api/projects');
      assert.equal(r.status, 200, r.body);
      const ids = JSON.parse(r.body).projects.flatMap((p) => p.sessions.map((s) => s.session_id));
      assert.deepEqual(ids, ['COL']);
    } finally { server.close(); }
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
