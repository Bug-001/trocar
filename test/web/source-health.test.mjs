// test/web/source-health.test.mjs — the board SAYS what it did not read (4.4:83 · invariant 4 · the
// user's 2026-10-06 requirement that becomes D38). Drives the REAL module out of src/web/index.html
// under a DOM shim (as poll-recovery.test.mjs does) with a scripted /api/projects `source`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const INDEX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'web', 'index.html');

function El() {
  const el = {
    innerHTML: '', className: '', textContent: '', title: '', checked: true, value: '', dataset: {}, style: {},
    querySelector() { return null }, querySelectorAll() { return [] }, insertAdjacentHTML() {}, scrollIntoView() {},
    addEventListener() {}, removeEventListener() {}, appendChild() {}, removeChild() {}, remove() {},
    getBoundingClientRect() { return { left: 0, width: 1000, top: 0, height: 100 } },
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false } },
  };
  return el;
}
let seq = 0;
async function boardWith(source, projects = [], reply = null) {
  const store = {};
  const getEl = (id) => store[id] || (store[id] = El());
  globalThis.document = { getElementById: getEl, querySelector() { return null }, querySelectorAll() { return [] }, addEventListener() {}, body: El(), documentElement: El(), createElement() { return El() } };
  globalThis.window = { addEventListener() {}, removeEventListener() {}, matchMedia() { return { matches: false, addEventListener() {} } } };
  globalThis.location = { reload() {}, href: '', search: '' };
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  globalThis.setInterval = () => 0; globalThis.clearInterval = () => {}; globalThis.setTimeout = () => 0;
  globalThis.requestAnimationFrame = () => 0;
  globalThis.console = { ...console, error() {} };
  globalThis.fetch = (url) => Promise.resolve(String(url).startsWith('/api/projects') && reply ? reply
    : { ok: true, json: () => Promise.resolve(String(url).startsWith('/api/projects') ? { projects, source } : {}) });
  const html = fs.readFileSync(INDEX, 'utf8');
  const js = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].at(-1)[1];
  await import(`data:text/javascript;base64,${Buffer.from(js + `\n;globalThis.__H__={poll};\n//# health-${++seq}\n`).toString('base64')}`);
  await new Promise((r) => setImmediate(r));
  await globalThis.__H__.poll();
  return Object.assign(getEl('srcbar'), { empty: getEl('ctxwin').innerHTML });
}

test('an empty board over a source with a dangling link and torn lines says so, next to "no sessions"', async () => {
  const bar = await boardWith({
    skipped: [
      { root: '/h', name: 'dangling.ndjson', reason: 'broken-symlink', attention: true },
      { root: '/h', name: 'old.ndjson.gz', reason: 'compressed', attention: true },
      { root: '/h', name: 'config.json', reason: 'not-ndjson', attention: false },
    ],
    corrupt_lines: { '/h/claude-capture.ndjson': 2 }, resets: [], unidentified_lines: 0, tail_pending: { '/h/c/capture-2026-10-06.ndjson': 40 },
  });
  for (const s of ['2 capture files not read', '<b>dangling.ndjson</b> (broken-symlink)', '<b>old.ndjson.gz</b> (compressed)',
    '2 unparseable line(s) in <b>claude-capture.ndjson</b> ×2', '1 other entry not read (files that are not *.ndjson, subdirectories',
    '1 file(s) end in an incomplete line (a write in progress, or a writer that stopped mid-line): <b>capture-2026-10-06.ndjson</b>']) assert.ok(bar.innerHTML.includes(s), `${s} in ${bar.innerHTML}`);
  assert.match(bar.title, /\/h\/config\.json — not-ndjson/);
  assert.match(bar.empty, /No sessions captured yet/, 'the empty state still renders beside the bar');
  assert.notEqual(bar.style.cssText || '', '');
});

test('a source whose only unread entries are not capture files raises no bar', async () => {
  const bar = await boardWith({ skipped: [{ root: '/h', name: 'config.json', reason: 'not-ndjson', attention: false }], corrupt_lines: {}, resets: [], unidentified_lines: 0 });
  assert.equal(bar.innerHTML, '');
  assert.equal(bar.style.display, 'none');
});

test('a listing the server failed (500 {error}) is shown as a failure, never as "No sessions captured yet"', async () => {
  const bar = await boardWith(null, [], { ok: false, status: 500, json: () => Promise.resolve({ error: 'capture source unreadable (/h): EACCES' }) });
  assert.match(bar.innerHTML, /could not list the sessions: <b>capture source unreadable \(\/h\): EACCES<\/b>/);
  assert.match(bar.empty, /Could not list the sessions/);
  assert.doesNotMatch(bar.empty, /No sessions captured yet/);
});
