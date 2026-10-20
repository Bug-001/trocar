import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import * as nodeFs from 'node:fs';
import {
  getDesktopSteer, injectScript, stripBlock, spliceRuntime, stripRuntime,
  stripMergeLegacy, scriptBlock, PROXY_NAME, DESKTOP_RULE,
  mihomoSockCandidates, knownMihomoSocks, discoverMihomoSock,
} from '../../src/capture/desktop-steer.mjs';

// 4.1:61 / D22 — the macOS-only CC-Desktop Clash steer. Durable mechanism = the Verge global
// Script (imperative unshift, survives regen). All I/O is injected so NO real Clash config is
// touched: an in-memory fs + spy mihomoReload/probeLive.
// A developer's own TROCAR_MIHOMO_SOCK would outrank the controlled discovery below and point the
// default reload at their REAL core — never inherit it here.
delete process.env.TROCAR_MIHOMO_SOCK;

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

test('darwin on(): augments the global Script, writes no whole-file backup, reloads mihomo, reports live', async () => {
  const fs = fakeFs({ '/s.js': NO_OP, '/rt.yaml': RT, '/m.yaml': 'profile:\n  store-selected: true\nprepend-proxies:\n  - {name: atrace-mitm, type: http, server: 127.0.0.1, port: 9899}\n' });
  const reloads = [];
  const steer = getDesktopSteer('darwin', { fs, scriptPath: '/s.js', runtimePath: '/rt.yaml', mergePath: '/m.yaml', mihomoReload: (y) => (reloads.push(y), Promise.resolve({ status: 204 })), probeLive: () => Promise.resolve(true) });
  const out = await steer.on({ port: 9898 });
  assert.equal(out.ok, true);
  assert.match(fs.files.get('/s.js'), /port: 9898/, 'Script.js carries the atrace unshift');
  assert.equal(fs.files.has('/s.js.atrace-bak'), false, 'no .atrace-bak snapshot (undo = strip the sentinel block)');
  assert.doesNotMatch(fs.files.get('/m.yaml'), /prepend-proxies/, 'legacy Merge.yaml block cleaned');
  assert.equal(reloads.length, 1);
  assert.match(reloads[0], /atrace-mitm, type: http, server: 127\.0\.0\.1, port: 9898/, 'reloaded config has the runtime splice');
  assert.equal(out.status.scriptInstalled, true);
  assert.equal(out.status.live, true);
});

test('darwin off(): strips the atrace block back to a no-op main + reloads a clean runtime (zero residual)', async () => {
  const fs = fakeFs({ '/s.js': NO_OP, '/rt.yaml': RT });
  const reloads = [];
  const deps = { fs, scriptPath: '/s.js', runtimePath: '/rt.yaml', mergePath: '/m.yaml', mihomoReload: (y) => (reloads.push(y), Promise.resolve({ status: 204 })), probeLive: () => Promise.resolve(false) };
  const steer = getDesktopSteer('darwin', deps);
  await steer.on({ port: 9898 });
  const out = await steer.off();
  const after = fs.files.get('/s.js');
  assert.doesNotMatch(after, /atrace|unshift|9898/, 'no atrace residue in Script.js');
  assert.match(after, /function main\([^)]*\)\s*\{\s*return config;\s*\}/, 'a no-op main that still returns config');
  await steer.on({ port: 9898 });
  await steer.off();
  assert.equal(fs.files.get('/s.js'), after, 'on→off is a fixpoint from the second round on');
  assert.doesNotMatch(reloads.at(-1), /atrace-mitm/, 'final reload carries a clean runtime');
  assert.equal(out.status.scriptInstalled, false);
});

// ── B5: a splice that found no anchor is NOT a successful steer ───────────────────────────────
// A runtime YAML with quoted keys ("proxies":) or flow-style rules has no bare `proxies:`/`rules:`
// line, so spliceRuntime is a no-op. Reporting ok:true there tells the user monitoring is live when
// nothing was routed — the worst possible failure for a capture tool (保真边界写明).
const UNSPLICEABLE = '"mixed-port": 7897\n"proxies": [{name: VPN}]\n"rules": ["MATCH,AI"]\n';

test('B5 on() reports ok:false and SKIPS the reload when the runtime splice finds no anchor', async () => {
  const fs = fakeFs({ '/s.js': NO_OP, '/rt.yaml': UNSPLICEABLE });
  const reloads = [];
  const steer = getDesktopSteer('darwin', { fs, scriptPath: '/s.js', runtimePath: '/rt.yaml', mergePath: '/m.yaml', mihomoReload: (y) => (reloads.push(y), Promise.resolve({ status: 204 })), probeLive: () => Promise.resolve(false) });
  const out = await steer.on({ port: 9898 });
  assert.equal(out.ok, false, 'a no-op splice must not be reported as success');
  assert.match(out.reason, /splice/i, 'says WHY');
  assert.equal(reloads.length, 0, 'never reload mihomo with a config that has no atrace route');
});

test('B5 a runtime missing only `rules:` still fails loudly (a proxy with no rule routes nothing)', async () => {
  const fs = fakeFs({ '/s.js': NO_OP, '/rt.yaml': 'proxies:\n- {name: VPN}\n"rules": ["MATCH,AI"]\n' });
  const reloads = [];
  const steer = getDesktopSteer('darwin', { fs, scriptPath: '/s.js', runtimePath: '/rt.yaml', mergePath: '/m.yaml', mihomoReload: (y) => (reloads.push(y), Promise.resolve({ status: 204 })), probeLive: () => Promise.resolve(false) });
  const out = await steer.on({ port: 9898 });
  assert.equal(out.ok, false);
  assert.equal(reloads.length, 0);
});

