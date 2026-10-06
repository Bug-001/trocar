// D38 R-7a cross-guard. Two branches each taught the readers to report what they could not read:
// feat/read-cc-line (entries not read, each with a reason: a dangling link, a compressed capture, a
// file that fails to open; lines that would not parse) and feat/raw-sealer (files read, but not in
// full: a damaged sealed file, a capture-looking file not read, a per-session file whose source
// cannot be told). Their merge rewrote the resolver (src/query/source.mjs) and the board's read-health
// field on both sides; resolving a conflict toward one side would silently drop the other's report
// (D38: failures are never silent). One source carrying every kind of failure, read by both readers:
// every reason from both sides must still come out, in ONE `source` field on the board.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from '../../src/server.mjs';
import { buildResolver } from '../../src/query/source.mjs';
import { sealUnchecked } from '../../src/raw/seal.mjs';
import { tmpDir, conversation, toLine, writeShard } from './helpers.mjs';

const A = 'aaaaaaaa-1111-4111-8111-11111111111a';
const canChmod = !(process.getuid && process.getuid() === 0); // root reads a mode-000 file anyway

function brokenSource(root) {
  const cap = path.join(root, 'cap'), ses = path.join(root, 'sessions'), other = path.join(root, 'other');
  writeShard(path.join(cap, 'claude-capture.ndjson'), [...conversation(A, 2).map((r) => toLine(r)), Buffer.from('{"ts":"torn json\n')]);
  fs.symlinkSync(path.join(root, 'nowhere.ndjson'), path.join(cap, 'dangling.ndjson'));     // read-cc-line: broken-symlink
  fs.writeFileSync(path.join(cap, 'codex-capture.ndjson.zst'), 'x');                        // both: compressed / not read
  const damaged = path.join(cap, 'old-capture.ndjson.0001.sealed');
  fs.writeFileSync(damaged, 'damaged');                                                     // sealer: unreadable sealed file
  const locked = writeShard(path.join(cap, 'locked.ndjson'), conversation(A, 1, { idPrefix: 'lk_' }).map((r) => toLine(r)));
  if (canChmod) fs.chmodSync(locked, 0o000);                                                // read-cc-line: unreadable (EACCES)
  const orphan = path.join(ses, 'S', 'calls.ndjson.0001.sealed');
  writeShard(orphan, [Buffer.from('damaged')]);                                             // sealer: unattributed
  writeShard(path.join(other, 'b.ndjson'), conversation(A, 1, { idPrefix: 'b_' }).map((r) => toLine(r)));
  return { cap, ses, other, damaged, locked, orphan };
}
const unlock = (f) => { try { fs.chmodSync(f, 0o600); } catch {} };

test('the resolver keeps both reason sets, under one root and several', async () => {
  const root = tmpDir();
  const src = brokenSource(root);
  try {
    for (const roots of [src.cap, [src.cap, src.other]]) {
      const r = await buildResolver(roots, { sessionsRoot: src.ses });
      try {
        const scan = r.scan, label = Array.isArray(roots) ? 'two roots' : 'one root';
        const reasons = new Set(scan.skipped.map((x) => x.reason));
        // read-cc-line's
        for (const want of ['broken-symlink', 'compressed', ...(canChmod ? ['unreadable'] : [])]) assert.ok(reasons.has(want), `${label}: no "${want}" in ${JSON.stringify(scan.skipped)}`);
        if (canChmod) assert.equal(scan.skipped.find((x) => x.reason === 'unreadable').error, 'EACCES', label);
        assert.ok(scan.corruptLines >= 1, `${label}: the torn line is not counted`);
        // the sealer's
        assert.ok(scan.unreadableSealed.some((x) => x.file === src.damaged), `${label}: the damaged sealed file is not counted`);
        assert.ok(scan.unattributed.some((x) => x.file === src.orphan), `${label}: the unattributable per-session file is not named`);
        const miss = r.detail('claude-capture.ndjson#no_such_id::0-1');
        assert.equal(miss.status, 'absent', label);
        for (const f of [src.damaged, src.orphan]) assert.ok(miss.reason.includes(path.basename(f)), `${label}: the absent reason does not name ${path.basename(f)}: ${miss.reason}`);
        assert.ok(r.detail(`claude-capture.ndjson#req_00001::0-1`).status === 'ok', `${label}: a readable record no longer resolves`);
      } finally { r.dispose(); }
    }
  } finally { unlock(src.locked); fs.rmSync(root, { recursive: true, force: true }); }
});

