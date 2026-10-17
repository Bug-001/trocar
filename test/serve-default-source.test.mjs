import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import http from 'node:http';
import { createServer } from '../src/server.mjs';
import { tmpDir } from './helpers/tmp.mjs';

// `asight serve` WITH NO ARGUMENTS SERVED AN EMPTY BOARD.
//
// bin/asight.mjs:34 read `flag('--source', process.env.ASIGHT_SOURCE || null)` and passed that null
// straight through, so makeRecordLoader short-circuited at `if (!sourcePath) return []` and the board
// rendered "no sessions captured yet" — about a machine with gigabytes of captures on disk.
//
// README.md:72-77 documents the exact opposite, in bold: "With no --source it reads the capture
// directory every tap writes into, so Claude Code, Codex and OpenCode sessions appear side by side on
// one board." src/paths.mjs exists solely to make that true — its header documents the earlier audit
// where diverging inline defaults produced this same silent empty state — and `serveSource()` was
// wired into `asight doctor` and NOWHERE ELSE. The one verb it was written for never called it.
//
// This is the worst shape a bug can take here: the failure is indistinguishable from the honest
// empty state, so it reads as "I haven't captured anything yet" rather than "the board is not
// looking where I write". Nothing in the suite covered the no-argument path, because every test and
// every manual check passed --source or ASIGHT_SOURCE explicitly — the maintainer never typed the
// command the docs tell a new user to type.
//
// These drive the REAL default-resolution path with no source argument at all.

const REC = (id, sid) => JSON.stringify({
  id, is_llm_call: true, endpoint: 'https://api.anthropic.com/v1/messages',
  ts_request: '2026-01-01T00:00:00.000Z',
  req_headers: { 'x-claude-code-session-id': sid },
  req_body: JSON.stringify({ model: 'claude-sonnet-4-5', system: [{ type: 'text', text: 's' }], messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] }),
  resp: { status: 200, body: JSON.stringify({ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } }) },
});

const get = (port, p) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path: p }, (res) => {
    let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b }));
  });
  req.on('error', reject); req.end();
});

async function boardOver(sourcePath) {
  // An unreadable root may be refused at STARTUP (buildResolver stats it) or at request time (the
  // loader). Either is a correct answer to "this root does not exist"; both are reported here, and
  // silence is what the test rejects.
  let made;
  try { made = await createServer({ dbPath: '/nonexistent-db-xyz', sourcePath }); }
  catch (e) { return { error: String((e && e.message) || e) }; }
  const { server } = made;
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port;
  const r = await get(port, '/api/projects');
  server.close();
  if (r.status !== 200) return { error: r.body };
  return { sessions: (JSON.parse(r.body).projects || []).flatMap((p) => p.sessions || []) };
}

test('the CLI resolves a default source instead of passing null', () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'cli', 'serve.mjs'), 'utf8');
  assert.doesNotMatch(src, /sourcePath:\s*null/,
    'serve passed a bare null as the source default, so `asight serve` read nothing at all while '
    + 'README promises it reads the capture directory');
  assert.match(src, /serveSource\(\)/,
    'the default must come from src/paths.mjs — the module that exists to keep what capture WRITES '
    + 'and what serve READS in agreement');
  assert.doesNotMatch(src, /ASIGHT_(PORT|DB|SOURCE|CONTROL)/, 'and there is no environment variable behind the user\'s back (1.6 §1.8)');
});

test('a board over MULTIPLE roots lists the sessions of every root', async () => {
  // D27: the new home plus the legacy one. A user upgrading has history in one and new capture in
  // the other, and must see both — the loader fails soft, so a missed root is invisible.
  const base = tmpDir('asight-roots-');
  const a = path.join(base, 'new'), b = path.join(base, 'legacy');
  fs.mkdirSync(a); fs.mkdirSync(b);
  fs.writeFileSync(path.join(a, 'claude-capture.ndjson'), REC('n1', 'sess-new') + '\n');
  fs.writeFileSync(path.join(b, 'claude-capture.ndjson'), REC('o1', 'sess-legacy') + '\n');

  const { sessions } = await boardOver([a, b]);
  const ids = sessions.map((s) => s.session_id).sort();
  assert.deepEqual(ids, ['sess-legacy', 'sess-new'],
    'a session present on disk under a configured root was not listed — this is how a rename '
    + 'silently eats history (invariant 2)');
  fs.rmSync(base, { recursive: true, force: true });
});

test('an unreadable root is REPORTED, not silently reduced to fewer sessions', async () => {
  const base = tmpDir('asight-roots-');
  const a = path.join(base, 'new');
  fs.mkdirSync(a);
  fs.writeFileSync(path.join(a, 'c.ndjson'), REC('n1', 'sess-new') + '\n');

  const r = await boardOver([a, path.join(base, 'does-not-exist')]);
  assert.ok(r.error,
    'a configured root that cannot be read must surface as an error. Returning only the sessions of '
    + 'the roots that happened to work makes a broken configuration look like a smaller capture — '
    + 'the one failure mode that cannot be noticed (invariant 4)');
  fs.rmSync(base, { recursive: true, force: true });
});

test('a single string source still works exactly as before (back-compat)', async () => {
  const base = tmpDir('asight-roots-');
  fs.writeFileSync(path.join(base, 'c.ndjson'), REC('n1', 'sess-one') + '\n');
  const { sessions } = await boardOver(path.join(base, 'c.ndjson'));
  assert.deepEqual(sessions.map((s) => s.session_id), ['sess-one']);
  fs.rmSync(base, { recursive: true, force: true });
});
