import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { verifyAgainst, verifyTree } from '../../src/raw/verify.mjs';
import { sealUnchecked } from '../../src/raw/seal.mjs';
import { tmpDir, e1Lines, writeShard, listFiles } from './helpers.mjs';

// `asight raw verify` (coordinator 2026-10-06): before an operator deletes an original, decode its
// sealed copy and compare it with the original BYTE FOR BYTE — not a hash the sealer wrote itself.

function sealedBeside(root) {
  const f = writeShard(path.join(root, 'S-1', 'calls.ndjson'), e1Lines());
  return sealUnchecked(f, { split: false, deleteOriginal: false, frameBytes: 4096 }).then((r) => ({ f, sealed: r.outputs[0].path }));
}

test('a faithful sealed copy verifies byte for byte against its original', async () => {
  const root = tmpDir();
  try {
    const { f, sealed } = await sealedBeside(root);
    const v = verifyAgainst([sealed], f);
    assert.equal(v.ok, true, v.reason);
    assert.equal(v.bytes, fs.statSync(f).size);
    assert.equal(v.records, e1Lines().length);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('one changed byte, an extra line or a missing line in the original fails with where', async () => {
  const root = tmpDir();
  try {
    const { f, sealed } = await sealedBeside(root);
    const orig = fs.readFileSync(f);
    const other = path.join(root, 'calls.ndjson');                     // same name, compared as the original
    const flip = Buffer.from(orig); flip[orig.indexOf('lorem') + 2] ^= 0x20;
    fs.writeFileSync(other, flip);
    let v = verifyAgainst([sealed], other);
    assert.equal(v.ok, false);
    assert.match(v.reason, /line 0 differs at byte \d+/);
    fs.writeFileSync(other, Buffer.concat([orig, Buffer.from('{"id":"extra"}\n')]));
    v = verifyAgainst([sealed], other);
    assert.equal(v.ok, false);
    assert.match(v.reason, /does not record|longer/);
    fs.writeFileSync(other, orig.subarray(0, orig.length - 5));
    assert.equal(verifyAgainst([sealed], other).ok, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('verifyTree checks every sealed file: against its original while it exists, by itself after', async () => {
  const root = tmpDir();
  try {
    const { f } = await sealedBeside(root);
    const g = writeShard(path.join(root, 'control', 'telemetry.ndjson'), e1Lines().slice(0, 3));
    await sealUnchecked(g, { split: false, deleteOriginal: false });
    let res = verifyTree(root);
    assert.deepEqual(res.map((r) => [path.relative(root, r.original), r.mode, r.ok]).sort(),
      [['S-1/calls.ndjson', 'against-original', true], ['control/telemetry.ndjson', 'against-original', true]]);
    fs.unlinkSync(f); fs.unlinkSync(g);
    res = verifyTree(root);
    assert.deepEqual(res.map((r) => [r.mode, r.ok]), [['self', true], ['self', true]]);
    const victim = listFiles(path.join(root, 'S-1'))[0];
    const b = fs.readFileSync(victim); b[40] ^= 0xff; fs.writeFileSync(victim, b);   // inside the first frame
    res = verifyTree(root);
    assert.equal(res.filter((r) => !r.ok).length, 1);
    assert.match(res.find((r) => !r.ok).reason, /corrupt|decode|sha256/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
