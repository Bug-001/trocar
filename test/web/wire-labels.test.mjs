// test/web/wire-labels.test.mjs — invariant 4 labels rendered where the call is shown, from canonical
// server-baked fields only (3.2:133, 4.6 §记录 / R2 / R5 / W16, 3.1:58, 3.2:134; G9 placement).
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadIndex } from '../helpers/frontend.mjs';

const call = (wire, extra = {}) => ({ gi: 0, ts: '2026-10-06T00:00:00Z', ctx: 10, usage: { read: 0, create: 0, fresh: 10, out: 1 }, flat: [],
  rec: { id: 'r1', request: { model: 'm', message_count: 1, tool_count: 0, system_chars: 1, context_chars: 10 } }, wire, ...extra });
const session = (c, more = {}) => ({
  records: [{ id: 'r1', is_llm_call: true, ts_request: '2026-10-06T00:00:00Z', response: { status: 200 } }],
  analyzed: { steps: [c], lanes: [{ id: 'main', kind: 'main', icon: '💬', label: 'conversation', calls: [0], events: [], resources: [], seenFiles: [], peakCtx: 10, flagged: 0 }], stats: { calls: 1 }, ...more },
  probes: { count: 0, series: [] }, meta: { session_id: 'S', harness: 'codex', provider: 'openai' }, truncated: null,
});
const W = { format: 'openai-responses', vendor: 'openai', transport: 'http', contextState: 'complete', observerEffect: null, labels: [] };
const render = async (s) => { const t = await loadIndex(s, ['poll']); await t.M.poll(); return { raw: t.getEl('rawpanel').innerHTML, ctx: t.getEl('ctxwin').innerHTML, t }; };

test('context_state partial / reconstructed / server_edited is labelled on the call, in the raw panel and atop the context', async () => {
  for (const [cs, re] of [['partial', /不完整/], ['reconstructed', /跨记录拼接/], ['server_edited', /服务端删改/]]) {
    const v = await render(session(call({ ...W, contextState: cs })));
    assert.match(v.raw, re, cs);
    assert.match(v.ctx, re, `${cs}: also where the context is shown`);
  }
  const v = await render(session(call(W)));
  assert.doesNotMatch(v.raw + v.ctx, /不完整|跨记录拼接|服务端删改/, 'a complete call carries no badge');
});

test('a request stored incomplete is said once, by its own exact badge, not twice', async () => {
  const q = { truncated: true, storedBytes: 40, partial: null, text: 'request body cut at the capture cap: only the first 40 bytes are stored' };
  const v = await render(session(call({ ...W, contextState: 'partial' }, { reqIncomplete: q })));
  assert.match(v.raw, /请求体已截断/);
  assert.doesNotMatch(v.raw, /不完整 · partial context/);
});

test('observer effect is labelled on the call; absent for the control group (R5)', async () => {
  const eff = [{ id: 'codex-rustls-h2', what: 'TLS stack switched to rustls', cause: 'SSL_CERT_FILE in $CODEX_HOME/.env' }];
  let v = await render(session(call({ ...W, observerEffect: eff })));
  assert.match(v.raw, /观测者效应/);
  assert.match(v.raw, /rustls/);
  v = await render(session(call({ ...W, observerEffect: null })));
  assert.doesNotMatch(v.raw, /观测者效应/);
});

test('an unknown vendor says its cache semantics are unknown; WebSocket transport is shown', async () => {
  const v = await render(session(call({ ...W, vendor: null, transport: 'ws' })));
  assert.match(v.raw, /厂商缓存语义未知/);
  assert.match(v.raw, /WebSocket/);
  assert.doesNotMatch((await render(session(call(W)))).raw, /厂商缓存语义未知|WebSocket/);
});

test('a known vendor whose cache semantics are unknown on this wire still gets the badge (dsh, Kimi; 3.3:89)', async () => {
  for (const vendor of ['deepseek', 'moonshot']) {
    const v = await render(session(call({ ...W, format: vendor === 'deepseek' ? 'anthropic' : 'openai-chat', vendor, cacheSemanticsKnown: false })));
    assert.match(v.raw, /厂商缓存语义未知/, vendor);
  }
  assert.doesNotMatch((await render(session(call({ ...W, cacheSemanticsKnown: true })))).raw, /厂商缓存语义未知/);
});