const get = (port, p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port, path: p }, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res(JSON.parse(b))); }).on('error', rej);
});

test('the board reports both in ONE `source` field: what it did not read, and what it read only in part', async () => {
  const root = tmpDir();
  const src = brokenSource(root);
  try {
    const { server } = await createServer({ dbPath: '/nonexistent-db', sourcePath: src.cap, sessionsRoot: src.ses, enrich: () => null });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    try {
      const port = server.address().port;
      const pj = await get(port, '/api/projects');
      assert.ok(!('source_errors' in pj), 'a second read-health field is back');
      assert.deepEqual(pj.projects.flatMap((p) => p.sessions.map((s) => s.session_id)), [A]);
      // read-cc-line's report
      const skipped = new Map(pj.source.skipped.filter((x) => x.attention).map((x) => [x.name, x.reason]));
      assert.equal(skipped.get('dangling.ndjson'), 'broken-symlink');
      assert.equal(skipped.get('codex-capture.ndjson.zst'), 'compressed');
      if (canChmod) assert.equal(skipped.get('locked.ndjson'), 'unreadable');
      assert.deepEqual(pj.source.corrupt_lines, { [path.join(src.cap, 'claude-capture.ndjson')]: 1 });
      // the sealer's report
      const errors = new Map(pj.source.errors.map((e) => [e.file, e]));
      assert.ok(errors.has(src.damaged), `the damaged sealed file is not in source.errors: ${JSON.stringify(pj.source.errors)}`);
      assert.match(errors.get(path.join(src.cap, 'codex-capture.ndjson.zst')).reason, /compressed capture/);
      assert.ok(errors.has(src.orphan), 'the unattributable per-session file is not in source.errors');
      // a view built from the same incomplete source says so in the same field
      const sa = await get(port, `/api/session?id=${A}`);
      assert.ok(!('source_errors' in sa));
      assert.ok(sa.source.errors.some((e) => e.file === src.damaged), 'the session view does not say its source was read only in part');
    } finally { server.close(); }
  } finally { unlock(src.locked); fs.rmSync(root, { recursive: true, force: true }); }
});

// The rest: paths the fresh-context review of the union found unguarded or silent.
async function serveOn(sourcePath, opts = {}) {
  const { server } = await createServer({ dbPath: '/nonexistent-db', sourcePath, enrich: () => null, ...opts });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { server, port: server.address().port };
}
const callsOf = (pj) => pj.projects.flatMap((p) => p.sessions.map((s) => `${s.session_id}:${s.calls}`));

