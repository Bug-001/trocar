import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { homeWith, query } from './helpers/session-doc.mjs';

// The shipped demo capture is the FIRST THING a new user sees (`npm run demo`), and the only way a
// GitHub visitor can evaluate the tool without first MITM-ing their own agent — trocar's real test
// fixture is a personal session and is gitignored, so before this sample existed `git clone` rendered
// an empty board. That makes the sample load-bearing: if it stops rendering, the project's shop
// window goes dark and nothing else in the suite would notice.
//
// It is also the one committed capture that is SAFE to assert against in detail, being entirely
// synthetic (no real prompts, file contents or credentials).

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.join(HERE, '..', 'samples', 'demo-session.ndjson');
const records = readFileSync(SAMPLE, 'utf8').trim().split('\n').map((l) => JSON.parse(l));

// the demo session read as every path reads it: its `session` document and its main lane's definitions (test/helpers/session-doc.mjs)
async function demo() {
  const home = homeWith(records), { sessions: [{ session_id: id }] } = await query(home, 'sessions');
  const doc = await query(home, 'session', { id });
  const main = doc.lanes.find((l) => l.kind === 'main');
  return { doc, lane: await query(home, 'lane', { id, lane: main.lane }) };
}

test('every panel the demo is supposed to show has real data behind it', async () => {
  const { doc, lane } = await demo();
  assert.ok(doc.calls.length >= 6, 'timeline has bars');
  assert.equal(doc.more, false, 'the demo is one page: it exists to show the full view');
  const secs = new Set(Object.values(lane.defs).map((d) => d.sec));
  for (const sec of ['tools', 'system', 'messages']) assert.ok(secs.has(sec), `${sec} renders`);
  assert.ok(doc.calls.at(-1).usage.read > 0, 'cache overlay has a real cache_read to draw');
});

test('the sample exercises the error path, and the failed call does not corrupt the cache-break chain', async () => {
  const { doc } = await demo();
  assert.ok(doc.calls.some((c) => c.status === 429), 'the demo shows a failed call');
  const bad = doc.calls.filter((c) => c.cacheBreak && c.cacheBreak.attribution && c.cacheBreak.attribution !== 'harmless');
  assert.deepEqual(bad.map((c) => c.rid), [], 'a clean append-only conversation: no break runs through the 429');
});

test('the sample contains no real credentials', () => {
  const raw = readFileSync(SAMPLE, 'utf8');
  for (const h of ['authorization', 'x-api-key', 'cookie']) {
    const re = new RegExp(`"${h}"\\s*:\\s*"(?!<redacted>)[^"]+"`, 'i');
    assert.doesNotMatch(raw, re, `${h} must be redacted in a committed sample`);
  }
  assert.doesNotMatch(raw, /sk-ant-|sk-[A-Za-z0-9]{20}/, 'no API-key-shaped strings may ship');
});

// `npm run demo` is gone with `serve --source` (1.6 §2: serve has only --port): the sample is read, not served by a script of its own.
