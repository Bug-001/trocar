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

test('darwin on(): augments the global Script, writes no whole-file backup, reloads mihomo, reports live', async () => {
  const fs = fakeFs({ '/s.js': NO_OP, '/rt.yaml': RT, '/m.yaml': 'profile:\n  store-selected: true\nprepend-proxies:\n  - {name: atrace-mitm, type: http, server: 127.0.0.1, port: 9899}\n' });
  const reloads = [];
  const steer = getDesktopSteer('darwin', { fs, scriptPath: '/s.js', runtimePath: '/rt.yaml', mergePath: '/m.yaml', mihomoReload: (y) => (reloads.push(y), Promise.resolve({ status: 204 })), probeLive: () => Promise.resolve(true) });
  const out = await steer.on({ port: 9898 });
  assert.equal(out.ok, true);
  assert.match(fs.files.get('/s.js'), /port: 9898/, 'Script.js carries the atrace unshift');
  assert.equal(fs.files.has('/s.js.atrace-bak'), false, 'no .atrace-bak snapshot (D28: undo = strip the sentinel block)');
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
// routed into the MITM. Undo is first-class (4.1:64 「off 对称 … 零残留」) — so a failed undo MUST
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

// ── D28: off() strips ONLY the sentinel block — never a whole-file snapshot restore ────────────
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

test('D28 on()→off() round-trips a custom global Script byte-for-byte (user logic outside the block survives)', async () => {
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

test('D28 rules the user adds WHILE capture is on survive off() (the snapshot-restore regression)', async () => {
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

test('D28 a stale .atrace-bak left by an older asight is neither restored nor touched', async () => {
  const fs = fakeFs({ '/s.js': USER_MAIN, '/s.js.atrace-bak': NO_OP, '/rt.yaml': RT });
  const steer = getDesktopSteer('darwin', { fs, scriptPath: '/s.js', runtimePath: '/rt.yaml', mergePath: '/m.yaml', mihomoReload: () => Promise.resolve({ status: 204 }), probeLive: () => Promise.resolve(false) });
  await steer.on({ port: 9898 });
  await steer.off();
  assert.equal(fs.files.get('/s.js'), USER_MAIN, 'the live Script is not rolled back to the stale snapshot');
  assert.equal(fs.files.get('/s.js.atrace-bak'), NO_OP, 'the legacy file is left alone (the user decides whether to delete it)');
});

test('D28 off() with no atrace block present leaves Script.js unwritten', async () => {
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
