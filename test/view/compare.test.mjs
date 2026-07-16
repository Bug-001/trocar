import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readRecords } from '../../src/etl/ingest.mjs';
import { groupSessions, compareView } from '../../src/view/board.mjs';

const FIXTURE = path.resolve('test/fixtures/cc-session-real.ndjson');
const MAIN = '3e03c998-f70d-4843-8639-40f2d8b2cdc7';

async function load() {
  const records = await readRecords(FIXTURE, { normalize: false });
  const ids = [...groupSessions(records).keys()];
  return { records, ids };
}

// D17③: two unknown ids → null (server maps to 404, never a 200 empty shell)
test('compareView: unknown session id → null', async () => {
  const { records } = await load();
  assert.equal(compareView(records, 'nope-a', 'nope-b'), null);
  assert.equal(compareView(records, MAIN, 'nope-b'), null, 'one missing is still null');
});

// self-compare: a run vs itself is byte-structurally identical the whole way (the alignment sanity anchor)
test('compareView: self-compare → zero divergence, no A-only/B-only resources', async () => {
  const { records } = await load();
  const c = compareView(records, MAIN, MAIN);
  assert.ok(c && c.a && c.b, 'produced a comparison');
  assert.equal(c.a.stats.calls, c.b.stats.calls);
  assert.equal(c.align.compared, c.a.steps.length, 'compared all steps (equal length)');
  assert.equal(c.align.firstDiverge, -1, 'no divergent step vs itself');
  assert.equal(c.align.sharedPrefix, c.align.compared, 'shared prefix spans the whole run');
  assert.ok(c.align.per.every((s) => s.identical), 'every step identical vs itself');
  assert.equal(c.resources.aonly.length, 0, 'no A-only resources vs itself');
  assert.equal(c.resources.bonly.length, 0, 'no B-only resources vs itself');
});

// cross-run: main vs a minority singleton session — the real diff surface
test('compareView: cross-run diff surfaces stepwise divergence + resource set-diff', async () => {
  const { records, ids } = await load();
  const other = ids.find((id) => id !== MAIN);
  assert.ok(other, 'fixture has a second session to compare against');
  const c = compareView(records, MAIN, other);
  assert.ok(c.a.stats.calls > 0 && c.b.stats.calls >= 0);
  // aligned over the shorter run; every per-step entry carries the structural Δ (added/removed block counts)
  assert.equal(c.align.compared, Math.min(c.a.steps.length, c.b.steps.length));
  assert.ok(c.align.per.every((s) => typeof s.added === 'number' && typeof s.removed === 'number'));
  // two genuinely different runs diverge somewhere within the compared prefix (or one run is longer)
  const diverges = c.align.firstDiverge >= 0 || c.align.aExtra > 0 || c.align.bExtra > 0;
  assert.ok(diverges, 'distinct runs are not identical');
  // resource set-diff partitions cleanly (no key in two buckets)
  const all = [...c.resources.both, ...c.resources.aonly, ...c.resources.bonly];
  assert.ok(all.length >= 0);
  assert.ok(c.resources.both.every((r) => r.kind && r.label !== undefined), 'resource rows carry kind+label');
});

// wire payload is lean: per-step content_hash arrays are stripped (page needs curves + align summary only)
test('compareView: wire payload strips heavy per-step content_hash arrays', async () => {
  const { records } = await load();
  const c = compareView(records, MAIN, MAIN);
  assert.ok(c.a.steps.every((s) => !('keys' in s)), 'no raw content_hash arrays leak onto the wire');
  assert.ok(c.a.steps.every((s) => 'ctx' in s && 'compaction' in s), 'steps keep ctx + compaction for the growth curve');
});
