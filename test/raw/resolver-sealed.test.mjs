import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { buildResolver } from '../../src/query/source.mjs';
import { readRecords } from '../../src/etl/ingest.mjs';
import { runEtl, rebuildContext } from '../../src/etl/orchestrator.mjs';
import { applyDDL } from '../../src/model/schema.mjs';
import { openDb } from '../../src/db.mjs';
import { sealShard } from '../../src/raw/seal.mjs';
import { markClosed } from '../../src/raw/closed.mjs';
import { tmpDir, conversation, toLine, writeShard, listFiles } from './helpers.mjs';

const S = 'dddddddd-0000-4000-8000-00000000000d', T = 'eeeeeeee-0000-4000-8000-00000000000e';
const fileSha = (f) => createHash('sha256').update(fs.readFileSync(f)).digest('hex');

// Two closed daily shards; session S spans both, and both shards mint the same ids (req_00000…).
function corpus(root) {
  const cap = path.join(root, 'collector'), ses = path.join(root, 'sessions');
  fs.mkdirSync(ses, { recursive: true });
  const s = conversation(S, 6), t = conversation(T, 3, { idPrefix: 'treq_' });
  const day1 = writeShard(path.join(cap, 'capture-2026-10-05.ndjson'), [s[0], t[0], s[1], t[1], s[2], t[2]].map((r) => toLine(r)));
  const day2 = writeShard(path.join(cap, 'capture-2026-10-06.ndjson'), s.slice(3).map((r, i) => toLine({ ...r, id: `req_${String(i).padStart(5, '0')}` })));
  return { cap, ses, shards: [day1, day2] };
}

// E2 (4.6): raw_ref / text_ref resolve to identical bytes before and after sealing (AC-1 through the
// sealed file), and the DuckDB store is not rebuilt.
test('E2: every text_ref resolves to the same bytes before and after sealing per session', async () => {
  const root = tmpDir();
  try {
    const { cap, ses, shards } = corpus(root);
    const dbPath = path.join(root, 'a.duckdb');
    const db = await openDb(dbPath);
    await applyDDL(db.connection);
    const recs = [...await readRecords(shards[0]), ...await readRecords(shards[1])];
    await runEtl(recs, db.connection, { streamOf: (r) => r._stream });
    const refs = (await db.connection.runAndReadAll('SELECT DISTINCT text_ref FROM block_contents WHERE text_ref IS NOT NULL ORDER BY 1')).getRowObjects().map((r) => r.text_ref);
    const callIds = (await db.connection.runAndReadAll('SELECT call_id, raw_ref FROM calls ORDER BY raw_ref')).getRowObjects();
    assert.ok(refs.some((r) => r.includes('capture-2026-10-06.ndjson#req_00000')) && refs.some((r) => r.includes('capture-2026-10-05.ndjson#req_00000')), 'the fixture must have the same id in both shards');

    // the product layout: `asight serve --source <collector>` (bin passes the sessions dir the sealer files into)
    const before = await buildResolver(cap, { sessionsRoot: ses });
    const bytesBefore = refs.map((r) => before.detail(r));
    assert.ok(bytesBefore.every((o) => o.status === 'ok'), 'precondition: every ref resolves from the NDJSON');
    const ctxBefore = [];
    for (const c of callIds) ctxBefore.push(await rebuildContext(db.connection, c.call_id, before));
    before.dispose();
    await db.close();
    const dbSha = fileSha(dbPath);

    for (const f of shards) { markClosed(f); await sealShard(f, { sessionsRoot: ses }); }
    assert.equal(listFiles(cap, /\.ndjson$/).length, 0, 'the originals are gone — only sealed files can answer now');
    assert.equal(listFiles(path.join(ses, S)).length, 2, 'S has one sealed file per source shard');

    const after = await buildResolver(cap, { sessionsRoot: ses });
    assert.deepEqual(refs.map((r) => after.detail(r)), bytesBefore);
    const twoRoots = await buildResolver([cap, ses]);
    assert.deepEqual(refs.map((r) => twoRoots.detail(r)), bytesBefore, 'serving both dirs as roots must agree');
    twoRoots.dispose();
    const db2 = await openDb(dbPath, { readOnly: true });
    for (let k = 0; k < callIds.length; k++) assert.deepEqual(await rebuildContext(db2.connection, callIds[k].call_id, after), ctxBefore[k]);
    await db2.close();
    after.dispose();
    assert.equal(fileSha(dbPath), dbSha, 'the DuckDB store changed — it must not be rebuilt for sealing');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a resolver built before sealing re-indexes when the original disappears under it', async () => {
  const root = tmpDir();
  try {
    const { cap, ses, shards } = corpus(root);
    const ref = `${S}/capture-2026-10-05.ndjson#req_00001::0-12`;
    const live = await buildResolver([cap, ses]);                          // indexed, but never read the shard
    const want = live.detail(ref);
    const fresh = await buildResolver([cap, ses]);
    for (const f of shards) { markClosed(f); await sealShard(f, { sessionsRoot: ses }); }
    assert.deepEqual(fresh.detail(ref), want);                             // ENOENT → re-index → sealed file
    assert.deepEqual(live.detail(ref), want);                              // its fd still reads the old inode
    live.dispose(); fresh.dispose();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('an unreadable sealed file is counted and named by the resolver, not silently absent', async () => {
  const root = tmpDir();
  try {
    const { cap, ses, shards } = corpus(root);
    for (const f of shards) { markClosed(f); await sealShard(f, { sessionsRoot: ses }); }
    const victim = listFiles(path.join(ses, T))[0];
    const b = fs.readFileSync(victim); b[b.length - 30] ^= 0xff; fs.writeFileSync(victim, b);   // trailer/index damage
    const r = await buildResolver([cap, ses]);
    assert.equal(r.scan.unreadableSealed.length, 1);
    assert.equal(r.scan.unreadableSealed[0].file, victim);
    const miss = r.detail(`${T}/capture-2026-10-05.ndjson#treq_00000::0-5`);
    assert.notEqual(miss.status, 'ok');
    assert.match(miss.reason, /could not be read/);
    assert.equal(r.detail(`${S}/capture-2026-10-06.ndjson#req_00000::0-5`).status, 'ok', 'the other files still serve');
    r.dispose();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
