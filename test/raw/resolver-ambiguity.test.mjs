import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildResolver } from '../../src/query/source.mjs';
import { markClosed } from '../../src/raw/closed.mjs';
import { sealShard } from '../../src/raw/seal.mjs';
import { tmpDir, envelope, toLine, writeShard } from './helpers.mjs';

// 4.2 「读」: a duplicated (stream, id) MUST resolve to "ambiguous", never to one of them — "和封存前
// 同名文件里撞 id 的行为一致". Before sealing, two records with one id in ONE shard are ambiguous.
// The per-session split can put them into sealed files under different roots; each root alone then
// holds the id once, and "first root wins" served the other record's bytes as ok. They still come
// from one source shard, so they are still one collision.
const S = 'aaaaaaaa-1111-4111-8111-11111111111a';
async function outcome(roots, ref) {
  const r = await buildResolver(roots);
  try { const d = r.detail(ref); return `${d.status} ${d.text}`; } catch (e) { return 'throws ' + e.message; } finally { r.dispose(); }
}

test('a duplicated id split across roots by sealing is still ambiguous, in either root order', async () => {
  const root = tmpDir();
  try {
    const cap = path.join(root, 'collector'), ses = path.join(root, 'sessions');
    fs.mkdirSync(ses, { recursive: true });
    const shard = writeShard(path.join(cap, 'capture-2026-10-05.ndjson'), [
      toLine(envelope({ id: 'req_00001', body: '{"messages":["ANOTHER RUN, NO SESSION HEADER"]}' })),
      toLine(envelope({ sid: S, id: 'req_00001', body: '{"messages":["THE SESSION RECORD"]}' })),
    ]);
    const ref = `${S}/capture-2026-10-05.ndjson#req_00001::0-20`;
    assert.match(await outcome([cap, ses], ref), /^throws .*ambiguous/, 'precondition: ambiguous before sealing');
    markClosed(shard);
    await sealShard(shard, { sessionsRoot: ses });
    for (const roots of [[cap, ses], [ses, cap]]) {
      assert.match(await outcome(roots, ref), /^throws .*ambiguous.*capture-2026-10-05\.ndjson/, `roots ${roots.map((r) => path.basename(r))} picked one record`);
    }
    // a record whose id is unique in its shard still resolves through the same two roots
    const other = writeShard(path.join(cap, 'capture-2026-10-06.ndjson'), [toLine(envelope({ sid: S, id: 'req_00001', body: '{"messages":["NEXT DAY"]}' }))]);
    markClosed(other);
    await sealShard(other, { sessionsRoot: ses });
    assert.match(await outcome([cap, ses], `${S}/capture-2026-10-06.ndjson#req_00001::0-12`), /^ok \{"messages":/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('an id three times in one shard (two without a session) stays ambiguous after the split, in both root orders', async () => {
  const root = tmpDir();
  try {
    const cap = path.join(root, 'collector'), ses = path.join(root, 'sessions');
    fs.mkdirSync(ses, { recursive: true });
    const shard = writeShard(path.join(cap, 'capture-2026-10-05.ndjson'), [
      toLine(envelope({ id: 'req_00001', body: '{"messages":["RUN 1"]}' })),
      toLine(envelope({ id: 'req_00001', body: '{"messages":["RUN 2"]}' })),
      toLine(envelope({ sid: S, id: 'req_00001', body: '{"messages":["THE SESSION RECORD"]}' })),
    ]);
    markClosed(shard);
    await sealShard(shard, { sessionsRoot: ses });
    const ref = `${S}/capture-2026-10-05.ndjson#req_00001::0-12`;
    for (const roots of [[cap, ses], [ses, cap]]) assert.match(await outcome(roots, ref), /^throws .*ambiguous/, `roots ${roots.map((r) => path.basename(r))} picked one record`);
    assert.match(await outcome(cap, ref), /^throws .*ambiguous/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// Union of feat/read-cc-line (each root refreshes on its own, incrementally) with this branch (the
// split poisoning across roots): when ONE root re-indexes, the other still holds the earlier
// poisoning, and a pass that counted only un-poisoned entries saw the re-indexed copy alone and let
// it answer. The pass takes the earlier poisoning back first, so it is the same after a refresh.
test('a split duplicate stays ambiguous after one root re-indexes on refresh', async () => {
  const root = tmpDir();
  try {
    const cap = path.join(root, 'collector'), ses = path.join(root, 'sessions');
    fs.mkdirSync(ses, { recursive: true });
    const shard = writeShard(path.join(cap, 'capture-2026-10-05.ndjson'), [
      toLine(envelope({ id: 'req_00001', body: '{"messages":["ANOTHER RUN, NO SESSION HEADER"]}' })),
      toLine(envelope({ sid: S, id: 'req_00001', body: '{"messages":["THE SESSION RECORD"]}' })),
    ]);
    markClosed(shard);
    await sealShard(shard, { sessionsRoot: ses });
    const extra = writeShard(path.join(cap, 'scratch.ndjson'), [toLine(envelope({ id: 'req_09999', body: '{"messages":["x"]}' }))]);
    const ref = `${S}/capture-2026-10-05.ndjson#req_00001::0-20`;
    const r = await buildResolver([cap, ses]);
    try {
      assert.throws(() => r.detail(ref), /ambiguous/, 'precondition: ambiguous');
      for (let pass = 1; pass <= 3; pass++) {  // each pass poisons again over the last pass's poisoning
        if (pass > 1) { writeShard(extra, [toLine(envelope({ id: 'req_09999', body: '{"messages":["x"]}' }))]); assert.equal(await r.refresh(), true); }
        fs.rmSync(extra);                     // collector/ re-indexes whole on the next refresh; sessions/ does not
        assert.equal(await r.refresh(), true);
        assert.throws(() => r.detail(ref), /ambiguous.*occurs 2 times/, `pass ${pass}: the re-indexed root answered, or the collision was miscounted`);
      }
    } finally { r.dispose(); }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// A refresh that re-indexes a root (a file left its listing: the sealer deleted a verified original)
// awaits file reads, and lookups run in between. They must be answered from a whole, poisoned index —
// never from a half-built one, where one copy of a split duplicate is back and its other copy (or the
// poisoning pass) is not yet: that copy answered `ok` with the other record's bytes (fresh-context
// review of the read-cc-line × raw-sealer union, finding 1). One root (the copy under sessions/ read as
// a continuation) and two roots.
test('a split duplicate never answers ok while a refresh re-indexes a root', async () => {
  const root = tmpDir();
  try {
    const cap = path.join(root, 'collector'), ses = path.join(root, 'sessions');
    fs.mkdirSync(ses, { recursive: true });
    const shard = writeShard(path.join(cap, 'capture-2026-10-05.ndjson'), [
      toLine(envelope({ id: 'req_00001', body: '{"messages":["ANOTHER RUN, NO SESSION HEADER"]}' })),
      toLine(envelope({ sid: S, id: 'req_00001', body: '{"messages":["THE SESSION RECORD"]}' })),
    ]);
    markClosed(shard);
    await sealShard(shard, { sessionsRoot: ses });
    // a large capture read between the two copies, so the re-index yields to other work on the way
    const pad = 'x'.repeat(1000);
    writeShard(path.join(cap, 'zz-big.ndjson'), Array.from({ length: 12000 }, (_, i) => toLine({ id: `big_${i}`, pad })));
    // and a session file under sessions/ that grows, so that root's refresh also yields AFTER collector/'s
    // rebuild is swapped in (the two-root resolver must re-poison then, not after every root is done)
    const live = writeShard(path.join(ses, 'X', 'calls.ndjson'), [toLine({ id: 'live_0', pad })]);
    const ref = `${S}/capture-2026-10-05.ndjson#req_00001::0-20`;
    for (const [label, r] of [['one root', await buildResolver(cap, { sessionsRoot: ses })], ['two roots', await buildResolver([cap, ses], { sessionsRoot: ses })]]) {
      try {
        const scratch = writeShard(path.join(cap, 'scratch.ndjson'), [toLine(envelope({ id: 'req_09999', body: '{"messages":["x"]}' }))]);
        assert.equal(await r.refresh(), true);
        assert.throws(() => r.detail(ref), /ambiguous/, `${label}: precondition`);
        fs.rmSync(scratch);                   // collector/ re-indexes whole on the next refresh
        fs.appendFileSync(live, Buffer.concat(Array.from({ length: 12000 }, (_, i) => toLine({ id: `${label.length}_live_${i}`, pad }))));
        const seen = [];
        let done = false;
        const probe = () => { if (done) return; try { const d = r.detail(ref); seen.push(`${d.status} ${d.text}`); } catch (e) { seen.push(/ambiguous/.test(e.message) ? 'ambiguous' : 'throws ' + e.message); } setImmediate(probe); };
        setImmediate(probe);
        await r.refresh();
        done = true;
        assert.ok(seen.length > 1, `${label}: precondition — lookups ran during the refresh (${seen.length})`);
        assert.deepEqual([...new Set(seen)], ['ambiguous'], `${label}: a lookup during the re-index answered ${JSON.stringify([...new Set(seen)])}`);
        assert.throws(() => r.detail(ref), /ambiguous/, `${label}: after the refresh`);
      } finally { r.dispose(); }
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// The collector restarts the same day after a seal: a new capture-2026-10-05.ndjson holding req_00001
// again is indexed on refresh, onto an entry an earlier pass poisoned across roots. The new duplicate
// must count the record that entry stood for (`splitFrom`), or the next pass sees the copy under
// sessions/ alone and lets it answer (fresh-context review of the union, finding 4).
test('a new capture of the same stream, indexed onto a split duplicate, keeps it ambiguous in both root orders', async () => {
  for (const order of ['ses-first', 'cap-first']) {
    const root = tmpDir();
    try {
      const cap = path.join(root, 'collector'), ses = path.join(root, 'sessions');
      fs.mkdirSync(ses, { recursive: true });
      const shard = writeShard(path.join(cap, 'capture-2026-10-05.ndjson'), [
        toLine(envelope({ id: 'req_00001', body: '{"messages":["ANOTHER RUN, NO SESSION HEADER"]}' })),
        toLine(envelope({ sid: S, id: 'req_00001', body: '{"messages":["THE SESSION RECORD"]}' })),
      ]);
      markClosed(shard);
      await sealShard(shard, { sessionsRoot: ses });
      assert.ok(!fs.existsSync(shard), 'precondition: the original was deleted after its copies were verified');
      const ref = `${S}/capture-2026-10-05.ndjson#req_00001::0-20`;
      const r = await buildResolver(order === 'ses-first' ? [ses, cap] : [cap, ses]);
      try {
        assert.throws(() => r.detail(ref), /ambiguous/, `${order}: precondition`);
        writeShard(shard, [toLine(envelope({ id: 'req_00001', body: '{"messages":["AFTER THE RESTART"]}' }))]);
        assert.equal(await r.refresh(), true);
        assert.throws(() => r.detail(ref), /ambiguous/, `${order}: a copy answered after the restart`);
      } finally { r.dispose(); }
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});
