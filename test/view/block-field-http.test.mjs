// test/view/block-field-http.test.mjs — /api/block accepts the text_ref field segment (RFC 4.2:40 字段段, gate G1)
// and nothing looser. The record is written by the collector's REAL exchange tee and record store, so resp.raw
// is exactly what the collector stores for an SSE reply.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { createExchangeTee } from '../../src/collector/core/engine/exchange.mjs';
import { createRecordStore } from '../../src/collector/core/record/store.mjs';
import { createServer } from '../../src/server.mjs';
import { mintRawRef, composeTextRef } from '../../src/etl/orchestrator.mjs';

const get = (port, p) => new Promise((res, rej) => http.get({ host: '127.0.0.1', port, path: p },
  (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res({ status: r.statusCode, body: b })); }).on('error', rej));
const SSE = 'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","usage":{"input_tokens":3}}}\n\n'
  + ': keep-alive comment\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';

test('a field-qualified ref resolves over HTTP to the reply bytes; a field outside the grammar is a 400', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-bf-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createRecordStore({ root, onError: (e) => { throw e; } });
  const flow = { id: 'f1', host: 'api.anthropic.com', scheme: 'https', dst: { address: '127.0.0.1', port: 443 }, proc: { pid: 9, exe: '/x/claude', agent: 'claude-code' } };
  const tee = createExchangeTee({ flow, recordStore: { envelope: (e) => store.envelope(e) } });
  const body = '{"model":"m","messages":[{"role":"user","content":"q"}]}';
  tee.fromClient(Buffer.from(`POST /v1/messages HTTP/1.1\r\nHost: api.anthropic.com\r\nx-claude-code-session-id: S\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n${body}`));
  tee.fromUpstream(Buffer.from(`HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: ${Buffer.byteLength(SSE)}\r\n\r\n${SSE}`));
  await sleep(5);
  store.close();
  const file = fs.readdirSync(root).find((f) => f.endsWith('.ndjson'));
  const rec = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8').trim());
  assert.equal(rec.resp.raw, SSE, 'precondition: the collector stored the SSE text verbatim');

  const { server } = await createServer({ dbPath: '/nonexistent-db-xyz', sourcePath: [root] });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => server.close());
  const port = server.address().port;
  const base = mintRawRef('S', file, rec.id);
  const ask = (ref) => get(port, '/api/block?ref=' + encodeURIComponent(ref));

  const whole = await ask(composeTextRef(base, [0, SSE.length], 'resp.raw'));
  assert.equal(whole.status, 200, whole.body);
  assert.deepEqual([JSON.parse(whole.body).text, JSON.parse(whole.body).fidelity], [SSE, 'verbatim']);
  const part = await ask(composeTextRef(base, [21, 60], 'resp.raw'));
  assert.equal(JSON.parse(part.body).text, SSE.slice(21, 60));
  // the same record's request body through a legacy ref, unchanged
  assert.equal(JSON.parse((await ask(composeTextRef(base, [1, 8]))).body).text, body.slice(1, 8));

  for (const ref of [`${base}::resp.headers::0-5`, `${base}::resp.body::0-5`, `${base}::req_body::0-5`,
    `${base}::resp.messages.x::0-5`, `${base}::resp.raw::0-5::0-5`, `${base}::resp.raw`]) {
    const r = await ask(ref);
    assert.equal(r.status, 400, `accepted: ${ref}`);
    assert.equal(JSON.parse(r.body).text, undefined);
  }
  const absent = await ask(composeTextRef(base, [0, 5], 'resp.messages.0'));
  assert.equal(absent.status, 404, 'a well-formed ref to a field the record lacks is a stated miss');
  assert.match(JSON.parse(absent.body).error, /resp\.messages\.0/);
});
