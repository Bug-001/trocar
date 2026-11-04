// test/view/extract.test.mjs — extraction, part 1 (RFC 4.3 §3), over generated
// sessions on the wires whose request carries its whole context: Claude Code over HTTP (JSON and streamed replies), Chat, and
// Responses over HTTP with a streamed reply; plus records that are no call.
//   (a) every definition checks out: its ref resolved against the record's field and hashed with its section and role gives its bid;
//       one with no span hashes its canonical JSON under the 'u' tag
//   (b) a definition depends only on its bytes, section and role: the same bytes at another position, call or lane, one axis at a time
//   (d) rows and definitions are JSON documents, and no credential header value is in them
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { extract, createExtractContext, materialize, materializeAttrs, anthropicFlat, replyBlocks } from '../../src/view/extract.mjs';
import { parseTextRef } from '../../src/raw/refs.mjs';
import { fieldTextOf } from '../../src/dissect/record-fields.mjs';
import { shapeResponse } from '../../src/collector/core/record/body.mjs';
import { tmpDir } from '../helpers/tmp.mjs';
import { bigSession } from '../query/big-session.mjs';
import { replyOf } from '../helpers/cc-threads.mjs';

const STREAM = '20261020T164737Z.ndjson';
const stamp = (r) => Object.defineProperty(r, '_stream', { value: STREAM, enumerable: false, configurable: true });
const SECRET = 'sk-test-0123456789-secret';

// ── generated sessions ─────────────────────────────────────────────────────────────────────────────────────────────────────────
function generated(wire, n = 14) {
  const s = bigSession({ home: tmpDir('trocar-extract-'), wire, growth: 600, subEvery: 4 });
  s.append(n);
  return fs.readFileSync(s.file, 'utf8').split('\n').filter(Boolean).map((l) => stamp(JSON.parse(l)));
}
// Claude Code with streamed replies: the same calls, each JSON reply re-sent as the stream the collector stores
const streamed = (recs) => recs.map((r) => stamp({ ...r, resp: replyOf(r.resp.body.id, r.resp.body.content, r.resp.body.usage) }));
// Responses over HTTP: a conversation growing by a message, a function call and its output per call; each reply streamed
const sseOf = (events) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
function responsesSession(n = 6) {
  const input = [], out = [];
  for (let i = 0; i < n; i++) {
    input.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: `turn ${i}: list  the files 你好` }]});
    const items = [{ type: 'message', id: `m${i}`, role: 'assistant', content: [{ type: 'output_text', text: `reply ${i} — ok` }] },
      { type: 'function_call', id: `fc${i}`, call_id: `c${i}`, name: 'shell', arguments: JSON.stringify({ cmd: `ls ${i}` }) }];
    const events = items.flatMap((item, k) => [{ type: 'response.output_item.added', output_index: k, item }, { type: 'response.output_item.done', output_index: k, item }]);
    events.push({ type: 'response.completed', response: { id: `resp_${i}`, status: 'completed', output: items, usage: { input_tokens: 10, output_tokens: 4 } } });
    const body = JSON.stringify({ model: 'gpt-x', instructions: 'You are Codex.', tools: [{ type: 'function', name: 'shell', parameters: { type: 'object' } }], input });
    out.push(stamp({ id: `r${i}`, ts_request: `2026-10-20T16:00:${String(i).padStart(2, '0')}Z`, is_llm_call: true, endpoint: '/v1/responses',
      req_headers: { 'session-id': 'S', authorization: `Bearer ${SECRET}` }, req_body: body,
      resp: shapeResponse({ status: 200, headers: [['content-type', 'text/event-stream']], body: Buffer.from(sseOf(events)) }) }));
    input.push(items[0], items[1], { type: 'function_call_output', call_id: `c${i}`, output: `a${i}.txt` });
  }
  return out;
}
// records that are no call: a token-count probe and a call no dissector claims
const nonCalls = () => [
  stamp({ id: 'p1', ts_request: '2026-10-20T16:47:38Z', is_llm_call: false, endpoint: '/v1/messages/count_tokens', req_headers: { 'x-api-key': SECRET }, req_body: '{}', resp: { status: 200, kind: 'json', body: { input_tokens: 12 } } }),
  stamp({ id: 'u1', ts_request: '2026-10-20T16:47:39Z', is_llm_call: true, endpoint: '/v1beta/models/g:generateContent', req_headers: {}, req_body: '{"model":"g"}', resp: { status: 200, kind: 'json', body: {} } }),
];
// Claude Code whose system block carries a per-call nonce (the billing header): one block in the middle changes every call
const nonced = (n = 5) => Array.from({ length: n }, (_, i) => stamp({ id: `v${i}`, ts_request: `2026-10-20T16:01:0${i}Z`, is_llm_call: true, endpoint: '/v1/messages',
  req_headers: { 'x-claude-code-session-id': 'S' }, resp: replyOf(`msg_v${i}`, [{ type: 'text', text: `ok ${i}` }]),
  req_body: JSON.stringify({ model: 'claude-opus-x', tools: [{ name: 'Read', description: 'read', input_schema: { type: 'object' } }],
    system: [{ type: 'text', text: `x-anthropic-billing-header: cc_version=2.1; cch=${i};` }, { type: 'text', text: 'You are a coding assistant.' }],
    messages: Array.from({ length: i + 1 }, (_, k) => ({ role: k % 2 ? 'assistant' : 'user', content: [{ type: 'text', text: `message ${k}` }] })) }) }));
