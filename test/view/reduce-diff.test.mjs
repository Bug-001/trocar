// test/view/reduce-diff.test.mjs — TEMPORARY (deleted once the real
// session agrees): the document reduced from a session's context projection is the record fold's, over generated sessions on every
// wire (Anthropic whole context and Message Threads, Responses over HTTP and WebSocket, Chat; sub-agents side by side and written
// late), sessions mixing wires with records no dissector reads, the thread helper's session in causal and file
// order, axes that break the cache inside the shared prefix (an edited block, reordered JSON keys, a reordered tools array), a call
// that fails midway (it moves no lane's baseline), calls that cannot show their context (a body that does not parse, an unstored
// WebSocket request, a continuation with its predecessor missing), the committed captured response shapes, and the real captured session when on disk.
//   (a) reduce(projection) ≡ createAssembler push-all → finish, serialised, except prefixSha256, lanes[].key, items
//   (b) listOf(rid) of every call is the call's list as extraction materialises it (its base chain), boundaries too
//   (c) a break detail is written once per pair of blocks: a second reduction appends nothing
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { reduce, listOf } from '../../src/view/reduce.mjs';
import { extractMembers, blockAt, materialize } from '../../src/view/extract.mjs';
import { createAssembler } from '../../src/view/assemble.mjs';
import { OrderBound, stepOrder } from '../../src/view/analyze.mjs';
import { openProjection, projectionFile } from '../../src/query/projection.mjs';
import { parseTextRef } from '../../src/raw/refs.mjs';
import { readRecords } from '../../src/raw/ingest.mjs';
import { groupSessions } from '../../src/view/board.mjs';
import { tmpDir } from '../helpers/tmp.mjs';
import { bigSession } from '../query/big-session.mjs';
import { threadSession } from '../helpers/cc-threads.mjs';
import { fixtureGate, hasFixture, CC_SESSION_REAL } from '../helpers/fixture.mjs';

const SEG = '20261020T164737Z', STREAM = `${SEG}.ndjson`, KEY = 'big-0000-4a1b-9c2d-000000000001';
const stamp = (r) => Object.defineProperty(r, '_stream', { value: STREAM, enumerable: false, configurable: true });
// records as the daemon writes them: ids `segment:line` in write order
const filed = (recs) => recs.map((r, i) => ({ ...r, id: `${SEG}:${i + 1}` }));
const copies = (recs) => recs.map((r) => stamp(JSON.parse(JSON.stringify(r))));

function big(wire, late, subLanes) {
  const s = bigSession({ home: tmpDir('trocar-reduce-'), wire, growth: 300, subEvery: 3, subLanes, late, compactAt: 4_000 });
  s.append(18);
  return fs.readFileSync(s.file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
// one axis of a cache break inside the shared prefix, at call k of a whole-context session
const rebody = (r, f) => ({ ...r, req_body: JSON.stringify(f(JSON.parse(r.req_body))) });
const firstUse = (b) => b.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).find((c) => c.type === 'tool_use');
const AXES = {
  edited: (b) => { b.messages[0].content[0].text += ' (edited)'; return b; },
  keyOrder: (b) => { const u = firstUse(b); if (u) u.input = Object.fromEntries(Object.entries(u.input).reverse()); return b; },
  toolOrder: (b) => { b.tools = b.tools.slice().reverse(); return b; },
};
function broken(recs, axis) {
  // two keys to reorder, two tools to swap, in every call; then the axis on one call midway
  const all = recs.map((r) => rebody(r, (b) => {
    for (const m of b.messages) for (const c of Array.isArray(m.content) ? m.content : []) if (c.type === 'tool_use') c.input = { ...c.input, limit: 5 };
    return { ...b, tools: [{ name: 'Read', description: 'read', input_schema: { type: 'object' } }, { name: 'Edit', description: 'edit', input_schema: { type: 'object' } }] };
  }));
  const k = Math.floor(all.length / 2);
  return all.map((r, i) => (i === k ? rebody(r, AXES[axis]) : r));
}
// a call midway that fails cleanly: it moves no lane's cache baseline
const failed = (recs) => recs.map((r, i) => (i === Math.floor(recs.length / 2)
  ? { ...r, resp: { status: 529, kind: 'json', body: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } } } : r));
