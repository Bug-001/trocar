import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assembleSession } from '../../src/view/assemble.mjs';
import { linearContext } from '../../src/view/analyze.mjs';
import { readRecords } from '../../src/etl/ingest.mjs';
import { buildResolver } from '../../src/query/source.mjs';
import { slimBlock } from '../../src/view/blockmeta.mjs';

// ── the resource explorer must preview what the model SAW, not what it ASKED FOR ──────────
// 📂 "files opened" is one of the three signature views. Clicking a Read-opened file previewed the
// tool_use REQUEST JSON (`{"file_path":"/work/src/duration.mjs"}`) — the arguments the model sent —
// while the bytes that actually entered the context live in the sibling `tool_result`. The panel
// answered "what did the model ask for" under a heading that promises "what did the model see".
//
// The board resolves a resource card to a block by resKey; this is its exact selector
// (src/web/index.html renderResourceView): prefer a non-tool_use block carrying the same resKey,
// else fall back to the tool_use. Before the fix NOTHING but the tool_use ever carried a file::
// resKey, so the fallback always fired and the request JSON was shown as if it were the file.
//
// ── WHAT THE NEW WIRE CONTRACT CHANGED HERE (RFC 1.4:35 · 4.2:55) ─────────────────────────
// A block no longer ships its body. An addressable block carries `text_ref` =
// `<session>/<stream>#<recordId>::<start>-<end>` and the heavy fields (text/block/desc/schema/props)
// are gone; the body is fetched 「回源」 from the raw capture. So the question this file asks — "which
// BYTES does the resource card preview" — is now answered by resolving the locator, which is exactly
// the AC-1 algorithm RFC 2.3 §验收1 specifies (「定位源记录 → slice(start,end)」, diff = 0 against the
// NDJSON source). Reading the fixture through readRecords() is what makes the blocks addressable —
// records hand-built in a test carry no `_stream` stamp and take the inlined path instead.
const pick = (flat, rk) =>
  flat.find((x) => x.resKey === rk && x.kind !== 'tool_use') || flat.find((x) => x.resKey === rk);

// The body of an INLINED (unaddressable) block — the synthetic cases below, which have no wire bytes.
const resultText = (b) => {
  const c = b?.block?.content;
  return typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => x.text || '').join('\n') : '';
};

// ── real capture (samples/demo-session.ndjson · 8 calls, Read/Edit/Bash/Grep with siblings) ──
const here = path.dirname(fileURLToPath(import.meta.url));
const REAL = path.join(here, '..', '..', 'samples', 'demo-session.ndjson');
const realCalls = async () => {
  // through readRecords, NOT JSON.parse: the non-enumerable `_stream` stamp it applies is half of
  // every text_ref, and without it the blocks fall back to the inlined path and nothing is 回源-able.
  const records = await readRecords(REAL);
  const A = assembleSession(records);
  const main = (A.lanes || []).find((l) => l.kind === 'main');
  assert.ok(main && main.calls.length >= 8, 'demo session should assemble into a main lane');
  return main.calls;
};

// One resolver for the whole file; `detail` reports status + fidelity, not just a string.
const resolver = await buildResolver(REAL);

// 回源: the block's VERBATIM bytes, sliced out of the raw NDJSON by its own locator, parsed back to
// the wire node. Fails loudly if the ref does not resolve — an unresolvable ref is a lost body.
const sourceNode = (b) => {
  assert.ok(b.text_ref, 'an addressable block MUST carry a text_ref (a bodyless, locator-less row is unreadable)');
  const got = resolver.detail(b.text_ref);
  assert.equal(got.status, 'ok', `text_ref ${b.text_ref} must resolve against the raw capture`);
  assert.equal(got.fidelity, 'verbatim', 'these bytes come from a D10 verbatim capture');
  return { text: got.text, node: JSON.parse(got.text) };
};

// The raw file, read INDEPENDENTLY of the resolver — so the locator is checked against the bytes on
// disk, not merely against the code that mints it.
const rawBodyOf = (recordId) => {
  const line = fs.readFileSync(REAL, 'utf8').split('\n').filter(Boolean)
    .map((l) => JSON.parse(l)).find((r) => r.id === recordId);
  assert.ok(line && typeof line.req_body === 'string', `record ${recordId} must carry verbatim req_body`);
  return line.req_body;
};
const spanOfRef = (ref) => {
  const m = /::(\d+)-(\d+)$/.exec(ref);
  assert.ok(m, `text_ref must carry a byte span: ${ref}`);
  return [Number(m[1]), Number(m[2])];
};

