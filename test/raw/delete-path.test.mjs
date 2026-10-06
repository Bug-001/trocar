import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { sealLegacy, otherSealers } from '../../src/raw/legacy.mjs';
import { readJournal } from '../../src/raw/journal.mjs';
import { tmpDir, conversation, toLine, writeShard } from './helpers.mjs';

// The confirm review of review 3 ("yes, with conditions") on the path that deletes originals —
// `asight raw seal --legacy --delete-original`, about to run on 7.6 GB nobody can capture again. One
// test (or more) per row of its table; each is shown red by a mutation (scratchpad falsify-review3.md).

const NONE = { fdHolders: async () => new Map(), processList: async () => [], sleep: async () => {} };
const SID = 'aaaaaaaa-0000-4000-8000-00000000000a';
function sealedTree() {
  const root = tmpDir();
  const f = writeShard(path.join(root, 'sessions', SID, 'calls.ndjson'), conversation(SID, 4).map((r) => toLine(r)));
  return { root, f, journal: path.join(root, 'j.jsonl') };
}

// ── row 2: the delete takes the shard's seal lock, and refuses while another sealer runs ──────────
test('row 2: an original whose seal lock a live sealer holds is not deleted — refused, journalled, the lock left alone', async () => {
  const { root, f, journal } = sealedTree();
  try {
    await sealLegacy(f, { ...NONE, journal });
    fs.writeFileSync(f + '.sealing', String(process.ppid));          // a live process that is not us
    const res = await sealLegacy(f, { ...NONE, journal, deleteOriginal: true });
    assert.ok(fs.existsSync(f), 'deleted while another sealer held its lock');
    assert.deepEqual(res.deletedOnly, []);
    assert.match(res.refused.find((r) => r.file === f).reason, new RegExp(`another sealer \\(pid ${process.ppid}\\) holds .*nothing deleted`));
    assert.ok(readJournal({ journal }).some((e) => e.op === 'delete-original' && e.outcome === 'refused' && e.file === f));
    assert.equal(fs.readFileSync(f + '.sealing', 'utf8'), String(process.ppid), 'another sealer\'s lock was touched');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('row 2: the lock is held from the byte-for-byte check through the unlink, and released after', async () => {
  const { root, f, journal } = sealedTree();
  try {
    await sealLegacy(f, { ...NONE, journal });
    const seen = [];
    const spy = { ...fs,
      openSync: (p, ...a) => { if (p === f) seen.push(['read', fs.existsSync(f + '.sealing') && fs.readFileSync(f + '.sealing', 'utf8')]); return fs.openSync(p, ...a); },
      unlinkSync: (p) => { if (p === f) seen.push(['unlink', fs.existsSync(f + '.sealing') && fs.readFileSync(f + '.sealing', 'utf8')]); return fs.unlinkSync(p); } };
    const res = await sealLegacy(f, { ...NONE, journal, deleteOriginal: true, fs: spy });
    assert.equal(res.deletedOnly.length, 1);
    const check = seen.filter(([k]) => k === 'read').at(-1), unlink = seen.find(([k]) => k === 'unlink');
    assert.deepEqual(check, ['read', String(process.pid)], 'the byte-for-byte check ran without the lock');
    assert.deepEqual(unlink, ['unlink', String(process.pid)], 'the unlink ran without the lock');
    assert.ok(!fs.existsSync(f + '.sealing'), 'the lock was not released');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('row 2: the run refuses while another `asight raw seal` works in its tree (argv, a macOS ps line, a relative path); its own ancestors and sealers elsewhere are not "another"', async () => {
  const { root, f, journal } = sealedTree();
  try {
    await sealLegacy(f, { ...NONE, journal });
    const ses = path.join(root, 'sessions');
    for (const other of [{ pid: 424242, argv: ['node', '/x/bin/asight.mjs', 'raw', 'seal', '--legacy', ses] },
      { pid: 424243, cmd: `/usr/local/bin/node /x/bin/asight.mjs raw seal ${path.join(root, 'cap.ndjson')} --sessions ${ses}` },
      { pid: 424245, argv: ['node', '/x/bin/asight.mjs', 'raw', 'seal', '--legacy', 'sessions'] }]) {         // whose cwd? cannot tell
      await assert.rejects(sealLegacy(f, { ...NONE, journal, deleteOriginal: true, processList: async () => [other] }),
        new RegExp(`another \`asight raw seal\` is running \\(pid ${other.pid}\\)`));
      assert.ok(fs.existsSync(f), 'deleted while another sealer ran');
    }
    assert.ok(readJournal({ journal }).some((e) => e.op === 'seal-legacy' && e.outcome === 'refused' && /another `asight raw seal`/.test(e.reason)));
    // `npx asight raw seal …`: npm's own process is this one's parent, not another sealer
    const me = { pid: process.pid, ppid: process.ppid, argv: ['node', '/x/bin/asight.mjs', 'raw', 'seal', '--legacy', root] };
    const npx = { pid: process.ppid, ppid: 1, argv: ['npm', 'exec', 'asight', 'raw', 'seal', '--legacy', root] };
    const elsewhere = { pid: 424246, ppid: 1, argv: ['node', '/x/bin/asight.mjs', 'raw', 'seal', '--legacy', path.join(path.dirname(root), 'not-this-tree')] };
    const closedHere = { pid: 424247, ppid: 1, argv: ['node', '/x/bin/asight.mjs', 'raw', 'seal', '/elsewhere/cap.ndjson'] };   // files into the default sessions root
    assert.deepEqual(otherSealers([me, npx, elsewhere], { target: f }), []);
    assert.deepEqual(otherSealers([me, npx, closedHere], { target: f, sessionsRoot: ses, homeOf: () => null, alive: () => true }).map((p) => p.pid), [424247], 'its HOME unknown: this one\'s');
    assert.deepEqual(otherSealers([me, npx, closedHere], { target: f, sessionsRoot: ses, homeOf: () => null, alive: () => false }), [], 'it ended since the list was taken');
    assert.deepEqual(otherSealers([me, npx, closedHere], { target: f, homeOf: () => path.dirname(path.dirname(ses)) }).map((p) => p.pid), [], 'its default sessions root is under ITS home');
    const homeHere = path.join(root, 'home'); fs.mkdirSync(path.join(homeHere, '.asight', 'sessions'), { recursive: true });
    assert.deepEqual(otherSealers([closedHere], { target: path.join(homeHere, '.asight', 'sessions'), homeOf: () => homeHere }).map((p) => p.pid), [424247]);
    assert.deepEqual(otherSealers([{ pid: 9, argv: ['vim', 'asight', 'raw', 'seal'] }, { pid: 10, argv: ['node', '/x/bin/asight.mjs', 'raw', 'verify', ses] }], { target: f }), [], 'not a sealer');
    const res = await sealLegacy(f, { ...NONE, journal, deleteOriginal: true, processList: async () => [me, npx, elsewhere] });
    assert.equal(res.deletedOnly.length, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ── row 3: a journal entry before every unlink; no journal, no deletion ──────────────────────────
test('row 3: a raw journal that cannot be written refuses the whole delete run — nothing deleted', async () => {
  const { root, f } = sealedTree();
  const ro = path.join(root, 'ro');
  try {
    await sealLegacy(f, { ...NONE, journal: path.join(root, 'j.jsonl') });
    fs.mkdirSync(ro); fs.chmodSync(ro, 0o500);
    for (const journal of [path.join(ro, 'journal.jsonl'), null]) {
      await assert.rejects(sealLegacy(f, { ...NONE, journal, deleteOriginal: true }), /raw journal .*cannot be written.*nothing deleted/);
      assert.ok(fs.existsSync(f), `deleted without a durable record (journal ${journal})`);
    }
  } finally { fs.chmodSync(ro, 0o700); fs.rmSync(root, { recursive: true, force: true }); }
});

test('row 3: each original\'s "deleting" entry is durable before its unlink; a journal that breaks mid-run stops the run there', async () => {
  const root = tmpDir(), journal = path.join(root, 'j.jsonl');
  try {
    const dir = path.join(root, 'sessions', SID);
    const files = ['calls.ndjson', 'probes.ndjson', 'other.ndjson'].map((n) => writeShard(path.join(dir, n), conversation(SID, 2, { idPrefix: n[0] }).map((r) => toLine(r))));
    await sealLegacy(dir, { ...NONE, journal });
    const before = [];
    const spy = { ...fs, unlinkSync: (p) => { if (files.includes(p)) before.push([p, readJournal({ journal }).at(-1)]); return fs.unlinkSync(p); } };
    let n = 0;
    // the journal breaks before the 2nd file and would work again for the 3rd: the run stopped at the 2nd
    const res = await sealLegacy(dir, { ...NONE, journal, deleteOriginal: true, fs: spy, onFile: () => { n++; fs.chmodSync(journal, n === 2 ? 0o400 : 0o600); } });
    assert.equal(before.length, 1, 'an original was unlinked after the journal could not be written');
    assert.equal(before[0][1].op, 'delete-original');
    assert.equal(before[0][1].outcome, 'deleting', 'no durable entry before the unlink');
    assert.equal(before[0][1].file, before[0][0]);
    assert.deepEqual(res.deletedOnly.map((x) => x.file), [before[0][0]]);
    const kept = files.filter((f) => f !== before[0][0]);
    assert.equal(kept.length, 2);
    for (const f of kept) {
      assert.ok(fs.existsSync(f));
      assert.match(res.refused.find((r) => r.file === f).reason, /raw journal .*cannot be written/);
    }
    assert.equal(n, 2, 'the run went on after the journal broke');
  } finally { try { fs.chmodSync(journal, 0o600); } catch {} fs.rmSync(root, { recursive: true, force: true }); }
});

// ── row 4: an unreadable directory or original is a journalled refusal naming it, never a stack trace ──
const CLI = path.join(path.dirname(new URL(import.meta.url).pathname), '..', '..', 'bin', 'asight.mjs');
const SID_B = 'bbbbbbbb-0000-4000-8000-00000000000b';
function cliTree() {
  const root = tmpDir(), home = path.join(root, 'home'), ses = path.join(home, '.asight', 'sessions');
  for (const sid of [SID, SID_B]) writeShard(path.join(ses, sid, 'calls.ndjson'), conversation(sid, 2).map((r) => toLine(r)));
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, HOME: home, ASIGHT_SOURCE: '' } });
  return { root, home, ses, run, journal: path.join(home, '.asight', 'raw', 'journal.jsonl') };
}
const noTrace = (r) => assert.doesNotMatch(r.stderr, /\n\s+at .*\(.*:\d+:\d+\)/, `a stack trace:\n${r.stderr}`);

for (const what of ['a session directory', 'an original']) {
  test(`row 4: ${what} that cannot be read — seal --legacy (dry and real), verify and compare name it, journal it, exit 1, no stack trace; nothing of it deleted`, async () => {
    const { root, ses, run, journal } = cliTree();
    const bad = what === 'an original' ? path.join(ses, SID_B, 'calls.ndjson') : path.join(ses, SID_B);
    try {
      await sealLegacy(ses, { ...NONE, journal: path.join(root, 'j.jsonl') });
      fs.chmodSync(bad, 0);
      for (const args of [['raw', 'seal', '--legacy', ses, '--delete-original', '--quiet', '0', '--dry-run'], ['raw', 'seal', '--legacy', ses, '--delete-original', '--quiet', '0'],
        ['raw', 'verify', ses], ['raw', 'compare', ses]]) {
        const r = run(...args);
        noTrace(r);
        assert.equal(r.status, 1, `${args.join(' ')}: exit ${r.status}\n${r.stdout}${r.stderr}`);
        assert.ok((r.stdout + r.stderr).includes(bad), `${args.join(' ')} does not name ${bad}:\n${r.stdout}${r.stderr}`);
      }
      fs.chmodSync(bad, 0o700);
      assert.ok(fs.existsSync(path.join(ses, SID_B, 'calls.ndjson')), 'the unreadable one was deleted');
      const j = readJournal({ journal });
      assert.ok(j.some((e) => e.op === 'seal-legacy' && e.outcome === 'refused' && e.file === bad && /nothing .*deleted/.test(e.reason)), 'seal --legacy: no journalled refusal naming it');
      assert.ok(j.some((e) => e.op === 'verify' && e.outcome === 'failed' && JSON.stringify(e).includes(bad)), 'verify: no journalled failure naming it');
      assert.ok(j.some((e) => e.op === 'compare' && e.outcome === 'diff' && JSON.stringify(e).includes(bad)), 'compare: no journalled difference naming it');
    } finally { try { fs.chmodSync(bad, 0o700); } catch {} fs.rmSync(root, { recursive: true, force: true }); }
  });
}

// ── row 5: a copy that cannot be read is named, never "no sealed copy yet" ────────────────────────
test('row 5: a sealed segment of the stream whose index cannot be read is named in the refusal — delete and seal alike', async () => {
  const { root, f, journal } = sealedTree();
  try {
    await sealLegacy(f, { ...NONE, journal });
    const copy = f + '.0001.sealed';
    assert.ok(fs.existsSync(copy), 'precondition: the copy');
    fs.truncateSync(copy, fs.statSync(copy).size - 7);                  // its index tail is cut
    for (const deleteOriginal of [true, false]) {
      const res = await sealLegacy(f, { ...NONE, journal, deleteOriginal });
      const r = res.refused.find((x) => x.file === f);
      assert.ok(r, `deleteOriginal=${deleteOriginal}: not refused`);
      assert.doesNotMatch(r.reason, /no sealed copy yet/);
      assert.match(r.reason, /calls\.ndjson\.0001\.sealed could not be read/);
      assert.ok(fs.existsSync(f));
      assert.ok(!fs.existsSync(f + '.0002.sealed'), 'sealed a second time beside a copy that cannot be read');
    }
    assert.ok(readJournal({ journal }).some((e) => e.outcome === 'refused' && e.file === f && /0001\.sealed could not be read/.test(e.reason)));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ── row 6: a rewrite that keeps size, mtime and inode still counts as a change ───────────────────
test('row 6: an original rewritten in place between its byte-for-byte check and the unlink, size and mtime restored, is not deleted', async () => {
  const { root, f, journal } = sealedTree();
  try {
    await sealLegacy(f, { ...NONE, journal });
    const T = Math.floor(Date.now() / 1000) - 60;
    fs.utimesSync(f, T, T);                                         // a whole second: restorable exactly
    let done = false;
    const spy = { ...fs, fsyncSync: (fd) => {                        // the first fsync is of the copy's directory, after the check
      if (!done) {
        done = true;
        const at = fs.readFileSync(f).indexOf('lorem');
        const w = fs.openSync(f, 'r+'); fs.writeSync(w, Buffer.from('L'), 0, 1, at); fs.closeSync(w);
        fs.utimesSync(f, T, T);
      }
      return fs.fsyncSync(fd);
    } };
    const res = await sealLegacy(f, { ...NONE, journal, deleteOriginal: true, fs: spy });
    assert.ok(done, 'precondition: the rewrite happened');
    assert.equal(fs.statSync(f).mtimeMs, T * 1000, 'precondition: mtime restored');
    assert.ok(fs.existsSync(f), 'an original rewritten after its check was deleted');
    assert.deepEqual(res.deletedOnly, []);
    assert.match(res.refused.find((r) => r.file === f).reason, /changed after the quiet window/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