// a call midway that cannot show its context (3.4: no compaction verdict, not its lane's baseline), one shape per axis: a body that is
// stored but does not parse; a WebSocket call whose request message was not stored (over the size cap: req_body null, a client
// data frame in ws_raw); a WebSocket continuation whose predecessor is not in the capture
const FAILS = {
  unparsed: { on: (r) => typeof r.req_body === 'string', f: (r) => ({ ...r, req_body: r.req_body.slice(0, -7) }) },
  unstored: { on: (r) => r.transport === 'ws', f: (r) => ({ ...r, req_body: null, ws_truncated: true, ws_raw: [{ d: 'c', h: Buffer.from([0x81, 0x7e]).toString('base64') }] }) },
  orphan: { on: (r) => /previous_response_id/.test(r.req_body || ''), f: (r) => rebody(r, (b) => ({ ...b, previous_response_id: 'resp_gone' })) },
};
function blind(recs, axis) {
  const { on, f } = FAILS[axis], at = recs.map((r, i) => i).filter((i) => recs[i].is_llm_call && on(recs[i]));
  const k = at[Math.floor(at.length / 2)];
  return recs.map((r, i) => (i === k ? f(r) : r));
}
const fixture = (name) => fs.readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

// Codex over Responses HTTP: the whole context each request; every third call a subagent's (a harness lane hint, no agent id), a
// probe (prewarm) call, and one call per axis midway: a compaction (the harness hint, the input cut), a failed stream, an edited turn
const SSE = (events) => events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
function responses(axis, n = 15) {
  const lanes = { main: [], sub: [] }, k = Math.floor(n / 2), out = [];
  const tools = [{ type: 'function', name: 'shell', description: 'run a command', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } }];
  for (let i = 0; i < n; i++) {
    const sub = i % 3 === 2, probe = i === 1, L = sub ? 'sub' : 'main';
    if (sub && lanes.sub.length > 6) lanes.sub = [];
    if (axis === 'compaction' && i === k) lanes.main = lanes.main.slice(-3);
    if (!probe) lanes[L].push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: `ask ${i} `.repeat(30) }] },
      { type: 'function_call', name: 'shell', arguments: JSON.stringify({ cmd: `ls ${i}` }), call_id: `c${i}` },
      { type: 'function_call_output', call_id: `c${i}`, output: `out ${i} `.repeat(40) });
    const input = lanes[L].map((m) => JSON.parse(JSON.stringify(m)));
    if (axis === 'edited' && i === k && !sub) input[0].content[0].text += ' (edited)';
    const item = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `reply ${i}` }] }, id = `resp_${i}`;
    const failed = axis === 'failed' && i === k;
    const events = [{ type: 'response.created', response: { id } }, { type: 'response.output_item.added', output_index: 0, item },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: failed ? 'response.failed' : 'response.completed', response: { id, status: failed ? 'failed' : 'completed', output: [item],
        usage: { input_tokens: 100 + i, input_tokens_details: { cached_tokens: 50 * i }, output_tokens: 20 } } }];
    const meta = probe ? 'prewarm' : axis === 'compaction' && i === k ? 'compaction' : null;
    out.push({ ts_request: new Date(Date.parse('2026-10-20T16:47:37Z') + i * 4000).toISOString(), endpoint: '/v1/responses', is_llm_call: true,
      proc: { pid: 1, exe: '/x/codex', agent: 'codex' },
      req_headers: { 'session-id': 'S', ...(sub ? { 'x-openai-subagent': 'agent' } : {}), ...(meta ? { 'x-codex-turn-metadata': JSON.stringify({ request_kind: meta }) } : {}) },
      req_body: JSON.stringify({ model: 'gpt-x', instructions: 'You are Codex.', tools, input: probe ? [] : input, stream: true }),
      resp: { status: 200, kind: 'sse', raw: SSE(events), raw_sse: events } });
  }
  return out;
}
// one session, several wires (Hermes: Chat for the conversation, the Anthropic wire for a side model), and records no dissector reads
function mixed(n = 14) {
  const msgs = [{ role: 'system', content: 'you are hermes' }], out = [];
  for (let i = 0; i < n; i++) {
    const at = { ts_request: new Date(Date.parse('2026-10-20T16:47:37Z') + i * 4000).toISOString(), is_llm_call: true,
      proc: { pid: 1, exe: '/x/hermes', agent: 'hermes' }, req_headers: {}, resp: { status: 200, kind: 'sse', raw_sse: [], usage: {} } };
    if (i % 5 === 4) { out.push({ ...at, endpoint: '/v1beta/models/x:generateContent', req_body: JSON.stringify({ session_id: 'H1', contents: [] }) }); continue; }
    if (i % 4 === 3) {
      out.push({ ...at, endpoint: '/v1/messages', req_body: JSON.stringify({ session_id: 'H1', model: 'claude-haiku', system: [{ type: 'text', text: 'title this' }], messages: [{ role: 'user', content: `q ${i}` }] }) });
      continue;
    }
    msgs.push({ role: 'user', content: `turn ${i} `.repeat(20) }, { role: 'assistant', content: `answer ${i} `.repeat(10) });
    out.push({ ...at, endpoint: '/v1/chat/completions', req_body: JSON.stringify({ session_id: 'H1', model: 'nous', messages: msgs }) });
  }
  return out;
}
// records written later than they were sent: every `pick`ed record moves `by` places down the file (as a call is written when it ends)
function lateBy(recs, pick, by) {
  const out = recs.slice();
  for (let i = out.length - 1; i >= 0; i--) if (pick(out[i], i)) out.splice(Math.min(out.length - 1, i + by), 0, ...out.splice(i, 1));
  return out;
}
const subOf = (r) => /subagent/.test(JSON.stringify(r.req_headers) + (r.req_body || ''));