// review finding 2: read-cc-line's classifier raises `attention` for *.ndjson names only, and the
// sealer's unreadCapture() passes a numbered sealed name (it is normally read) — so a sealed name that
// is a dangling link raised nothing. On feat/raw-sealer it was read, vanished and was reported.
test('a sealed name that is a dangling link is reported, not skipped in silence', async () => {
  const root = tmpDir();
  try {
    writeShard(path.join(root, 'claude-capture.ndjson'), conversation(A, 1).map((r) => toLine(r)));
    fs.symlinkSync(path.join(root, 'gone.sealed'), path.join(root, 'old-capture.ndjson.0001.sealed'));
    const s = await serveOn(root);
    try {
      const pj = await get(s.port, '/api/projects');
      const sk = pj.source.skipped.find((x) => x.name === 'old-capture.ndjson.0001.sealed');
      assert.deepEqual(sk && [sk.reason, sk.attention], ['broken-symlink', true], JSON.stringify(pj.source.skipped));
      const e = pj.source.errors.find((x) => path.basename(x.file) === 'old-capture.ndjson.0001.sealed');
      assert.match(e && e.reason, /sealed file that is not a regular file/);
    } finally { s.server.close(); }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// review finding 5: a listed file gone on BOTH the read and the one re-list is reported twice over —
// as a `vanished` entry the board retries (read-cc-line) and in `source.errors` (the sealer).
test('a file that vanishes on the read and again on the re-list is reported, in both reports', async () => {
  const root = tmpDir();
  try {
    writeShard(path.join(root, 'claude-capture.ndjson'), conversation(A, 1).map((r) => toLine(r)));
    const f = writeShard(path.join(root, 'b.ndjson'), conversation(A, 1, { idPrefix: 'b_' }).map((r) => toLine(r)));
    const s = await serveOn(root);
    const real = fs.statSync;
    let hits = 0;
    try {
      fs.statSync = function (p, ...a) {
        if (p === f && /server\.mjs/.test(new Error().stack.split('\n')[2] || '')) { hits++; const e = new Error(`ENOENT: ${p}`); e.code = 'ENOENT'; throw e; }
        return real.call(this, p, ...a);
      };
      const pj = await get(s.port, '/api/projects');
      fs.statSync = real;
      assert.ok(hits >= 2, `precondition: the loader looked twice (${hits})`);
      assert.ok(pj.source.skipped.some((x) => x.name === 'b.ndjson' && x.reason === 'vanished' && x.attention), JSON.stringify(pj.source.skipped));
      assert.ok(pj.source.errors.some((x) => x.file === f && /vanished while being read, twice in a row/.test(x.reason)), JSON.stringify(pj.source.errors));
    } finally { fs.statSync = real; s.server.close(); }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// review finding 5: /api/control's own `source.errors` (a damaged sealed file in control/) — the
// field this merge renamed — checked at the server, not only through a stubbed board fetch.
test('/api/control names a control/ file it could not read, in `source.errors`', async () => {
  const root = tmpDir();
  try {
    writeShard(path.join(root, A, 'calls.ndjson'), conversation(A, 1).map((r) => toLine(r)));
    fs.writeFileSync(path.join(root, A, 'meta.json'), JSON.stringify({ session_id: A }));
    const victim = path.join(root, 'control', 'telemetry.ndjson.0001.sealed');
    writeShard(victim, [Buffer.from('damaged')]);
    const s = await serveOn(root);
    try {
      const ctl = await get(s.port, '/api/control');
      assert.ok(!('source_errors' in ctl));
      assert.ok(ctl.source && ctl.source.errors.some((e) => e.file === victim), JSON.stringify(ctl));
    } finally { s.server.close(); }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// review, outside the three commits: the loader kept a sealed file's records by its old size — one
// replaced in place by another seal under the same name kept showing the old records, unreported.
test('a sealed file replaced in place is read again whole, and the board says so', async () => {
  const root = tmpDir();
  try {
    const sealedOf = async (n) => {
      const g = writeShard(path.join(tmpDir(), 'cap.ndjson'), conversation(A, n).map((r) => toLine(r)));
      await sealUnchecked(g, { split: false, deleteOriginal: true });
      return g + '.0001.sealed';
    };
    const target = path.join(root, 'cap.ndjson.0001.sealed');
    fs.renameSync(await sealedOf(1), target);
    const s = await serveOn(root);
    try {
      assert.deepEqual(callsOf(await get(s.port, '/api/projects')), [`${A}:1`]);
      fs.renameSync(await sealedOf(3), target);
      const pj = await get(s.port, '/api/projects');
      assert.deepEqual(callsOf(pj), [`${A}:3`], 'the replaced sealed file still served its old records');
      assert.ok(pj.source.resets.some((x) => x.file === target && /sealed file replaced/.test(x.why)), JSON.stringify(pj.source.resets));
    } finally { s.server.close(); }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
