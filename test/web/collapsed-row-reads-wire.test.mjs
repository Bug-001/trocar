import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRecords } from '../../src/raw/ingest.mjs';
import { sessionView, forWire } from '../../src/view/board.mjs';

// THE BROWSER MUST READ WHAT THE SERVER SENDS — NOT RE-DERIVE IT FROM A BODY THAT IS GONE.
//
// Moving blocks to "metadata + text_ref" (commit 4c15271) deleted `text`, `block`, `desc`, `schema`
// and `props` from every addressable block, and slimmed `rec.request` to five counters. That was
// right — RFC 4.2:55 「表里不留全文(存 text_ref)」, and it is what lets a real session open at all.
//
// But index.html re-derives nearly everything from exactly those fields, and it was never re-pointed.
// SIX independent read paths broke at once, and only one of them (flatBytes) was noticed and fixed:
//
//   ctxBlock:1357      `const h = blockHead(b)` — the BROWSER's blockHead, which reads b.text/b.block.
//                      The server already ships the answer as `b.head`. Every collapsed row lost its
//                      label and preview: hundreds of rows reading `user` / `say` / `def`, identical,
//                      with nothing to scan. Visible without clicking anything.
//   ctxBody:1386-1394  reads b.text / b.block / b.desc / b.schema — expanding a row renders an EMPTY
//                      <pre>. The product's one job, blank.
//   ctxBlock:1366      the tools faithfulness badge still says `verbatim` while the body it would
//                      show is absent, so the row renders a green "byte-faithful" badge above
//                      「description: —」. That is worse than blank: it states as source truth that
//                      the tool HAS no description (invariant 4 — a fidelity label that lies).
//   :1353,:1624,:1637  `b.block.text` — turn grouping and "is this a human query" detection. Messages
//                      stop splitting into TURNs and the outline's query rows go empty; the D17②
//                      section tax then books the whole conversation as `task` with `history` = 0,
//                      and that number is presented as a research finding.
//   callInput:1259     `rq.system` / `rq.messages` — the detail panel's persona line and user excerpt,
//                      both permanently empty.
//
// The shape of the mistake is worth naming, because it is the same one twice: a server-side change
// removed an input the browser was silently depending on, and every guard in the suite compared the
// rendered DOM against the payload's OWN value, so nothing could see it. This file asserts the
// browser's output against the SOURCE — the only comparison that can catch a value that is merely
// absent rather than wrong.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const INDEX = path.join(ROOT, 'src', 'web', 'index.html');
const SAMPLE = path.join(ROOT, 'samples', 'demo-session.ndjson');
const SID = 'demo-0000-4a1b-9c2d-000000000001';

let loadSeq = 0;
const El = () => ({
  innerHTML: '', textContent: '', style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
  appendChild() {}, addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], scrollIntoView() {},
});

// Load index.html's module scope and expose the render functions this file exercises.
async function loadModule() {
  const store = {};
  globalThis.document = {
    getElementById(id) { return store[id] || (store[id] = El()) },
    querySelector() { return null }, querySelectorAll() { return [] },
    addEventListener() {}, body: El(), documentElement: El(), createElement() { return El() },
  };
  globalThis.window = { addEventListener() {}, removeEventListener() {}, matchMedia() { return { matches: false, addEventListener() {} } } };
  globalThis.location = { reload() {}, href: '', search: '' };
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  globalThis.setInterval = () => 0; globalThis.clearInterval = () => {};
  globalThis.setTimeout = () => 0;
  globalThis.fetch = () => new Promise(() => {});
  globalThis.requestAnimationFrame = () => 0;
  const html = fs.readFileSync(INDEX, 'utf8');
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
  const moduleJs = scripts[scripts.length - 1][1];
  const expose = '\n;globalThis.__RM__={ctxBlock, ctxBody, messageTurns, callInput};\n';
  const url = `data:text/javascript;base64,${Buffer.from(moduleJs + expose + `\n//# r-${++loadSeq}\n`).toString('base64')}`;
  await import(url);
  return globalThis.__RM__;
}

// The EXACT payload /api/session sends, then re-hydrated the way buildLanes does.
const records = await readRecords(SAMPLE, { normalize: false });
const wire = forWire(sessionView(records, SID));
const steps = wire.analyzed.steps;
const lastCall = steps[steps.length - 1];
const flat = lastCall.flat || [];

// Independent truth: the request body this call actually sent, straight off the NDJSON.
const rawBodyOf = (c) => {
  const rec = records.find((r) => String(r.id) === String(c.rec && c.rec.id));
  return rec && rec.req_body;
};
const srcOf = (c) => JSON.parse(rawBodyOf(c));