const SESSIONS = () => ({ nonced: nonced(), http: [...generated('http'), ...nonCalls()], httpStream: streamed(generated('http')), chat: generated('chat'), responses: responsesSession() });

// extracted in record order, as the driver will
function run(records, ctx = createExtractContext()) {
  const defs = new Map(), rows = new Map();
  for (const r of records) { const o = extract(r, ctx); for (const d of o.defs) { assert.ok(!defs.has(d.bid), 'a definition is written once'); defs.set(d.bid, d); } rows.set(o.row.rid, o.row); }
  return { defs, rows };
}
// independent of the code under test: the spec's hash and canonical form
const b64 = (s) => createHash('sha256').update(s, 'utf8').digest().subarray(0, 16).toString('base64url');
const canon = (v) => (Array.isArray(v) ? `[${v.map(canon).join(',')}]` : v && typeof v === 'object'
  ? `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}` : JSON.stringify(v));
const resolve = (rec, ref) => {
  const { field, start, end } = parseTextRef(ref);
  const t = field ? fieldTextOf(rec, field).text : rec.req_body;
  return t.slice(start, end);
};
const expectedBid = (byId, d) => (d.ref ? b64(`${d.sec}\x1F${d.role}\x1F${resolve(byId.get(parseTextRef(d.ref).recordId), d.ref)}`)
  : b64(`u\x1F${d.sec}\x1F${d.role}\x1F${canon(d.sec === 'system' ? d.text : d.block)}`));

test('(a) every definition resolves to the bytes its bid hashes; a block with no span hashes its canonical JSON', () => {
  for (const [name, recs] of Object.entries(SESSIONS())) {
    const byId = new Map(recs.map((r) => [String(r.id), r]));
    const { defs } = run(recs);
    assert.ok(defs.size, name);
    for (const d of defs.values()) {
      assert.match(d.bid, /^[A-Za-z0-9_-]{22}$/);
      assert.equal(d.bid, expectedBid(byId, d), `${name} ${d.sec}/${d.role}/${d.kind} ${d.ref}`);
      if (!d.ref) assert.ok(d.ff.unaddressable, 'a block with no span says why and carries its body');
    }
    // a streamed reply's blocks are addressed in resp.raw; a JSON reply's are not
    const replies = [...defs.values()].filter((d) => d.ref && parseTextRef(d.ref).field === 'resp.raw');
    assert.equal(replies.length > 0, recs.some((r) => r.resp && r.resp.kind === 'sse'), name);
  }
});

// ── (b): one axis at a time ────────────────────────────────────────────────────────────────────────────────────────────────────
const cc = (id, messages, headers = {}) => stamp({ id, ts_request: `2026-10-20T16:00:00Z`, is_llm_call: true, endpoint: '/v1/messages',
  req_headers: { 'x-claude-code-session-id': 'S', 'user-agent': 'claude-cli/2.1 (external, cli)', ...headers },
  req_body: JSON.stringify({ model: 'claude-opus-x', system: [{ type: 'text', text: 'You are a coding assistant.' }],
    tools: [{ name: 'Read', description: 'read a file', input_schema: { type: 'object' } }], messages }),
  resp: replyOf(`msg_${id}`, [{ type: 'text', text: 'done' }]) });
const read = (id) => [{ role: 'assistant', content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: '/w/a.mjs' } }] }];
const result = (id) => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'file text [truncated to 30 chars]' }, { type: 'text', text: 'go on' }] });
const ask = { role: 'user', content: [{ type: 'text', text: 'read a.mjs please' }] };
const chat = (id, messages) => stamp({ id, ts_request: '2026-10-20T16:00:00Z', is_llm_call: true, endpoint: '/chat/completions',
  req_headers: { host: 'api.deepseek.com' }, req_body: JSON.stringify({ model: 'deepseek-chat', messages }), resp: { status: 200, kind: 'json', body: { id: 'c', choices: [] } } });
