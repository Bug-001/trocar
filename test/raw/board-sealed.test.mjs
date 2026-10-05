import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir, conversation, envelope, toLine, writeShard, listFiles } from './helpers.mjs';
import { createServer } from '../../src/server.mjs';
import { shardOnce } from '../../src/etl/shard.mjs';
import { sealShard, sealUnchecked } from '../../src/raw/seal.mjs';
import { markClosed } from '../../src/raw/closed.mjs';

// E8 (4.6), board half: the session list and every session's records are the same before and after
// sealing — on a legacy `asight shard` root and on a collector shard read flat — and a poll that runs
// while the sealer works neither duplicates nor drops a record.

const get = (port, p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port, path: p }, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res(JSON.parse(b))); }).on('error', rej);
});
async function serve(sourcePath, opts = {}) {
  const { server } = await createServer({ dbPath: '/nonexistent-db', sourcePath, enrich: () => null, ...opts });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { server, port: server.address().port };
}
// Everything the board shows: the list, each session (full records), the control plane. The list's
// `source` report (feat/read-cc-line, 4.4:83) also names every entry the board does not read; the ones
// that cannot hold capture bytes (`attention: false` — the sealer's own temp files, marker and lock, a
// session dir it is still writing) come and go while the sealer works and are left out of the
// comparison. Everything that may hold capture bytes is still compared.
const capturesOnly = (projects) => { if (projects.source) projects.source.skipped = projects.source.skipped.filter((x) => x.attention); return projects; };
async function board(port) {
  const projects = capturesOnly(await get(port, '/api/projects'));
  const ids = projects.projects.flatMap((p) => p.sessions.map((s) => s.session_id)).sort();
  const sessions = {};
  for (const id of ids) sessions[id] = await get(port, `/api/session?id=${encodeURIComponent(id)}`);
  const control = await get(port, '/api/control');
  for (const c of control.classes || []) control[c.class] = await get(port, `/api/control?class=${encodeURIComponent(c.class)}`);
  return { projects, sessions, control };
}
const A = 'aaaaaaaa-1111-4111-8111-11111111111a', B = 'bbbbbbbb-2222-4222-8222-22222222222b';
function capture() {
  const a = conversation(A, 5, { idPrefix: 'ra_' }), b = conversation(B, 3, { idPrefix: 'rb_' });
  const probe = envelope({ sid: A, id: 'probe_1', body: '{"messages":[]}', endpoint: '/v1/messages/count_tokens', llm: false });
  const tel = envelope({ id: 'tel_1', body: { raw_chars: 9, verbatim: false }, endpoint: '/api/event_logging/batch', llm: false });
  return [a[0], b[0], probe, a[1], tel, b[1], a[2], a[3], b[2], a[4]].map((r) => toLine(r));
}

