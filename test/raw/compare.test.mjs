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
    // the "after deletion" resolver is the one built with the ORIGINALS set aside
    const resolverOf = async (r, o = {}) => { const after = [...(o.exclude || [])].some((f) => f.endsWith('.ndjson'));
      return { detail: (ref) => ({ status: after && ref.endsWith('#ca_00002') ? 'absent' : 'ok', text: 'x' }), dispose() {} }; };
    const res = await compareTree(ses, { resolverOf });
    const a = res.groups.find((g) => g.group === A);
    assert.equal(a.status, 'diff');
    assert.match(a.diff.what, /resolver answers .*ca_00002.*now ok, after deletion absent/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// Second review of F1 (偷换概念): compare decided "would be deleted" by the readers' stat rule, the
// deleter by content. After a `touch`, or in a tree copied without times, the dry run deletes files
// compare called "not covered" — deletions nobody compared. compare now takes the deleter's own test
// (legacy.mjs sameStreamCopies, relation `same`): every file the dry run would delete is compared.
async function planned(ses) {
  const dry = await sealLegacy(ses, { ...NONE, journal: null, deleteOriginal: true, dryRun: true });
  return dry.plan.filter((x) => x.action === 'delete').map((x) => x.file).sort();
}
for (const [label, mangle] of [
  ['a touched original (same bytes, new mtime)', (ses) => { const t = new Date(Date.now() + 5000); fs.utimesSync(path.join(ses, A, 'probes.ndjson'), t, t); return ses; }],
  ['a tree copied without its times (cp -R)', (ses, root) => {
    const copy = path.join(root, 'copy'); fs.cpSync(ses, copy, { recursive: true });
    const t = new Date(Date.now() + 5000);
    for (const f of listFiles(copy, /\.ndjson$/)) fs.utimesSync(f, t, t);
    return copy;
  }],
]) {
  test(`F1: every original the dry run would delete is compared — ${label}`, async () => {
    const root = tmpDir();
    try {
      const ses0 = await tree(root);
      await sealLegacy(ses0, { ...NONE, journal: path.join(root, 'j.jsonl') });
      const ses = mangle(ses0, root);
      const plan = await planned(ses);
      assert.ok(plan.length >= 1, 'precondition: the dry run would delete something');
      const res = await compareTree(ses);
      const covered = res.groups.flatMap((g) => g.deletable).sort();
      const uncovered = res.groups.flatMap((g) => g.uncovered);
      assert.deepEqual(plan.filter((f) => uncovered.includes(f)), [], 'a file the dry run would delete is "not covered" in compare');
      assert.deepEqual(plan.filter((f) => !covered.includes(f)), [], 'a file the dry run would delete was not compared');
      assert.equal(res.ok, true, JSON.stringify(res.groups.filter((g) => g.status !== 'same')));
      assert.equal(res.compared, 10);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}

test('F1: `raw compare --list` names every compared and every not-covered original (for the cross-check with the dry run)', async () => {
  const root = tmpDir();
  try {
    const home = path.join(root, 'home'), ses = await tree(path.join(home, '.asight'));
    await sealLegacy(path.join(ses, A), { ...NONE, journal: null });                      // A sealed, B and control not
    const r = spawnSync(process.execPath, [CLI, 'raw', 'compare', ses, '--list'], { encoding: 'utf8', env: { ...process.env, HOME: home, ASIGHT_SOURCE: '' } });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const lines = (tag) => r.stdout.split('\n').filter((l) => l.startsWith(tag + ' ')).map((l) => l.slice(tag.length).trim()).sort();
    assert.deepEqual(lines('compared-original'), listFiles(path.join(ses, A), /\.ndjson$/));
    assert.deepEqual(lines('not-covered'), [...listFiles(path.join(ses, B), /\.ndjson$/), ...listFiles(path.join(ses, 'control'), /\.ndjson$/)].sort());
    const j = readJournal({ journal: path.join(home, '.asight', 'raw', 'journal.jsonl') }).filter((e) => e.op === 'compare' && e.outcome === 'not-covered');
    assert.deepEqual(j.flatMap((e) => e.files).sort(), lines('not-covered'), 'the not-covered files are not journalled by name');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// Review 3 confirm, row 1: compare grouped the tree its own way (a session dir read for calls, probes,
// other only), so an extra stream in a session dir, or a stream in a directory that is no session, was
// deleted by --delete-original and compared by nobody; a symlinked original was "compared" although
// the deleter refuses it. compare now takes its candidates from the legacy entry's own walk
// (legacyTargets) and the deleter's own per-file test (planFile): the two sets are equal.
test('row 1: compare compares exactly the originals the dry run would delete — an extra stream, a dir that is no session, a symlink', async () => {
  const root = tmpDir();
  try {
    const ses = await tree(root);
    const recs = (p) => [0, 1].map((i) => toLine(envelope({ sid: A, id: `${p}_${i}`, body: '{}', endpoint: '/v1/models', llm: false })));
    const extra = writeShard(path.join(ses, A, 'extra.ndjson'), recs('xa')), misc = writeShard(path.join(ses, 'misc', 'x.ndjson'), recs('xm'));
    await sealLegacy(ses, { ...NONE, journal: path.join(root, 'j.jsonl') });
    // B's calls.ndjson becomes a symlink to a byte-identical copy: the deleter refuses symlinks
    const link = path.join(ses, B, 'calls.ndjson'), real = path.join(root, 'elsewhere.ndjson');
    fs.copyFileSync(link, real); fs.rmSync(link); fs.symlinkSync(real, link);
    const plan = await planned(ses);
    for (const f of [extra, misc]) assert.ok(plan.includes(f), `precondition: the dry run would delete ${f}`);
    assert.ok(!plan.includes(link), 'precondition: the dry run refuses the symlink');
    const res = await compareTree(ses);
    const compared = res.groups.filter((g) => g.status === 'same' || g.status === 'diff').flatMap((g) => g.deletable).sort();
    assert.deepEqual(compared, plan, 'compare did not compare exactly what the dry run would delete');
    assert.equal(res.ok, true, JSON.stringify(res.groups.filter((g) => g.status !== 'same' && g.status !== 'not-covered')));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('row 1: an original --delete-original would delete that no group compared fails the compare, by name', async () => {
  const root = tmpDir();
  try {
    const ses = await tree(root);
    await sealLegacy(ses, { ...NONE, journal: path.join(root, 'j.jsonl') });
    const res = await compareTree(ses, { groupsHook: (gs) => gs.filter((g) => g.group !== B) });   // a grouping that misses B
    assert.equal(res.ok, false, 'a deletion nobody compared passed');
    const o = res.groups.find((g) => g.kind === 'not-compared');
    assert.ok(o, 'the uncompared deletions are not reported');
    assert.equal(o.status, 'diff');
    assert.deepEqual(o.notCompared.slice().sort(), listFiles(path.join(ses, B), /\.ndjson$/));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('row 1 (cosmetic): the summary counts not-covered ORIGINALS, also in a group that mixes covered and uncovered ones', async () => {
  const root = tmpDir();
  try {
    const home = path.join(root, 'home'), ses = await tree(path.join(home, '.asight'));
    await sealLegacy(path.join(ses, A, 'calls.ndjson'), { ...NONE, journal: null });         // A mixes; B and control not sealed
    const r = spawnSync(process.execPath, [CLI, 'raw', 'compare', ses, '--list'], { encoding: 'utf8', env: { ...process.env, HOME: home, ASIGHT_SOURCE: '' } });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const n = r.stdout.split('\n').filter((l) => l.startsWith('not-covered ')).length;
    assert.ok(n >= 3, 'precondition: several originals not covered');
    assert.match(r.stdout, new RegExp(`: 0 differ, ${n} original\\(s\\) not covered,`));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