test('B5 the durable Script.js steer still lands even when the runtime splice fails', async () => {
  const fs = fakeFs({ '/s.js': NO_OP, '/rt.yaml': UNSPLICEABLE });
  const steer = getDesktopSteer('darwin', { fs, scriptPath: '/s.js', runtimePath: '/rt.yaml', mergePath: '/m.yaml', mihomoReload: () => Promise.resolve({ status: 204 }), probeLive: () => Promise.resolve(false) });
  const out = await steer.on({ port: 9898 });
  assert.match(fs.files.get('/s.js'), /port: 9898/, 'durable half succeeded — it just is not live until a regen');
  assert.equal(out.status.scriptInstalled, true);
});

test('B5 a healthy runtime is still ok:true (the happy path is not collateral damage)', async () => {
  const fs = fakeFs({ '/s.js': NO_OP, '/rt.yaml': RT });
  const steer = getDesktopSteer('darwin', { fs, scriptPath: '/s.js', runtimePath: '/rt.yaml', mergePath: '/m.yaml', mihomoReload: () => Promise.resolve({ status: 204 }), probeLive: () => Promise.resolve(true) });
  assert.equal((await steer.on({ port: 9898 })).ok, true);
});

// ── B6: `off()` must report the REAL teardown outcome ─────────────────────────────────────────
// A failed `off` that reports ok:true tells the user monitoring is off while their traffic is STILL
// routed into the MITM. Undo is first-class — so a failed undo MUST
// be loud.
test('B6 off() reports ok:false when the mihomo reload is rejected (traffic may still be routed)', async () => {
  const fs = fakeFs({ '/s.js': NO_OP, '/rt.yaml': RT });
  const steer = getDesktopSteer('darwin', { fs, scriptPath: '/s.js', runtimePath: '/rt.yaml', mergePath: '/m.yaml', mihomoReload: () => Promise.resolve({ status: 500 }), probeLive: () => Promise.resolve(true) });
  await steer.on({ port: 9898 });
  const out = await steer.off();
  assert.equal(out.ok, false, 'a rejected reload is not a clean teardown');
  assert.match(out.reason, /reload/i, 'says WHY');
  assert.match(out.reason, /500/, 'carries the actual status');
});

test('B6 off() reports ok:false when the mihomo socket is unreachable (status 0 + error)', async () => {
  const fs = fakeFs({ '/s.js': NO_OP, '/rt.yaml': RT });
  const steer = getDesktopSteer('darwin', { fs, scriptPath: '/s.js', runtimePath: '/rt.yaml', mergePath: '/m.yaml', mihomoReload: () => Promise.resolve({ status: 0, error: 'ENOENT /tmp/verge/verge-mihomo.sock' }), probeLive: () => Promise.resolve(false) });
  await steer.on({ port: 9898 });
  const out = await steer.off();
  assert.equal(out.ok, false);
  assert.match(out.reason, /ENOENT|reload/i);
});

test('B6 off() reports ok:false when the Script.js restore itself failed', async () => {
  const fs = fakeFs({ '/s.js': NO_OP, '/rt.yaml': RT });
  const steer = getDesktopSteer('darwin', { fs, scriptPath: '/s.js', runtimePath: '/rt.yaml', mergePath: '/m.yaml', mihomoReload: () => Promise.resolve({ status: 204 }), probeLive: () => Promise.resolve(false) });
  await steer.on({ port: 9898 });
  // now the Script.js becomes unwritable (read-only file / EACCES) — the restore cannot land
  const realWrite = fs.writeFileSync;
  fs.writeFileSync = (p, c) => { if (p === '/s.js') { const e = new Error('EACCES: permission denied'); e.code = 'EACCES'; throw e; } return realWrite(p, c); };
  const out = await steer.off();
  fs.writeFileSync = realWrite;
  assert.equal(out.ok, false, 'the steer is STILL installed — that is not a clean off');
  assert.match(out.reason, /s\.js/, 'names the file that could not be restored');
  assert.equal(out.status.scriptInstalled, true, 'and says so in the status');
});

test('B6 the clean teardown path is still ok:true (no collateral damage)', async () => {
  const fs = fakeFs({ '/s.js': NO_OP, '/rt.yaml': RT });
  const steer = getDesktopSteer('darwin', { fs, scriptPath: '/s.js', runtimePath: '/rt.yaml', mergePath: '/m.yaml', mihomoReload: () => Promise.resolve({ status: 204 }), probeLive: () => Promise.resolve(false) });
  await steer.on({ port: 9898 });
  const out = await steer.off();
  assert.equal(out.ok, true);
  assert.equal(out.status.scriptInstalled, false);
});

// ── B7: `on()` must fold the mihomo reload status into its own ok ──────────────────────────────
test('B7 on() reports ok:false when mihomo REJECTS the reloaded config (status 500)', async () => {
  const fs = fakeFs({ '/s.js': NO_OP, '/rt.yaml': RT });
  const steer = getDesktopSteer('darwin', { fs, scriptPath: '/s.js', runtimePath: '/rt.yaml', mergePath: '/m.yaml', mihomoReload: () => Promise.resolve({ status: 500 }), probeLive: () => Promise.resolve(false) });
  const out = await steer.on({ port: 9898 });
  assert.equal(out.ok, false, 'a rejected reload means capture is NOT live now');
  assert.match(out.reason, /reload/i);
  assert.match(out.reason, /500/);
  assert.equal(out.status.scriptInstalled, true, 'the durable half still landed — say that too');
});

