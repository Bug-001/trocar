// test/web/label-once.test.mjs — merge of the read-seven labels (call.wire.labels, from capture-labels.mjs::captureLabelsOf)
// and the D38 labels (call.respIncomplete / call.wsIncomplete): both are baked on every call, and some say the same thing
// (a reply cut at the cap, a reply that could not be decoded, a WebSocket call past the cap). The page says each fact once
// (invariant 4 asks for the label, not for a second copy of it); a label only one family has still shows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadIndex } from '../helpers/frontend.mjs';

const count = (s, re) => (s.match(re) || []).length;
const W = { format: 'openai-responses', vendor: 'openai', transport: 'http', contextState: 'complete', observerEffect: null };
const call = (wire, extra) => ({ gi: 0, ts: '2026-10-06T00:00:00Z', ctx: 10, usage: { read: 0, create: 0, fresh: 10, out: 1 }, flat: [],
  rec: { id: 'r1', request: { model: 'm', message_count: 1, tool_count: 0, system_chars: 1, context_chars: 10 } }, wire, ...extra });
const session = (c) => ({
  records: [{ id: 'r1', is_llm_call: true, ts_request: '2026-10-06T00:00:00Z', response: { status: 200 } }],
  analyzed: { steps: [c], lanes: [{ id: 'main', kind: 'main', icon: '💬', label: 'conversation', calls: [0], events: [], resources: [], seenFiles: [], peakCtx: 10, flagged: 0 }], stats: { calls: 1 } },
  probes: { count: 0, series: [] }, meta: { session_id: 'S', harness: 'codex', provider: 'openai' }, truncated: null,
});
const shown = async (c) => { const t = await loadIndex(session(c), ['poll']); await t.M.poll(); return t.getEl('rawpanel').innerHTML };

test('a reply cut at the cap is said once, by the response badge, not also by the wire label', async () => {
  const resp = { undecoded: false, binary: false, notJson: false, empty: false, unparsed: 0, truncated: true, bodyBytes: 40, text: 'response: the body was cut at the capture cap: only the first 40 bytes are stored' };
  const labels = [{ id: 'resp-truncated', label: '已截断 · reply cut at the cap', text: 'the reply was cut at the capture cap: only its first 40 bytes are stored' }];
  const raw = await shown(call({ ...W, labels }, { respIncomplete: resp }));
  assert.equal(count(raw, /响应已截断/g) >= 1, true, 'the response badge is there');
  assert.equal(count(raw, /reply cut at the cap/g), 0, 'and the wire label that says the same thing is not');
});

test('a reply that could not be decoded, and a WebSocket call past the cap: each said once', async () => {
  const resp = { undecoded: true, binary: false, notJson: false, empty: false, unparsed: 0, truncated: false, bodyBytes: null, text: 'response: the body could not be decompressed (zstd)' };
  const ws = { partial: false, partialReasons: [], truncated: true, omitted: 1, undecoded: 0, nonVerbatim: 0, text: 'WebSocket call: 1 message(s) past the capture cap kept only their size' };
  const labels = [{ id: 'resp-undecoded', label: '回复未解码 · reply not decoded', text: 'x' }, { id: 'ws-truncated', label: '已截断 · call over the size cap', text: 'y' }];
  const raw = await shown(call({ ...W, labels }, { respIncomplete: resp, wsIncomplete: ws }));
  assert.equal(count(raw, /响应未解码/g) >= 1 && count(raw, /已截断 · truncated/g) >= 1, true)
  assert.equal(count(raw, /回复未解码|call over the size cap/g), 0)
});

test('a label only the wire family has still shows: a reply that never finished, a compressed request not decoded', async () => {
  const labels = [{ id: 'resp-partial', label: '不完整 · reply never finished', text: 'a' }, { id: 'req-undecoded', label: '压缩请求体未解码 · compressed request not decoded', text: 'b' }];
  const raw = await shown(call({ ...W, labels }, {}));
  assert.equal(count(raw, /reply never finished/g) >= 1 && count(raw, /compressed request not decoded/g) >= 1, true);
});

// 1.6 §1.3 / invariant 4: a call whose response head trocar added a line to says so on the call, once — the one wire family label has no D38 twin
test('a call trocar added Connection: close to is labelled 「trocar 加的」 on the call, once, with what it means', async () => {
  const labels = [{ id: 'trocar-added', label: 'trocar 加的 · Connection: close', text: 'trocar added the hop-by-hop header Connection: close to this response when capture was turned off; the response body is byte for byte what the upstream sent, and resp_head_raw is the upstream head' }];
  const raw = await shown(call({ ...W, labels }, {}));
  assert.equal(count(raw, /trocar 加的 · Connection: close/g), 1);
  assert.equal(count(raw, /resp_head_raw is the upstream head/g) >= 1, true, 'the meaning is on the page, not only the name');
});