function sessions() {
  const out = {};
  for (const wire of ['http', 'threads']) for (const late of [0, 3]) for (const subLanes of [1, 2]) out[`${wire} late=${late} subLanes=${subLanes}`] = big(wire, late, subLanes);
  const T = threadSession();
  out['threads helper causal'] = [T.S0, T.M0, T.M1, T.A, T.S1, T.M2];
  out['threads helper file order'] = T.fileOrder;
  for (const axis of Object.keys(AXES)) out[`http ${axis}`] = broken(big('http', 0, 1), axis);
  for (const wire of ['http', 'threads']) for (const late of [0, 3]) out[`${wire} failed late=${late}`] = failed(big(wire, late, 2));
  for (const wire of ['ws', 'chat']) for (const late of [0, 3]) for (const subLanes of [1, 2]) out[`${wire} late=${late} subLanes=${subLanes}`] = big(wire, late, subLanes);
  for (const axis of ['plain', 'compaction', 'failed', 'edited']) for (const late of [0, 2]) out[`responses ${axis} late=${late}`] = lateBy(responses(axis), subOf, late);
  for (const late of [0, 3]) {
    for (const axis of ['unparsed', 'unstored', 'orphan']) out[`ws ${axis} late=${late}`] = blind(big('ws', late, 2), axis);
    out[`chat unparsed late=${late}`] = blind(big('chat', late, 2), 'unparsed');
  }
  for (const late of [0, 2]) out[`responses unparsed late=${late}`] = lateBy(blind(responses('plain'), 'unparsed'), subOf, late);
  for (const late of [0, 2]) out[`mixed late=${late}`] = lateBy(mixed(), (r) => /messages|generate/.test(r.endpoint), late);
  out['captured response shapes'] = fixture('old-capture-resp-shapes.ndjson').filter((r) => /^\/v1\/messages/.test(r.endpoint || ''));
  for (const k of Object.keys(out)) out[k] = filed(out[k]);
  return out;
}
const SESSIONS = sessions();