test('B7 on() reports ok:false when the mihomo control socket is unreachable (status 0)', async () => {
  const fs = fakeFs({ '/s.js': NO_OP, '/rt.yaml': RT });
  const steer = getDesktopSteer('darwin', { fs, scriptPath: '/s.js', runtimePath: '/rt.yaml', mergePath: '/m.yaml', mihomoReload: () => Promise.resolve({ status: 0, error: 'connect ENOENT /tmp/verge/verge-mihomo.sock' }), probeLive: () => Promise.resolve(false) });
  const out = await steer.on({ port: 9898 });
  assert.equal(out.ok, false);
  assert.match(out.reason, /ENOENT|reload/i);
});

// ── B8: a Script.js we cannot READ must never be overwritten ──────────────────────────────────
// read() defaulting every error to '' turns "EACCES on the user's real Script.js" into "empty file,
// use the stub" — and then on() writes a GENERATED script over the user's own Clash logic.
test('B8 on() REFUSES to overwrite a present-but-unreadable Script.js', async () => {
  const CUSTOM = '// the user\'s own global script\nfunction main(config) { config.rules.unshift("MATCH,DIRECT"); return config; }\n';
  const fs = fakeFs({ '/s.js': CUSTOM, '/rt.yaml': RT });
  const realRead = fs.readFileSync;
  fs.readFileSync = (p) => { if (p === '/s.js') { const e = new Error('EACCES: permission denied'); e.code = 'EACCES'; throw e; } return realRead(p); };
  const steer = getDesktopSteer('darwin', { fs, scriptPath: '/s.js', runtimePath: '/rt.yaml', mergePath: '/m.yaml', mihomoReload: () => Promise.resolve({ status: 204 }), probeLive: () => Promise.resolve(false) });
  await assert.rejects(() => steer.on({ port: 9898 }), (e) => e.message.includes('/s.js') && /EACCES|read/i.test(e.message), 'throws, naming the file it could not read');
  fs.readFileSync = realRead;
  assert.equal(fs.files.get('/s.js'), CUSTOM, 'the user\'s Script.js is byte-identical — never written on a failed read');
  assert.equal(fs.files.has('/s.js.atrace-bak'), false, 'and no bogus backup of an unread file');
});

test('B8 an ABSENT Script.js is still fine — ENOENT means "start from the no-op stub"', async () => {
  const fs = fakeFs({ '/rt.yaml': RT });
  const steer = getDesktopSteer('darwin', { fs, scriptPath: '/s.js', runtimePath: '/rt.yaml', mergePath: '/m.yaml', mihomoReload: () => Promise.resolve({ status: 204 }), probeLive: () => Promise.resolve(true) });
  const out = await steer.on({ port: 9898 });
  assert.equal(out.ok, true);
  assert.match(fs.files.get('/s.js'), /port: 9898/, 'a fresh Script.js was generated from the stub');
});

// ── B9: an unreadable RUNTIME config must not throw out of on()/off() ─────────────────────────
// read(runtimePath) throws on anything that is not ENOENT (EACCES / EISDIR). Both call sites run
// AFTER the durable half has already been written, so an uncaught throw leaves the machine in a
// half-applied / half-torn-down state and returns NO structured result at all — the user cannot
// tell what state their traffic routing is in. Fail loudly, but as a RESULT, not an exception.
function denyRead(fs, target, code = 'EACCES') {
  const real = fs.readFileSync;
  fs.readFileSync = (p) => { if (p === target) { const e = new Error(`${code}: denied`); e.code = code; throw e; } return real(p); };
  return () => { fs.readFileSync = real; };
}

test('B9 on() returns a structured ok:false when the runtime config is unreadable (never throws)', async () => {
  const fs = fakeFs({ '/s.js': NO_OP, '/rt.yaml': RT });
  const reloads = [];
  const steer = getDesktopSteer('darwin', { fs, scriptPath: '/s.js', runtimePath: '/rt.yaml', mergePath: '/m.yaml', mihomoReload: (y) => (reloads.push(y), Promise.resolve({ status: 204 })), probeLive: () => Promise.resolve(false) });
  const restore = denyRead(fs, '/rt.yaml');
  let out;
  try { out = await steer.on({ port: 9898 }); } finally { restore(); }
  assert.equal(out.ok, false, 'an unreadable runtime means capture is NOT live now');
  assert.match(out.reason, /rt\.yaml/, 'names the file it could not read');
  assert.equal(reloads.length, 0, 'never reload from a config we could not read');
  assert.equal(out.status.scriptInstalled, true, 'the durable half DID land — the result must say so');
});

test('B9 off() returns a structured ok:false when the runtime config is unreadable (never throws)', async () => {
  const fs = fakeFs({ '/s.js': NO_OP, '/rt.yaml': RT });
  const steer = getDesktopSteer('darwin', { fs, scriptPath: '/s.js', runtimePath: '/rt.yaml', mergePath: '/m.yaml', mihomoReload: () => Promise.resolve({ status: 204 }), probeLive: () => Promise.resolve(true) });
  await steer.on({ port: 9898 });
  const restore = denyRead(fs, '/rt.yaml');
  let out;
  try { out = await steer.off(); } finally { restore(); }
  // the Script.js restore already ran → the machine is HALF torn down. Saying so is the whole point.
  assert.equal(out.ok, false, 'a teardown that could not clear the runtime splice is not clean');
  assert.match(out.reason, /rt\.yaml/, 'names the file it could not read');
  assert.doesNotMatch(fs.files.get('/s.js'), /atrace/, 'the durable half was still stripped');
});

