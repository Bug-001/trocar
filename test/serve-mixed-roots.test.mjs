// test/serve-mixed-roots.test.mjs — the default board over all three roots at once (4.4:78, 4.4:129).
// `/api/projects` switches to shard mode (lists only meta.json summaries, never reads flat files) as
// soon as ANY root has a direct subfolder holding meta.json or a session stream file. The collector's
// subdirectories (flows/ audit/ replays/, written here by its REAL record store) must not trip that
// switch, or every flat capture would vanish — the legacy MITM file and the collector's own sessions.
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

const env = (id, sid, extra = {}) => ({
  ts: '2026-10-06T00:00:00.000Z', endpoint: '/v1/messages', method: 'POST',
  req_headers: { 'x-claude-code-session-id': sid, 'user-agent': 'claude-cli/2.1.0 (external, cli)' },
  req_body: JSON.stringify({ model: 'claude-x', system: [{ type: 'text', text: 's' }], messages: [{ role: 'user', content: [{ type: 'text', text: sid }] }] }),
  resp: { status: 200, kind: 'sse', usage: { input_tokens: 1, output_tokens: 1 } },
  id, ts_request: '2026-10-06T00:00:00.000Z', is_llm_call: true, ...extra,
});
const get = (port, p) => new Promise((res, rej) => http.get({ host: '127.0.0.1', port, path: p },
  (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res({ status: r.statusCode, body: b })); }).on('error', rej));

async function board(t, roots) {
  const { server } = await createServer({ dbPath: '/nonexistent-db', sourcePath: roots });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => server.close());
  const port = server.address().port;
  const metas = JSON.parse((await get(port, '/api/projects')).body).projects.flatMap((p) => p.sessions);
  return { port, metas };
}
function homes(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-mixed-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, 'asight'), legacy = path.join(base, 'atrace-asight');
  fs.mkdirSync(home); fs.mkdirSync(legacy);
  return { base, home, legacy };
}

test('a flat legacy capture and a collector-written session list side by side on the default board', async (t) => {
  const { home, legacy } = homes(t);
  fs.writeFileSync(path.join(home, 'claude-capture.ndjson'), JSON.stringify(env('m-1', 'FLAT-MITM', { capture: 'mitm' })) + '\n');
  fs.writeFileSync(path.join(legacy, 'claude-capture.ndjson'), JSON.stringify(env('l-1', 'LEGACY')) + '\n');
  const store = createRecordStore({ root: collectorHome(home), onError: (e) => { throw e; } });
  store.envelope(env('req_c-00001', 'COLLECTOR', { capture: 'transparent', proc: { pid: 3, exe: '/x/claude', agent: 'claude-code' } }));
  store.flow({ ts: '2026-10-06T00:00:00.000Z', flow_id: 'f1', decision: 'decrypt' });
  store.audit({ ts: '2026-10-06T00:00:00.000Z', event: 'on' });
  store.replay(env('rp-1', 'REPLAY'));
  store.close();
  const roots = serveSource({ home, legacy, legacyExists: true });
  assert.deepEqual(roots, [home, collectorHome(home), legacy]);
  const { port, metas } = await board(t, roots);
  assert.deepEqual(metas.map((m) => m.session_id).sort(), ['COLLECTOR', 'FLAT-MITM', 'LEGACY'], 'not shard mode: every flat root is read');
  for (const id of ['COLLECTOR', 'FLAT-MITM', 'LEGACY']) {
    const v = JSON.parse((await get(port, `/api/session?id=${id}`)).body);
    assert.equal(v.analyzed.steps.length, 1, id);
  }
});

test('a capture linked from one root to a file in another root is read once, not twice', async (t) => {
  const { home, legacy } = homes(t);
  fs.writeFileSync(path.join(legacy, 'codex-capture.ndjson'), JSON.stringify(env('k-1', 'LINKED')) + '\n');
  fs.symlinkSync(path.join(legacy, 'codex-capture.ndjson'), path.join(home, 'codex-capture.ndjson'));
  const { port, metas } = await board(t, serveSource({ home, legacy, legacyExists: true }));
  assert.deepEqual(metas.map((m) => [m.session_id, m.calls]), [['LINKED', 1]]);
  const v = JSON.parse((await get(port, '/api/session?id=LINKED')).body);
  assert.deepEqual(v.analyzed.steps.map((s) => s.id), ['k-1']);
});