test('precondition: these blocks really are the slimmed wire shape', () => {
  assert.ok(flat.length > 0, 'sanity: the last call has blocks');
  assert.ok(flat.some((b) => b.text_ref), 'blocks must be addressable, or this file tests nothing');
  assert.ok(flat.every((b) => b.text === undefined && b.block === undefined),
    'a block on the wire carries no body — if it does, the payload fix has regressed and every '
    + 'assertion below would pass for the wrong reason');
});

test('a collapsed row shows the block\'s LABEL, not just its tag', async () => {
  const M = await loadModule();
  // A tool_use row: the argument preview is the one thing that distinguishes 25 "action · Read" rows
  // from each other. It is in the payload as head.label, computed server-side off the ONE cross-
  // provider vocabulary (invariant 3).
  const src = srcOf(lastCall);
  const toolUses = src.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .filter((b) => b.type === 'tool_use');
  assert.ok(toolUses.length > 0, 'sanity: the fixture has tool_use blocks');

  const rows = flat.map((b, i) => M.ctxBlock(b, i, null)).join('\n');
  for (const tu of toolUses) {
    const arg = String(tu.input && (tu.input.file_path || tu.input.path || tu.input.command || tu.input.pattern) || '');
    if (!arg) continue;
    assert.ok(rows.includes(arg),
      `the collapsed rows never mention "${arg}", the argument of a ${tu.name} call in this very `
      + 'request. ctxBlock re-derives its header with the BROWSER\'s blockHead(), which reads b.block '
      + '— deleted on the wire — instead of the server-computed b.head. Every action row renders as a '
      + 'bare tag, so a several-hundred-row window has nothing to scan by.');
  }

  // …as the ARGUMENT, not as the raw `Read({"file_path":…})` blob.
  //
  // This distinction is what makes b.head the single point of control, and it took a failed mutation
  // to find: reverting ctxBlock to the browser's blockHead() left this test green, because the
  // `b.preview` fallback below it supplies a string that also happens to contain the path. Both
  // render SOMETHING; only one renders the row RFC 1.4:35 specifies. head.label is the argument alone
  // — the tool's name is already in the tag ("action · Read"), so the blob spends the line repeating
  // it and pushes the part the user is scanning for off the end.
  const actionRow = flat.findIndex((b) => b.kind === 'tool_use');
  assert.ok(actionRow >= 0, 'sanity: an action block on the wire');
  const row = String(M.ctxBlock(flat[actionRow], actionRow, null));
  const want = flat[actionRow].head.label;
  assert.ok(want && row.includes(want), `the action row does not carry its head.label ("${want}")`);
  assert.ok(!/\w+\(\{&quot;|\w+\(\{"/.test(row),
    'the action row shows the raw `Name({json})` preview instead of the server-computed argument. '
    + 'The tool name is already in the tag, so the blob repeats it and buries the argument.');
});

test('a collapsed row shows the block\'s PREVIEW text', async () => {
  const M = await loadModule();
  const src = srcOf(lastCall);
  const rows = flat.map((b, i) => M.ctxBlock(b, i, null)).join('\n');
  // Take a distinctive run of words from a user message in the source and demand it is on the row.
  const userText = src.messages
    .flatMap((m) => (m.role === 'user' && Array.isArray(m.content) ? m.content : []))
    .filter((b) => b.type === 'text' && b.text && b.text.length > 20)
    .map((b) => b.text)[0];
  assert.ok(userText, 'sanity: the fixture has a user text block');
  const needle = userText.replace(/\s+/g, ' ').trim().slice(0, 24);
  assert.ok(rows.includes(needle),
    `no collapsed row previews "${needle}…". RFC 1.4:35 fixes the row as 「role · kind-tag · 短预览 · `
    + '字符数」; the server ships that preview as b.preview and the browser never reads it.');

  // A block whose head.label is EMPTY BY DESIGN is where b.preview is the only thing standing between
  // the user and an unreadable wall. head.label previews a tool's argument and a text block's text,
  // but for system / tool_result / thinking it is '' — so those rows carry nothing but a tag unless
  // the preview is read. (Found by mutation: removing the b.preview fallback left this file green,
  // because the only row it checked was a text block whose head.label already contained the text.)
  const sys = flat.find((b) => b.sec === 'system');
  assert.ok(sys && sys.head.label === '', 'precondition: a system row\'s head.label is empty by design');
  assert.ok(sys.preview, 'precondition: the server computed a preview for it');
  const sysRow = String(M.ctxBlock(sys, flat.indexOf(sys), null));
  assert.ok(sysRow.includes(sys.preview.slice(0, 24)),
    'a system row shows only its tag — no preview of the prompt text. The system stack is dozens of '
    + 'rows on a real session, and without previews they are indistinguishable from one another.');
});

test('expanding a row yields the body, or says plainly why it cannot', async () => {
  const M = await loadModule();
  const b = flat.find((x) => x.sec === 'system' && x.text_ref);
  assert.ok(b, 'sanity: an addressable system block');
  const html = String(M.ctxBody(b) || '');
  const stripped = html.replace(/<[^>]*>/g, '').trim();
  assert.notEqual(stripped, '',
    'expanding a context block renders an EMPTY body. The bytes are in the capture and the block '
    + 'carries a locator to them, so the row must either resolve them or state that it is fetching / '
    + 'that it failed. Silent blank reads as "the model saw nothing here", which is the invariant-4 '
    + 'failure this whole change was supposed to avoid.');
});

test('a tools row never claims `verbatim` while showing no description', async () => {
  const M = await loadModule();
  const t = flat.find((x) => x.sec === 'tools' && x.text_ref);
  assert.ok(t, 'sanity: an addressable tools block');
  assert.ok(t.verbatim, 'precondition: D15 capture marks this tool definition verbatim');

  const row = String(M.ctxBlock(t, 0, null) || '');
  const body = String(M.ctxBody(t) || '');
  const claimsVerbatim = /faithfulness: verbatim/.test(row);

  // Asserted on the ROW ALONE, not on "row claims verbatim AND body shows a dash". Those two fixes
  // are coupled — once ctxBody renders a pending state the dash is gone — so the conjunction went
  // green with the badge lie fully restored (found by mutation). The badge is a claim about bytes
  // that are not on this page; it must not be made at all until they are fetched.
  assert.ok(!claimsVerbatim,
    'the row wears the green "faithfulness: verbatim / byte-faithful" badge for a tool definition '
    + 'whose description and schema were NOT shipped with the page. The badge asserts that what you '
    + 'are looking at is the verbatim wire content; nothing is being shown. Say 已寻址·未取回 until '
    + 'the bytes are resolved, then badge them with the fidelity the resolver reports (invariant 4).');
  const showsNoDesc = /description:\s*(—|-)\s*/.test(body) || /description:\s*<\/|description:\s*$/.test(body);
  assert.ok(!(claimsVerbatim && showsNoDesc),
    'the row carries a green "verbatim / byte-faithful" badge above 「description: —」. The tool DOES '
    + 'have a description — it is in the capture, and this block carries a locator to it. Rendering '
    + '"not shipped on this page" as "does not exist", under a badge asserting byte-fidelity, is a '
    + 'label that lies (invariant 4). Either fetch it, or say it was not shipped — never both claim '
    + 'verbatim and show nothing.');
});

test('messages still split into TURNs — history vs task is a published number', async () => {
  const M = await loadModule();
  const turns = M.messageTurns(flat);
  assert.ok(Array.isArray(turns) && turns.length > 1,
    `messages collapsed into ${Array.isArray(turns) ? turns.length : 'no'} turn(s). Turn detection `
    + 'reads b.block.text (index.html:1624,1637), which the wire no longer carries, so every message '
    + 'lands in one card — and the D17② section tax then books the entire conversation as `task` with '
    + '`history` = 0, a number the board presents as a research finding.');
});

test('the detail panel\'s persona and user excerpt are not blank', async () => {
  const M = await loadModule();
  // callInput returns the panel's FIELDS ({persona, sysFull, user}), not markup — stringifying it
  // would compare against "[object Object]" and pass for any implementation whatsoever.
  const out = M.callInput(lastCall, 'k') || {};
  const stripped = [out.persona, out.sysFull, out.user, out.notShipped].filter(Boolean).join('\n');
  const src = srcOf(lastCall);
  const sysText = (src.system || []).map((s) => s.text || '').join(' ').replace(/\s+/g, ' ').trim();
  assert.ok(sysText, 'sanity: the fixture has a system prompt');
  const needle = sysText.slice(0, 20);
  assert.ok(stripped.includes(needle) || /not shipped|回源|fetch/i.test(stripped),
    `the detail panel shows neither the persona ("${needle}…") nor any statement that it was not `
    + 'shipped. callInput reads rq.system / rq.messages, which REQ_KEEP dropped, so the panel renders '
    + 'empty with no explanation.');
});