test('B9 an ABSENT runtime config is still fine — ENOENT means "nothing live to splice"', async () => {
  const fs = fakeFs({ '/s.js': NO_OP });
  const steer = getDesktopSteer('darwin', { fs, scriptPath: '/s.js', runtimePath: '/rt.yaml', mergePath: '/m.yaml', mihomoReload: () => Promise.resolve({ status: 204 }), probeLive: () => Promise.resolve(false) });
  assert.equal((await steer.on({ port: 9898 })).ok, true, 'no runtime on disk is not a failure');
  assert.equal((await steer.off()).ok, true);
});

// ── B10: off() must not claim a clean teardown it could not VERIFY ────────────────────────────
// status() honestly reports scriptInstalled:null (UNKNOWN) for an unreadable Script.js. `else if
// (st.scriptInstalled)` treats null as falsy → off() reports a clean undo it never confirmed.
test('B10 off() reports ok:false when it CANNOT VERIFY the Script.js restore (scriptInstalled null)', async () => {
  const fs = fakeFs({ '/s.js': NO_OP, '/rt.yaml': RT });
  const steer = getDesktopSteer('darwin', { fs, scriptPath: '/s.js', runtimePath: '/rt.yaml', mergePath: '/m.yaml', mihomoReload: () => Promise.resolve({ status: 204 }), probeLive: () => Promise.resolve(true) });
  await steer.on({ port: 9898 });
  // the strip itself lands (off() reads + rewrites Script.js) but the file is unreadable by the time
  // status() re-reads it → UNKNOWN, which MUST NOT be reported as success.
  const realRead = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = (p) => { if (p === '/s.js' && ++reads > 1) { const e = new Error('EACCES: denied'); e.code = 'EACCES'; throw e; } return realRead(p); };
  let out;
  try { out = await steer.off(); } finally { fs.readFileSync = realRead; }
  assert.doesNotMatch(fs.files.get('/s.js'), /atrace/, 'the strip did land');
  assert.equal(out.status.scriptInstalled, null, 'status is honest: UNKNOWN, not false');
  assert.equal(out.ok, false, 'unverified is not verified — never claim a clean teardown');
  assert.match(out.reason, /s\.js/, 'names the file whose state is unknown');
});

// ── off() strips ONLY the sentinel block — never a whole-file snapshot restore ────────────
// The global Script is shared with the user's own Clash logic (e.g. "SMTP ports → DIRECT" because
// the subscription's nodes block 25/465/587). Restoring a snapshot taken at the first on() silently
// deletes every rule the user added since; stripping the sentinel block cannot.
const USER_MAIN = [
  '// the user\'s own global script',
  'function main(config, profileName) {',
  '  // >>> mail smtp direct (manual) >>>',
  '  config.rules = config.rules || [];',
  "  ['DST-PORT,587,DIRECT', 'DST-PORT,465,DIRECT', 'DST-PORT,25,DIRECT'].forEach(function (r) {",
  '    if (config.rules.indexOf(r) === -1) config.rules.unshift(r);',
  '  });',
  '  // <<< mail smtp direct <<<',
  '  return config;',
  '}',
  '',
].join('\n');

test('on()→off() round-trips a custom global Script byte-for-byte (user logic outside the block survives)', async () => {
  const fs = fakeFs({ '/s.js': USER_MAIN, '/rt.yaml': RT });
  const steer = getDesktopSteer('darwin', { fs, scriptPath: '/s.js', runtimePath: '/rt.yaml', mergePath: '/m.yaml', mihomoReload: () => Promise.resolve({ status: 204 }), probeLive: () => Promise.resolve(false) });
  await steer.on({ port: 9898 });
  const on = fs.files.get('/s.js');
  assert.match(on, /port: 9898/, 'steer installed');
  assert.match(on, /DST-PORT,465,DIRECT/, 'user rules kept while on');
  const out = await steer.off();
  assert.equal(out.ok, true);
  assert.equal(fs.files.get('/s.js'), USER_MAIN, 'byte-identical to the pre-on() Script');
});

test('rules the user adds WHILE capture is on survive off() (the snapshot-restore regression)', async () => {
  const fs = fakeFs({ '/s.js': NO_OP, '/rt.yaml': RT });
  const steer = getDesktopSteer('darwin', { fs, scriptPath: '/s.js', runtimePath: '/rt.yaml', mergePath: '/m.yaml', mihomoReload: () => Promise.resolve({ status: 204 }), probeLive: () => Promise.resolve(false) });
  await steer.on({ port: 9898 });
  // the user edits the global Script by hand: a rule after the atrace block, before `return config`
  const edited = fs.files.get('/s.js').replace(/\n(\s*return config;)/, "\n  config.rules.unshift('DST-PORT,465,DIRECT');\n$1");
  assert.notEqual(edited, fs.files.get('/s.js'), 'fixture edit applied');
  fs.files.set('/s.js', edited);
  const out = await steer.off();
  assert.equal(out.ok, true);
  const after = fs.files.get('/s.js');
  assert.match(after, /config\.rules\.unshift\('DST-PORT,465,DIRECT'\);/, 'the user rule survived off()');
  assert.doesNotMatch(after, /atrace|9898/, 'and only the atrace block is gone');
  assert.equal(after, stripBlock(edited), 'off() == stripBlock(current file), nothing else');
});

