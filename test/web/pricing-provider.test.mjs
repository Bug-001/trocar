import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// BUG 3 · cross-provider pricing was never built — gpt-5.5 was silently
// priced at ANTHROPIC rates.
//
// `PRICING` holds Anthropic $/Mtok under the family keys opus/sonnet/haiku, and `priceKey()`
// matched them as MODEL-NAME SUBSTRINGS with **haiku as the fallback**:
//     const priceKey=m=>/opus/.test(m)?'opus':/sonnet/.test(m)?'sonnet':'haiku'
// so EVERY OpenAI / DeepSeek / OpenCode model fell through to haiku and got a confident dollar
// figure with an "≈ 本地估价" badge on it. A wrong number rendered without qualification is worse
// than no number (不变式4) — and spec 2.2:42/44 already REQUIRE the table to be a
// `price[provider, model, role]` space ("单价表按 (provider, model) 扩展"), so this is
// implementing existing spec, not changing it.
//
// Property pinned here: no price row ⇒ NO number. D14 editable pricing must keep working.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX = path.join(HERE, '..', '..', 'src', 'web', 'index.html');

function El() {
  const el = {
    innerHTML: '', className: '', textContent: '', checked: true, value: '', dataset: {},
    style: new Proxy({}, { get: () => '', set: () => true }), _cls: new Set(),
    querySelector() { return null }, querySelectorAll() { return [] },
    insertAdjacentHTML() {}, scrollIntoView() {}, addEventListener() {}, removeEventListener() {},
    appendChild() {}, removeChild() {}, remove() {},
    getBoundingClientRect() { return { left: 0, width: 1000, top: 0, height: 100 } },
    set onclick(v) {}, set onmouseenter(v) {}, set onmouseleave(v) {}, set onmousemove(v) {},
    set onchange(v) {}, set oninput(v) {}, set onkeydown(v) {},
  };
  el.classList = {
    add: (c) => el._cls.add(c), remove: (c) => el._cls.delete(c),
    toggle: (c, on) => (on ? el._cls.add(c) : el._cls.delete(c)), contains: (c) => el._cls.has(c),
  };
  return el;
}

const USAGE = { read: 1000, create: 2000, fresh: 3000, out: 4000 };
const mkCall = (i, model) => ({
  gi: i, ts: new Date(Date.UTC(2026, 6, 19, 0, i)).toISOString(), ctx: 10000,
  usage: { ...USAGE }, flat: [],
  rec: { request: { model, messages: [], system: [], tools: [] } },
});
function sessionFor(model, provider, harnessName) {
  const lane = {
    id: 'main', streamId: 'main', kind: 'main', icon: '💬', label: 'conversation',
    calls: [mkCall(0, model), mkCall(1, model)],
    events: [], resources: [], seenFiles: [], peakCtx: 10000, flagged: 0, spawnStep: null, parent: null,
  };
  return {
    records: [],
    analyzed: { streams: [], steps: [], lanes: [lane], stats: { calls: 2, streams: 1, subagents: 0, monitors: 0, compactions: 0, peakCtx: 10000 } },
    probes: { count: 0, series: [] },
    meta: { session_id: 'S', project_slug: 'P', project_path: '/p', harness: harnessName, provider, entrypoint: 'cli', title: 'T' },
    truncated: null,
  };
}

function harness(session) {
  const store = {};
  const getEl = (id) => store[id] || (store[id] = El());
  globalThis.document = {
    getElementById: getEl, querySelector() { return null }, querySelectorAll() { return [] },
    addEventListener() {}, body: El(), documentElement: El(), createElement() { return El() },
  };
  globalThis.window = { addEventListener() {}, removeEventListener() {}, matchMedia() { return { matches: false, addEventListener() {} } } };
  globalThis.location = { reload() {}, href: '', search: '' };
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  globalThis.setInterval = () => 0; globalThis.clearInterval = () => {};
  globalThis.setTimeout = () => 0;
  globalThis.console = { ...console, error() {} };
  globalThis.requestAnimationFrame = () => 0;
  const PROJECTS = { sessions: [{ project_slug: 'P', session_id: 'S', title: 'T', calls: 2, probes: 0, last_ts: 'T1', entrypoint: 'cli' }] };
  globalThis.fetch = (url) => {
    const u = String(url);
    if (u.startsWith('/api/sessions')) return Promise.resolve({ ok: true, json: () => Promise.resolve(PROJECTS) });
    if (u.startsWith('/api/session')) return Promise.resolve({ ok: true, json: () => Promise.resolve(session) });
    // /api/pricing: the module's own bootstrap — leave the built-in defaults in place
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  };
  return { getEl };
}

let seq = 0;
async function loadModule(session) {
  const h = harness(session);
  const html = fs.readFileSync(INDEX, 'utf8');
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
  const js = scripts[scripts.length - 1][1];
  const expose = '\n;globalThis.__P__={poll, costOf, usd, get PRICING(){return PRICING}, set PRICING(v){PRICING=v}};\n';
  const url = `data:text/javascript;base64,${Buffer.from(js + expose + `\n//# price-${++seq}\n`).toString('base64')}`;
  await import(url);
  await new Promise((r) => setImmediate(r));
  return { M: globalThis.__P__, h };
}

