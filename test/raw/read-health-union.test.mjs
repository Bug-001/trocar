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