test('a stale .atrace-bak left by an older trocar is neither restored nor touched', async () => {
  const fs = fakeFs({ '/s.js': USER_MAIN, '/s.js.atrace-bak': NO_OP, '/rt.yaml': RT });
  const steer = getDesktopSteer('darwin', { fs, scriptPath: '/s.js', runtimePath: '/rt.yaml', mergePath: '/m.yaml', mihomoReload: () => Promise.resolve({ status: 204 }), probeLive: () => Promise.resolve(false) });
  await steer.on({ port: 9898 });
  await steer.off();
  assert.equal(fs.files.get('/s.js'), USER_MAIN, 'the live Script is not rolled back to the stale snapshot');
  assert.equal(fs.files.get('/s.js.atrace-bak'), NO_OP, 'the legacy file is left alone (the user decides whether to delete it)');
});

test('off() with no atrace block present leaves Script.js unwritten', async () => {
  const fs = fakeFs({ '/s.js': USER_MAIN, '/rt.yaml': RT });
  const writes = [];
  const realWrite = fs.writeFileSync;
  fs.writeFileSync = (p, c) => { writes.push(p); return realWrite(p, c); };
  const steer = getDesktopSteer('darwin', { fs, scriptPath: '/s.js', runtimePath: '/rt.yaml', mergePath: '/m.yaml', mihomoReload: () => Promise.resolve({ status: 204 }), probeLive: () => Promise.resolve(false) });
  const out = await steer.off();
  assert.equal(out.ok, true);
  assert.ok(!writes.includes('/s.js'), 'nothing to strip → no write');
  assert.equal(fs.files.get('/s.js'), USER_MAIN);
});

// ── the immediate step on Clash Verge 2.5.x service mode ────────────────────────────────
// Verified 2026-09-27 on Verge 2.5.5 + mihomo v1.19.31 (service mode):
//  · the control socket is /var/run/clash-verge-service/users/<uid>/verge-mihomo.sock (mihomo runs as
//    root with `-ext-ctl-unix <that>`); /tmp/verge is gone and the runtime yaml's
//    external-controller-unix is stale → discover the socket, never hard-code one;
//  · PUT /configs {path} → 400 "not subpath of home directory or SAFE_PATHS" (home = a root-owned dir);
//    PUT /configs {payload} → 204 → reload by payload, write no file;
//  · after ANY Verge regen the runtime already carries the Script-produced proxy + rule WITHOUT our
//    sentinels → splicing again = duplicate proxy name → mihomo 400; and an off() that strips only
//    sentinel lines leaves the live route in place while claiming a clean teardown.

// what Verge writes after a regen with the durable Script.js steer in place (serde_yaml block style)
const RT_REGEN = [
  'mixed-port: 7897',
  'external-controller-unix: /var/folders/xx/T/verge-mihomo.sock',
  'proxies:',
  '- name: atrace-mitm',
  '  type: http',
  '  server: 127.0.0.1',
  '  port: 9898',
  '- name: VPN',
  '  type: anytls',
  '  alpn:',
  '  - h2',
  'proxy-groups:',
  '- name: AI',
  '  type: select',
  '  proxies:',
  '  - VPN',
  'rules:',
  '- DST-PORT,25,DIRECT',
  `- ${DESKTOP_RULE}`,
  '- MATCH,AI',
  '',
].join('\n');
const RT_REGEN_CLEAN = RT_REGEN.replace('- name: atrace-mitm\n  type: http\n  server: 127.0.0.1\n  port: 9898\n', '').replace(`- ${DESKTOP_RULE}\n`, '');
const countProxy = (y) => (y.match(/name: '?atrace-mitm'?[,}\s]/g) || []).length;
const countRule = (y) => y.split('\n').filter((l) => l.includes(DESKTOP_RULE)).length;

test('stripRuntime also removes the Script-produced (unmarked, block-style) proxy + rule', () => {
  assert.equal(RT_REGEN_CLEAN.includes('atrace-mitm'), false, 'fixture sanity');
  assert.equal(stripRuntime(RT_REGEN), RT_REGEN_CLEAN, 'exactly our two entries go; the VPN item keeps its nested list, other rules stay');
});

test('spliceRuntime over a regenerated runtime yields exactly ONE proxy + ONE rule (mihomo 400s on a duplicate name)', () => {
  const { yaml, splicedProxies, splicedRules } = spliceRuntime(RT_REGEN, 9899);
  assert.ok(splicedProxies && splicedRules);
  assert.equal(countProxy(yaml), 1, 'one atrace-mitm proxy');
  assert.equal(countRule(yaml), 1, 'one atrace rule');
  assert.match(yaml, /port: 9899\}/, 'the requested port wins over the regenerated one');
  assert.doesNotMatch(yaml, /port: 9898/);
  assert.equal(stripRuntime(yaml), RT_REGEN_CLEAN, 'and it still strips back to the clean runtime');
});

test('stripRuntime handles key order, quoting and indented-list variants — and only the EXACT name', () => {
  const rt = [
    'proxies:',
    '  - type: http',
    "    name: 'atrace-mitm'",
    '    port: 9898',
    '  - {name: atrace-mitm, type: http, server: 127.0.0.1, port: 9898}',
    '  - name: atrace-mitm-backup',
    '    type: http',
    'rules:',
    `  - '${DESKTOP_RULE}'`,
    '  - MATCH,DIRECT',
    '',
  ].join('\n');
  assert.equal(stripRuntime(rt), 'proxies:\n  - name: atrace-mitm-backup\n    type: http\nrules:\n  - MATCH,DIRECT\n');
});