// the record fold, as the query folds a session: every record in write order, its lanes folded again when one arrives late; a
// session whose sub-agents are told apart only by order folded from scratch in step order
function folded(recs) {
  const byId = new Map(recs.map((r) => [r.id, r]));
  const run = (order) => { const a = createAssembler({ read: (ids) => ids.map((id) => byId.get(id)).filter(Boolean) }); for (const r of order) a.push(r); return a.finish(); };
  try { return run(recs); } catch (e) { if (!(e instanceof OrderBound)) throw e; return run(recs.slice().sort(stepOrder)); }
}
// extraction → the projection → reduction
function projected(recs, home = tmpDir('trocar-reduce-')) {
  const byId = new Map(recs.map((r) => [r.id, r]));
  const store = openProjection({ home, key: KEY });
  const members = recs.map((r) => ({ id: r.id }));
  extractMembers({ store, members, recordsAt: (rows) => rows.map((m) => byId.get(m.id)) });
  const resolve = (ref) => blockAt(byId.get(parseTextRef(ref).recordId), ref);
  return { store, members, resolve, home, doc: () => reduce(store, members, { resolve }) };
}
// the documents as they are sent, minus what the reduction leaves out or adds on purpose (`mark` / `pending`: the extraction frontier
// a projection is reduced at, design §3.4, which a fold over records has no counterpart for; reduce-frontier.test.mjs covers them)
const serialised = (doc) => {
  const { items, mark, pending, ...rest } = doc;
  return JSON.parse(JSON.stringify({ ...rest, lanes: (rest.lanes || []).map(({ key, ...l }) => l) },
    (k, v) => (k === 'prefixSha256' ? undefined : v instanceof Map ? [...v] : v)));
};

test('(a) the document reduced from the projection is the record fold\'s', () => {
  for (const [name, recs] of Object.entries(SESSIONS)) {
    const want = serialised(folded(copies(recs)));
    const got = projected(copies(recs)).doc();
    assert.ok(want.steps.length, name);
    assert.deepEqual(serialised(got), want, name);
    // what the reduction adds: each lane's first call, each record's facts
    for (const l of got.lanes) assert.equal(l.key, String(l.calls[0].id), `${name} lane key`);
    assert.deepEqual([...got.items.keys()].sort(), recs.map((r) => r.id).sort(), `${name} items`);
  }
});

test('(a) on the real captured session', fixtureGate(), async () => {
  const all = await readRecords(CC_SESSION_REAL, { normalize: false });
  const [sid] = [...groupSessions(all).entries()].sort((a, b) => b[1].length - a[1].length)[0];
  const recs = filed(groupSessions(all).get(sid).map((r) => JSON.parse(JSON.stringify(r))));
  assert.deepEqual(serialised(projected(copies(recs)).doc()), serialised(folded(copies(recs))));
});

test('(b) listOf gives every call the list and boundaries extraction materialises', () => {
  for (const [name, recs] of Object.entries(SESSIONS)) {
    const { store } = projected(copies(recs));
    const memo = new Map();
    const of = (rid, key) => {
      if (memo.has(rid + key)) return memo.get(rid + key);
      const row = store.rows.get(rid), v = materialize(row.base == null ? null : of(row.base, key), key === 'list' ? row : row.mb);
      memo.set(rid + key, v);
      return v;
    };
    // asked in a scrambled order, so lists come from keyframes and recent ones alike
    const rids = [...store.rows.keys()].filter((rid) => Array.isArray(store.rows.get(rid).x.secs)).reverse();
    for (const rid of [...rids, ...rids.slice().sort()]) {
      const got = listOf(store, rid);
      assert.deepEqual(got.bids, of(rid, 'list'), `${name} ${rid}`);
      assert.deepEqual(got.mb, of(rid, 'mb'), `${name} ${rid} boundaries`);
      assert.deepEqual(got.attrs, store.rows.get(rid).attrs || {}, `${name} ${rid} attrs`);
    }
  }
});

test('(c) a break detail is written once per pair of blocks: reducing again appends nothing', () => {
  let pairs = 0;
  for (const [name, recs] of Object.entries(SESSIONS)) {
    const p = projected(copies(recs)), file = projectionFile(p.home, KEY);
    p.doc();
    const once = fs.readFileSync(file);
    const brks = once.toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((o) => o.b);
    const keys = brks.map((o) => o.b.brk.join('\n'));
    assert.equal(new Set(keys).size, keys.length, `${name}: one line per pair`);
    pairs += keys.length;
    p.doc();
    assert.deepEqual(fs.readFileSync(file), once, `${name}: the same store reduced again`);
    // a store opened afresh over the file reads them back
    const again = openProjection({ home: p.home, key: KEY });
    reduce(again, p.members, { resolve: () => assert.fail('a stored detail is not worked out again') });
    assert.deepEqual(fs.readFileSync(file), once, `${name}: a store reopened from disk`);
  }
  assert.ok(pairs > 0, 'the sessions break inside a shared prefix');
});
