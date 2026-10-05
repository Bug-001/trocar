import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir, conversation, envelope, toLine, writeShard } from './helpers.mjs';
import { createServer } from '../../src/server.mjs';
import { shardOnce } from '../../src/etl/shard.mjs';
import { sealLegacy } from '../../src/raw/legacy.mjs';
import { orderInputs, listSources } from '../../src/raw/discover.mjs';

// 4.2 「watermark」: a session's record sequence read from sealed files is the one read from the
// originals. Review 3 F2: the originals were read calls → probes → other, the sealed segments in file
// name order (calls → other → probes), so a session with all three streams changed order on sealing —
// and the board's tail bound (the newest calls that fit 6 MB) picks by that order.

const get = (port, p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port, path: p }, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res(JSON.parse(b))); }).on('error', rej);
});
async function sessionIds(ses, id) {   // a fresh server each time: the session memo outlives file changes
  const { server } = await createServer({ dbPath: '/nonexistent-db', sourcePath: ses, enrich: () => null });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try { return (await get(server.address().port, `/api/session?id=${id}`)).records.map((r) => r.id); } finally { server.close(); }
}
const NONE = { fdHolders: async () => new Map(), processList: async () => [], sleep: async () => {} };
const S = 'dddddddd-5555-4555-8555-55555555555d';

test('F2: a session with calls, probes and other reads in the same order after its originals are deleted', async () => {
  const root = tmpDir();
  try {
    const c = conversation(S, 3, { idPrefix: 'oc_' });
    const probe = (id) => envelope({ sid: S, id, body: '{}', endpoint: '/v1/messages/count_tokens', llm: false });
    const other = (id) => envelope({ sid: S, id, body: '{}', endpoint: '/v1/models', llm: false });
    const ses = path.join(root, 'sessions'), journal = path.join(root, 'j.jsonl');
    await shardOnce({ file: writeShard(path.join(root, 'cap.ndjson'), [c[0], other('oo_1'), probe('op_1'), c[1], probe('op_2'), other('oo_2'), c[2]].map((r) => toLine(r))), outDir: ses });
    for (const s of ['calls', 'probes', 'other']) assert.ok(fs.existsSync(path.join(ses, S, `${s}.ndjson`)), `precondition: ${s}.ndjson`);
    const before = await sessionIds(ses, S);
    assert.deepEqual(before, ['oc_00000', 'oc_00001', 'oc_00002', 'op_1', 'op_2', 'oo_1', 'oo_2']);
    await sealLegacy(ses, { ...NONE, journal });
    assert.deepEqual(await sessionIds(ses, S), before, 'keep-originals state');
    await sealLegacy(ses, { ...NONE, journal, deleteOriginal: true });
    assert.equal(fs.existsSync(path.join(ses, S, 'calls.ndjson')), false, 'precondition: originals deleted');
    assert.deepEqual(await sessionIds(ses, S), before, 'the sealed segments are read in another order than the originals were');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('F2: order = stream rank, then segment number (numerically), the live original after its segments', () => {
  const d = '/x/s';
  const files = ['other.ndjson.0001.sealed', 'calls.ndjson', 'calls.ndjson.10000.sealed', 'zeta.ndjson.0001.sealed', 'probes.ndjson',
    'calls.ndjson.9999.sealed', 'alpha.ndjson.0001.sealed', 'calls.ndjson.0002.sealed'].map((n) => path.join(d, n));
  assert.deepEqual(orderInputs(files, ['calls.ndjson', 'probes.ndjson', 'other.ndjson']).map((f) => path.basename(f)), [
    'calls.ndjson.0002.sealed', 'calls.ndjson.9999.sealed', 'calls.ndjson.10000.sealed', 'calls.ndjson',
    'probes.ndjson', 'other.ndjson.0001.sealed', 'alpha.ndjson.0001.sealed', 'zeta.ndjson.0001.sealed']);
});

test('F2: a flat root reads a stream\'s older sealed segment before the fresh file written after it', async () => {
  const root = tmpDir();
  try {
    const cap = writeShard(path.join(root, 'src', 'codex-capture.ndjson'), [toLine(envelope({ id: 'old', body: '' }))]);
    await sealLegacy(cap, { ...NONE, journal: path.join(root, 'j.jsonl') });
    await sealLegacy(cap, { ...NONE, journal: path.join(root, 'j.jsonl'), deleteOriginal: true });
    writeShard(cap, [toLine(envelope({ id: 'new', body: '' }))]);
    assert.deepEqual(listSources([path.dirname(cap)]).files.map((f) => path.basename(f)), ['codex-capture.ndjson.0001.sealed', 'codex-capture.ndjson']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