test('stripRuntime never deletes a user proxy for a NESTED `name: atrace-mitm` (only the item\'s own name)', () => {
  const rt = [
    'proxies:',
    '- name: VPN',
    '  type: ss',
    '  plugin-opts:',
    '    name: atrace-mitm',
    '-',
    '  name: atrace-mitm',
    '  type: http',
    'rules:',
    '- MATCH,VPN',
    '',
  ].join('\n');
  assert.equal(stripRuntime(rt), 'proxies:\n- name: VPN\n  type: ss\n  plugin-opts:\n    name: atrace-mitm\nrules:\n- MATCH,VPN\n',
    'the VPN proxy survives; the bare-dash atrace item goes');
});

test('stripRuntime works on a CRLF runtime (else on() 400s on a duplicate and off() leaves the route)', () => {
  const crlf = RT_REGEN.replace(/\n/g, '\r\n');
  assert.equal(stripRuntime(crlf), RT_REGEN_CLEAN.replace(/\n/g, '\r\n'));
});

test('mihomoSockCandidates: the live core\'s -ext-ctl-unix first, then the runtime yaml, then known locations (deduped)', () => {
  const ps = [
    '/Applications/Clash Verge.app/Contents/MacOS/clash-verge',
    '/Library/Application Support/clash-verge-service/cores/verge-mihomo -d /Library/Application Support/clash-verge-service/users/501/runtime -f /Library/Application Support/clash-verge-service/users/501/runtime/config.yaml -ext-ctl-unix /var/run/clash-verge-service/users/501/verge-mihomo.sock',
    '/opt/mihomo -ext-ctl-unix /Users/me/My Socks/m.sock -secret s3cr3t',
    '/opt/other-core --ext-ctl-unix=/run/x.sock',
  ].join('\n');
  const got = mihomoSockCandidates({ psText: ps, runtimeYaml: RT_REGEN, known: knownMihomoSocks(501) });
  assert.deepEqual(got, [
    '/var/run/clash-verge-service/users/501/verge-mihomo.sock',
    '/Users/me/My Socks/m.sock',
    '/run/x.sock',
    '/var/folders/xx/T/verge-mihomo.sock',
    '/tmp/verge/verge-mihomo.sock',
  ]);
  assert.deepEqual(mihomoSockCandidates({}), [], 'nothing known → nothing to try (never a made-up path)');
});

test('discoverMihomoSock takes the first candidate that ANSWERS and says what it tried', async () => {
  const alive = new Set(['/b.sock', '/c.sock']);
  assert.deepEqual(await discoverMihomoSock(['/a.sock', '/b.sock', '/c.sock'], async (p) => alive.has(p)), { sock: '/b.sock', tried: ['/a.sock', '/b.sock'] });
  assert.deepEqual(await discoverMihomoSock(['/a.sock'], async () => false), { sock: null, tried: ['/a.sock'] });
});

// A fake mihomo on a REAL unix socket (temp dir) — exercises the product path end to end (discovery →
// payload reload → live probe) without ever touching the machine's own Clash. It enforces the two
// behaviours of the real v1.19.31 core that broke the old path: SAFE_PATHS on {path}, and a
// duplicate-proxy-name rejection.
async function fakeMihomo({ rejectAll = null } = {}) {
  const dir = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'trocar-mh-'));
  const sock = path.join(dir, 'm.sock');
  const state = { puts: [], live: false };
  const send = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(obj ? JSON.stringify(obj) : ''); };
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => (b += c));
    req.on('end', () => {
      if (req.method === 'GET' && req.url === '/version') return send(res, 200, { meta: true, version: 'v1.19.31' });
      if (req.method === 'GET' && req.url === '/proxies') return send(res, 200, { proxies: state.live ? { [PROXY_NAME]: { type: 'Http' } } : {} });
      if (req.method === 'PUT' && req.url.startsWith('/configs')) {
        const body = JSON.parse(b); state.puts.push(body);
        if (body.path) return send(res, 400, { message: `path is not subpath of home directory or SAFE_PATHS: ${body.path}` });
        if (countProxy(body.payload) > 1) return send(res, 400, { message: `proxy ${PROXY_NAME} is the duplicate name` });
        if (rejectAll) return send(res, 400, { message: rejectAll });
        state.live = countProxy(body.payload) === 1 && countRule(body.payload) === 1;
        return send(res, 204);
      }
      send(res, 404, { message: 'no route' });
    });
  });
  await new Promise((r) => srv.listen(sock, r));
  return { sock, state, close: () => new Promise((r) => srv.close(() => { nodeFs.rmSync(dir, { recursive: true, force: true }); r(); })) };
}
// deps for the REAL default reload/probe: discovery is fed a controlled ps listing + known list, so the
// test can never find (let alone reload) the developer's own mihomo.
const psFor = (sock) => () => `/x/verge-mihomo -d /x/runtime -ext-ctl-unix ${sock}`;

