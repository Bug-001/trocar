import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { markClosed, closedState, closedMarkerPath } from '../../src/raw/closed.mjs';
import { sessionKeyOfLine } from '../../src/raw/session-key.mjs';
import { sessionKeyOfHeaders, SESSION_HEADER_KEYS } from '../../src/dissect/session-headers.mjs';
import { sessionIdOf } from '../../src/view/assemble.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'asight-closed-'));

// 4.6 §日志体积预算 「已关闭」: closed = the writer wrote an explicit close marker after fsync + close.
// Never inferred from a date in the name or from mtime (an SSE response can straddle midnight).
test('a shard is closed only once its writer has written the close marker', () => {
  const dir = tmp();
  try {
    const shard = path.join(dir, 'capture-2026-10-05.ndjson');
    fs.writeFileSync(shard, '{"id":"a"}\n', { mode: 0o600 });
    const old = new Date(Date.now() - 86400e3 * 3);
    fs.utimesSync(shard, old, old);                       // old date + old mtime: still NOT closed
    assert.equal(closedState(shard).closed, false);
    assert.match(closedState(shard).reason, /no close marker/);
    markClosed(shard);
    assert.equal(fs.statSync(closedMarkerPath(shard)).size, 0, 'the marker is an empty file beside the shard');
    assert.equal(fs.statSync(closedMarkerPath(shard)).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(shard, 'utf8'), '{"id":"a"}\n', 'marking must not touch the shard bytes');
    assert.equal(closedState(shard).closed, true);
    markClosed(shard);                                     // idempotent
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(shard, later, later);                    // written after its marker → not closed
    assert.equal(closedState(shard).closed, false);
    assert.match(closedState(shard).reason, /after its close marker/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('markClosed refuses a shard that does not exist', () => {
  const dir = tmp();
  try { assert.throws(() => markClosed(path.join(dir, 'nope.ndjson')), /ENOENT|no such/); assert.deepEqual(fs.readdirSync(dir), []); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// D20 的 D35 修订: the sealer reads ONLY the request-header session key, never the body.
const line = (env) => Buffer.from(JSON.stringify(env) + '\n');
test('the session key comes from the request headers only, never from the body', () => {
  assert.equal(sessionKeyOfLine(line({ ts: 't', req_headers: { 'x-claude-code-session-id': 'S1' }, req_body: '{"x-session-id":"BODY"}' })), 'S1');
  assert.equal(sessionKeyOfLine(line({ ts: 't', req_headers: { a: 'b' }, req_body: JSON.stringify({ req_headers: { 'session-id': 'BODY' } }) })), null);
  assert.equal(sessionKeyOfLine(line({ ts: 't', req_body: '"req_headers":{"session-id":"BODY"}' })), null, 'no envelope headers → no key');
  assert.equal(sessionKeyOfLine(line({ ts: 't', request_headers: { 'thread-id': 'T9' }, request: {} })), 'T9', 'v0 envelopes too');
  assert.equal(sessionKeyOfLine(Buffer.from('{"ts":"t","req_headers":{"session-id":"S\\"}{x"},"req_body":""}\n')), 'S"}{x', 'braces and quotes inside header values');
  assert.equal(sessionKeyOfLine(line({ ts: 't', request: { req_headers: { 'session-id': 'BODY' } } })), null, 'a v0 request object is a body too');
  assert.equal(sessionKeyOfLine(line({ ts: 't', req_body: { req_headers: { 'session-id': 'BODY' } } })), null, 'an object req_body is a body too');
  assert.equal(sessionKeyOfLine(Buffer.from('{"broken\n')), null);
  assert.equal(sessionKeyOfLine(Buffer.from('\n')), null);
});

test('the sealer and the board agree on which header names the session', () => {
  const combos = [
    {}, { 'x-claude-code-session-id': 'A' }, { 'x-session-id': 'B' }, { 'session-id': 'C', 'thread-id': 'D' },
    { 'thread-id': 'D' }, { 'x-session-id': 'B', 'session-id': 'C' }, { 'x-claude-code-session-id': 'A', 'session-id': 'C' }, { 'x-session-id': '', 'session-id': 'C' },
  ];
  for (const h of combos) {
    assert.equal(sessionKeyOfHeaders(h), sessionIdOf({ req_headers: h }), `drift on ${JSON.stringify(h)}`);
    assert.equal(sessionKeyOfLine(line({ ts: 't', req_headers: h, req_body: '' })), sessionIdOf({ req_headers: h }));
  }
  assert.ok(SESSION_HEADER_KEYS.length >= 4);
});