const AXES = [
  ['position', cc('a', [ask, ...read('t1'), result('t1')]), cc('a', [{ role: 'user', content: 'earlier' }, { role: 'assistant', content: 'ok' }, ask, ...read('t1'), result('t1')])],
  ['call', cc('a', [ask, ...read('t1'), result('t1')]), cc('b', [ask, ...read('t1'), result('t1')])],
  ['lane', cc('a', [ask, ...read('t1'), result('t1')]), cc('a', [ask, ...read('t1'), result('t1')], { 'x-claude-code-agent-id': 'agent-7' })],
  ['sibling', cc('a', [ask, ...read('t1'), result('t1')]), cc('a', [ask, result('t1')])], // a file's result with and without its tool_use
  ['chat position', chat('a', [{ role: 'system', content: 'sys' }, { role: 'user', content: 'q' }]), chat('a', [{ role: 'system', content: 'sys' }, { role: 'user', content: 'p' }, { role: 'assistant', content: 'x' }, { role: 'user', content: 'q' }])],
];
test('(b) the same bytes at another position, call, lane or beside another sibling give the same definition', () => {
  const noRef = (d) => ({ ...d, ref: null });
  for (const [axis, one, two] of AXES) {
    const a = run([one]).defs, b = run([two]).defs;
    const both = [...a.keys()].filter((k) => b.has(k));
    assert.ok(both.length >= 2, axis);
    for (const k of both) assert.deepEqual(noRef(b.get(k)), noRef(a.get(k)), `${axis}: ${a.get(k).kind}`);
  }
});

test('(d) rows and definitions survive a JSON round trip, and carry no credential header value', () => {
  for (const [name, recs] of Object.entries(SESSIONS())) {
    for (const r of recs) if (name === 'http') r.req_headers.authorization = `Bearer ${SECRET}`;
    const { defs, rows } = run(recs);
    for (const o of [...defs.values(), ...rows.values()]) {
      const s = JSON.stringify(o);
      assert.deepStrictEqual(JSON.parse(s), o, name);
      assert.ok(!s.includes(SECRET), `${name}: no secret`);
    }
    for (const r of recs) assert.ok(rows.get(String(r.id)).x.item, `${name}: every record has a row`);
  }
});

// ── part 2: the calls whose context is stitched across records, and the build driver ───────────────────────────────────────────────────
//   (a) every definition reachable from a stitched call's list checks out (as part 1's (a))
//   (c) a restart (rows 0..k stored, the store reopened from disk) goes on to the rows one pass gives
//   (d) the frontier: the largest rid with every member up to it extracted
import { extractMembers } from '../../src/view/extract.mjs';
import { openProjection } from '../../src/query/projection.mjs';
import { threadSession, record } from '../helpers/cc-threads.mjs';