test('on() finds the live socket via ps, reloads by PAYLOAD (never a file path), status() probes the same socket', async () => {
  const mh = await fakeMihomo();
  try {
    const fs = fakeFs({ '/s.js': NO_OP, '/rt.yaml': RT_REGEN });
    const steer = getDesktopSteer('darwin', { fs, scriptPath: '/s.js', runtimePath: '/rt.yaml', mergePath: '/m.yaml', psText: psFor(mh.sock), knownSocks: [] });
    const out = await steer.on({ port: 9898 });
    assert.equal(out.ok, true, out.reason);
    assert.equal(mh.state.puts.length, 1, 'one reload');
    assert.deepEqual(Object.keys(mh.state.puts[0]), ['payload'], 'payload form only — no path, so no SAFE_PATHS 400');
    assert.equal(countProxy(mh.state.puts[0].payload), 1, 'the Script-produced copy was not duplicated');
    // (the payload-only key check above is what rules out the old apply-file: it was written via the
    // real fs, not deps.fs — this line only proves on() adds nothing next to Verge's own files)
    assert.deepEqual([...fs.files.keys()].sort(), ['/rt.yaml', '/s.js'], 'nothing written beside Script.js');
    assert.equal(out.status.live, true, 'the probe reached the same (discovered) socket');
    assert.equal(out.status.mihomoSock, mh.sock);
  } finally { await mh.close(); }
});

test('off() over a regenerated runtime drops the Script-produced route from the LIVE core, not just the file', async () => {
  const mh = await fakeMihomo();
  try {
    const fs = fakeFs({ '/s.js': NO_OP, '/rt.yaml': RT });
    const steer = getDesktopSteer('darwin', { fs, scriptPath: '/s.js', runtimePath: '/rt.yaml', mergePath: '/m.yaml', psText: psFor(mh.sock), knownSocks: [] });
    assert.equal((await steer.on({ port: 9898 })).ok, true);
    fs.files.set('/rt.yaml', RT_REGEN); // Verge regenerated meanwhile: the route is now unmarked
    const out = await steer.off();
    assert.equal(out.ok, true, out.reason);
    const last = mh.state.puts.at(-1).payload;
    assert.equal(countProxy(last), 0, 'no atrace-mitm proxy pushed to the core');
    assert.equal(countRule(last), 0, 'no atrace rule pushed to the core');
    assert.equal(last, RT_REGEN_CLEAN);
    assert.equal(out.status.live, false);
  } finally { await mh.close(); }
});

test('no reachable socket → ok:false naming what was tried + the Profiles → reactivate fallback', async () => {
  const gone = path.join(os.tmpdir(), `trocar-no-such-${process.pid}.sock`);
  const fs = fakeFs({ '/s.js': NO_OP, '/rt.yaml': RT });
  const steer = getDesktopSteer('darwin', { fs, scriptPath: '/s.js', runtimePath: '/rt.yaml', mergePath: '/m.yaml', psText: () => '', knownSocks: [gone] });
  const on = await steer.on({ port: 9898 });
  assert.equal(on.ok, false);
  assert.ok(on.reason.includes(gone), 'names the socket paths it tried');
  assert.match(on.reason, /Profiles/, 'tells the user how to apply it by hand');
  assert.match(on.reason, /reactivate/);
  assert.equal(on.status.scriptInstalled, true, 'the durable half landed');
  assert.equal(on.status.live, null, 'no socket → live is UNKNOWN, not "no"');
  const off = await steer.off();
  assert.equal(off.ok, false);
  assert.match(off.reason, /reactivate/, 'the block is gone from Script.js → reactivating drops the live route');
});

test('a mihomo rejection surfaces mihomo\'s OWN message, not just a status code', async () => {
  const mh = await fakeMihomo({ rejectAll: 'rules[3] [NOPE] error: unsupported rule type' });
  try {
    const fs = fakeFs({ '/s.js': NO_OP, '/rt.yaml': RT });
    const steer = getDesktopSteer('darwin', { fs, scriptPath: '/s.js', runtimePath: '/rt.yaml', mergePath: '/m.yaml', psText: psFor(mh.sock), knownSocks: [] });
    const out = await steer.on({ port: 9898 });
    assert.equal(out.ok, false);
    assert.match(out.reason, /400/);
    assert.match(out.reason, /unsupported rule type/);
    assert.match(out.reason, /reactivate/);
  } finally { await mh.close(); }
});

test('off(): the reactivate hint appears ONLY once the Script.js block is really gone', async () => {
  const fs = fakeFs({ '/s.js': NO_OP, '/rt.yaml': RT });
  const steer = getDesktopSteer('darwin', { fs, scriptPath: '/s.js', runtimePath: '/rt.yaml', mergePath: '/m.yaml', mihomoReload: () => Promise.resolve({ status: 0, error: 'no socket' }), probeLive: () => Promise.resolve(null) });
  await steer.on({ port: 9898 });
  const realWrite = fs.writeFileSync;
  fs.writeFileSync = (p, c) => { if (p === '/s.js') { const e = new Error('EACCES'); e.code = 'EACCES'; throw e; } return realWrite(p, c); };
  const stuck = await steer.off();
  fs.writeFileSync = realWrite;
  assert.equal(stuck.ok, false);
  assert.doesNotMatch(stuck.reason, /reactivate/, 'reactivating would RE-APPLY a block that is still in Script.js');
});

