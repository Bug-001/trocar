import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runExport, exportFiles } from '../../src/raw/export.mjs';
import { sealUnchecked } from '../../src/raw/seal.mjs';
import { readJournal } from '../../src/raw/journal.mjs';
import { tmpDir, conversation, envelope, toLine, writeShard } from './helpers.mjs';

// Review 3 F8: `asight raw export <session>` wrote every sealed file of the session into ONE file. A
// stream whose last line has no "\n" (a torn final record — normal for a capture cut off mid-write)
// then ran into the next stream's first line: the export was no longer the original bytes. Each
// segment is exported to its own file now, byte for byte the original it was sealed from.

const S = 'cdcdcdcd-1212-4121-8121-12121212121c';

test('F8: a session exports one file per segment, each the exact bytes of its original — a torn last line stays apart', async () => {
  const root = tmpDir();
  try {
    const dir = path.join(root, 'sessions', S), journal = path.join(root, 'j.jsonl');
    const calls = Buffer.concat([...conversation(S, 2).map((r) => toLine(r)), Buffer.from('{"id":"torn","req_body":"cut off mid-wri')]);
    const probes = toLine(envelope({ sid: S, id: 'pr_1', body: '{}', endpoint: '/v1/messages/count_tokens', llm: false }));
    writeShard(path.join(dir, 'calls.ndjson'), [calls]);
    writeShard(path.join(dir, 'probes.ndjson'), [probes]);
    for (const n of ['calls.ndjson', 'probes.ndjson']) await sealUnchecked(path.join(dir, n), { split: false, deleteOriginal: true, journal });
    const out = path.join(root, 'out');
    const res = runExport({ target: S, sessionsRoot: path.join(root, 'sessions'), out, journal });
    assert.equal(res.out, out);
    assert.deepEqual(fs.readdirSync(out).sort(), ['calls.ndjson.0001.ndjson', 'probes.ndjson.0001.ndjson']);
    assert.ok(fs.readFileSync(path.join(out, 'calls.ndjson.0001.ndjson')).equals(calls), 'the calls export is not its original');
    assert.ok(fs.readFileSync(path.join(out, 'probes.ndjson.0001.ndjson')).equals(probes), 'the torn line ran into the next stream');
    assert.equal(res.records, 4);
    for (const f of fs.readdirSync(out)) assert.equal(fs.statSync(path.join(out, f)).mode & 0o777, 0o600);
    assert.throws(() => runExport({ target: S, sessionsRoot: path.join(root, 'sessions'), out, journal }), /export failed.*EEXIST/, 'an export overwrote an earlier one');
    const ok = readJournal({ journal }).filter((e) => e.op === 'export' && e.outcome === 'ok');
    assert.equal(ok.length, 1);
    assert.equal(ok[0].outputs.length, 2);
    // the default place: ~/.asight/export/<session>/ (0700), which doctor ④b scans
    const def = runExport({ target: S, sessionsRoot: path.join(root, 'sessions'), journal });
    assert.equal(def.out, path.join(process.env.HOME, '.asight', 'export', S));
    assert.equal(fs.statSync(def.out).mode & 0o777, 0o700);
    assert.deepEqual(exportFiles().map((f) => path.relative(def.out, f)).sort(), ['calls.ndjson.0001.ndjson', 'probes.ndjson.0001.ndjson']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