test('REAL capture: a Read-opened file previews the tool_result BYTES, not the request JSON', async () => {
  const calls = await realCalls();
  // req_00003 (index 2) is the first call whose context holds BOTH Reads with their results.
  const flat = calls[2].flat;
  const b = pick(flat, 'file::/work/src/duration.mjs');
  assert.ok(b, 'the opened file must resolve to a block in this call');
  assert.equal(b.kind, 'tool_result', 'the previewed block must be the sibling tool_result');
  assert.equal(b.resRole, 'result');
  // AC-1 round trip: resolve the locator back against the NDJSON source and read the actual bytes.
  const { text, node } = sourceNode(b);
  assert.equal(node.type, 'tool_result');
  assert.match(node.content, /^ {2}1\texport function parseDuration/,
    'the preview must be the file content that entered the context');
  // and it must NOT be the arguments the model sent
  assert.doesNotMatch(text, /"file_path"/, 'the preview must not be the tool_use request JSON');
  // the collapsed row the user sees first must agree with those bytes (it is all they see until
  // they expand), and its char count must be the resolved body's, not the request JSON's.
  assert.match(b.preview, /export function parseDuration/);
  assert.equal(b.chars, node.content.length);
  // the locator itself is honest: the span, applied to the file's own req_body, yields those bytes.
  const [s, e] = spanOfRef(b.text_ref);
  assert.equal(rawBodyOf('req_00003').slice(s, e), text, 'AC-1: slice(start,end) over the source = the block, diff 0');
});

test('REAL capture: every file resource with a sibling result resolves to that result', async () => {
  const flat = (await realCalls())[7].flat; // req_00008 — the fullest context
  for (const rk of ['file::/work/test/duration.test.mjs', 'file::/work/src/duration.mjs', 'file::/work/src/retry.mjs']) {
    const b = pick(flat, rk);
    assert.ok(b, `${rk} must resolve`);
    assert.equal(b.kind, 'tool_result', `${rk} must preview its result, not its request`);
    assert.equal(b.resRole, 'result');
    // and the bytes behind it really are a tool_result, not a re-labelled request
    const { node } = sourceNode(b);
    assert.equal(node.type, 'tool_result', `${rk} must 回源 to the result node`);
    assert.equal(node.input, undefined, `${rk} must not 回源 to tool_use arguments`);
  }
});

test('REAL capture: a tool_use whose result is NOT in this call is marked pending, never faked', async () => {
  // req_00007/8 carry Grep `toolu_5` while the only sibling result in the transcript is `toolu_6` —
  // a real orphan. The panel must be able to say "result not in this call's context yet".
  const flat = (await realCalls())[6].flat;
  const b = pick(flat, 'file::/work/src');
  assert.ok(b, 'the Grep target must still resolve to its tool_use');
  assert.equal(b.kind, 'tool_use');
  assert.equal(b.resRole, 'request');
  assert.equal(b.resPending, true, 'no sibling result in this call → the block MUST say so');
  // pending means "the bytes are not here", NOT "we could not find them": what this block does
  // address must still be the request node itself.
  assert.equal(sourceNode(b).node.type, 'tool_use');
});

test('REAL capture: results with no matching tool_use are NOT given a borrowed resKey', async () => {
  const flat = (await realCalls())[7].flat;
  // the block body is no longer on the wire, so identify the orphan by 回源 — its tool_use_id lives
  // in the source bytes the locator points at.
  const orphan = flat.find((x) => x.kind === 'tool_result' && sourceNode(x).node.tool_use_id === 'toolu_6');
  assert.ok(orphan, 'the orphan result block must exist');
  assert.equal(orphan.resKey || '', '', 'an unmatched result must not claim a resource');
});

// ── synthetic edges: error / truncation / result-arrives-next-call ─────────────────────────
// These run on linearContext() directly — the pre-slim, in-process block shape. That is deliberate:
// they pin how analyze.mjs LINKS request↔result, and the link flags (resKey/resRole/resPending/
// resError/resTruncNote) are metadata, which survives onto the wire untouched. Hand-built records
// have no `_stream` anyway, so their blocks would take the inlined path.
const req = (messages) => ({ model: 'claude-opus-4-8', system: [{ type: 'text', text: 'S' }], tools: [], messages });
const use = (id, name, input) => ({ type: 'tool_use', id, name, input });
const res = (id, content, extra = {}) => ({ type: 'tool_result', tool_use_id: id, content, ...extra });