test('an OpenAI model is NOT given a fabricated dollar figure', async () => {
  const { M, h } = await loadModule(sessionFor('gpt-5.5', 'openai', 'codex'));
  await M.poll();
  const panel = h.getEl('rawpanel').innerHTML;
  assert.match(panel, /gpt-5\.5/, 'precondition: the raw panel is showing the gpt-5.5 call');
  assert.doesNotMatch(panel, /\$[0-9]/,
    `no local price exists for (openai, gpt-5.5) — any $ figure here is haiku rates in disguise (got: ${panel})`);
  assert.match(panel, /n\/a/i, 'the cost must be rendered as unavailable, not omitted silently');
});

test('costOf returns null (not a haiku-priced number) for a model with no price row', async () => {
  const { M } = await loadModule(sessionFor('gpt-5.5', 'openai', 'codex'));
  assert.equal(M.costOf('gpt-5.5', USAGE, 'openai'), null, 'openai model, anthropic-only table ⇒ no price');
  assert.equal(M.costOf('deepseek-chat', USAGE, 'deepseek'), null, 'deepseek model, anthropic-only table ⇒ no price');
  assert.equal(M.costOf('some-unknown-model', USAGE, null), null,
    'the haiku FALLBACK is the defect: an unrecognized model must have no price at all');
  // the provider GATE, independently of the fallback: opus/sonnet/haiku are Anthropic model
  // names, so matching them as substrings on another provider's model is the same class of bug.
  assert.equal(M.costOf('sonnet-mini-2', USAGE, 'openai'), null,
    'an Anthropic family name inside a non-Anthropic model must not pull Anthropic rates');
});

test('Anthropic pricing still works and is still recomputable (D14 no regression)', async () => {
  const { M, h } = await loadModule(sessionFor('claude-opus-4-20250514', 'anthropic', 'claude-code'));
  await M.poll();
  const panel = h.getEl('rawpanel').innerHTML;
  const want = M.usd(M.costOf('claude-opus-4-20250514', USAGE));
  assert.notEqual(M.costOf('claude-opus-4-20250514', USAGE), null, 'opus must still price');
  assert.ok(panel.indexOf('>' + want + '<') >= 0, `cost must still be usage×price recomputable (expected ${want}) — got ${panel}`);
  assert.match(panel, /≈ 本地估价/, 'the estimate badge (D14 fidelity marker) must still be there');
  // the family keys must survive: sonnet/haiku sessions still price off the editable table
  assert.notEqual(M.costOf('claude-3-5-haiku-20241022', USAGE), null, 'haiku must still price when it IS haiku');
  assert.notEqual(M.costOf('claude-sonnet-4-20250514', USAGE), null, 'sonnet must still price');
});

test('D14: the pricing table is still editable — and an added row prices a foreign model', async () => {
  const { M } = await loadModule(sessionFor('claude-opus-4-20250514', 'anthropic', 'claude-code'));
  const before = M.costOf('claude-opus-4-20250514', USAGE);
  M.PRICING = { ...M.PRICING, opus: [30, 150, 37.5, 3] }; // as /api/pricing would override it
  assert.equal(M.costOf('claude-opus-4-20250514', USAGE), before * 2, 'editing the unit price must change the estimate');
  // the escape hatch: a user who adds a row for their model gets a real number for it
  assert.equal(M.costOf('gpt-5.5', USAGE, 'openai'), null, 'precondition: unpriced before the row is added');
  M.PRICING = { ...M.PRICING, 'gpt-5.5': [1, 1, 1, 1] };
  assert.equal(M.costOf('gpt-5.5', USAGE, 'openai'), (1000 + 2000 + 3000 + 4000) / 1e6,
    'a user-supplied (provider, model) row must be honored');
});

// REGRESSION GUARD (collateral-damage audit, 2026-07-19).
// The provider gate above keyed on `meta.provider`, which in this codebase means the WIRE DIALECT,
// not the model vendor (src/view/board.mjs:50 wireProviderOf). OpenCode is explicitly
// provider-agnostic, so an Anthropic model reached over an OpenAI-Responses endpoint reports
// provider:'openai' — and the gate then stripped its perfectly correct opus pricing. That session
// exists in the developer's own capture (opencode-capture.ndjson, model claude-opus-4-6).
// The right discriminator is whether the MODEL is Anthropic-shaped, not how the bytes travelled.
test('an Anthropic model keeps Anthropic pricing regardless of the wire it travelled over', async () => {
  const { M } = await loadModule(sessionFor('claude-opus-4-6', 'openai', 'opencode'));
  const viaOpenAiWire = M.costOf('claude-opus-4-6', USAGE, 'openai');
  const viaAnthropicWire = M.costOf('claude-opus-4-6', USAGE, 'anthropic');
  assert.ok(viaOpenAiWire != null,
    'claude-opus-4-6 over an OpenAI-shaped endpoint is still an Anthropic model — opus rates apply');
  assert.equal(viaOpenAiWire, viaAnthropicWire,
    'the same model must cost the same regardless of transport; pricing keys on the model, not the wire');
});

test('a non-Anthropic model containing a family word still gets no price', async () => {
  const { M } = await loadModule(sessionFor('sonnet-mini-2', 'openai', 'codex'));
  assert.equal(M.costOf('sonnet-mini-2', USAGE, 'openai'), null,
    'family substrings are Anthropic names — they must not pull Anthropic rates into other vendors');
  assert.equal(M.costOf('sonnet-mini-2', USAGE, null), null,
    'and that must hold even when the wire dialect is unknown');
});
