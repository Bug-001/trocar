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
