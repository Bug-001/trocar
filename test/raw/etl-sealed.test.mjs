import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readRecords } from '../../src/etl/ingest.mjs';
import { etlFile } from '../../src/etl/cli.mjs';
import { openDb } from '../../src/db.mjs';
import { sealShard, sealUnchecked } from '../../src/raw/seal.mjs';
import { markClosed } from '../../src/raw/closed.mjs';
import { dumpAll } from '../etl/helpers.mjs';
import { tmpDir, conversation, envelope, toLine, writeShard, e1Lines, listFiles } from './helpers.mjs';

// ETL ingest MUST read sealed files (D35 ⑥ / 4.2 「读」): same records, same `_stream` (the ORIGINAL
// stream name, so raw_ref / text_ref minted after sealing equal those minted before), and the
// skipped-line report says the same thing it said about the plain NDJSON.

test('readRecords returns the same records, stream names and skip report from a sealed file', async () => {
  const root = tmpDir();
  try {
    const lines = [...e1Lines().slice(0, -1), Buffer.from('{"id":"cr1"}\r{"id":"cr2"}\r\n'), Buffer.from('{"id":"bad\xff"}\n', 'latin1'), Buffer.from('{"id":"tail"}\r')];
    const shard = writeShard(path.join(root, 'calls.ndjson'), lines);
    const before = await readRecords(shard, { normalize: false });
    await sealUnchecked(shard, { split: false, deleteOriginal: false });
    const [sealed] = listFiles(root);
    const after = await readRecords(sealed, { normalize: false });
    assert.deepEqual(after, before);
    assert.deepEqual(after.map((r) => r._stream), before.map(() => 'calls.ndjson'));
    const { file: _a, ...sa } = after.scan, { file: _b, ...sb } = before.scan;
    const { sealed: isSealed, unreadableRecords, unreadable, ...rest } = sa;
    assert.deepEqual(rest, sb);
    assert.equal(isSealed, true);
    assert.equal(unreadableRecords, 0); assert.deepEqual(unreadable, []);
    assert.deepEqual(await readRecords(sealed, { limit: 3 }), (await readRecords(shard, { limit: 3 })));
    assert.deepEqual(await readRecords(sealed, { startOffset: fs.statSync(sealed).size }), [], 'a poll at EOF of a sealed file reads nothing');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

async function snapshot(dbPath) {
  const db = await openDb(dbPath);
  try {
    const tables = await dumpAll(db.connection);
    const wm = (await db.connection.runAndReadAll('SELECT session_id, records_consumed FROM etl_watermark ORDER BY session_id')).getRowObjects()
      .map((r) => ({ ...r, records_consumed: Number(r.records_consumed) }));
    return { tables, wm };
  } finally { await db.close(); }
}

// E8 (4.6), ETL half: the tables and the watermark are the same before and after sealing.
test('E8: ETL tables and watermark are identical before and after sealing', async () => {
  const root = tmpDir();
  try {
    const a = conversation('aaaaaaaa-0000-4000-8000-00000000000a', 5, { idPrefix: 'ra_' });
    const b = conversation('bbbbbbbb-0000-4000-8000-00000000000b', 4, { idPrefix: 'rb_' });
    const tel = envelope({ id: 'tel_1', body: { raw_chars: 9, verbatim: false }, endpoint: '/api/event_logging/batch', llm: false });
    const recs = [a[0], b[0], a[1], tel, b[1], a[2], a[3], b[2], b[3], a[4]];
    const shard = writeShard(path.join(root, 'collector', 'capture-2026-10-05.ndjson'), recs.map((r) => toLine(r)));
    const db1 = path.join(root, 'one.duckdb'), db2 = path.join(root, 'two.duckdb');
    await etlFile(shard, { dbPath: db1 });
    const before = await snapshot(db1);
    assert.ok(before.tables.calls.length >= 9 && before.wm.length >= 2, 'the fixture must actually populate the store');
    assert.ok(before.tables.calls.every((c) => c.raw_ref.includes('/capture-2026-10-05.ndjson#')));

    markClosed(shard);
    const res = await sealShard(shard, { sessionsRoot: path.join(root, 'sessions') });
    assert.equal(res.outputs.length, 3);
    for (const o of res.outputs) await etlFile(o.path, { dbPath: db1 });      // incremental re-run over the sealed files
    assert.deepEqual(await snapshot(db1), before, 'sealing changed the derived store or moved the watermark');

    for (const o of res.outputs) await etlFile(o.path, { dbPath: db2 });      // a fresh store built only from sealed files
    assert.deepEqual(await snapshot(db2), before, 'a store rebuilt from the sealed files differs from the original one');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// No silent failure (user requirement 2026-10-06): an unreadable sealed file is counted and labelled,
// the readable records still come through, and the ETL leaves a durable journal entry.
test('a damaged sealed file is counted and labelled, never silently shortened', async () => {
  const root = tmpDir();
  try {
    const recs = conversation('cccccccc-0000-4000-8000-00000000000c', 12, { idPrefix: 'rc_' });
    const shard = writeShard(path.join(root, 'calls.ndjson'), recs.map((r) => toLine(r)));
    await sealUnchecked(shard, { split: false, deleteOriginal: true, frameBytes: 2048 });
    const [sealed] = listFiles(root);
    const { openSealed } = await import('../../src/raw/reader.mjs');
    const sf = openSealed(sealed); const fr = sf.frames[sf.frames.length - 1]; sf.close();
    const b = fs.readFileSync(sealed); b[fr[0] + (fr[1] >> 1)] ^= 0xff; fs.writeFileSync(sealed, b);   // last frame
    const got = await readRecords(sealed);
    assert.ok(got.length > 0 && got.length < recs.length, `read ${got.length} of ${recs.length}`);
    assert.equal(got.scan.unreadableRecords, recs.length - got.length);
    assert.match(got.scan.unreadable[0].reason, /corrupt|decode|sha256/);

    fs.writeFileSync(path.join(root, 'junk.ndjson.0001.sealed'), 'not sealed');
    const none = await readRecords(path.join(root, 'junk.ndjson.0001.sealed'));
    assert.equal(none.length, 0);
    assert.match(none.scan.sealedError, /not a sealed file/);

    const journal = path.join(root, 'journal.jsonl');
    const out = await etlFile(sealed, { dbPath: path.join(root, 'x.duckdb'), journal });
    assert.equal(out.records, got.length);
    assert.equal(out.sourceErrors.length, 1);
    const entries = fs.readFileSync(journal, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(entries.length, 1);
    assert.equal(entries[0].op, 'read'); assert.equal(entries[0].reader, 'etl'); assert.equal(entries[0].file, sealed);
    assert.equal(entries[0].unreadableRecords, recs.length - got.length);
    assert.equal(fs.statSync(journal).mode & 0o777, 0o600);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
