import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCall, ccControlKind } from '../../src/adapters/cc.mjs';
import { ccLlmRecord, ccControlRecord, ccFullEnvelopeRecord } from '../fixtures/cc-record.mjs';

test('parseCall of an llm record: class=llm, per-call lane, model/stream, stop_reason, canonical usage', () => {
  const c = parseCall(ccLlmRecord());
  assert.equal(c.class, 'llm');
  assert.equal(c.control_kind, null);
  assert.equal(c.lane, 'main'); // per-CALL lane (B-lane), via 3.4 identity.lane
  assert.equal(c.model, 'claude-opus-4-6');
  assert.equal(c.stream, true);
  assert.equal(c.stop_reason, 'tool_use');
  assert.equal(c.duration_ms, 1200);
  assert.equal(c.error, false);
  assert.equal(c.usage.total_input, 2150);
});

test('parseCall of a control record: class=control, control_kind mapped, no llm usage', () => {
  const c = parseCall(ccControlRecord());
  assert.equal(c.class, 'control');
  assert.equal(c.control_kind, 'telemetry');
  assert.equal(c.usage.total_input, 0);
});

test('ccControlKind maps endpoints to the 3.2 enum (imported from 3.4 identity)', () => {
  assert.equal(ccControlKind('/v1/event_logging'), 'telemetry');
  assert.equal(ccControlKind('/v1/mcp_registry/list'), 'registry');
  assert.equal(ccControlKind('/v1/oauth/token'), 'account');
  assert.equal(ccControlKind('/v1/bootstrap'), 'config');
  assert.equal(ccControlKind('/v1/whatever'), 'other');
});

test('per-call lane: subagent → subagent; count_tokens → probe; monitor/aux detected (demo v6/v10)', () => {
  const sub = ccLlmRecord({ req: { system: [{ type: 'text', text: 'cc_is_subagent=true' }] } });
  assert.equal(parseCall(sub).lane, 'subagent');
  const probe = ccLlmRecord({ env: { endpoint: '/v1/messages/count_tokens' } });
  assert.equal(parseCall(probe).lane, 'probe');
  // monitor: CC's built-in security-monitor lane (system marker) — demo v6
  const mon = ccLlmRecord({ req: { system: [{ type: 'text', text: 'You are a security monitor' }] } });
  assert.equal(parseCall(mon).lane, 'monitor');
  // aux: small background model (haiku) + tiny message array — notify/titlegen/quota — demo v10
  const aux = ccLlmRecord({ req: { model: 'claude-haiku-4-5', messages: [{ role: 'user', content: 'quota' }] } });
  assert.equal(parseCall(aux).lane, 'aux');
});

test('parseCall flags error records (resp.kind=error or >=500), never counts them as success', () => {
  const rec = ccLlmRecord({ env: { error: true, resp: { kind: 'error', status: 500 } } });
  assert.equal(parseCall(rec).error, true);
});

test('unmapped invariant: a novel envelope field lands in extra and bumps unmapped_count by exactly 1', () => {
  const base = parseCall(ccLlmRecord());
  const bumped = parseCall(ccLlmRecord({ env: { novel_field: 'surprise' } }));
  assert.equal(bumped.extra.novel_field, 'surprise');
  assert.equal(bumped.unmapped_count, base.unmapped_count + 1);
});

test('B-env: a FULL D10 envelope inflates unmapped_count by ONLY a novel field (8 observ-meta consumed)', () => {
  const clean = parseCall(ccFullEnvelopeRecord());
  assert.equal(clean.unmapped_count, 0); // id/ts/ts_request/ts_response_start/end/duration_ms/is_llm_call/capture/auth_mode/endpoint/method/req_headers/req_body/resp/error — all consumed
  assert.deepEqual(clean.extra, {});
  const withNovel = parseCall(ccFullEnvelopeRecord({ novel_probe: 42 }));
  assert.equal(withNovel.unmapped_count, 1); // ONLY the novel field
  assert.deepEqual(withNovel.extra, { novel_probe: 42 });
});
