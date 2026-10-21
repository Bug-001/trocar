// test/dissect/chain-unread.test.mjs — a stitched context whose middle record does not read back (3.1:60, invariant 4 / D38):
// the session still folds, that call's context is partial and names the record, every other call is as it was.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir } from '../helpers/tmp.mjs';
import { readRecords } from '../../src/raw/ingest.mjs';
import { createAssembler } from '../../src/view/assemble.mjs';
import { threadSession, record, replyOf, user } from '../helpers/cc-threads.mjs';

// M0 → M1 → M2 with enough fresh threads between M1 and M2 that no held tip knows M2's prefix: M2's context is read back by id.
async function fold(unread) {
  const s = threadSession();
  const fresh = Array.from({ length: 12 }, (_, i) => record(`F${i}`, `2026-10-20T00:00:03.${String(100 + i)}Z`, {
    model: 'claude-opus-x', thread: { type: 'create' }, max_tokens: 100, stream: true,
    system: [{ type: 'text', text: `fresh thread ${i}` }], messages: [user(`task ${i}`)],
  }, replyOf(`msg_f${i}`, [{ type: 'text', text: `done ${i}` }])));
  const file = path.join(tmpDir('trocar-unread-'), 'cap.ndjson');
  fs.writeFileSync(file, [s.M0, s.M1, ...fresh, s.M2].map((r) => JSON.stringify(r)).join('\n') + '\n');
  const recs = await readRecords(file);
  const read = function* (ids) { for (const r of recs) if (ids.includes(r.id) && r.id !== unread) yield r; };
  const asm = createAssembler({ read });
  for (const r of recs) asm.push(r);
  const A = asm.finish();
  return new Map(A.lanes.flatMap((l) => l.calls.map((c) => [c.id, c])));
}

test('a record a context is stitched from that does not read back: that call is partial naming it, the rest unchanged', async () => {
  const whole = await fold(null);
  const gap = await fold('M1');
  assert.equal(whole.get('M2').wire.contextState, 'reconstructed');
  const m2 = gap.get('M2');
  assert.equal(m2.wire.contextState, 'partial');
  assert.match(m2.wire.contextMissing, /\bM1\b/);
  for (const [id, c] of whole) if (id !== 'M2') assert.deepEqual(JSON.parse(JSON.stringify(gap.get(id))), JSON.parse(JSON.stringify(c)), id);
});
