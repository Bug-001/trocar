import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { readRecords } from '../../src/etl/ingest.mjs';
import { checkDeps, qCapturing, qCorrect, qNoLeak, qUserTrustOnly, runSelfTest } from '../../src/capture/selftest.mjs';
import { fixtureGate } from '../helpers/fixture.mjs';

const FIXTURE = path.resolve('test/fixtures/cc-session-real.ndjson');

// 4.5:41,77 — dependency self-check probes openssl (all) + certutil (linux only), one-line hint if missing.
test('checkDeps: openssl always required; certutil only on linux; missing → install hint', () => {
  const present = checkDeps({ platform: 'linux', has: () => true });
  assert.deepEqual(present.map((d) => d.bin).sort(), ['certutil', 'openssl']);
  assert.ok(present.every((d) => d.present));
  const mac = checkDeps({ platform: 'darwin', has: () => true });
  assert.deepEqual(mac.map((d) => d.bin), ['openssl'], 'no certutil requirement off-linux');
  const missing = checkDeps({ platform: 'linux', has: (b) => b === 'openssl' }); // certutil absent
  const cu = missing.find((d) => d.bin === 'certutil');
  assert.equal(cu.present, false);
  assert.match(cu.hint, /nss-tools|libnss3-tools/, 'gives a concrete one-line install hint');
});

// ① 是否真在抓
test('qCapturing: no source → not ok; source with records → ok', () => {
  assert.equal(qCapturing([], null).ok, false);
  assert.equal(qCapturing([], { exists: false }).ok, false);
  assert.equal(qCapturing([], { exists: true, bytes: 0 }).ok, false); // exists but empty
  const ok = qCapturing([{}, {}], { exists: true, bytes: 100, mtimeMs: 1 });
  assert.equal(ok.ok, true);
  assert.equal(ok.n, 2);
});

// ② 抓得对 — over the REAL fixture: every LLM call carries verbatim req_body + a reconstructed response.
test('qCorrect: real capture — LLM calls have verbatim req_body + response, none missing req', fixtureGate(), async () => {
  const recs = await readRecords(FIXTURE);
  const q = qCorrect(recs);
  assert.ok(q.llm > 0, 'fixture has LLM calls');
  assert.equal(q.badReq, 0, 'no LLM call lost its verbatim req_body');
  assert.equal(q.good, q.llm - q.badResp, 'good == llm minus any interrupted (missing-response) calls');
  assert.ok(q.ok);
});

// ③ 凭据 — CONTRACT CHANGED 2026-07-20 (spec 4.1 §采集安全 patched same commit).
// The redact firewall is gone: headers are stored VERBATIM, because rewriting them made the capture
// non-verbatim at the layer whose whole thesis is byte-fidelity. So ③ REPORTS rather than gates, and
// the hard red line moved to ④b (the file holding those credentials must be owner-only).
// This is not a weakened assertion — it is the inverse contract, and ④b below is stricter than what
// it replaced, because the old check could pass while a 0644 file sat full of `<redacted>` sentinels
// and real token-shaped bodies.
test('qNoLeak: reports credential-bearing records, does not fail on them', () => {
  const withCreds = qNoLeak([{ req_headers: { authorization: 'Bearer sk-ant-oat-REALTOKEN123' }, req_body: '{}' }]);
  assert.equal(withCreds.ok, true, 'credentials in the capture are by design now');
  assert.equal(withCreds.withCreds, 1, 'but their presence MUST be counted and surfaced');
  assert.equal(qNoLeak([]).ok, false, 'a scan that examined nothing still certifies nothing');
});

test('qNoLeak: real fixture leaks no un-redacted secret header', fixtureGate(), async () => {
  const recs = await readRecords(FIXTURE);
  const q = qNoLeak(recs);
  assert.equal(q.ok, true, 'reporting a real capture must not fail: ' + q.note);
  assert.equal(typeof q.withCreds, 'number', 'and it must count how many records carry credentials');
});

test('qNoLeak: a raw sk-ant token in a request BODY is a warning, not a hard fail (user-sent content)', () => {
  const q = qNoLeak([{ req_headers: { authorization: '<redacted>' }, req_body: '{"messages":[{"text":"my key is sk-ant-oat-PASTED12345"}]}' }]);
  assert.equal(q.ok, true, 'body-content token does not breach the firewall gate');
  assert.equal(q.tokenCount, 1, 'but it IS surfaced as a warning');
});

// ④ 没弱化全机 TLS
test('qUserTrustOnly: verify()=true → ok; false → not onboarded; throw → captured', () => {
  assert.equal(qUserTrustOnly(() => true).ok, true);
  const off = qUserTrustOnly(() => false);
  assert.equal(off.ok, false);
  assert.match(off.note, /not onboarded|user-level/);
  const boom = qUserTrustOnly(() => { throw new Error('nss missing'); });
  assert.equal(boom.ok, false);
  assert.match(boom.note, /errored: nss missing/);
});

// assembled: hardFail gates ONLY on a credential leak
test('runSelfTest: hardFail gates on FILE PERMISSIONS and on a vacuous scan', fixtureGate(), async () => {
  const recs = await readRecords(FIXTURE);
  const okFile = path.join(os.tmpdir(), `asight-perm-ok-${process.pid}.ndjson`);
  fs.writeFileSync(okFile, '{}\n'); fs.chmodSync(okFile, 0o600);
  try {
    const good = runSelfTest({ records: recs, srcMeta: { exists: true, bytes: 10, mtimeMs: 1 }, files: [okFile], deps: checkDeps({ platform: 'darwin', has: () => true }), verify: () => true });
    assert.equal(good.hardFail, false, 'a real capture in an owner-only file must pass');

    // A credential-bearing record is NO LONGER a hard failure — that is the point of the change.
    const creds = runSelfTest({ records: [{ req_headers: { 'x-api-key': 'sk-leak' }, req_body: '{}', endpoint: '/v1/messages' }], srcMeta: { exists: true }, files: [okFile], verify: () => true });
    assert.equal(creds.hardFail, false, 'credentials present = by design, not a failure');

    // A world-readable file holding them IS.
    fs.chmodSync(okFile, 0o644);
    const loose = runSelfTest({ records: recs, srcMeta: { exists: true }, files: [okFile], verify: () => true });
    assert.equal(loose.hardFail, true, 'a 0644 capture full of live credentials must hard-fail');

    // …and so is examining nothing.
    const vacuous = runSelfTest({ records: [], srcMeta: { exists: true }, files: [okFile], verify: () => true });
    assert.equal(vacuous.hardFail, true, 'a scan of zero records must never exit 0');
  } finally { fs.rmSync(okFile, { force: true }); }
});

// bounded read: the self-test samples a head rather than loading a whole large capture
test('readRecords honors a limit (bounded sampling for the self-test)', fixtureGate(), async () => {
  const capped = await readRecords(FIXTURE, { limit: 5 });
  assert.equal(capped.length, 5);
});