test('E8: a legacy `asight shard` root looks the same to the board after every stream is sealed', async () => {
  const root = tmpDir();
  try {
    const ses = path.join(root, 'sessions');
    await shardOnce({ file: writeShard(path.join(root, 'claude-capture.ndjson'), capture()), outDir: ses });
    let s = await serve(ses);
    const before = await board(s.port);
    s.server.close();
    assert.equal(Object.keys(before.sessions).length, 2);
    assert.ok(JSON.stringify(before.control).includes('tel_1'), 'precondition: control traffic is shown');
    const streams = listFiles(ses, /\.ndjson$/);
    assert.ok(streams.some((f) => f.endsWith('probes.ndjson')) && streams.some((f) => f.includes('/control/')));
    for (const f of streams) await sealUnchecked(f, { split: false, deleteOriginal: true });
    assert.deepEqual(listFiles(ses, /\.ndjson$/), []);
    s = await serve(ses);
    assert.deepEqual(await board(s.port), before);
    s.server.close();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// Served the way `asight serve --source <collector>` serves it: the collector dir as the root, plus the
// sessions dir `asight raw seal` files into (bin passes sessionsRoot). Serving the sessions dir as a
// SECOND ROOT (no CLI flag produces that) is not a layout: the board picks one mode for all roots,
// and session dirs appearing in a served root switch it to sharded mode mid-seal.
for (const layout of ['--source <collector dir>']) test(`E8: a collector shard read flat (${layout}) — the board is the same before, during and after sealing`, async () => {
  const root = tmpDir();
  try {
    const cap = path.join(root, 'collector'), ses = path.join(root, 'sessions');
    fs.mkdirSync(ses, { recursive: true });
    const shard = writeShard(path.join(cap, 'capture-2026-10-05.ndjson'), capture());
    const src = layout.startsWith('--source') ? [cap, { sessionsRoot: ses }] : [[cap, ses]];
    const s = await serve(...src);
    try {
      const before = await board(s.port);
      assert.equal(Object.keys(before.sessions).length, 2);
      markClosed(shard);
      const during = [];
      await sealShard(shard, { sessionsRoot: ses, onPhase: async (p) => { during.push([p, await board(s.port)]); } });
      assert.deepEqual(during.map(([p]) => p), ['written', 'verified', 'renamed', 'renamed', 'renamed', 'synced', 'deleted']);
      for (const [p, seen] of during) assert.deepEqual(seen, before, `the board changed at phase "${p}"`);
      assert.equal(fs.existsSync(shard), false);
      assert.deepEqual(await board(s.port), before, 'the live board changed once only sealed files were left');
      const fresh = await serve(...src);
      assert.deepEqual(await board(fresh.port), before, 'a fresh board over the sealed files differs');
      fresh.server.close();
    } finally { s.server.close(); }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a sealed file the board cannot read is labelled in the response, and the rest still shows', async () => {
  const root = tmpDir();
  try {
    const cap = path.join(root, 'collector'), ses = path.join(root, 'sessions');
    fs.mkdirSync(ses, { recursive: true });
    const shard = writeShard(path.join(cap, 'capture-2026-10-05.ndjson'), capture());
    markClosed(shard);
    await sealShard(shard, { sessionsRoot: ses });
    const victim = listFiles(path.join(ses, B))[0];
    fs.writeFileSync(victim, 'damaged');
    const s = await serve(cap, { sessionsRoot: ses });
    try {
      const pj = await get(s.port, '/api/projects');
      assert.equal(pj.source.errors.length, 1);
      assert.equal(pj.source.errors[0].file, victim);
      assert.match(pj.source.errors[0].reason, /not a sealed file/);
      const ids = pj.projects.flatMap((p) => p.sessions.map((x) => x.session_id));
      assert.ok(ids.includes(A) && !ids.includes(B));
      const sa = await get(s.port, `/api/session?id=${A}`);
      assert.equal(sa.source.errors.length, 1, 'every view built from an incomplete source says so');
    } finally { s.server.close(); }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// The default `asight serve` root is ~/.asight itself: flat captures at the top, collector/ and
// sessions/ below. Sealing a collector shard leaves its per-shard file in collector/ — that dir must
// not start to look like a session dir, or the whole board flips into sharded mode and lists
// "collector" as a session instead of what it listed before.
test('the home layout: sealing a collector shard does not change what `asight serve` (root ~/.asight) lists', async () => {
  const home = tmpDir();
  try {
    writeShard(path.join(home, 'claude-capture.ndjson'), conversation(B, 2, { idPrefix: 'rl_' }).map((r) => toLine(r)));
    const shard = writeShard(path.join(home, 'collector', 'capture-2026-10-05.ndjson'), capture());
    const opts = { sessionsRoot: path.join(home, 'sessions') };
    let s = await serve(home, opts);
    const before = capturesOnly(await get(s.port, '/api/projects')), ctlBefore = await get(s.port, '/api/control');   // the new sessions/ dir is not capture bytes
    s.server.close();
    markClosed(shard);
    await sealShard(shard, opts);
    assert.ok(listFiles(path.join(home, 'collector')).length, 'precondition: a per-shard sealed file stays in collector/');
    s = await serve(home, opts);
    assert.deepEqual(capturesOnly(await get(s.port, '/api/projects')), before);
    s.server.close();
    // the same through a RELATIVE --source (paths are compared resolved)
    s = await serve(path.relative(process.cwd(), home), opts);
    assert.deepEqual(capturesOnly(await get(s.port, '/api/projects')), before, 'a relative source flipped the board');
    assert.deepEqual(await get(s.port, '/api/control'), ctlBefore, 'a relative source read collector/\'s own per-shard file');
    s.server.close();
    // a damaged per-shard file is reported where it is — it does not turn collector/ into a session
    fs.writeFileSync(listFiles(path.join(home, 'collector'))[0], 'damaged');
    s = await serve(home, opts);
    const pj = await get(s.port, '/api/projects');
    s.server.close();
    assert.deepEqual(pj.projects, before.projects, 'a damaged file flipped the board into sharded mode');
    assert.ok(pj.source.errors.some((e) => e.file.startsWith(path.join(home, 'collector'))), 'the damaged file is not reported');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
