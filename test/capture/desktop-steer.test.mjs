import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getDesktopSteer, injectScript, stripBlock, spliceRuntime, stripRuntime,
  stripMergeLegacy, scriptBlock, PROXY_NAME, DESKTOP_RULE,
} from '../../src/capture/desktop-steer.mjs';

// 4.1:61 / D22 — the macOS-only CC-Desktop Clash steer. Durable mechanism = the Verge global
// Script (imperative unshift, survives regen). All I/O is injected so NO real Clash config is
// touched: an in-memory fs + spy mihomoReload/probeLive.

const NO_OP = '// Define main function (script entry)\nfunction main(config, profileName) { return config; }\n';

test('scriptBlock/injectScript: imperative unshift of the scoped proxy+rule, before return config', () => {
  const out = injectScript(NO_OP, 9898);
  assert.match(out, /config\.proxies\.unshift\(\{ name: 'atrace-mitm', type: 'http', server: '127\.0\.0\.1', port: 9898 \}\)/);
  assert.match(out, /PROCESS-PATH-REGEX,\(\?i\)Application Support\/Claude\/claude-code/);
  assert.match(out, /DOMAIN,api\.anthropic\.com/);
  // the block sits BEFORE `return config`
  assert.ok(out.indexOf('unshift') < out.indexOf('return config'), 'atrace block precedes return');
});

test('injectScript is idempotent — re-running yields exactly one block', () => {
  const once = injectScript(NO_OP, 9898);
  const twice = injectScript(once, 9898);
  assert.equal(twice, once, 're-inject rebuilds from the clean base → stable fixpoint');
  assert.equal((once.match(/atrace desktop capture/g) || []).length, 2, 'exactly one BEGIN + one END sentinel');
});

test('stripBlock round-trips injectScript back to a trivial, atrace-free main', () => {
  const stripped = stripBlock(injectScript(NO_OP, 9898));
  assert.doesNotMatch(stripped, /atrace|unshift|9898/, 'no atrace residue');
  assert.match(stripped, /function main\([^)]*\)\s*\{[\s\S]*return config[\s\S]*\}/, 'still a valid main returning config');
});

test('spliceRuntime inserts proxy after proxies: and rule after rules:, idempotently', () => {
  const rt = 'mixed-port: 7897\nproxies:\n- {name: VPN}\nproxy-groups:\n- {name: AI}\nrules:\n- MATCH,AI\n';
  const { yaml, splicedProxies, splicedRules } = spliceRuntime(rt, 9898);
  assert.ok(splicedProxies && splicedRules);
  assert.match(yaml, /proxies:\n[^\n]*\n- \{name: atrace-mitm, type: http, server: 127\.0\.0\.1, port: 9898\}/);
  assert.match(yaml, /rules:\n[^\n]*\n- AND,\(\(PROCESS-PATH-REGEX/);
  // re-splicing does not duplicate
  assert.equal(spliceRuntime(yaml, 9898).yaml, yaml);
  // and stripping returns to the original
  assert.equal(stripRuntime(yaml), rt);
});

test('stripMergeLegacy removes the inert demo prepend-proxies/prepend-rules blocks', () => {
  const merge = 'profile:\n  store-selected: true\nprepend-proxies:\n  - {name: atrace-mitm, type: http, server: 127.0.0.1, port: 9899}\nprepend-rules:\n  - AND,((PROCESS-PATH-REGEX,foo),(DOMAIN,api.anthropic.com)),atrace-mitm\n';
  const out = stripMergeLegacy(merge);
  assert.doesNotMatch(out, /prepend-proxies|prepend-rules|atrace-mitm/);
  assert.match(out, /store-selected: true/, 'real keys survive');
});

// ── the injected-fs steer ───────────────────────────────────────────────────────────────────
function fakeFs(seed = {}) {
  const files = new Map(Object.entries(seed));
  return {
    files,
    readFileSync: (p) => { if (!files.has(p)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } return files.get(p); },
    writeFileSync: (p, c) => files.set(p, c),
    existsSync: (p) => files.has(p),
    mkdirSync: () => {},
  };
}
const RT = 'mixed-port: 7897\nproxies:\n- {name: VPN}\nrules:\n- MATCH,AI\n';

test('darwin on(): augments the global Script, backs up the original, reloads mihomo, reports live', async () => {
  const fs = fakeFs({ '/s.js': NO_OP, '/rt.yaml': RT, '/m.yaml': 'profile:\n  store-selected: true\nprepend-proxies:\n  - {name: atrace-mitm, type: http, server: 127.0.0.1, port: 9899}\n' });
  const reloads = [];
  const steer = getDesktopSteer('darwin', { fs, scriptPath: '/s.js', runtimePath: '/rt.yaml', mergePath: '/m.yaml', mihomoReload: (y) => (reloads.push(y), Promise.resolve({ status: 204 })), probeLive: () => Promise.resolve(true) });
  const out = await steer.on({ port: 9898 });
  assert.equal(out.ok, true);
  assert.match(fs.files.get('/s.js'), /port: 9898/, 'Script.js carries the atrace unshift');
  assert.equal(fs.files.get('/s.js.atrace-bak'), NO_OP, 'original Script.js backed up');
  assert.doesNotMatch(fs.files.get('/m.yaml'), /prepend-proxies/, 'legacy Merge.yaml block cleaned');
  assert.equal(reloads.length, 1);
  assert.match(reloads[0], /atrace-mitm, type: http, server: 127\.0\.0\.1, port: 9898/, 'reloaded config has the runtime splice');
  assert.equal(out.status.scriptInstalled, true);
  assert.equal(out.status.live, true);
});

test('darwin off(): restores the no-op Script from backup + reloads a clean runtime (zero residual)', async () => {
  const fs = fakeFs({ '/s.js': NO_OP, '/rt.yaml': RT });
  const reloads = [];
  const deps = { fs, scriptPath: '/s.js', runtimePath: '/rt.yaml', mergePath: '/m.yaml', mihomoReload: (y) => (reloads.push(y), Promise.resolve({ status: 204 })), probeLive: () => Promise.resolve(false) };
  const steer = getDesktopSteer('darwin', deps);
  await steer.on({ port: 9898 });
  const out = await steer.off();
  assert.equal(fs.files.get('/s.js'), NO_OP, 'Script.js restored to the pristine no-op');
  assert.doesNotMatch(reloads.at(-1), /atrace-mitm/, 'final reload carries a clean runtime');
  assert.equal(out.status.scriptInstalled, false);
});

test('non-darwin: explicit reserved refusal, never a silent no-op (D22)', () => {
  const steer = getDesktopSteer('linux', {});
  const out = steer.on({ port: 9898 });
  assert.equal(out.ok, false);
  assert.equal(out.reserved, true);
  assert.match(out.reason, /macOS-Desktop-only/);
  assert.equal(steer.status().reserved, true);
});

test('the scoped rule targets ONLY claude-code→anthropic (surgical; never the system proxy)', () => {
  assert.equal(PROXY_NAME, 'atrace-mitm');
  assert.match(DESKTOP_RULE, /^AND,\(\(PROCESS-PATH-REGEX,\(\?i\)Application Support\/Claude\/claude-code\),\(DOMAIN,api\.anthropic\.com\)\),atrace-mitm$/);
  assert.doesNotMatch(scriptBlock(9898), /system|proxy-server|DIRECT|MATCH/i);
});
