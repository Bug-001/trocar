// Compare-page render gate (D17③). Drives the REAL reused compare page (src/web/compare.html) under a
// headless DOM shim, feeding it the FROZEN server canonical (what /api/compare + /api/projects emit) via
// a fetch stub — the page does ZERO provider parsing (invariant 3). Asserts every panel populates and the
// stepwise structural-diff strip renders identical vs divergent steps + the first-divergence marker.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRecords } from '../../src/etl/ingest.mjs';
import { projectsView } from '../../src/view/board.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const PAGE = path.join(ROOT, 'src', 'web', 'compare.html');
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'cc-session-real.ndjson');

// select stub parses value="…" out of its assigned innerHTML so boot()'s option-scan works headlessly.
function El(tag) {
  let _html = '';
  return {
    tag, className: '', textContent: '', _value: '',
    set innerHTML(v) { _html = String(v); }, get innerHTML() { return _html; },
    set value(v) { this._value = v; }, get value() { return this._value; },
    querySelectorAll(sel) {
      if (sel === 'option') return [..._html.matchAll(/value="([^"]*)"/g)].map((m) => ({ value: m[1].replace(/&amp;/g, '&') }));
      return [];
    },
    querySelector() { return null; }, addEventListener() {}, appendChild() {},
    set onchange(v) {}, set onclick(v) {},
  };
}
function installShim() {
  const store = {};
  globalThis.document = {
    getElementById(id) { return store[id] || (store[id] = El('el:' + id)); },
    querySelector() { return null; }, querySelectorAll() { return []; },
    addEventListener() {}, body: El('body'), documentElement: El('html'), createElement: (t) => El(t),
  };
  globalThis.window = { addEventListener() {} };
  globalThis.location = { href: '', reload() {} };
  return store;
}

// a crafted compare canonical exercising BOTH identical + divergent steps + a length tail + resource diff
function fixtureCompare() {
  const stats = (calls, peak) => ({ calls, streams: 2, subagents: 1, monitors: 0, compactions: 1, totalIn: 32000, totalOut: 31000, peakCtx: peak });
  return {
    a: { meta: { session_id: 'aaaa1111' }, stats: stats(4, 54000), steps: [{ ctx: 10, compaction: false }, { ctx: 20, compaction: false }, { ctx: 30, compaction: false }, { ctx: 40, compaction: true }] },
    b: { meta: { session_id: 'bbbb2222' }, stats: stats(3, 41000), steps: [{ ctx: 10, compaction: false }, { ctx: 20, compaction: false }, { ctx: 33, compaction: false }] },
    align: {
      compared: 3, firstDiverge: 2, sharedPrefix: 2, aExtra: 1, bExtra: 0,
      per: [
        { i: 0, identical: true, added: 0, removed: 0, aBlocks: 5, bBlocks: 5 },
        { i: 1, identical: true, added: 0, removed: 0, aBlocks: 6, bBlocks: 6 },
        { i: 2, identical: false, added: 2, removed: 1, aBlocks: 7, bBlocks: 8 },
      ],
    },
    resources: {
      both: [{ kind: 'file', label: '/x/shared.py' }],
      aonly: [{ kind: 'file', label: '/x/only_a.py' }, { kind: 'scaffold', label: 'CLAUDE.md' }],
      bonly: [{ kind: 'dir', label: '/x/dir_b' }],
    },
  };
}

function buildGateModule(projectsJson, compareJson) {
  const html = fs.readFileSync(PAGE, 'utf8');
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
  const moduleJs = scripts[scripts.length - 1][1];
  const harness = `
;globalThis.fetch = (u) => {
  if (/\\/api\\/projects/.test(u)) return Promise.resolve({ ok:true, json: async()=>globalThis.__CMP_PROJECTS__ });
  if (/\\/api\\/compare/.test(u)) return Promise.resolve({ ok:true, status:200, json: async()=>globalThis.__CMP_PAYLOAD__ });
  return Promise.resolve({ ok:false, status:404, json: async()=>({}) });
};
`;
  // boot() runs on import (async). We await a microtask flush in the test after import.
  return `globalThis.__CMP_PROJECTS__ = ${projectsJson};\nglobalThis.__CMP_PAYLOAD__ = ${compareJson};\n${harness}\n${moduleJs}`;
}

test('compare render gate: panels + stepwise structural diff render from frozen canonical', async () => {
  const store = installShim();
  const records = await readRecords(FIXTURE, { normalize: false });
  const projects = projectsView(records, { enrich: null });

  const combined = buildGateModule(JSON.stringify(projects), JSON.stringify(fixtureCompare()));
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'asight-cmpgate-')), 'gate.mjs');
  fs.writeFileSync(tmp, combined);
  await import('file://' + tmp);
  // let boot()'s awaited fetches + render() settle
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 20));

  const out = store['out'].innerHTML;
  const fails = [];
  // stats table with A / B / B−A delta
  if (!/class="stats"/.test(out)) fails.push('stats table missing');
  if (!/B−A/.test(out)) fails.push('B−A delta column missing');
  // D17③ stepwise structural diff
  if (!/stepwise structural diff/i.test(out)) fails.push('align section header missing');
  if (!/first diverged at step #3/.test(out)) fails.push('first-divergence headline wrong/missing (expected step #3)');
  if ((out.match(/stepcell same/g) || []).length !== 2) fails.push('expected 2 identical (same) step cells');
  if ((out.match(/stepcell diff/g) || []).length !== 1) fails.push('expected 1 divergent (diff) step cell');
  if (!/stepcell diff first/.test(out)) fails.push('first-divergence cell not outlined (.first)');
  if ((out.match(/x xa/g) || []).length !== 1) fails.push('A-only length tail (aExtra=1) not rendered');
  // never re-calls the model — the offline determinism claim is on the page
  if (!/never re-calls the model/.test(out)) fails.push('determinism/offline note missing');
  // context-growth saws for both runs
  if ((out.match(/class="sawbox"/g) || []).length !== 2) fails.push('expected 2 growth-curve saw boxes');
  if (!/class="bar compact"/.test(out)) fails.push('compaction ✂ bar marker missing');
  // resource set-diff: both / A-only / B-only with counts
  if (!/loaded in both \(1\)/.test(out)) fails.push('resource "both" column/count wrong');
  if (!/A only \(2\)/.test(out)) fails.push('resource "A only" column/count wrong');
  if (!/B only \(1\)/.test(out)) fails.push('resource "B only" column/count wrong');
  // dropdowns were populated from /api/projects (session ids as option values)
  if (store['selA'].querySelectorAll('option').length < 1) fails.push('run-A picker not populated from /api/projects');

  assert.deepEqual(fails, [], 'compare gate failures:\n  - ' + fails.join('\n  - '));
});
