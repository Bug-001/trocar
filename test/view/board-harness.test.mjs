import test from 'node:test';
import assert from 'node:assert/strict';
import { projectsView } from '../../src/view/board.mjs';

// D3 (amended 2026-07-18) + D25(b) + invariant 4 — harness identity is a TABLE row, and a harness we
// cannot name MUST NOT be silently rendered as some other harness. Live counter-evidence that drove
// this: a real OpenCode session (13 calls, gpt-5.5 via mini-codex) landed on the board with
// harness=null, which the frontend chip then painted 🟠 "Claude Code" — foreign bytes passed off as
// CC, exactly the mislabeling invariant 4 forbids.

const rec = (i, { ua, endpoint = '/models-proxy/responses', sid = 'ses_OC' }) => ({
  id: `r${i}`, ts_request: `2026-07-18T00:00:${String(i).padStart(2, '0')}.000Z`,
  is_llm_call: true, endpoint,
  req_headers: { 'session-id': sid, 'user-agent': ua },
  req_body: JSON.stringify({ model: 'gpt-5.5', input: [], instructions: '' }),
  resp: { kind: 'json', status: 200 },
});

const metaFor = (recs, sid) => {
  for (const p of projectsView(recs).projects) {
    const hit = (p.sessions || []).find((s) => s.session_id === sid);
    if (hit) return hit;
  }
  return null;
};

// the exact UA the real capture carried — note it does NOT contain the substring "openai"
const OC_UA = 'opencode/1.17.12 (darwin 25.5.0; arm64) ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.13';

test('OpenCode is identified as its own harness (not codex, not null)', () => {
  const m = metaFor([rec(1, { ua: OC_UA })], 'ses_OC');
  assert.equal(m.harness, 'opencode');
});

test("OpenCode's provider is read from the WIRE, never assumed from the harness name", () => {
  // same harness, Anthropic-shaped wire → MUST report anthropic, not openai
  const anth = metaFor([rec(1, { ua: OC_UA, endpoint: '/v1/messages', sid: 'ses_A' })], 'ses_A');
  assert.equal(anth.harness, 'opencode');
  assert.equal(anth.provider, 'anthropic');
  // Responses wire → openai
  const oai = metaFor([rec(1, { ua: OC_UA })], 'ses_OC');
  assert.equal(oai.provider, 'openai');
});

test('a wire we do not recognize yields provider=null rather than a guess', () => {
  const m = metaFor([rec(1, { ua: OC_UA, endpoint: '/some/unknown/route', sid: 'ses_U' })], 'ses_U');
  assert.equal(m.harness, 'opencode');
  assert.equal(m.provider, null, 'unobserved provider MUST stay null, never inferred');
});

test('"opencode" does not collide with the /codex/ row', () => {
  const m = metaFor([rec(1, { ua: OC_UA })], 'ses_OC');
  assert.notEqual(m.harness, 'codex');
  // and a genuine Codex UA still lands on its own row
  const cx = metaFor([rec(1, { ua: 'codex_cli_rs/0.20.0', sid: 'ses_C' })], 'ses_C');
  assert.equal(cx.harness, 'codex');
  assert.equal(cx.provider, 'openai');
});

test('existing harness rows are unchanged by the new row', () => {
  const cc = metaFor([rec(1, { ua: 'claude-cli/2.0.0', endpoint: '/v1/messages', sid: 'ses_CC' })], 'ses_CC');
  assert.equal(cc.harness, 'claude-code');
  assert.equal(cc.provider, 'anthropic');
});
