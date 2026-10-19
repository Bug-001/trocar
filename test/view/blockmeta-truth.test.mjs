import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRecords } from '../../src/raw/ingest.mjs';
import { sessionView } from '../../src/view/board.mjs';

// THE NUMBERS ON THE COLLAPSED ROW MUST BE THE SOURCE'S NUMBERS.
//
// Since a block ships as metadata + a text_ref, four scalars ARE the row: `bytes`, `chars`, `head`
// and `preview`. Everything the board draws is denominated in them — the composition bar, the
// timeline bars, the section tax, the growth Δ — and blockmeta.mjs's own header states the contract:
// 「Ported verbatim from the browser's flatBytes(); the numbers must not move, or every historical
// reading of a session silently changes meaning.」
//
// WHY THIS FILE EXISTS (2026-07-20, found by an adversarial audit of the test rewrite itself).
// Nothing tested that. Three mutations, each run against the whole suite:
//   • `blockBytes(b) → 1` for every block: 497 of 498 assertions still passed. The one that noticed
//     was an exact byte formula over a single hand-built tools block in assemble-d10 — no real
//     capture, no bar, no bucket.
//   • `blockHead(b) → {role:'user',tag:'user',label:''}` for every block, tools and thinking and
//     tool_result alike: 78/78 green across the thirteen rewritten files.
//   • `preview → blockPreview(b).slice(0,3)`: 77/78 green.
// The reason is a pattern worth naming, because it looks like coverage and is not: the checks that
// existed compared the RENDERED DOM against the payload's OWN value — `html.includes('>'+b.head.role
// +'<')`. That detects a head that went missing. It cannot detect a head that is wrong, because both
// sides of the comparison move together. A test whose expected value comes from the thing under test
// is not a test.
//
// This regressed BECAUSE of a fix, which is the part worth remembering. When index.html::flatBytes()
// was changed to prefer the server's pre-computed `b.bytes` (correct — the body it used to re-read is
// no longer sent), the composition bar's input moved from "computed by the code under test" to "a
// scalar handed over and never checked", and the bucket assertions stayed at `c[k] > 0`, which any
// non-zero constant satisfies. Reach was lost silently, with no assertion deleted.
//
// So the expectations here are derived INDEPENDENTLY, from the raw NDJSON `req_body` — the one source
// of truth (invariant 2) — and never from the shipped block. The derivation below is deliberately
// written from what the model actually received, not by copying blockmeta.mjs's branch structure; if
// it were a transcription of the implementation it would agree with the implementation's bugs.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const SAMPLE = path.join(ROOT, 'samples', 'demo-session.ndjson');
const SID = 'demo-0000-4a1b-9c2d-000000000001';

const utf8 = (s) => Buffer.byteLength(String(s ?? ''), 'utf8');

// The blocks the model was sent, in the order RFC 1.4:35 fixes: tools → system → messages. Built by
// reading the request body itself, so this doubles as the assembly-order check (which the render gate
// does not make — RFC 1.4 §验收, and a finding of the 2026-07-20 audit in its own right).
function sourceBlocks(reqBody) {
  const rq = JSON.parse(reqBody);
  return [
    ...(rq.tools || []).map((t) => ({ sec: 'tools', src: t })),
    ...(rq.system || []).map((s) => ({ sec: 'system', src: s })),
    ...(rq.messages || []).flatMap((m) => {
      const content = Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content }];
      return content.map((c) => ({ sec: 'messages', role: m.role, src: c }));
    }),
  ];
}

// What the block WEIGHS in the context, from the source. A tool definition costs its name, its prose
// description and its schema; a text block costs its text; a tool call costs its name and arguments;
// an observation costs whatever came back.
function expectedBytes({ sec, src }) {
  if (sec === 'tools') return utf8(src.name) + utf8(src.description ?? '') + (src.input_schema !== undefined ? utf8(JSON.stringify(src.input_schema)) : 0);
  if (sec === 'system') return utf8(src.text);
  if (src.type === 'text') return utf8(src.text);
  if (src.type === 'thinking') return utf8(src.thinking || '');
  if (src.type === 'redacted_thinking') return utf8(src.thinking || '');
  if (src.type === 'tool_use' || src.type === 'server_tool_use') return utf8(src.name) + utf8(JSON.stringify(src.input || {}));
  if (src.type === 'tool_result') { const c = src.content; return utf8(typeof c === 'string' ? c : JSON.stringify(c ?? '')); }
  if (src.type === 'image') return 800;
  return utf8(JSON.stringify(src));
}

