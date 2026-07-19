import test from 'node:test';
import assert from 'node:assert/strict';
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

// ③ 凭据没漏 — the redact firewall is the acceptance face.
test('qNoLeak: redacted headers pass; an un-redacted secret header fails', () => {
  const clean = qNoLeak([{ req_headers: { authorization: '<redacted>', 'content-type': 'application/json' }, req_body: '{"messages":[]}' }]);
  assert.equal(clean.ok, true);
  const leaked = qNoLeak([{ req_headers: { authorization: 'Bearer sk-ant-oat-REALTOKEN123' }, req_body: '{}' }]);
  assert.equal(leaked.ok, false);
  assert.deepEqual(leaked.unredacted, ['authorization']);
});

test('qNoLeak: real fixture leaks no un-redacted secret header', fixtureGate(), async () => {
  const recs = await readRecords(FIXTURE);
  const q = qNoLeak(recs);
  assert.equal(q.ok, true, 'real capture keeps every secret header redacted: ' + JSON.stringify(q.unredacted));
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
test('runSelfTest: hardFail true iff a secret header is un-redacted', fixtureGate(), async () => {
  const recs = await readRecords(FIXTURE);
  const good = runSelfTest({ records: recs, srcMeta: { exists: true, bytes: 10, mtimeMs: 1 }, deps: checkDeps({ platform: 'darwin', has: () => true }), verify: () => true });
  assert.equal(good.hardFail, false);
  assert.equal(good.q3.ok, true);
  const bad = runSelfTest({ records: [{ req_headers: { 'x-api-key': 'sk-leak' }, req_body: '{}', endpoint: '/v1/messages' }], srcMeta: { exists: true }, verify: () => true });
  assert.equal(bad.hardFail, true, 'a leaked x-api-key hard-fails the doctor');
});

// bounded read: the self-test samples a head rather than loading a whole large capture
test('readRecords honors a limit (bounded sampling for the self-test)', fixtureGate(), async () => {
  const capped = await readRecords(FIXTURE, { limit: 5 });
  assert.equal(capped.length, 5);
});
