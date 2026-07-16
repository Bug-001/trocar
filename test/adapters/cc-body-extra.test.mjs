import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parseCall } from '../../src/adapters/cc.mjs';
import { readRecords } from '../../src/etl/ingest.mjs';

const FIXTURE = path.resolve('test/fixtures/cc-session-real.ndjson');

// RFC 3.1:44 — canonical ∪ extra MUST cover the original object's keys, PER LAYER. The envelope
// pass treats req_body as consumed-whole, so unmapped provider REQUEST fields must be caught by a
// req_body-level diff and nested under extra.req_body (+ counted).
test('parseCall: unmapped req_body provider fields surface in extra.req_body (real trace)', async () => {
  const recs = await readRecords(FIXTURE); // normalized (req_body = string)
  const r = recs.find((x) => x.is_llm_call);
  const c = parseCall(r);
  assert.ok('req_body.max_tokens' in c.extra, 'max_tokens (unmapped) captured, not dropped');
  assert.ok('req_body.thinking' in c.extra, 'thinking config (unmapped) captured');
  assert.ok(c.unmapped_count >= 2, 'unmapped_count reflects the req_body fields');
  // contract invariant: unmapped_count == |extra keys|
  assert.equal(c.unmapped_count, Object.keys(c.extra).length, 'unmapped_count == |extra keys|');
  // mapped fields MUST NOT leak into extra
  for (const k of ['req_body.model', 'req_body.system', 'req_body.messages', 'req_body.tools', 'req_body.metadata']) assert.ok(!(k in c.extra), `${k} is mapped, not in extra`);
});

test('parseCall: a NOVEL req_body field lands in extra.req_body and bumps the count', async () => {
  const recs = await readRecords(FIXTURE);
  const r = recs.find((x) => x.is_llm_call);
  const body = JSON.parse(r.req_body);
  body.temperature = 0.7; body.top_p = 0.9; // provider knobs the adapter doesn't map
  const rec = { ...r, req_body: JSON.stringify(body) };
  const before = parseCall(r).unmapped_count;
  const c = parseCall(rec);
  assert.equal(c.extra['req_body.temperature'], 0.7);
  assert.equal(c.extra['req_body.top_p'], 0.9);
  assert.equal(c.unmapped_count, before + 2, 'exactly the two novel fields added');
});
