import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from '../../src/server.mjs';

// THE BOARD, IN AN ACTUAL BROWSER.
//
// Every other test of the frontend in this repo loads index.html's module scope into Node with a
// hand-stubbed `document`, then calls render functions directly. That catches a lot, and it is blind
// to exactly the failures that matter most: a JS error at boot, a selector that matches nothing, a
// fetch that is never issued, a click handler that is not wired to the element the user clicks.
//
// 2026-07-20 — the whole 「元数据 + text_ref」 change and its six-read-path repair were verified that
// way and ONLY that way. An adversarial audit of the work said so in as many words: 「所有证据都是
// 『读代码 + 在 Node 里重放函数』,没有一条是真在浏览器里点出来的」 — and then disagreed with itself
// about whether expanding a row threw a TypeError or merely rendered blank, because neither side had
// opened a browser. Two agents reasoning about JS semantics is not evidence.
//
// So this drives the real server with a real Chromium: load the board, read the rows, click one open,
// and assert the bytes arrive.
//
// Playwright is deliberately NOT a package.json dependency — a ~150 MB chromium download is not
// something to impose on every checkout of a personal research instrument. It is resolved from the
// repo if present, else from ASIGHT_PLAYWRIGHT (a path to a node_modules holding it):
//     mkdir -p /tmp/pw && (cd /tmp/pw && npm i playwright && npx playwright install chromium)
//     ASIGHT_PLAYWRIGHT=/tmp/pw/node_modules npm test
//
// A SKIPPED TEST IS NOT A PASSING TEST. If this file skips everywhere it is decoration, which is the
// precise failure this suite has been cleaning up all day — so the skip reason names what to do, and
// the last test in the file fails loudly if the harness is present but resolved nothing.
// NODE_PATH does NOT work here: ESM resolution ignores it. That is why the env var is a path that
// gets turned into a file: URL below.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const SAMPLE = path.join(ROOT, 'samples', 'demo-session.ndjson');

// playwright ships CommonJS, so importing it by FILE URL yields the module on `.default` rather than
// as named exports — `m.chromium` is undefined and the whole file would silently skip forever, which
// is worse than not having the test. Accept either shape.
const chromiumOf = (m) => (m && (m.chromium || (m.default && m.default.chromium))) || null;
async function loadPlaywright() {
  try { const m = await import('playwright'); if (chromiumOf(m)) return chromiumOf(m); } catch { /* not in the repo */ }
  const ext = process.env.ASIGHT_PLAYWRIGHT;
  if (!ext) return null;
  try { return chromiumOf(await import(pathToFileURL(path.join(ext, 'playwright', 'index.js')).href)); }
  catch { return null; }
}
const chromium = await loadPlaywright();
const SKIP = !chromium
  && 'playwright unavailable — set ASIGHT_PLAYWRIGHT=<path to node_modules with playwright> (see header)';

let srv, port, browser, page;
const pageErrors = [], apiRequests = [];

test.before(async () => {
  if (!chromium) return;
  const made = await createServer({ dbPath: '/nonexistent-db-xyz', sourcePath: SAMPLE });
  srv = made.server; srv.listen(0, '127.0.0.1'); await once(srv, 'listening'); port = srv.address().port;
  browser = await chromium.launch();
  page = await browser.newPage();
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  page.on('request', (r) => { if (r.url().includes('/api/')) apiRequests.push(r.url()); });
  // NOT 'networkidle': the board polls on an interval, so the network is never idle and the wait
  // times out after 30s on a perfectly healthy page.
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
});
test.after(async () => { await browser?.close(); srv?.close(); });

test('the board boots with no JavaScript errors', { skip: SKIP }, () => {
  assert.deepEqual(pageErrors, [],
    'an uncaught error at boot stops the render wherever it happened, and the board falls through to '
    + 'a blank or half-drawn page with nothing in the UI to say why');
});

