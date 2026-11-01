import test from 'node:test';
import assert from 'node:assert/strict';
import { linearContext } from '../../src/view/analyze.mjs';
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
const pick = (flat, rk) =>
  flat.find((x) => x.resKey === rk && x.kind !== 'tool_use') || flat.find((x) => x.resKey === rk);

// The body of an INLINED (unaddressable) block — the synthetic cases below, which have no wire bytes.
const resultText = (b) => {
  const c = b?.block?.content;
  return typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => x.text || '').join('\n') : '';
};

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