// What the row's body READS as — the string a user would see on expanding it. `chars` counts this,
// not the wire bytes, which is why an escaped-JSON span is longer than its decoded content.
function expectedText({ sec, src }) {
  if (sec === 'tools') return (src.description || '') + (src.input_schema !== undefined ? JSON.stringify(src.input_schema) : '');
  if (sec === 'system') return src.text || '';
  if (src.type === 'text') return src.text || '';
  if (src.type === 'thinking') return src.thinking || '';
  if (src.type === 'redacted_thinking') return '[redacted_thinking]';
  if (src.type === 'tool_use' || src.type === 'server_tool_use') return `${src.name}(${JSON.stringify(src.input ?? {})})`;
  if (src.type === 'tool_result') {
    const c = src.content;
    return typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => x.text || `[${x.type}]`).join('\n') : JSON.stringify(c ?? '');
  }
  return JSON.stringify(src);
}

// Who is speaking, and what kind of turn it is — the two strings the collapsed row leads with.
function expectedRoleTag({ sec, role, src }) {
  if (sec === 'tools') return { role: 'tool', tag: 'def' };
  if (sec === 'system') return { role: 'system', tag: null };   // tag is the server's section label
  if (src.type === 'thinking' || src.type === 'redacted_thinking') return { role: 'assistant', tag: 'thinking' };
  if (src.type === 'tool_use' || src.type === 'server_tool_use') return { role: 'assistant', tag: `action · ${src.name}` };
  if (src.type === 'tool_result') return { role, tag: 'observation' };
  if (src.type === 'image') return { role, tag: 'image' };
  if (src.type === 'document') return { role, tag: 'document' };
  return { role, tag: role === 'user' ? 'user' : role === 'assistant' ? 'say' : role === 'system' ? 'system-reminder' : 'text' };
}

const records = await readRecords(SAMPLE, { normalize: false });
const view = sessionView(records, SID);
const steps = view.analyzed.steps || [];

// Pair every shipped block with the source block it claims to describe. Zipping by POSITION is the
// point: it only works if the assembly order is right, so a reordering shows up as a wall of value
// mismatches rather than passing silently.
function pairs() {
  const out = [];
  for (const c of steps) {
    const body = c.rec && c.rec.req_body;
    const raw = typeof body === 'string' ? body : (records.find((r) => String(r.id) === String(c.rec && c.rec.id)) || {}).req_body;
    if (typeof raw !== 'string') continue;
    const src = sourceBlocks(raw);
    const got = c.flat || [];
    out.push({ gi: c.gi, src, got });
  }
  return out;
}

test('the source really does exercise every block kind this pins', () => {
  const all = pairs();
  assert.ok(all.length >= 4, `only ${all.length} calls had a readable req_body — this fixture cannot carry the file`);
  const kinds = new Set(all.flatMap((p) => p.got.map((b) => `${b.sec}/${b.kind || '-'}`)));
  for (const k of ['tools/tool', 'system/system', 'messages/text', 'messages/tool_use', 'messages/tool_result']) {
    assert.ok(kinds.has(k), `no ${k} block in the fixture — a constant-value mutation could hide there`);
  }
});

test('assembly order is tools → system → messages, positionally', () => {
  // RFC 1.4:35: 窗口严格按 call_blocks.seq 铺:tools → system → messages. Asserted nowhere else
  // (2026-07-20 audit). Positional zipping below depends on it, so it is checked first and directly.
  for (const { gi, src, got } of pairs()) {
    assert.equal(got.length, src.length,
      `call #${gi}: ${got.length} blocks shipped for ${src.length} in the source request`);
    assert.deepEqual(got.map((b) => b.sec), src.map((s) => s.sec),
      `call #${gi}: the section order on the wire is not the order the model was sent`);
  }
});