test('it requests a WINDOW, and renders the session rather than its empty state', { skip: SKIP }, async () => {
  assert.ok(apiRequests.some((u) => /\/api\/session\?.*cursor=\d+.*limit=\d+/.test(u)),
    `no windowed /api/session request was made. Seen: ${JSON.stringify(apiRequests)}`);
  assert.equal(await page.locator('text=/No sessions captured yet/i').count(), 0,
    'the board shows its empty state for a session it was just served');
});

test('context rows carry a readable preview, not just a bare tag', { skip: SKIP }, async () => {
  // The regression this file was written for: with the browser re-deriving headers from a body that
  // is no longer sent, every row rendered as `user` / `say` / `def` and nothing else.
  const rows = page.locator('#ctxwin .cblk');
  const n = await rows.count();
  assert.ok(n > 10, `only ${n} context rows rendered`);

  const texts = [];
  for (let i = 0; i < Math.min(n, 12); i++) texts.push((await rows.nth(i).innerText()).replace(/\s+/g, ' ').trim());

  // A system row must show the prompt text, and an action row must show its argument.
  assert.ok(texts.some((t) => /You are a coding assistant/.test(t)),
    `no row previews the system prompt. Rows: ${JSON.stringify(texts.slice(0, 6))}`);
  assert.ok(texts.some((t) => /action ·/.test(t) && /\/work\//.test(t)),
    `no action row shows the file it acted on. Rows: ${JSON.stringify(texts.slice(0, 12))}`);
});

test('expanding a row FETCHES its bytes and shows them, badged verbatim', { skip: SKIP }, async () => {
  // 看全文 = 回源 (RFC 4.2:55 / 1.4:35), end to end, through a real click.
  const rows = page.locator('#ctxwin .cblk');
  const n = await rows.count();
  const target = rows.nth(n - 2);
  const before = apiRequests.length;
  await target.click();
  await page.waitForTimeout(1500);

  const fetched = apiRequests.slice(before).filter((u) => u.includes('/api/block?ref='));
  assert.ok(fetched.length > 0,
    'clicking a row issued no /api/block request — the body is not on the wire, so without the fetch '
    + 'the row can only render empty');

  const shown = (await target.innerText()).replace(/\s+/g, ' ');
  assert.match(shown, /逐字回源|verbatim from capture/,
    'the resolved body carries no fidelity badge — bytes sliced verbatim from the capture and bytes '
    + 'that were re-serialized must not render identically (invariant 4)');
  assert.ok(/\{|\}/.test(shown.replace(/^[^{]*/, '')),
    `the expanded row shows no body content: ${shown.slice(0, 200)}`);
});

test('the composition bar is multi-colour, not one solid block', { skip: SKIP }, async () => {
  // The flatBytes regression, seen the way a user sees it: when block weights all read 0 the bar
  // collapses to a single colour.
  //
  // SCOPED TO THE BARS, and this scoping is the whole assertion. A document-wide `[class*="ct-"]`
  // also matches the legend, which paints one swatch per kind unconditionally — so under the real
  // regression (every non-tools block weighing 0) the page still contained seven distinct ct- classes
  // and this test passed. Found by mutation, not by reading. Inside `.bar`, a kind appears once per
  // call that actually contains it, so the legend cannot supply it.
  const byKind = await page.evaluate(() => [...document.querySelectorAll('.bar [class*="ct-"]')]
    .reduce((m, e) => { const k = (String(e.className).match(/ct-[a-z_]+/) || [''])[0]; m[k] = (m[k] || 0) + 1; return m; }, {}));
  const lit = Object.keys(byKind).filter((k) => k && k !== 'ct-unloaded');
  assert.ok(lit.length >= 5,
    `the composition bars painted only ${lit.length} kinds of segment (${JSON.stringify(byKind)}). `
    + 'When every block weighs 0 the bar renders as one flat colour — the "one solid colour" bug '
    + 'reported against real captures. Only tool NAMES survive a body-less block, so tools stays lit '
    + 'while every other bucket goes to zero: seeing ct-tools alone here is that exact failure.');
});