test('an ACCEPTED reload is not proof: on() with the proxy absent from the live core is ok:false', async () => {
  const fs = fakeFs({ '/s.js': NO_OP, '/rt.yaml': RT });
  const steer = getDesktopSteer('darwin', { fs, scriptPath: '/s.js', runtimePath: '/rt.yaml', mergePath: '/m.yaml', mihomoReload: () => Promise.resolve({ status: 204 }), probeLive: () => Promise.resolve(false) });
  const out = await steer.on({ port: 9898 });
  assert.equal(out.ok, false);
  assert.match(out.reason, /accepted the reload but atrace-mitm is NOT/);
  assert.match(out.reason, /reactivate/);
});

test('an ACCEPTED reload is not proof: off() with the proxy STILL live is ok:false (never a false "clean")', async () => {
  const fs = fakeFs({ '/s.js': NO_OP, '/rt.yaml': RT });
  const steer = getDesktopSteer('darwin', { fs, scriptPath: '/s.js', runtimePath: '/rt.yaml', mergePath: '/m.yaml', mihomoReload: () => Promise.resolve({ status: 204 }), probeLive: () => Promise.resolve(true) });
  await steer.on({ port: 9898 });
  const out = await steer.off();
  assert.equal(out.ok, false, 'the core still routes into the MITM');
  assert.match(out.reason, /STILL in its live proxy list/);
  assert.match(out.reason, /reactivate/, 'Script.js is clean → a Verge regen is the by-hand fix');
});

test('live UNKNOWN (null) after an accepted reload does not fail on()/off() — only a definite answer does', async () => {
  const fs = fakeFs({ '/s.js': NO_OP, '/rt.yaml': RT });
  const steer = getDesktopSteer('darwin', { fs, scriptPath: '/s.js', runtimePath: '/rt.yaml', mergePath: '/m.yaml', mihomoReload: () => Promise.resolve({ status: 204 }), probeLive: () => Promise.resolve(null) });
  assert.equal((await steer.on({ port: 9898 })).ok, true);
  assert.equal((await steer.off()).ok, true);
});

test('no Verge runtime config for this HOME → no discovery at all (never probes some other core), live UNKNOWN', async () => {
  let psCalls = 0;
  const fs = fakeFs({ '/s.js': NO_OP });
  const steer = getDesktopSteer('darwin', { fs, scriptPath: '/s.js', runtimePath: '/rt.yaml', mergePath: '/m.yaml', psText: () => (psCalls++, ''), knownSocks: [] });
  const st = await steer.status();
  assert.equal(psCalls, 0, 'ps never consulted');
  assert.equal(st.live, null);
  assert.equal(st.mihomoSock, null);
});

test('TROCAR_MIHOMO_SOCK pins the socket: no ps, no known locations, reload goes exactly there', async () => {
  const mh = await fakeMihomo();
  const prev = process.env.TROCAR_MIHOMO_SOCK;
  process.env.TROCAR_MIHOMO_SOCK = mh.sock;
  try {
    const fs = fakeFs({ '/s.js': NO_OP, '/rt.yaml': RT });
    const steer = getDesktopSteer('darwin', { fs, scriptPath: '/s.js', runtimePath: '/rt.yaml', mergePath: '/m.yaml', psText: () => { throw new Error('ps must not run when pinned'); }, knownSocks: ['/must/not/be/tried.sock'] });
    const out = await steer.on({ port: 9898 });
    assert.equal(out.ok, true, out.reason);
    assert.equal(mh.state.puts.length, 1);
    assert.equal(out.status.mihomoSock, mh.sock);
  } finally {
    if (prev === undefined) delete process.env.TROCAR_MIHOMO_SOCK; else process.env.TROCAR_MIHOMO_SOCK = prev;
    await mh.close();
  }
});

test('discovery only accepts a real socket (a regular file at a candidate path is skipped, not PUT to)', async () => {
  const dir = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'trocar-nosock-'));
  const file = path.join(dir, 'verge-mihomo.sock');
  nodeFs.writeFileSync(file, 'not a socket');
  const mh = await fakeMihomo();
  try {
    const fs = fakeFs({ '/s.js': NO_OP, '/rt.yaml': RT });
    const steer = getDesktopSteer('darwin', { fs, scriptPath: '/s.js', runtimePath: '/rt.yaml', mergePath: '/m.yaml', psText: () => '', knownSocks: [file, mh.sock] });
    const out = await steer.on({ port: 9898 });
    assert.equal(out.ok, true, out.reason);
    assert.equal(out.status.mihomoSock, mh.sock, 'the regular file was passed over');
  } finally { await mh.close(); nodeFs.rmSync(dir, { recursive: true, force: true }); }
});

test('non-darwin: explicit reserved refusal, never a silent no-op (D22)', () => {
  const steer = getDesktopSteer('linux', {});
  const out = steer.on({ port: 9898 });
  assert.equal(out.ok, false);
  assert.equal(out.reserved, true);
  assert.match(out.reason, /macOS-Desktop-only/);
  assert.match(out.reason, /`trocar on` where the per-process collector exists \(Linux\), or `trocar monitor on --no-autostart`/, 'it points at the commands that do the thing now (1.6 §2), not at the old `trocar on`');
  assert.equal(steer.status().reserved, true);
});

test('the scoped rule targets ONLY claude-code→anthropic (surgical; never the system proxy)', () => {
  assert.equal(PROXY_NAME, 'atrace-mitm');
  assert.match(DESKTOP_RULE, /^AND,\(\(PROCESS-PATH-REGEX,\(\?i\)Application Support\/Claude\/claude-code\),\(DOMAIN,api\.anthropic\.com\)\),atrace-mitm$/);
  assert.doesNotMatch(scriptBlock(9898), /system|proxy-server|DIRECT|MATCH/i);
});
