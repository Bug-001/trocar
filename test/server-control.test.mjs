import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createServer } from '../src/server.mjs';

// D26 — the opt-in control plane + its security gate. Default OFF ⇒ no control endpoints ⇒ 4.4 read-only
// contract holds. When ON, mutations are gated by Host allowlist (anti DNS-rebind) + Origin + a
// GET-issued CSRF token. Control deps are injected so no real CA / LaunchAgent is touched.
function fakeDeps() {
  const log = [];
  const onboard = {
    atraceOn: (o) => { log.push(['on', o.proxyUrl]); return { ca: {}, install: { ok: true }, steer: {} }; },
    atraceOff: () => { log.push(['off']); return { steer: {}, ca: null }; },
    verifyUserTrustOnly: () => false,
  };
  const autostart = { platform: 'darwin', install: () => ({ ok: true, plistPath: '/p' }), remove: () => ({ ok: true, removed: false }), status: () => ({ installed: false }) };
  const getenv = () => null; // the status's default reader is the real `launchctl getenv`: inject one (test/helpers/no-real-os.cjs refuses the real tool)
  return { log, controlDeps: { onboard, autostart, getenv } };
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

// ── 1.6 §4 / V40 (D39⑥ executed 2026-10-11): the switch's off ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// The legacy-platform branch — the full in-process `asight off` behind a hasNewCollector gate — went with the old capture's
// retirement. What is left is the one behavior there now is: off is atraceOff (the old CC-CLI steer only), and the status
// labels it so. The gate-refusal cells (CSRF / Host / Origin before an off) are covered above for the pair.
const post = (port, csrf, action, extra = {}) => req(port, 'POST', '/control/monitoring', { headers: { 'x-asight-csrf': csrf, 'content-type': 'application/json' }, body: JSON.stringify({ action, ...extra }) });
const csrfOf = async (port) => JSON.parse((await req(port, 'GET', '/control/status')).body).csrf;

test('V40: off is atraceOff as before (and `asight off` is not run), and GET /control/status says it only takes the old CC-CLI steer out, not the same as `asight off`', async () => {
  const { controlDeps, log } = fakeDeps();
  const a = await startServer({ control: true, controlDeps });
  try {
    const st = JSON.parse((await req(a.port, 'GET', '/control/status')).body)
    assert.match(st.monitoring.offNote, /只管旧 CC-CLI steer,不等于 `asight off`/)
    const off = await post(a.port, st.csrf, 'off')
    assert.equal(off.status, 200); assert.deepEqual(log.map((l) => l[0]), ['off'], 'atraceOff only')
    assert.equal(JSON.parse(off.body).receipt, undefined, 'the answer is the old one')
  } finally { a.server.close(); }
});