test('`bytes` is the block\'s real weight in the source, block by block', () => {
  // The unit the composition bar, the timeline bars, the section tax and the growth Δ are ALL
  // denominated in. A constant here repaints every visual in the product and, before this test,
  // cost the suite one assertion.
  let checked = 0;
  for (const { gi, src, got } of pairs()) {
    got.forEach((b, i) => {
      const want = expectedBytes(src[i]);
      assert.equal(b.bytes, want,
        `call #${gi} block ${i} (${b.sec}/${b.kind}): shipped bytes=${b.bytes}, source says ${want}. `
        + 'Every bar in the product is drawn from this number.');
      checked++;
    });
  }
  assert.ok(checked > 100, `only ${checked} blocks weighed — too few to call this coverage`);
});

test('`chars` and `preview` are the source\'s text, not the payload\'s own echo', () => {
  let checked = 0;
  for (const { gi, src, got } of pairs()) {
    got.forEach((b, i) => {
      const text = expectedText(src[i]);
      assert.equal(b.chars, text.length,
        `call #${gi} block ${i} (${b.sec}/${b.kind}): chars=${b.chars}, source text is ${text.length} long`);
      // The preview is a whitespace-collapsed, trimmed, 90-char cut of that same text. Recomputed
      // from the SOURCE — comparing it to b.preview's own prefix (the pattern this file exists to
      // replace) is satisfied by any truncation, including to three characters.
      const want = text.replace(/\s+/g, ' ').trim().slice(0, 90);
      assert.equal(b.preview, want,
        `call #${gi} block ${i} (${b.sec}/${b.kind}): preview is not the first 90 chars of the source text`);
      checked++;
    });
  }
  assert.ok(checked > 100, `only ${checked} previews checked`);
});

test('`head.role` and `head.tag` say what the source says', () => {
  // RFC 1.4:35 「头显 role · kind-tag · 短预览 · 字符数」. A wrong head is worse than a missing one:
  // the row still renders, and it attributes the wrong speaker or the wrong kind of turn to content
  // the user is reading as source truth.
  let checked = 0;
  for (const { gi, src, got } of pairs()) {
    got.forEach((b, i) => {
      const want = expectedRoleTag(src[i]);
      assert.equal(b.head.role, want.role,
        `call #${gi} block ${i} (${b.sec}/${b.kind}): head.role="${b.head.role}", source says "${want.role}"`);
      if (want.tag !== null) {
        assert.equal(b.head.tag, want.tag,
          `call #${gi} block ${i}: head.tag="${b.head.tag}", source says "${want.tag}"`);
      }
      checked++;
    });
  }
  assert.ok(checked > 100, `only ${checked} heads checked`);
});

test('`head.label` previews the tool ARGUMENT on an action row', () => {
  // The one field a user scans to see what a step actually did — "Read /work/test/duration.test.mjs"
  // rather than 25 identical "action · Read" rows. Unpinned before this file.
  let checked = 0;
  for (const { gi, src, got } of pairs()) {
    got.forEach((b, i) => {
      const s = src[i];
      if (s.sec !== 'messages' || (s.src.type !== 'tool_use' && s.src.type !== 'server_tool_use')) return;
      const inp = s.src.input || {};
      const want = String(inp.file_path || inp.path || inp.notebook_path || inp.command || inp.pattern
        || inp.url || inp.query || inp.description || inp.subagent_type
        || (inp.skill ? 'skill: ' + inp.skill : '') || '').replace(/\s+/g, ' ').trim().slice(0, 90);
      assert.equal(b.head.label, want,
        `call #${gi} block ${i}: action row shows "${b.head.label}", the call's argument is "${want}"`);
      checked++;
    });
  }
  assert.ok(checked > 10, `only ${checked} action rows checked`);
});
