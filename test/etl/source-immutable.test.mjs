// test/etl/source-immutable.test.mjs — 4.2 acceptance #4 (a GAP until now): reading never touches the
// source. Two halves, as the spec states them: the file's inode / size / mtime / bytes are unchanged,
// AND neither `asight etl` nor `asight serve` calls a node:fs entry point that could change a file
// under the source directory (rename / unlink / truncate / write / a writable open). The second half
// catches a write that happens to restore the bytes, which the first half alone would miss.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { etlFile } from '../../src/etl/cli.mjs';
import { createServer } from '../../src/server.mjs';

const ENV = JSON.stringify({
  ts: '2026-10-06T00:00:00.000Z', endpoint: '/v1/messages', method: 'POST',
  req_headers: { 'x-claude-code-session-id': 'S', 'user-agent': 'claude-cli/2.1.0' },
  req_body: JSON.stringify({ model: 'claude-x', system: [{ type: 'text', text: 'sys' }], messages: [{ role: 'user', content: 'hi' }] }),
  resp: { status: 200, kind: 'json', body: {} }, id: 'r1', ts_request: '2026-10-06T00:00:00.000Z', is_llm_call: true,
  capture: 'transparent', proc: { pid: 1, exe: '/x', agent: 'claude-code' },
});
const stamp = (f) => { const s = fs.statSync(f); return { ino: s.ino, size: s.size, mtimeMs: s.mtimeMs, mode: s.mode }; };
const get = (port, p) => new Promise((res, rej) => http.get({ host: '127.0.0.1', port, path: p }, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res({ status: r.statusCode, body: b })); }).on('error', rej));

// Records every call that names a path under `root` and could change a file there. Named imports of
// node:fs bind to the module's exports, so syncBuiltinESMExports() routes them through the spies too.
const MUTATORS = ['rename', 'unlink', 'truncate', 'rm', 'writeFile', 'appendFile', 'utimes', 'chmod', 'copyFile'];
const READ_ONLY = new Set([undefined, null, 'r', 'rs', fs.constants.O_RDONLY]);
function guardWrites(dir) {
  const hits = [];
  const roots = [path.resolve(dir), fs.realpathSync(dir)]; // macOS: tmpdir is a symlink
  const under = (p) => (typeof p === 'string' || p instanceof URL)
    && roots.some((r) => path.resolve(String(p instanceof URL ? p.pathname : p)).startsWith(r + path.sep));
  const spy = (obj, name, isOpen) => {
    if (typeof obj[name] !== 'function') return;
    const orig = obj[name];
    mock.method(obj, name, function (...args) {
      const flags = typeof args[1] === 'function' ? undefined : args[1];
      if (isOpen ? under(args[0]) && !READ_ONLY.has(flags) : args.some(under)) hits.push(`${name}(${args.filter((a) => typeof a !== 'function').join(', ')})`);
      return orig.apply(this, args);
    });
  };
  for (const n of MUTATORS) { spy(fs, n); spy(fs, n + 'Sync'); spy(fsp, n); }
  for (const n of ['open', 'openSync', 'createWriteStream']) spy(fs, n, n !== 'createWriteStream');
  spy(fsp, 'open', true);
  syncBuiltinESMExports();
  return { hits, restore: () => { mock.restoreAll(); syncBuiltinESMExports(); } };
}

test("ETL over a capture dir and board GETs leave every source file's inode, size and mtime unchanged", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-ro-'));
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-ro-db-'));
  try {
    const src = path.join(dir, 'capture-2026-10-06.ndjson');
    fs.writeFileSync(src, ENV + '\n', { mode: 0o600 });
    const bytes = fs.readFileSync(src);
    const before = stamp(src);
    const guard = guardWrites(dir);
    try {
      await etlFile(dir, { dbPath: path.join(dbDir, 'x.duckdb') });
      await etlFile(dir, { dbPath: path.join(dbDir, 'x.duckdb'), rebuild: true });
      const { server } = await createServer({ dbPath: path.join(dbDir, 'x.duckdb'), sourcePath: [dir] });
      server.listen(0, '127.0.0.1'); await once(server, 'listening');
      try {
        const port = server.address().port;
        assert.equal((await get(port, '/api/projects')).status, 200);
        const s = JSON.parse((await get(port, '/api/session?id=S')).body);
        const ref = s.analyzed.steps[0].flat.find((b) => b.text_ref).text_ref;
        assert.equal((await get(port, '/api/block?ref=' + encodeURIComponent(ref))).status, 200);
      } finally { server.close(); }
    } finally { guard.restore(); }
    assert.deepEqual(guard.hits, [], 'no fs call that could change a source file');
    assert.deepEqual(stamp(src), before);
    assert.ok(fs.readFileSync(src).equals(bytes), 'zero byte changes');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});
