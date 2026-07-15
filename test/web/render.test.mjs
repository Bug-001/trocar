import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { etlFile } from '../../src/etl/cli.mjs';
import { openDb } from '../../src/db.mjs';
import { listSessions, sessionCalls, sessionComposition, sessionResources, callContext } from '../../src/query/queries.mjs';
import { buildResolver } from '../../src/query/source.mjs';
import {
  esc, renderSessions, compositionMap, renderTimeline, renderCacheBand, renderScrub,
  renderContextWindow, renderCacheOverlay, renderResources,
} from '../../src/web/render.mjs';

const FIXTURE = path.resolve('test/fixtures/cc-session-real.ndjson');
let conn, resolve, db, topSid;

test.before(async () => {
  const store = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'asight-web-')), 'a.duckdb');
  await etlFile(FIXTURE, { dbPath: store, rebuild: true });
  db = await openDb(store, { readOnly: true }); conn = db.connection;
  resolve = await buildResolver(FIXTURE);
  topSid = (await listSessions(conn)).sort((a, b) => b.call_count - a.call_count)[0].session_id;
});
test.after(() => db?.close());

test('renderSessions lists sessions with canonical meta', async () => {
  const html = renderSessions(await listSessions(conn), topSid);
  assert.match(html, /class="sess active"/);
  assert.match(html, /calls</);
});

test('★ renderContextWindow: EXACT verbatim block bytes + .cblk[data-bi] anchors (AC-1 in render)', async () => {
  const calls = await sessionCalls(conn, topSid);
  let blocks = [];
  for (const c of calls) { const b = await callContext(conn, c.call_id, resolve); if (b.length) { blocks = b; break; } }
  assert.ok(blocks.length >= 1, 'found a call with context blocks');
  const html = renderContextWindow(blocks);
  assert.match(html, /class="cblk"/);
  assert.match(html, /data-bi="0"/);
  // AC-1: the EXACT escaped verbatim bytes of a real block appear in the rendered HTML.
  const sample = blocks.find((b) => b.text && b.text.length > 30);
  assert.ok(sample, 'a non-trivial verbatim block');
  assert.ok(html.includes(esc(sample.text)), 'rendered HTML contains the byte-verbatim (escaped) block text');
  assert.ok(html.includes(`${sample.text.length} chars`));
});

test('renderCacheOverlay: canonical usage roles, hit ratio, no provider-native names (AC-2)', async () => {
  const calls = await sessionCalls(conn, topSid);
  const withCache = calls.find((c) => c.cache_read != null && Number(c.cache_read) > 0);
  assert.ok(withCache, 'a call with real cache_read');
  const html = renderCacheOverlay(withCache);
  assert.match(html, /cache read/);
  assert.match(html, /hit ratio/);
  assert.ok(html.includes(String(Number(withCache.cache_read))), 'renders the real cache_read number');
  assert.ok(!html.includes('cache_read_input_tokens'), 'no provider-native leak');
});

test('timeline: multi-color composition bars + cache band + scrub (Batch A)', async () => {
  const calls = await sessionCalls(conn, topSid);
  const comp = compositionMap(await sessionComposition(conn, topSid));
  assert.ok(comp.size >= 1, 'composition map built from real store');
  const tl = renderTimeline(calls, comp, calls[0].call_id);
  assert.match(tl, /class="tbar active"/);
  // multi-color: at least one section segment class is present (real CC calls have tools+system+messages)
  assert.ok(/tseg-(tools|system|messages)/.test(tl), 'bars are colored by section composition');
  // cache band: one cell per call, tiered by hit_ratio
  const band = renderCacheBand(calls, calls[0].call_id);
  assert.match(band, /cband-cell cb-(hi|mid|lo|none)/);
  assert.equal((band.match(/cband-cell/g) || []).length, calls.length, 'one band cell per call');
  // scrub: playhead N/M + prev disabled at head
  const scrub = renderScrub(calls, calls[0].call_id);
  assert.match(scrub, new RegExp(`1/${calls.length}`));
  assert.match(scrub, /data-scrub="prev"[^>]*disabled/);
  assert.match(scrub, /data-scrub="end"/);
});

test('renderResources produces markup on real data', async () => {
  const html = renderResources(await sessionResources(conn, topSid));
  assert.ok(html.length > 0);
});