test('an ERROR result is still the bytes that entered context — linked, and flagged as an error', () => {
  const flat = linearContext(req([
    { role: 'user', content: [{ type: 'text', text: 'read it' }] },
    { role: 'assistant', content: [use('t1', 'Read', { file_path: '/a/gone.mjs' })] },
    { role: 'user', content: [res('t1', '<tool_use_error>File does not exist.</tool_use_error>', { is_error: true })] },
  ]));
  const b = pick(flat, 'file::/a/gone.mjs');
  assert.equal(b.kind, 'tool_result');
  assert.equal(b.resError, true, 'an error result MUST be flagged, not shown as file content');
  assert.equal(b.resRole, 'result');
});

test('a HARNESS-truncated result carries the harness’s own marker verbatim', () => {
  const flat = linearContext(req([
    { role: 'user', content: [{ type: 'text', text: 'read it' }] },
    { role: 'assistant', content: [use('t1', 'Read', { file_path: '/a/big.log' })] },
    { role: 'user', content: [res('t1', 'line one\nline two\n\n[truncated to 3000 chars]')] },
  ]));
  const b = pick(flat, 'file::/a/big.log');
  assert.equal(b.kind, 'tool_result');
  assert.equal(b.resTruncNote, '[truncated to 3000 chars]',
    'the marker must be quoted from the harness, never inferred from length');
});

test('a long result with NO harness marker is not accused of being truncated', () => {
  const flat = linearContext(req([
    { role: 'user', content: [{ type: 'text', text: 'read it' }] },
    { role: 'assistant', content: [use('t1', 'Read', { file_path: '/a/big.mjs' })] },
    { role: 'user', content: [res('t1', 'x'.repeat(50000))] },
  ]));
  const b = pick(flat, 'file::/a/big.mjs');
  assert.equal(b.resTruncNote ?? null, null);
});

test('the result that arrives in the NEXT call flips pending → linked', () => {
  const issued = req([
    { role: 'user', content: [{ type: 'text', text: 'go' }] },
    { role: 'assistant', content: [use('t1', 'Read', { file_path: '/a/x.mjs' })] },
  ]);
  const answered = req([...issued.messages, { role: 'user', content: [res('t1', 'FILE BYTES')] }]);
  const a = pick(linearContext(issued), 'file::/a/x.mjs');
  assert.equal(a.kind, 'tool_use');
  assert.equal(a.resPending, true);
  const b = pick(linearContext(answered), 'file::/a/x.mjs');
  assert.equal(b.kind, 'tool_result');
  assert.equal(resultText(b), 'FILE BYTES');
  // the tool_use in the answered call is no longer pending
  const tu = linearContext(answered).find((x) => x.kind === 'tool_use');
  assert.notEqual(tu.resPending, true);
});

// ── non-regression: the fix must not steal the other resource kinds' previews ──────────────
test('a SKILL still previews its verbatim SKILL.md body, not the Skill tool_result', () => {
  const flat = linearContext(req([
    { role: 'user', content: [{ type: 'text', text: 'use it' }] },
    { role: 'assistant', content: [use('t1', 'Skill', { skill: 'brainstorming' })] },
    { role: 'user', content: [res('t1', 'Skill loaded.')] },
    { role: 'user', content: [{ type: 'text', text: 'Base directory for this skill: /s/brainstorming\nBODY' }] },
  ]));
  const b = pick(flat, 'skill::brainstorming');
  assert.equal(b.kind, 'text');
  assert.match(b.block.text, /Base directory for this skill/);
});

test('block `key`s are untouched — the cache-prefix chain must not shift', () => {
  const messages = [
    { role: 'user', content: [{ type: 'text', text: 'go' }] },
    { role: 'assistant', content: [use('t1', 'Read', { file_path: '/a/x.mjs' })] },
    { role: 'user', content: [res('t1', 'BYTES')] },
  ];
  const flat = linearContext(req(messages));
  assert.deepEqual(flat.map((b) => b.key), [
    ...linearContext(req(messages)).map((b) => b.key),
  ]);
  // the result block's key must still be derived from tool_use_id + text only
  const r = flat.find((b) => b.kind === 'tool_result');
  assert.match(r.key, /^M:user:tool_result:[0-9a-f]{8}$/);
  // …and the wire transform must not touch it either: slimming drops the BODY, never the key the
  // cache-prefix chain hashed, nor the request↔result link the resource panel selects on.
  const w = slimBlock(r, 'S/f.ndjson#req_1::0-10');
  assert.equal(w.key, r.key);
  assert.equal(w.resKey, r.resKey);
  assert.equal(w.resRole, 'result');
  assert.equal(w.block, undefined, 'the body must not cross the wire');
  assert.equal(w.text_ref, 'S/f.ndjson#req_1::0-10');
});
