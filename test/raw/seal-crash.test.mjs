import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { sealShard } from '../../src/raw/seal.mjs';
import { markClosed, closedMarkerPath } from '../../src/raw/closed.mjs';
import { listSources, isSealedPath } from '../../src/raw/discover.mjs';
import { tmpDir, e1Lines, writeShard, listFiles, decodeAll } from './helpers.mjs';

// E5 (4.6): `kill -9` mid-seal — before any rename, between two renames (one shard → several sealed
// files), and after the renames but before the original is deleted. Afterwards the original MUST be
// intact (alone, or next to verified copies), every reader MUST use exactly one copy of each line,
// and a re-run MUST finish the job without leaving temps or duplicates behind.

const SEAL = new URL('../../src/raw/seal.mjs', import.meta.url).href;
const CHILD = `
import { sealShard } from ${JSON.stringify(SEAL)};
let n = 0;
await sealShard(process.env.SHARD, { sessionsRoot: process.env.SESSIONS, frameBytes: 4096, onPhase: (p) => {
  if (p === process.env.PHASE && ++n === Number(process.env.NTH)) process.kill(process.pid, 'SIGKILL');
} });
process.stdout.write('finished without being killed');
`;

// What a reader sees: every line of every file it would read, sealed ones decoded.
function readerLines(roots) {
  const out = [];
  for (const f of listSources(roots).files) {
    if (isSealedPath(f)) for (const { line } of decodeAll([f]).values()) out.push(line.toString('latin1'));
    else { const b = fs.readFileSync(f).toString('latin1'); out.push(...b.split(/(?<=\n)/)); }
  }
  return out.sort();
}

for (const [phase, nth, label] of [['written', 1, 'before any rename'], ['renamed', 1, 'between two renames'], ['synced', 1, 'after the renames, before the unlink']]) {
  test(`E5: kill -9 ${label} leaves the original intact and readers on one copy`, async () => {
    const root = tmpDir();
    try {
      const lines = e1Lines();
      const cap = path.join(root, 'collector'), ses = path.join(root, 'sessions');
      const shard = writeShard(path.join(cap, 'capture-2026-10-05.ndjson'), lines);
      markClosed(shard);
      fs.mkdirSync(ses);
      const want = lines.map((l) => l.toString('latin1')).sort();
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', CHILD], { env: { ...process.env, SHARD: shard, SESSIONS: ses, PHASE: phase, NTH: String(nth) }, encoding: 'utf8' });
      assert.equal(r.signal, 'SIGKILL', `the child was not killed at ${phase}: ${r.stdout}${r.stderr}`);
      assert.ok(fs.readFileSync(shard).equals(Buffer.concat(lines)), 'the original changed');
      assert.ok(fs.existsSync(closedMarkerPath(shard)));
      const sealed = listFiles(root).length;
      assert.equal(sealed, { written: 0, renamed: 1, synced: 3 }[phase]);
      assert.deepEqual(readerLines([cap, ses]), want, 'a reader saw a line twice or missed one');

      const res = await sealShard(shard, { sessionsRoot: ses, frameBytes: 4096 });  // the re-run completes it
      assert.equal(res.deleted, true);
      assert.deepEqual(listFiles(root, /\.tmp$|\.sealing$/), [], 'temps or the lock of the killed run survived');
      assert.equal(listFiles(root).length, 3, 'the killed run\'s copies were not superseded');
      assert.equal(decodeAll(listFiles(root)).size, lines.length);
      assert.deepEqual(readerLines([cap, ses]), want);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}
