import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpDir, conversation, envelope, toLine, writeShard, listFiles } from './helpers.mjs';
import { shardOnce } from '../../src/etl/shard.mjs';
import { sealLegacy } from '../../src/raw/legacy.mjs';
import { compareTree } from '../../src/query/raw-compare.mjs';
import { readJournal } from '../../src/raw/journal.mjs';

// Review 3 F1: the real-run check before deleting originals compared `curl -s` output of two servers
// — which were not listening yet, so both sides hashed the same empty string. `asight raw compare
// <dir>` replaces it: per session and per control class, what the readers read now (originals) against
// what they will read once the originals with a sealed copy are deleted (sealed copies), through the
// readers' own functions in-process — the record id/ts sequence, every record's bytes, the resolver's
// answer for every id. Non-zero on any difference, an unreadable copy, or nothing compared.

const NONE = { fdHolders: async () => new Map(), processList: async () => [], sleep: async () => {} };
const A = 'a1a1a1a1-0000-4000-8000-0000000000a1', B = 'b2b2b2b2-0000-4000-8000-0000000000b2';
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'asight.mjs');

async function tree(root) {
  const a = conversation(A, 4, { idPrefix: 'ca_' }), b = conversation(B, 2, { idPrefix: 'cb_' });
  const probe = envelope({ sid: A, id: 'pa_1', body: '{}', endpoint: '/v1/messages/count_tokens', llm: false });
  const other = envelope({ sid: A, id: 'oa_1', body: '{}', endpoint: '/v1/models', llm: false });
  const tel = envelope({ id: 'tel_1', body: { raw_chars: 1, verbatim: false }, endpoint: '/api/event_logging/batch', llm: false });
  const acct = envelope({ id: 'acc_1', body: '{}', endpoint: '/api/oauth/profile', llm: false });
  const ses = path.join(root, 'sessions');
  await shardOnce({ file: writeShard(path.join(root, 'cap.ndjson'), [a[0], other, b[0], probe, tel, a[1], acct, a[2], b[1], a[3]].map((r) => toLine(r))), outDir: ses });
  return ses;
}

test('F1: compare reads every session and control class over originals and over sealed copies — the same', async () => {
  const root = tmpDir();
  try {
    const ses = await tree(root), journal = path.join(root, 'j.jsonl');
    await sealLegacy(ses, { ...NONE, journal });
    const res = await compareTree(ses);
    assert.deepEqual(res.groups.filter((g) => g.status !== 'same').map((g) => [g.group, g.status, g.diff]), []);
    assert.deepEqual(res.groups.map((g) => g.group).sort(), [A, B, 'control/account.ndjson', 'control/telemetry.ndjson'].sort());
    assert.equal(res.compared, 10, 'not every record was compared');
    assert.equal(res.groups.find((g) => g.group === A).resolver.checked, 6, 'the resolver was not asked for every id of the session');
    assert.equal(res.ok, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('F1: a sealed copy that does not read back the same is a DIFF, named, journalled, exit 1; nothing compared is exit 1 too', async () => {
  const root = tmpDir();
  try {
    const home = path.join(root, 'home'), ses = await tree(path.join(home, '.asight'));
    const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, HOME: home, ASIGHT_SOURCE: '' } });
    let r = run('raw', 'compare', ses);
    assert.equal(r.status, 1, 'nothing sealed, yet compare passed');
    assert.match(r.stderr + r.stdout, /nothing compared/);
    await sealLegacy(ses, { ...NONE, journal: path.join(root, 'j.jsonl') });
    r = run('raw', 'compare', ses);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /compared 10 records in 4 groups/);
    // damage A's sealed probes (its frame; the index still opens). The resolver does not index probes in
    // a sharded tree, so only the record-by-record read can see it.
    for (const stream of ['probes', 'calls']) {
      const victim = listFiles(path.join(ses, A)).find((f) => f.includes(`${stream}.ndjson.`));
      const fd = fs.openSync(victim, 'r+'); fs.writeSync(fd, Buffer.from([0x5a, 0x5a]), 0, 2, 30); fs.closeSync(fd);
      r = run('raw', 'compare', ses);
      assert.equal(r.status, 1, `a damaged sealed ${stream} copy passed the compare`);
      assert.match(r.stdout + r.stderr, new RegExp(`DIFF\\s+${A} .*${stream}\\.ndjson\\.0001\\.sealed`));
    }
    const j = readJournal({ journal: path.join(home, '.asight', 'raw', 'journal.jsonl') }).filter((e) => e.op === 'compare');
    assert.ok(j.some((e) => e.outcome === 'diff' && e.group === A && e.reason), 'the difference left no durable record');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('F1: an original without a sealed copy is reported as not covered, not counted as compared', async () => {
  const root = tmpDir();
  try {
    const ses = await tree(root);
    await sealLegacy(path.join(ses, A, 'calls.ndjson'), { ...NONE, journal: path.join(root, 'j.jsonl') });
    const res = await compareTree(ses);
    const a = res.groups.find((g) => g.group === A);
    assert.equal(a.status, 'same');
    assert.deepEqual(a.uncovered.map((f) => path.basename(f)).sort(), ['other.ndjson', 'probes.ndjson']);
    assert.equal(res.groups.find((g) => g.group === B).status, 'not-covered');
    assert.equal(res.compared, 6);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('F1: an original changed in place under the same size and mtime (so readers take it for the sealed one) is a DIFF', async () => {
  const root = tmpDir();
  try {
    const ses = await tree(root);
    const f = path.join(ses, A, 'calls.ndjson'), T = Math.floor(Date.now() / 1000) - 60;
    fs.utimesSync(f, T, T);                                 // a whole second: restorable exactly below
    await sealLegacy(ses, { ...NONE, journal: path.join(root, 'j.jsonl') });
    const at = fs.readFileSync(f).indexOf('lorem');
    const fd = fs.openSync(f, 'r+'); fs.writeSync(fd, Buffer.from('L'), 0, 1, at); fs.closeSync(fd);
    fs.utimesSync(f, T, T);
    assert.equal(fs.statSync(f).mtimeMs, T * 1000, 'precondition: same mtime as when sealed');
    const res = await compareTree(ses);
    const a = res.groups.find((g) => g.group === A);
    assert.equal(a.status, 'diff');
    assert.match(a.diff.what, /same record id, other bytes/);
    assert.equal(res.ok, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('F1: a resolver that answers one id differently after the deletion is a DIFF (the comparison itself)', async () => {
  const root = tmpDir();
  try {
    const ses = await tree(root);
    await sealLegacy(ses, { ...NONE, journal: path.join(root, 'j.jsonl') });
    const resolverOf = async (r, o = {}) => ({ detail: (ref) => ({ status: o.exclude && ref.endsWith('#ca_00002') ? 'absent' : 'ok', text: 'x' }), dispose() {} });
    const res = await compareTree(ses, { resolverOf });
    const a = res.groups.find((g) => g.group === A);
    assert.equal(a.status, 'diff');
    assert.match(a.diff.what, /resolver answers .*ca_00002.*now ok, after deletion absent/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
