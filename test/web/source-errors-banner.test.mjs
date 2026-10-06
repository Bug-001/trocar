import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// No silent failure (user requirement 2026-10-06, D38): when the server reports `source.errors` — a
// capture file it could not read in full, e.g. a damaged D35 sealed file — the board MUST say so where
// the operator looks, not render a smaller board that looks healthy. It says so in the ONE read-health
// bar (#srcbar), beside what the board did not read at all (D38 R-7a). Drives the REAL module out of
// index.html under a DOM shim (same pattern as poll-recovery.test.mjs).

const INDEX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'web', 'index.html');
function El() {
  const el = { innerHTML: '', className: '', textContent: '', checked: true, value: '', dataset: {}, style: { cssText: '', display: '' },
    querySelector() { return null }, querySelectorAll() { return [] }, insertAdjacentHTML() {}, scrollIntoView() {},
    addEventListener() {}, removeEventListener() {}, appendChild() {}, removeChild() {}, remove() {},
    getBoundingClientRect() { return { left: 0, width: 1000, top: 0, height: 100 } } };
  const c = new Set();
  el.classList = { add: (x) => c.add(x), remove: (x) => c.delete(x), toggle: (x, on) => (on ? c.add(x) : c.delete(x)), contains: (x) => c.has(x) };
  return el;
}
let seq = 0;
async function boot(projects, { control = {}, session = {}, extra = '' } = {}) {
  const store = {};
  const getEl = (id) => store[id] || (store[id] = El());
  globalThis.document = { getElementById: getEl, querySelector() { return null }, querySelectorAll() { return [] }, addEventListener() {}, body: El(), documentElement: El(), createElement() { return El() } };
  globalThis.window = { addEventListener() {}, removeEventListener() {}, matchMedia() { return { matches: false, addEventListener() {} } } };
  globalThis.location = { reload() {}, href: '', search: '' };
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  globalThis.setInterval = () => 0; globalThis.clearInterval = () => {}; globalThis.setTimeout = () => 0;
  globalThis.requestAnimationFrame = () => 0;
  globalThis.console = { ...console, error() {} };
  globalThis.fetch = (url) => Promise.resolve({ ok: true, json: () => Promise.resolve(String(url).startsWith('/api/projects') ? projects : String(url).startsWith('/api/control') ? control : String(url).startsWith('/api/session') ? session : {}) });
  const html = fs.readFileSync(INDEX, 'utf8');
  const js = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].pop()[1];
  await import(`data:text/javascript;base64,${Buffer.from(js + `\n;globalThis.__M__={poll${extra}};\n//#${++seq}`).toString('base64')}`);
  await new Promise((r) => setImmediate(r));
  return { M: globalThis.__M__, getEl };
}
const SESSION = { slug: 'P', name: 'P', path: '/p', last_ts: 'T', sessions: [{ project_slug: 'P', session_id: 'S', title: 'S', calls: 1, probes: 0, last_ts: 'T', entrypoint: 'cli' }] };

test('an unreadable capture file reported by the server is shown in a banner', async () => {
  const { M, getEl } = await boot({ projects: [SESSION], source: { skipped: [], errors: [{ file: '/h/.asight/sessions/S/calls.ndjson.0001.sealed', reason: 'index checksum mismatch', unreadableRecords: null }] } });
  await M.poll();
  const bar = getEl('srcbar');
  assert.match(bar.innerHTML, /calls\.ndjson\.0001\.sealed/);
  assert.match(bar.innerHTML, /index checksum mismatch/);
  assert.notEqual(bar.style.display, 'none');
});

test('no banner when nothing failed', async () => {
  const { M, getEl } = await boot({ projects: [SESSION], source: { skipped: [], errors: [] } });
  await M.poll();
  assert.equal(getEl('srcbar').innerHTML, '');
});

// /api/control carries its own `source.errors` (a damaged sealed file in control/, which the sharded
// session list never reads). The control view must show them too (review F15).
test('the control view shows what control/ could not read', async () => {
  const { M, getEl } = await boot({ projects: [SESSION] }, {
    control: { classes: [{ class: 'telemetry', count: 1 }], source: { errors: [{ file: '/h/.asight/sessions/control/telemetry.ndjson.0001.sealed', reason: 'frame 0 corrupt', unreadableRecords: 3 }] } },
    extra: ",pick:(v)=>{curSel=v}" });
  M.pick('__control__');
  await M.poll();
  assert.match(getEl('srcbar').innerHTML, /telemetry\.ndjson\.0001\.sealed/);
  assert.match(getEl('srcbar').innerHTML, /3 record\(s\) unreadable/);
});