const SEG = '20261020T164737Z';
// records as the daemon writes them: ids are segment:line in write order (a call is written when it ends, so a predecessor first)
const filed = (recs) => recs.map((r, i) => stamp({ ...r, id: `${SEG}:${i + 1}` }));
const rebody = (r, f) => ({ ...r, req_body: JSON.stringify(f(JSON.parse(r.req_body))) });
const T = threadSession(), CAUSAL = [T.S0, T.M0, T.M1, T.A, T.S1, T.M2];
const THREAD_VARIANTS = {
  causal: CAUSAL,
  // M2 resends its own tools and a cached system block; S1 sends no system at all; M1's system is only a volatile block (as given)
  ownTools: CAUSAL.map((r) => (r === T.M2 ? rebody(r, (b) => ({ ...b, tools: [{ name: 'Grep', description: 'grep', input_schema: { type: 'object' } }], system: [{ type: 'text', text: 'A new system.' }] })) : r)),
  noSystem: CAUSAL.map((r) => (r === T.S1 ? rebody(r, ({ system, ...b }) => b) : r)),
  // M1's reply ended in an error: what it answered is not wholly known
  replyGap: CAUSAL.map((r) => (r === T.M1 ? { ...r, resp: { kind: 'error', status: 529, partial: r.resp } } : r)),
};
function wsVariant(recs) { const k = recs.findIndex((r, i) => i > 0 && JSON.parse(r.req_body).previous_response_id); return recs.map((r, i) => (i === k ? { ...r, partial: true, partial_reasons: ['gap'] } : r)); }
function stitchedSessions() {
  const out = {};
  for (const wire of ['threads', 'ws']) {
    const s = bigSession({ home: tmpDir('trocar-extract-'), wire, growth: 300, subEvery: 3, subLanes: 2, late: 2 });
    s.append(16);
    const recs = fs.readFileSync(s.file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    out[wire] = recs;
    if (wire === 'ws') out.wsGap = wsVariant(recs);
  }
  Object.assign(out, THREAD_VARIANTS);
  // one record at a time left out of the capture: what continues it is partial, and says what is missing
  for (const name of ['causal', 'ws']) out[name].forEach((_, k) => { out[`${name}-${k}`] = out[name].filter((__, i) => i !== k); });
  for (const k of Object.keys(out)) out[k] = filed(out[k]);
  return out;
}
const listsOf = (rows) => {
  const memo = new Map();
  const of = (rid, key) => {
    if (memo.has(rid + key)) return memo.get(rid + key);
    const row = rows.get(rid), was = row.base == null ? null : of(row.base, key);
    const v = key === 'attrs' ? materializeAttrs(was, row) : materialize(was, key === 'list' ? row : row.mb);
    memo.set(rid + key, v);
    return v;
  };
  return of;
};
const stitchedIds = (recs) => recs.filter((r) => { try { const b = JSON.parse(r.req_body); return (b.thread && b.thread.type === 'continue') || b.type === 'response.create'; } catch { return false; } }).map((r) => r.id);

test('(a) part 2: every definition a stitched call\'s list reaches checks out against the bytes its bid hashes', () => {
  for (const [name, recs] of Object.entries(stitchedSessions())) {
    const byId = new Map(recs.map((r) => [String(r.id), r]));
    const { defs, rows } = run(recs), of = listsOf(rows);
    const ids = stitchedIds(recs);
    assert.ok(ids.length, name);
    for (const rid of ids) for (const bid of of(rid, 'list').concat(rows.get(rid).reply)) {
      const d = defs.get(bid);
      assert.ok(d, `${name} ${rid}: ${bid} is defined`);
      assert.equal(d.bid, expectedBid(byId, d), `${name} ${rid} ${d.sec}/${d.role}/${d.kind}`);
    }
  }
});

// the driver over a session's members: index rows by id, records read through recordsAt (one chunk at a time)
const membersOf = (recs) => recs.map((r) => ({ id: r.id }));
const reader = (recs) => { const byId = new Map(recs.map((r) => [r.id, r])); return (rows) => rows.map((m) => byId.get(m.id)); };
const KEY = 'big-0000-4a1b-9c2d-000000000001';
const opened = (home) => openProjection({ home, key: KEY });

test('(c) a restart — rows 0..k stored, the store reopened from disk — goes on to exactly the rows of one pass', () => {
  const all = stitchedSessions();
  for (const name of ['threads', 'ws', 'causal']) {
    const recs = all[name], members = membersOf(recs), recordsAt = reader(recs);
    const one = opened(tmpDir('trocar-extract-'));
    extractMembers({ store: one, members, recordsAt });
    assert.equal(one.rows.size, recs.length, name);
    for (let k = 0; k < recs.length; k += 3) {
      const home = tmpDir('trocar-extract-');
      extractMembers({ store: opened(home), members: members.slice(0, k + 1), recordsAt });
      const again = opened(home);
      assert.equal(again.rows.size, k + 1, `${name} k=${k}: read back from disk`);
      extractMembers({ store: again, members, recordsAt });
      for (const r of recs) assert.deepEqual(again.rows.get(r.id), one.rows.get(r.id), `${name} k=${k} ${r.id}`);
    }
  }
});

test('(d) frontier: the largest rid with every member up to it extracted; done: the members up to it, the cursor to go on from', () => {
  const recs = stitchedSessions().threads, members = membersOf(recs), recordsAt = reader(recs);
  const store = opened(tmpDir('trocar-extract-'));
  // some later members first: the frontier stops at the first gap
  extractMembers({ store, members: members.filter((_, i) => i < 3 || (i >= 6 && i < 9)), recordsAt });
  // a budget spent before the first member still extracts one, the unit (3.5 后台抽取与归约: every slice moves the frontier)
  let r = extractMembers({ store, members, recordsAt, budgetMs: 0 });
  assert.deepEqual(r, { frontier: recs[3].id, done: 4, total: recs.length });
  // a budget that runs out midway: what it extracted is the next members in write order, and the frontier says how far
  for (const budget of [3, 6]) {
    let now = 0;
    const before = new Set(store.rows.keys());
    r = extractMembers({ store, members, recordsAt, budgetMs: budget, clock: () => now++ });
    const has = recs.map((x) => store.rows.has(x.id)), gap = has.indexOf(false);
    const taken = recs.filter((x) => store.rows.has(x.id) && !before.has(x.id)).map((x) => x.id);
    const todo = recs.filter((x) => !before.has(x.id)).map((x) => x.id);
    assert.ok(taken.length > 0 && taken.length < todo.length, `budget ${budget} stops midway`);
    assert.deepEqual(taken, todo.slice(0, taken.length), 'in write order');
    const done = gap < 0 ? recs.length : gap;
    assert.deepEqual(r, { frontier: done === 0 ? null : recs[done - 1].id, done, total: recs.length });
  }
});

test('(d) sliced: over budget-cut slices each member is read once, and the rows are those of one pass (3.5 后台抽取与归约)', () => {
  const all = stitchedSessions();
  for (const name of ['threads', 'ws']) {
    const recs = all[name], members = membersOf(recs), read = reader(recs);
    const one = opened(tmpDir('trocar-extract-'));
    extractMembers({ store: one, members, recordsAt: read });
    const store = opened(tmpDir('trocar-extract-'));
    let asked = 0, r = { done: 0 };
    do {
      let now = 0;
      r = extractMembers({ store, members, recordsAt: (rows) => { asked += rows.length; return read(rows); }, budgetMs: 2, clock: () => now++, from: r.done });
    } while (r.done < r.total);
    assert.equal(asked, members.length, `${name}: every member read once`);
    for (const x of recs) assert.deepEqual(store.rows.get(x.id), one.rows.get(x.id), `${name} ${x.id}`);
  }
});

test('(d) a member that does not read back is held with every row after it; the next open goes on to the rows of one pass', () => {
  const all = stitchedSessions();
  for (const name of ['threads', 'ws']) {
    const recs = all[name], members = membersOf(recs), recordsAt = reader(recs), whole = { frontier: recs.at(-1).id, done: recs.length, total: recs.length };
    const one = opened(tmpDir('trocar-extract-'));
    extractMembers({ store: one, members, recordsAt });
    recs.forEach(({ id: lost }, k) => {
      const home = tmpDir('trocar-extract-'), first = opened(home);
      assert.deepEqual(extractMembers({ store: first, members, recordsAt: (rows) => recordsAt(rows).filter((x) => x.id !== lost) }), whole);
      assert.ok(first.rows.get(lost).x.unparsed, `${name} k=${k}: held unparsed`);
      for (const r of recs.slice(k + 1)) {
        const m = r === lost ? null : first.rows.get(r.id).x.wire?.contextMissing;
        assert.ok(!m || !m.includes('in this capture') || one.rows.get(r.id).x.wire.contextMissing === m, `${name} k=${k} ${r.id}: no false claim`);
      }
      const again = opened(home);
      assert.equal(again.rows.size, k, `${name} k=${k}: only the rows before it on disk`);
      assert.deepEqual(extractMembers({ store: again, members, recordsAt }), whole);
      for (const r of recs) assert.deepEqual(again.rows.get(r.id), one.rows.get(r.id), `${name} k=${k} ${r.id}`);
    });
  }
});

test('reasoning with no plaintext on the wire is opaque on both sides of a call: signature only, or a redacted block', () => {
  const blocks = [{ type: 'redacted_thinking', data: 'ciphertext' }, { type: 'thinking', thinking: '', signature: 's' }, { type: 'thinking', thinking: 'seen', signature: 's' }];
  const want = ['opaque', 'opaque', undefined];
  assert.deepEqual(anthropicFlat({ messages: [{ role: 'assistant', content: blocks }] }, null).map((b) => b.faithfulness), want);
  const events = [{ type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', content: [] } },
    ...blocks.flatMap(({ thinking, signature, ...start }, index) => [{ type: 'content_block_start', index, content_block: { ...start, ...(thinking === undefined ? null : { thinking: '' }) } },
      ...(thinking ? [{ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking } }] : []),
      ...(signature ? [{ type: 'content_block_delta', index, delta: { type: 'signature_delta', signature } }] : []),
      { type: 'content_block_stop', index }]), { type: 'message_stop' }];
  const sse = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  const resp = shapeResponse({ status: 200, headers: [['content-type', 'text/event-stream']], body: Buffer.from(sse) });
  assert.deepEqual(replyBlocks({ resp }, { format: 'anthropic' }).map((x) => x.b.faithfulness), want);
});
