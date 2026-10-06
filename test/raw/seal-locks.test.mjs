import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { sealShard } from '../../src/raw/seal.mjs';
import { sealLegacy } from '../../src/raw/legacy.mjs';
import { markClosed } from '../../src/raw/closed.mjs';
import { readJournal } from '../../src/raw/journal.mjs';
import { tmpDir, conversation, envelope, toLine, writeShard, listFiles, decodeAll } from './helpers.mjs';

const S = '99999999-8888-4888-8888-888888888889';
const SEAL = new URL('../../src/raw/seal.mjs', import.meta.url).href;

// Review 3 F12: two sealers may file into one directory (two shards of one name, from two capture
// dirs, into one session dir). The segment number was chosen by listing the dir and then renamed onto:
// a sealer that published that name in between had its verified copy REPLACED — and then deleted its
// own original. The race is injected exactly there: the name is taken just before we publish.
test('F12: a segment name another sealer took a moment earlier is never overwritten', async () => {
  const root = tmpDir();
  try {
    const ses = path.join(root, 'sessions');
    const shard = writeShard(path.join(root, 'a', 'capture-2026-10-05.ndjson'), conversation(S, 3).map((r) => toLine(r)));
    markClosed(shard);
    const theirs = Buffer.from('another sealer\'s verified copy');
    let raced = null;
    const take = (fin) => { if (!raced && /\.sealed$/.test(fin) && fin.startsWith(ses)) { raced = fin; fs.writeFileSync(fin, theirs); } };
    const spy = { ...fs,
      renameSync: (a, b) => { take(b); return fs.renameSync(a, b); },
      linkSync: (a, b) => { take(b); return fs.linkSync(a, b); },
    };
    const res = await sealShard(shard, { sessionsRoot: ses, fs: spy, journal: null });
    assert.ok(raced, 'precondition: the race was injected');
    assert.ok(fs.readFileSync(raced).equals(theirs), 'the other sealer\'s copy was overwritten');
    const mine = res.outputs.find((o) => o.session === S).path;
    assert.notEqual(mine, raced);
    assert.match(path.basename(mine), /\.0002\.sealed$/);
    assert.equal(decodeAll([mine]).size, 3, 'our copy is not whole');
    assert.deepEqual(listFiles(root, /\.tmp$/), [], 'a temp name was left behind');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// Review 3 F10: kill -9 after the original's unlink leaves `<shard>.sealing` beside a shard that is
// gone; nothing would ever take it over. The next seal in that directory removes it and journals it.
const CHILD = `
import { sealShard } from ${JSON.stringify(SEAL)};
await sealShard(process.env.SHARD, { sessionsRoot: process.env.SESSIONS, journal: null, onPhase: (p) => { if (p === 'deleted') process.kill(process.pid, 'SIGKILL'); } });
`;
test('F10: the lock of a seal killed after its unlink is cleaned up, and journalled, by the next seal there', async () => {
  const root = tmpDir();
  try {
    const cap = path.join(root, 'collector'), ses = path.join(root, 'sessions'), journal = path.join(root, 'j.jsonl');
    const a = writeShard(path.join(cap, 'capture-2026-10-05.ndjson'), conversation(S, 2).map((r) => toLine(r)));
    markClosed(a);
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', CHILD], { env: { ...process.env, SHARD: a, SESSIONS: ses }, encoding: 'utf8' });
    assert.equal(r.signal, 'SIGKILL', r.stderr);
    assert.equal(fs.existsSync(a), false, 'precondition: the original was deleted');
    assert.ok(fs.existsSync(a + '.sealing'), 'precondition: the lock survived the kill');
    const b = writeShard(path.join(cap, 'capture-2026-10-06.ndjson'), [toLine(envelope({ id: 'x', body: '' }))]);
    markClosed(b);
    await sealShard(b, { sessionsRoot: ses, journal });
    assert.equal(fs.existsSync(a + '.sealing'), false, 'the dead lock is still there');
    const e = readJournal({ journal }).find((x) => x.op === 'lock');
    assert.ok(e, 'the cleanup was not journalled');
    assert.equal(e.outcome, 'removed');
    assert.equal(e.file, a + '.sealing');
    assert.match(e.reason, /not running.*gone/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('F10: the legacy entry cleans dead locks in the tree it seals; a live one is left alone', async () => {
  const root = tmpDir();
  try {
    const dir = path.join(root, 'sessions', S), journal = path.join(root, 'j.jsonl');
    writeShard(path.join(dir, 'calls.ndjson'), conversation(S, 2).map((x) => toLine(x)));
    const dead = spawnSync(process.execPath, ['-e', '']).pid;
    const done = path.join(root, 'sessions', 'aaaaaaaa-0000-4000-8000-00000000000a');   // nothing left to seal in it
    fs.mkdirSync(done, { recursive: true });
    fs.writeFileSync(path.join(done, 'calls.ndjson.sealing'), String(dead));
    fs.writeFileSync(path.join(dir, 'other.ndjson.sealing'), String(process.ppid));   // alive: someone's seal in progress
    const opts = { fdHolders: async () => new Map(), processList: async () => [], sleep: async () => {}, journal };
    const dry = await sealLegacy(path.join(root, 'sessions'), { ...opts, dryRun: true });
    assert.ok(dry.locks.some((x) => x.outcome === 'would-remove' && x.pid === dead), 'the dry run does not say it would remove the dead lock');
    assert.ok(fs.existsSync(path.join(done, 'calls.ndjson.sealing')), 'a dry run removed something');
    await sealLegacy(path.join(root, 'sessions'), opts);
    assert.equal(fs.existsSync(path.join(done, 'calls.ndjson.sealing')), false);
    assert.ok(fs.existsSync(path.join(dir, 'other.ndjson.sealing')), 'a live lock was removed');
    assert.ok(readJournal({ journal }).some((x) => x.op === 'lock' && x.outcome === 'removed' && x.pid === dead));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// Second pass on F12 (缺接线): the lock is per source path, but the dead-temp cleanup was per name in
// the target dir — so a sealer deleted the LIVE temp of another sealer filing a same-named shard into
// the same session dir, and that one aborted ("seal aborted, original kept: ENOENT … .tmp").
test('F12: a temp of a sealer that is still running is never removed by another', async () => {
  const root = tmpDir();
  try {
    const ses = path.join(root, 'sessions');
    const shard = writeShard(path.join(root, 'a', 'capture-2026-10-05.ndjson'), conversation(S, 2).map((r) => toLine(r)));
    markClosed(shard);
    fs.mkdirSync(path.join(ses, S), { recursive: true });
    const live = path.join(ses, S, `.capture-2026-10-05.ndjson.${process.ppid}-0badc0de.tmp`);   // a running process's temp
    const dead = path.join(ses, S, `.capture-2026-10-05.ndjson.${spawnSync(process.execPath, ['-e', '']).pid}-deadbeef.tmp`);
    fs.writeFileSync(live, 'in progress'); fs.writeFileSync(dead, 'left by a kill');
    await sealShard(shard, { sessionsRoot: ses, journal: null });
    assert.ok(fs.existsSync(live), 'a live sealer\'s temp was deleted');
    assert.equal(fs.existsSync(dead), false, 'a dead sealer\'s temp was kept');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

const PAIR = `
import { sealShard } from ${JSON.stringify(SEAL)};
await sealShard(process.env.SHARD, { sessionsRoot: process.env.SESSIONS, journal: null });
`;
test('F12: two sealers filing same-named shards into one session dir at once both finish, nothing lost', async () => {
  const { spawn } = await import('node:child_process');
  const run = (shard, ses) => new Promise((res) => { const c = spawn(process.execPath, ['--input-type=module', '-e', PAIR], { env: { ...process.env, SHARD: shard, SESSIONS: ses } }); let err = ''; c.stderr.on('data', (d) => (err += d)); c.on('close', (code) => res({ code, err })); });
  for (let round = 0; round < 6; round++) {
    const root = tmpDir();
    try {
      const ses = path.join(root, 'sessions');
      const a = writeShard(path.join(root, 'a', 'capture-2026-10-05.ndjson'), conversation(S, 60, { idPrefix: 'pa_' }).map((r) => toLine(r)));
      const b = writeShard(path.join(root, 'b', 'capture-2026-10-05.ndjson'), conversation(S, 60, { idPrefix: 'pb_' }).map((r) => toLine(r)));
      markClosed(a); markClosed(b);
      const [ra, rb] = await Promise.all([run(a, ses), run(b, ses)]);
      assert.equal(ra.code, 0, `round ${round}, sealer a: ${ra.err}`);
      assert.equal(rb.code, 0, `round ${round}, sealer b: ${rb.err}`);
      const segs = listFiles(path.join(ses, S));
      assert.equal(segs.length, 2, `round ${round}: ${segs.map((f) => path.basename(f))}`);
      assert.equal(decodeAll([segs[0]]).size + decodeAll([segs[1]]).size, 120);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});