test('top-level keys that are not blocks are listed one by one with a locator (R2)', async () => {
  const v = await render(session(call(W, { nonBlockKeys: [{ key: 'model', chars: 7, ref: 'S/c.ndjson#r1::9-16' }, { key: 'dsh_plugin_packages', chars: 2, ref: null }] })));
  assert.match(v.raw, /data-nbk="S\/c\.ndjson#r1::9-16"[^>]*>model<\/code>/);
  assert.match(v.raw, /<code>dsh_plugin_packages<\/code> 2c/, 'a key without a locator is still listed');
});

test('capture labels render on the call (已截断 / 压缩请求体未解码), also when the body is paged out', async () => {
  const labels = [{ id: 'ws-truncated', label: '已截断 · call over the size cap', text: 'messages past the per-call cap…' },
    { id: 'req-undecoded', label: '压缩请求体未解码 · compressed request not decoded', text: 'zstd' }];
  for (const extra of [{}, { paged_out: true }]) {
    const v = await render(session(call({ ...W, labels }, extra)));
    assert.match(v.raw, /已截断/);
    assert.match(v.raw, /压缩请求体未解码/);
  }
});

test('a request sent compressed says it is shown decompressed, and its size is not called wire bytes (4.6 §记录)', async () => {
  const v = await render(session(call({ ...W, reqEncoding: 'zstd' })));
  assert.match(v.raw, /请求体已解压 · request decompressed \(zstd\)/);
  assert.match(v.raw, /10 chars after decompression/);
  assert.doesNotMatch(v.raw, /bytes wire/);
  const plain = await render(session(call(W)));
  assert.doesNotMatch(plain.raw, /请求体已解压/);
  assert.match(plain.raw, /bytes wire/);
});

test('a non-LLM body stored as its length says 非逐字 in the control detail (4.6 W16 read half)', async () => {
  const rec = { id: 'c1', ts_request: '2026-10-06T00:00:00Z', method: 'GET', endpoint: '/v1/realtime', transport: 'ws', is_llm_call: false,
    req_headers: { 'user-agent': 'x' }, req_body: { raw_chars: 321, verbatim: false }, resp: { kind: 'ws', messages: [] } };
  const { M, getEl } = await loadIndex(session(call(W)), ['setCD(v){controlData=v}', 'openControlDetail']);
  M.setCD({ other: [rec] });
  M.openControlDetail('other', 0);
  assert.match(getEl('detail').innerHTML, /request 321 bytes/);
  assert.match(getEl('detail').innerHTML, /非逐字/);
});

test('analyzed.unknown renders a banner with the counts (3.1:58)', async () => {
  const { t } = await render(session(call(W), { unknown: { partial: true, records: 2, endpoints: ['/x:generateContent'], reason: 'no dissector', userAgents: [], models: [] } }));
  assert.match(t.getEl('unknownbar').innerHTML, /未识别/);
  assert.match(t.getEl('unknownbar').innerHTML, /<b>2<\/b> records in this session/);
  assert.match(t.getEl('unknownbar').innerHTML, /\/x:generateContent/);
  const clean = await render(session(call(W)));
  assert.equal(clean.t.getEl('unknownbar').innerHTML, '');
});

