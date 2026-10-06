// test/etl/shard-harness-keys.test.mjs — RFC 3.4:21: the sharder reads every harness's HEADER session key from
// the one table (src/dissect/harnesses.mjs), and header-less inference (Kimi's body key, Hermes's synthesized key)
// lands in `_unkeyed/`, never in `control/` (gate G12). Bytes are copied, never re-serialized (invariant 2).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { shardStream, sessionIdOfLine, UNKEYED_DIR, CONTROL_DIR, rebuildMeta, resplitShards } from '../../src/etl/shard.mjs';
import { sessionKeyOf, HEADER_SESSION_KEYS } from '../../src/dissect/harnesses.mjs';

// Collector envelope order: req_headers, req_body, then the appended fields (proc after req_body, 4.6 §记录).
const env = (id, agent, headers, body, extra = {}) => ({ id, ts_request: '2026-10-06T00:00:00Z', endpoint: extra.endpoint || '/v1/messages', method: 'POST',
  req_headers: headers, req_body: JSON.stringify(body), resp: { status: 200 }, is_llm_call: extra.llm ?? true, capture: 'transparent', proc: { pid: 1, exe: '/x', agent } });
const HEADER_KEYED = [
  env('cc', 'claude-code', { 'x-claude-code-session-id': 'CC1' }, {}),
  env('cx', 'codex', { 'session-id': 'CX1', 'thread-id': 'TH1' }, {}, { endpoint: '/v1/responses' }),
  env('oc', 'opencode', { 'x-opencode-session-id': 'OC1', 'session-id': 'OC1' }, {}, { endpoint: '/v1/chat/completions' }),
  env('ds', 'dsh', { 'x-deepseek-harness-session-id': 'DS1' }, { dsh_session_log: { session: { id: 'quoted-in-body' } } }),
  env('zc', 'z-code', { 'x-session-id': 'ZC1' }, {}),
];

async function shard(t, lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-shk-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const src = path.join(dir, 'capture-2026-10-06.ndjson');
  fs.writeFileSync(src, lines.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n');
  const out = path.join(dir, 'out');
  return { out, src, res: await shardStream({ file: src, outDir: out }) };
}
const linesIn = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean) : []);
const allLines = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? allLines(path.join(d, e.name))
  : e.name.endsWith('.ndjson') ? linesIn(path.join(d, e.name)) : []));

test('dsh/OpenCode/Z-Code headers shard into their session; header-less inference goes to _unkeyed, not control', async (t) => {
  const kimi = env('km', 'kimi-code', {}, { metadata: { user_id: 'K1' } });
  const hermes = env('hm', 'hermes', {}, { system: 'task' });
  const tele = env('tl', 'claude-code', {}, {}, { endpoint: '/api/event_logging/batch', llm: false });
  const { out, src, res } = await shard(t, [...HEADER_KEYED, kimi, hermes, tele]);
  for (const r of HEADER_KEYED) assert.equal(linesIn(path.join(out, sessionKeyOf(r).key, 'calls.ndjson')).length, 1, r.id);
  const unk = linesIn(path.join(out, UNKEYED_DIR, 'calls.ndjson'));
  assert.deepEqual(unk.map((l) => JSON.parse(l).id), ['km', 'hm']);
  assert.equal(res.unkeyed, 2);
  const ctl = fs.readdirSync(path.join(out, CONTROL_DIR)).flatMap((f) => linesIn(path.join(out, CONTROL_DIR, f)));
  assert.deepEqual(ctl.map((l) => JSON.parse(l).id), ['tl'], 'only the session-less non-inference record is control');
  assert.deepEqual(allLines(out).sort(), linesIn(src).sort(), 'every byte of every line, once (invariant 2)');
});

test('a parsed line is keyed by ITS harness\'s header: a stray key of another harness is not its session', async (t) => {
  const rec = env('d2', 'dsh', { 'x-claude-code-session-id': 'STRAY', 'x-deepseek-harness-session-id': 'DS2' }, {});
  const { out } = await shard(t, [rec]);
  assert.equal(linesIn(path.join(out, 'DS2', 'calls.ndjson')).length, 1);
  assert.equal(fs.existsSync(path.join(out, 'STRAY')), false, 'the line scan (first table key wins) would have said STRAY');
});

test('a line that does not parse is still keyed, by any table header key in its header region', async (t) => {
  const torn = JSON.stringify(env('t1', 'dsh', { 'x-deepseek-harness-session-id': 'DS3' }, { a: 1 })).slice(0, -3); // not JSON
  const { out } = await shard(t, [torn]);
  assert.deepEqual(linesIn(path.join(out, 'DS3', 'calls.ndjson')), [torn], 'byte-identical, in its session');
});

test('the line-scan fallback agrees with the harness table for every header-keyed harness', () => {
  for (const r of HEADER_KEYED) assert.equal(sessionIdOfLine(JSON.stringify(r)), sessionKeyOf(r, { headersOnly: true }).key, r.id);
  // req_body stored as a parsed object puts the quoted key in the line UNESCAPED: only the header bound keeps it out
  const quoted = { id: 'q', req_headers: {}, req_body: { 'x-deepseek-harness-session-id': 'BODY' }, is_llm_call: true };
  assert.equal(sessionIdOfLine(JSON.stringify(quoted)), null, 'a key quoted in req_body is never read');
  assert.ok(HEADER_SESSION_KEYS.includes('x-deepseek-harness-session-id') && HEADER_SESSION_KEYS.includes('x-opencode-session-id'));
});

test('headersOnly: a body key is never a sharding key (D35: the sharder reads headers only)', () => {
  const kimi = env('km', 'kimi-code', {}, { metadata: { user_id: 'K1' } });
  assert.equal(sessionKeyOf(kimi).key, 'K1', 'precondition: the board reads the body key');
  assert.equal(sessionKeyOf(kimi, { headersOnly: true }).key, null);
});

test('a session id that names a reserved directory is parked in _badsid', async (t) => {
  const { out } = await shard(t, [env('r1', 'dsh', { 'x-deepseek-harness-session-id': '_unkeyed' }, {}), env('r2', 'dsh', { 'x-deepseek-harness-session-id': 'control' }, {})]);
  assert.equal(linesIn(path.join(out, '_badsid', 'calls.ndjson')).length, 2);
  assert.equal(fs.existsSync(path.join(out, UNKEYED_DIR)), false);
  assert.equal(fs.existsSync(path.join(out, CONTROL_DIR)), false);
});

test('_unkeyed is not a session: rebuildMeta writes no meta.json for it, resplit leaves it alone', async (t) => {
  const { out } = await shard(t, [env('km', 'kimi-code', {}, { metadata: { user_id: 'K1' } })]);
  const before = linesIn(path.join(out, UNKEYED_DIR, 'calls.ndjson'));
  await rebuildMeta(out);
  assert.equal(fs.existsSync(path.join(out, UNKEYED_DIR, 'meta.json')), false);
  const r = await resplitShards(out);
  assert.equal(r.done + r.failed, 0, 'not treated as a legacy session shard');
  assert.deepEqual(linesIn(path.join(out, UNKEYED_DIR, 'calls.ndjson')), before);
  assert.equal(fs.existsSync(path.join(out, UNKEYED_DIR, '.split-v2')), false);
});