// D38 R-7a cross-guard: read-cc-line's report (entries not read, with a reason; lines that would not
// parse) and the sealer's (files read but not in full) used to be two fields and two bars. They are
// one field and one bar now, and neither side's reasons may be lost in the merge.
test('one bar carries both reports: what was not read, and what was read only in part', async () => {
  const { M, getEl } = await boot({ projects: [SESSION], source: {
    skipped: [{ root: '/h', name: 'dangling.ndjson', reason: 'broken-symlink', attention: true }, { root: '/h', name: 'ca.pem', reason: 'not-ndjson', attention: false }],
    corrupt_lines: { '/h/claude-capture.ndjson': 2 }, resets: [], tail_pending: {}, unidentified_lines: 0,
    errors: [{ file: '/h/old-capture.sealed', reason: 'a sealed file without a segment number — not read', unreadableRecords: null },
      { file: '/h/c.ndjson.0001.sealed', kind: 'coexist-mismatch', reason: 'records differ' }],
  } });
  await M.poll();
  const bar = getEl('srcbar');
  for (const s of ['2 capture file(s) could not be read as-is', '<b>old-capture.sealed</b>', 'original and sealed copy differ',
    '1 capture file not read: <b>dangling.ndjson</b> (broken-symlink)', '2 unparseable line(s) in <b>claude-capture.ndjson</b> ×2', '1 other entry not read']) assert.ok(bar.innerHTML.includes(s), `${s} in ${bar.innerHTML}`);
  assert.match(bar.title, /\/h\/ca\.pem — not-ndjson/);
  assert.match(bar.title, /\/h\/old-capture\.sealed — a sealed file without a segment number/);
  assert.match(bar.style.cssText, /#7a2b18/, 'a file read only in part is red, not the amber "not everything is shown"');
  const html = fs.readFileSync(INDEX, 'utf8');
  assert.doesNotMatch(html, /srcerrbar/, 'a second read-health bar is back');
  assert.doesNotMatch(html, /\.source_errors\b/, 'the board reads a second read-health field again');
});

// The session view's own errors (a damaged frame in this session's sealed file — the session list
// cannot see it) stay on screen when a poll skips the unchanged session's fetch.
test('a session\'s own read errors stay in the bar across a poll that skips its fetch', async () => {
  const { M, getEl } = await boot({ projects: [SESSION], source: { skipped: [], errors: [] } }, {
    session: { source: { errors: [{ file: '/h/.asight/sessions/S/calls.ndjson.0002.sealed', reason: 'frame 4 corrupt', unreadableRecords: 7 }] } } });
  await M.poll();
  assert.match(getEl('srcbar').innerHTML, /calls\.ndjson\.0002\.sealed<\/b> — 7 record\(s\) unreadable/);
  await M.poll();   // same calls / last_ts / window: the session is not fetched again
  assert.match(getEl('srcbar').innerHTML, /calls\.ndjson\.0002\.sealed<\/b> — 7 record\(s\) unreadable/, 'the session\'s errors were dropped');
});

// review finding 3: session → control view → the same session, unchanged. The cheap short-circuit
// skipped the session's fetch on the way back, so its own errors (and its timeline) were not shown.
test('a session\'s own read errors are back after a visit to the control view', async () => {
  const { M, getEl } = await boot({ projects: [SESSION], source: { skipped: [], errors: [] } }, {
    session: { source: { errors: [{ file: '/h/.asight/sessions/S/calls.ndjson.0002.sealed', reason: 'frame 4 corrupt', unreadableRecords: 7 }] } },
    control: { classes: [{ class: 'telemetry', count: 1 }], source: { errors: [{ file: '/h/.asight/sessions/control/telemetry.ndjson.0001.sealed', reason: 'frame 0 corrupt', unreadableRecords: 3 }] } },
    extra: ",pick:(v)=>{curSel=v}" });
  await M.poll();
  assert.match(getEl('srcbar').innerHTML, /calls\.ndjson\.0002\.sealed/);
  M.pick('__control__');
  await M.poll();
  assert.match(getEl('srcbar').innerHTML, /telemetry\.ndjson\.0001\.sealed/);
  assert.doesNotMatch(getEl('srcbar').innerHTML, /calls\.ndjson\.0002\.sealed/, 'the control view shows the session\'s errors');
  M.pick('P::S');
  await M.poll();
  assert.match(getEl('srcbar').innerHTML, /calls\.ndjson\.0002\.sealed<\/b> — 7 record\(s\) unreadable/, 'the session\'s errors were dropped on the way back');
});