test('probe detail says the request body is not retained (3.2:134); a server lane says what it is', async () => {
  const s = session(call(W));
  s.probes = { count: 1, series: [{ ts: '2026-10-06T00:00:00Z', tokens: 900, retention: 'legacy-meta' }] };
  const { M, getEl } = await loadIndex(s, ['poll', 'openDetail', 'get lanes(){return lanes}']);
  await M.poll();
  M.openDetail(M.lanes.find((l) => l.kind === 'probe'), 0);
  assert.match(getEl('detail').innerHTML, /not retained/, 'a probe captured before D40 kept only the length');
  assert.match(getEl('detail').innerHTML, /本条采于 D40 之前,只存了长度/);
  assert.doesNotMatch(getEl('detail').innerHTML, /\(verbatim\)/, 'the old text claimed the probe body was kept verbatim');
  M.openDetail({ kind: 'probe', label: 'warm-up / probe requests', note: 'a warm-up request: not a conversation turn', calls: [{ ts: '2026-10-06T00:00:00Z', ctx: 5 }] }, 0);
  assert.match(getEl('detail').innerHTML, /a warm-up request: not a conversation turn/);
  assert.doesNotMatch(getEl('detail').innerHTML, /token-count probe/);
  // D40: since then the body is kept verbatim by default, or not stored when the operator chose a log line — each says so (a not-retained claim on a kept body would be false)
  for (const [retention, re, not] of [['full', /kept verbatim/, /not retained|not stored/], ['log', /not stored.*只记日志/, /kept verbatim/]]) {
    const s2 = session(call(W)); s2.probes = { count: 1, series: [{ ts: '2026-10-06T00:00:00Z', tokens: 900, retention }] };
    const t = await loadIndex(s2, ['poll', 'openDetail', 'get lanes(){return lanes}']);
    await t.M.poll();
    t.M.openDetail(t.M.lanes.find((l) => l.kind === 'probe'), 0);
    assert.match(t.getEl('detail').innerHTML, re, retention);
    assert.doesNotMatch(t.getEl('detail').innerHTML, not, retention);
  }
});

test('a partial call\'s badge says which earlier record is missing (server-baked contextMissing)', async () => {
  const v = await render(session(call({ ...W, transport: 'ws', contextState: 'partial', contextMissing: 'response resp_9 (named by previous_response_id) is not in this capture' })));
  assert.match(v.raw, /title="response resp_9 \(named by previous_response_id\) is not in this capture — what is shown is NOT the full context/);
  assert.doesNotMatch((await render(session(call({ ...W, contextState: 'partial' })))).raw, / — what is shown/, 'no missing note, no prefix');
});

test('client messages sent while the call was open are listed on it and open from the raw record (3.1:37)', async () => {
  const xs = [{ key: 'req_extra_messages[0]', chars: 29, ref: 'S/c.ndjson#r1::req_extra_messages.0::0-29' },
    { key: 'req_extra_messages[1]', chars: null, ref: null, note: 'stored as base64 bytes ({b64}), not as text' }];
  const v = await render(session(call(W, { extraMessages: xs })));
  assert.match(v.raw, /later client messages in this call/);
  assert.match(v.raw, /data-nbk="S\/c\.ndjson#r1::req_extra_messages\.0::0-29"[^>]*>req_extra_messages\[0\]<\/code> 29c/);
  assert.match(v.raw, /<code>req_extra_messages\[1\]<\/code> stored as base64 bytes/, 'one that is not text says what is stored');
  assert.doesNotMatch((await render(session(call(W)))).raw, /later client messages/);
});

test('the reply is listed with one locator per piece; a piece without one says why (R2)', async () => {
  const v = await render(session(call(W, { respRefs: [{ label: 'stream', ref: 'S/c.ndjson#r1::resp.raw::0-90', chars: 90 },
    { label: 'body', ref: null, chars: null, why: 'a JSON reply is stored parsed by the collector' }] })));
  assert.match(v.raw, /reply · /);
  assert.match(v.raw, /data-nbk="S\/c\.ndjson#r1::resp\.raw::0-90"/);
  assert.match(v.raw, /stored parsed by the collector/);
  const none = await render(session(call(W)));
  assert.doesNotMatch(none.raw, /reply · /, 'an older payload without respRefs lists nothing rather than a guess');
});

test('decoded bytes get their own badge, distinct from verbatim and from re-serialized', async () => {
  const { M } = await loadIndex(session(call(W)), ['resolvedBody']);
  assert.match(M.resolvedBody({ status: 'ok', text: 'x', fidelity: 'decoded' }, {}), /解码后逐字/);
  assert.doesNotMatch(M.resolvedBody({ status: 'ok', text: 'x', fidelity: 'decoded' }, {}), /not byte-verbatim/);
  assert.match(M.resolvedBody({ status: 'ok', text: 'x', fidelity: 'verbatim' }, {}), /逐字回源/);
  assert.match(M.resolvedBody({ status: 'ok', text: 'x', fidelity: 'reserialized' }, {}), /not byte-verbatim/);
});
