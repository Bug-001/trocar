import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createServer } from '../src/server.mjs';

// D26 — the opt-in control plane + its security gate. Default OFF ⇒ no control endpoints ⇒ 4.4 read-only
// contract holds. When ON, mutations are gated by Host allowlist (anti DNS-rebind) + Origin + a
// GET-issued CSRF token. Control deps are injected so no real CA / LaunchAgent is touched.
function fakeDeps({ newCollector = true, off = null } = {}) {
  const log = [];
  const onboard = {
    atraceOn: (o) => { log.push(['on', o.proxyUrl]); return { ca: {}, install: { ok: true }, steer: {} }; },
    atraceOff: () => { log.push(['off']); return { steer: {}, ca: null }; },
    verifyUserTrustOnly: () => false,
  };
  const autostart = { platform: 'darwin', install: () => ({ ok: true, plistPath: '/p' }), remove: () => ({ ok: true, removed: false }), status: () => ({ installed: false }) };
  const getenv = () => null; // the status's default reader is the real `launchctl getenv`: inject one (test/helpers/no-real-os.cjs refuses the real tool)
  // 1.6 §4: which generation of the capture this platform has is injected, and so is `asight off` (the real one would take the old capture off the machine the test runs on)
  const asightOff = async () => { log.push(['asight off']); return off || { exit: 0, receipt: { command: 'off', ok: true, changed: [{ path: '/x/Script.js', change: 'block out' }] } }; };
  return { log, controlDeps: { onboard, autostart, getenv, hasNewCollector: () => newCollector, asightOff } };
}
const req = (port, method, p, { headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => { let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
  r.on('error', reject); if (body) r.write(body); r.end();
});

async function startServer(opts) {
  const { server } = await createServer({ dbPath: '/nonexistent-db', ...opts });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { server, port: server.address().port };
}

test('control OFF (default): /control/* is NOT mounted — data plane stays read-only', async () => {
  const { server, port } = await startServer({});
  try {
    const s = await req(port, 'GET', '/control/status');
    assert.notEqual(s.status, 200, 'no control status when control is off');
    const post = await req(port, 'POST', '/control/monitoring', { body: '{"action":"on"}' });
    assert.equal(post.status, 405, 'POST is rejected outright (data plane is GET-only)');
  } finally { server.close(); }
});

test('control ON: GET /control/status returns a CSRF token + monitoring status', async () => {
  const { controlDeps } = fakeDeps();
  const { server, port } = await startServer({ control: true, controlDeps, captureTarget: 'https://api.anthropic.com' });
  try {
    const s = await req(port, 'GET', '/control/status');
    assert.equal(s.status, 200);
    const d = JSON.parse(s.body);
    assert.match(d.csrf, /^[0-9a-f]{36}$/, 'per-process CSRF token');
    assert.equal(d.monitoring.forwardingTarget, 'https://api.anthropic.com', 'status shows the forwarding endpoint');
  } finally { server.close(); }
});

test('control ON: POST monitoring requires CSRF + loopback Host + same origin', async () => {
  const { controlDeps, log } = fakeDeps();
  const { server, port } = await startServer({ control: true, controlDeps });
  try {
    const { body } = await req(port, 'GET', '/control/status');
    const csrf = JSON.parse(body).csrf;
    // missing CSRF → 403
    assert.equal((await req(port, 'POST', '/control/monitoring', { body: '{"action":"on"}' })).status, 403);
    // wrong CSRF → 403
    assert.equal((await req(port, 'POST', '/control/monitoring', { headers: { 'x-asight-csrf': 'nope' }, body: '{"action":"on"}' })).status, 403);
    // spoofed Host (DNS-rebind) → 403
    assert.equal((await req(port, 'POST', '/control/monitoring', { headers: { host: 'evil.example.com', 'x-asight-csrf': csrf }, body: '{"action":"on"}' })).status, 403);
    // cross Origin → 403
    assert.equal((await req(port, 'POST', '/control/monitoring', { headers: { origin: 'https://evil.example.com', 'x-asight-csrf': csrf }, body: '{"action":"on"}' })).status, 403);
    assert.equal(log.length, 0, 'no onboard side effect from any rejected request');
  } finally { server.close(); }
});

test('control ON: a valid POST on/off maps to the underlying onboard commands', async () => {
  const { controlDeps, log } = fakeDeps();
  const { server, port } = await startServer({ control: true, controlDeps });
  try {
    const { body } = await req(port, 'GET', '/control/status');
    const csrf = JSON.parse(body).csrf;
    const on = await req(port, 'POST', '/control/monitoring', { headers: { 'x-asight-csrf': csrf, 'content-type': 'application/json' }, body: '{"action":"on","autostart":false}' });
    assert.equal(on.status, 200);
    assert.ok(JSON.parse(on.body).ok);
    const off = await req(port, 'POST', '/control/monitoring', { headers: { 'x-asight-csrf': csrf }, body: '{"action":"off"}' });
    assert.equal(off.status, 200);
    // bad action → 400
    assert.equal((await req(port, 'POST', '/control/monitoring', { headers: { 'x-asight-csrf': csrf }, body: '{"action":"bogus"}' })).status, 400);
    assert.deepEqual(log.map((l) => l[0]), ['on', 'off'], 'atraceOn then atraceOff were invoked');
  } finally { server.close(); }
});

// ── 1.6 §4 / V40: the switch's "off" on a platform without the new collector is `asight off` ──────────────────────────────────────────────────────────────────────────────────────────
const post = (port, csrf, action, extra = {}) => req(port, 'POST', '/control/monitoring', { headers: { 'x-asight-csrf': csrf, 'content-type': 'application/json' }, body: JSON.stringify({ action, ...extra }) });
const csrfOf = async (port) => JSON.parse((await req(port, 'GET', '/control/status')).body).csrf;

test('V40: no new collector — POST off calls the injected `asight off` once and never atraceOff by itself; the answer carries its receipt and exit; on is still atraceOn', async () => {
  const { controlDeps, log } = fakeDeps({ newCollector: false });
  const { server, port } = await startServer({ control: true, controlDeps });
  try {
    const csrf = await csrfOf(port)
    assert.equal((await post(port, csrf, 'on', { autostart: false })).status, 200)
    const off = await post(port, csrf, 'off')
    assert.equal(off.status, 200)
    const d = JSON.parse(off.body)
    assert.equal(d.ok, true); assert.equal(d.exit, 0)
    assert.equal(d.receipt.command, 'off'); assert.equal(d.receipt.changed[0].path, '/x/Script.js', 'the receipt is the CLI\'s own')
    assert.deepEqual(log.map((l) => l[0]), ['on', 'asight off'], 'atraceOn for on; for off only `asight off` — atraceOff is not called by itself')
  } finally { server.close(); }
});

test('V40: no new collector — an off that is not done is `ok: false` with the exit and the receipt (never a silent 200 that looks done); a throw is a 500 with its message; a refused request does not run it', async () => {
  const failed = { exit: 1, receipt: { command: 'off', ok: false, notes: ['the Clash route was not confirmed gone'] } }
  const { controlDeps, log } = fakeDeps({ newCollector: false, off: failed });
  const { server, port } = await startServer({ control: true, controlDeps });
  try {
    const csrf = await csrfOf(port)
    assert.equal((await req(port, 'POST', '/control/monitoring', { headers: { 'x-asight-csrf': 'nope' }, body: '{"action":"off"}' })).status, 403)
    assert.equal((await req(port, 'POST', '/control/monitoring', { headers: { origin: 'https://evil.example.com', 'x-asight-csrf': csrf }, body: '{"action":"off"}' })).status, 403)
    assert.deepEqual(log, [], 'a request the gate refused ran nothing')
    const d = JSON.parse((await post(port, csrf, 'off')).body)
    assert.deepEqual([d.ok, d.exit, d.receipt.ok], [false, 1, false]); assert.match(d.receipt.notes[0], /not confirmed gone/)
  } finally { server.close(); }
  const boom = fakeDeps({ newCollector: false }); boom.controlDeps.asightOff = async () => { throw new Error('the ledger could not be read') }
  const b = await startServer({ control: true, controlDeps: boom.controlDeps });
  try {
    const r = await post(b.port, await csrfOf(b.port), 'off')
    assert.equal(r.status, 500); assert.match(JSON.parse(r.body).error, /ledger could not be read/)
  } finally { b.server.close(); }
});

test('V40: a new collector — off is atraceOff as before (and `asight off` is not run), and GET /control/status says it only takes the old CC-CLI steer out, not the same as `asight off`; without one the note is gone', async () => {
  const has = fakeDeps({ newCollector: true });
  const a = await startServer({ control: true, controlDeps: has.controlDeps });
  try {
    const st = JSON.parse((await req(a.port, 'GET', '/control/status')).body)
    assert.match(st.monitoring.offNote, /只管旧 CC-CLI steer,不等于 `asight off`/)
    const off = await post(a.port, st.csrf, 'off')
    assert.equal(off.status, 200); assert.deepEqual(has.log.map((l) => l[0]), ['off'], 'atraceOff only')
    assert.equal(JSON.parse(off.body).receipt, undefined, 'the answer is the old one')
  } finally { a.server.close(); }
  const none = fakeDeps({ newCollector: false });
  const b = await startServer({ control: true, controlDeps: none.controlDeps });
  try { assert.equal(JSON.parse((await req(b.port, 'GET', '/control/status')).body).monitoring.offNote, null) } finally { b.server.close(); }
});
