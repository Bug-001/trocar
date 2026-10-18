import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir, conversation, envelope, toLine, writeShard } from './helpers.mjs';
import { listSources } from '../../src/raw/discover.mjs';
import { sealShard, sealUnchecked } from '../../src/raw/seal.mjs';
import { sealLegacy } from '../../src/raw/legacy.mjs';
import { markClosed } from '../../src/raw/closed.mjs';
import { appendJournal, readJournal } from '../../src/raw/journal.mjs';
import { createServer } from '../../src/server.mjs';
import { shardOnce } from '../../src/etl/shard.mjs';

// D38 (no failure or skip is silent), the sealer items of the audit (d38 draft §C5,
// S-3 … S-7) that the third review left open.

const S = '38383838-0000-4000-8000-000000000038';
const NONE = { fdHolders: async () => new Map(), processList: async () => [], sleep: async () => {} };
const get = (port, p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port, path: p }, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res(JSON.parse(b))); }).on('error', rej);
});
const root0 = process.getuid && process.getuid() === 0;

test('S-3: a directory a reader cannot open is "unreadable" and reported — not a harmless non-capture directory', { skip: root0 && 'root reads everything' }, async () => {
  const root = tmpDir();
  const unlock = () => { for (const d of [path.join(root, 'flat', 'locked'), path.join(root, 'sessions', '99999999-0000-4000-8000-000000000099')]) try { fs.chmodSync(d, 0o700); } catch {} };
  try {
    const flat = path.join(root, 'flat'), locked = path.join(flat, 'locked');
    writeShard(path.join(flat, 'capture.ndjson'), [toLine(envelope({ sid: S, id: 'a', body: '' }))]);
    writeShard(path.join(locked, 'calls.ndjson'), [toLine(envelope({ sid: S, id: 'b', body: '' }))]);
    fs.chmodSync(locked, 0o000);
    const sk = listSources([flat]).skipped.find((x) => x.name === 'locked');
    assert.equal(sk.reason, 'unreadable');
    assert.equal(sk.error, 'EACCES');
    assert.match(sk.report, /could not be read/);
    // the sharded board too: a session dir it cannot open is named in source.errors
    const ses = path.join(root, 'sessions');
    await shardOnce({ file: writeShard(path.join(root, 'cap.ndjson'), conversation(S, 1).map((r) => toLine(r))), outDir: ses });
    const sdir = path.join(ses, '99999999-0000-4000-8000-000000000099');
    writeShard(path.join(sdir, 'calls.ndjson'), conversation('99999999-0000-4000-8000-000000000099', 1).map((r) => toLine(r)));
    fs.chmodSync(sdir, 0o000);
    for (const src of [flat, ses]) {
      const { server } = await createServer({ dbPath: '/nonexistent-db', sourcePath: src, enrich: () => null });
      server.listen(0, '127.0.0.1'); await once(server, 'listening');
      try {
        const pj = await get(server.address().port, '/api/projects');
        const want = src === flat ? locked : sdir;
        assert.ok(((pj.source || {}).errors || []).some((e) => e.file === want && /could not be read/.test(e.reason)), `${want} not reported: ${JSON.stringify((pj.source || {}).errors)}`);
      } finally { server.close(); }
    }
  } finally { unlock(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('S-4: a segment of the stream the sealer cannot open is journalled, not only left for readers to find', async () => {
  const root = tmpDir();
  try {
    const f = writeShard(path.join(root, 'sessions', S, 'calls.ndjson'), conversation(S, 2).map((r) => toLine(r)));
    const bad = f + '.0005.sealed', journal = path.join(root, 'j.jsonl');
    fs.writeFileSync(bad, 'not a sealed file at all, but long enough to have a header, a tail and a trailer ......');
    // the sealer itself (the legacy entry refuses before it gets there — confirm review row 5, delete-path.test.mjs)
    await sealUnchecked(f, { split: false, deleteOriginal: false, journal });
    const e = readJournal({ journal }).find((x) => x.file === bad);
    assert.ok(e && e.outcome === 'note' && /could not be opened/.test(e.reason), JSON.stringify(readJournal({ journal })));
    assert.ok(fs.existsSync(bad), 'the unopenable file was touched');
    const r = (await sealLegacy(f, { ...NONE, journal })).refused.find((x) => x.file === f);
    assert.match(r.reason, /calls\.ndjson\.0005\.sealed could not be read/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('S-5: lines whose session key is unsafe as a directory name are counted and journalled', async () => {
  const root = tmpDir();
  try {
    const shard = writeShard(path.join(root, 'collector', 'capture-2026-10-05.ndjson'), [
      toLine(envelope({ sid: S, id: 'ok', body: '' })), toLine(envelope({ sid: '../escape', id: 'x1', body: '' })), toLine(envelope({ sid: 'a/b', id: 'x2', body: '' }))]);
    markClosed(shard);
    const journal = path.join(root, 'j.jsonl');
    const res = await sealShard(shard, { sessionsRoot: path.join(root, 'sessions'), journal });
    assert.equal(res.unsafeKeys, 2);
    assert.equal(readJournal({ journal }).find((e) => e.op === 'seal' && e.outcome === 'ok').unsafeKeys, 2);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('S-6: after journal writes failed, the next one that succeeds first records the gap', () => {
  const root = tmpDir();
  try {
    const journal = path.join(root, 'raw', 'journal.jsonl'), said = [];
    fs.writeFileSync(path.join(root, 'raw'), 'a file where the journal dir should be');
    assert.equal(appendJournal({ op: 'seal', outcome: 'refused', reason: 'one' }, { journal, warn: (m) => said.push(m) }), false);
    assert.equal(appendJournal({ op: 'seal', outcome: 'refused', reason: 'two' }, { journal, warn: (m) => said.push(m) }), false);
    fs.rmSync(path.join(root, 'raw'));
    assert.equal(appendJournal({ op: 'seal', outcome: 'ok', reason: 'three' }, { journal }), true);
    const [gap, ok, ...rest] = readJournal({ journal });
    assert.equal(gap.op, 'log-gap');
    assert.equal(gap.lost, 2);
    assert.ok(gap.from && gap.to && gap.error, JSON.stringify(gap));
    assert.equal(ok.reason, 'three');
    assert.deepEqual(rest, []);
    appendJournal({ op: 'x' }, { journal });
    assert.equal(readJournal({ journal }).filter((e) => e.op === 'log-gap').length, 1, 'the gap was recorded twice');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('S-7: a journal that exists but cannot be read is an error, not "nothing happened"', () => {
  const home = tmpDir();
  try {
    assert.deepEqual(readJournal({ journal: path.join(home, 'none.jsonl') }), [], 'a journal that does not exist yet is empty');
    const journal = path.join(home, '.asight', 'raw', 'journal.jsonl');
    fs.mkdirSync(journal, { recursive: true });                                    // a directory where the file should be
    assert.throws(() => readJournal({ journal }), /EISDIR/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
