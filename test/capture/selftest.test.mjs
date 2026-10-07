import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { readRecords } from '../../src/etl/ingest.mjs';
import { checkDeps, qCapturing, qCorrect, qNoLeak, qFilePerms, qUserTrustOnly, runSelfTest } from '../../src/capture/selftest.mjs';
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
  assert.match(off.note, /only `asight monitor on`[^;]*puts there; the collector's own CA \(`asight on`\) is in no trust store by design/, 'the item is the old capture\'s CA: `asight on` cannot fix it, so it must not be what the note tells you to run (1.6 §2, §4)');
  assert.doesNotMatch(off.note, /run: asight on/);
  const boom = qUserTrustOnly(() => { throw new Error('nss missing'); });
  assert.equal(boom.ok, false);
  assert.match(boom.note, /errored: nss missing/);
});

// assembled (R4): three outcomes, never mixed. failed = a capture file others can read (exit 1) · undetermined = nothing examined, or not all of it (exit 3) · otherwise ok (exit 0).
test('runSelfTest: failed on a file others can read; undetermined on a scan that examined nothing; neither on a real capture in an owner-only file', () => {
  const recs = [{ endpoint: 'https://api.anthropic.com/v1/messages', req_headers: { 'anthropic-version': '2023-06-01' }, req_body: '{"model":"m"}', resp: { usage: { input_tokens: 1 } } }];
  const okFile = path.join(os.tmpdir(), `asight-perm-ok-${process.pid}.ndjson`);
  fs.writeFileSync(okFile, '{}\n'); fs.chmodSync(okFile, 0o600);
  const verdict = (r) => [r.failed, r.undetermined, r.hardFail];
  try {
    const good = runSelfTest({ records: recs, srcMeta: { exists: true, bytes: 10, mtimeMs: 1 }, files: [okFile], deps: checkDeps({ platform: 'darwin', has: () => true }), verify: () => true });
    assert.deepEqual(verdict(good), [false, false, false], 'a real capture in an owner-only file must pass');

    // A credential-bearing record is NO LONGER a failure — that is the point of the 2026-07-20 change.
    const creds = runSelfTest({ records: [{ req_headers: { 'x-api-key': 'sk-leak' }, req_body: '{}', endpoint: '/v1/messages' }], srcMeta: { exists: true }, files: [okFile], verify: () => true });
    assert.deepEqual(verdict(creds), [false, false, false], 'credentials present = by design, not a failure');

    // A world-readable file holding them IS.
    fs.chmodSync(okFile, 0o644);
    const loose = runSelfTest({ records: recs, srcMeta: { exists: true }, files: [okFile], verify: () => true });
    assert.deepEqual(verdict(loose), [true, false, true], 'a 0644 capture full of live credentials fails');
    assert.match(loose.q4b.note, /采集文件可被他人读取/);

    // …and examining nothing is not a pass either: it is 无法判定 (exit 3), not a failure and not an all-clear.
    fs.chmodSync(okFile, 0o600);
    const vacuous = runSelfTest({ records: [], srcMeta: { exists: true }, files: [okFile], verify: () => true });
    assert.deepEqual(verdict(vacuous), [false, true, false], 'a scan of zero records must never be ok');
    assert.match(vacuous.undeterminedWhy.join(' '), /没有核到任何记录/);
    const noFiles = runSelfTest({ records: recs, srcMeta: { exists: true }, files: [], verify: () => true });
    assert.deepEqual(verdict(noFiles), [false, true, false], 'records but no file whose permissions were checked: ④b certifies nothing');

    // a problem that was found outranks one that could not be judged
    fs.chmodSync(okFile, 0o644);
    assert.deepEqual(verdict(runSelfTest({ records: [], srcMeta: { exists: true }, files: [okFile], verify: () => true })), [true, false, true]);

    // a capture file read only in part is not a pass
    fs.chmodSync(okFile, 0o600);
    const partial = runSelfTest({ records: recs, srcMeta: { exists: true }, files: [okFile], readErrors: ['/x/b.ndjson: EIO'], verify: () => true });
    assert.deepEqual(verdict(partial), [false, true, false]);
  } finally { fs.rmSync(okFile, { force: true }); }
});

// ④b: bad modes, files whose mode could not be read, and nothing examined are three different answers (R11)
test('qFilePerms: others-readable is a failure; a file whose permissions cannot be read is 不知道 with the file and the errno (never "readable by others", never ok); the fix line quotes the path', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-qfp-'));
  try {
    const loose = path.join(dir, "it's here.ndjson"); fs.writeFileSync(loose, '{}\n'); fs.chmodSync(loose, 0o640);
    const tight = path.join(dir, 'tight.ndjson'); fs.writeFileSync(tight, '{}\n'); fs.chmodSync(tight, 0o600);
    const gone = path.join(dir, 'gone.ndjson');
    const a = qFilePerms([loose, tight]);
    assert.deepEqual([a.ok, a.bad.map((b) => b.mode), a.unreadable.length], [false, ['0640'], 0]);
    assert.match(a.note, /采集文件可被他人读取: 1 个 \[it's here\.ndjson 0640\]/);
    assert.ok(a.note.includes(`chmod 600 '${loose.replace(/'/g, `'\\''`)}'`), `quoted for the shell: ${a.note}`);
    const b = qFilePerms([tight, gone]);
    assert.deepEqual([b.ok, b.bad.length, b.unreadable.map((u) => [u.file, u.error])], [false, 0, [[gone, 'ENOENT']]]);
    assert.match(b.note, /不知道/); assert.ok(b.note.includes(gone) && b.note.includes('ENOENT'));
    assert.ok(!/采集文件可被他人读取/.test(b.note), 'a file that could not be looked at is not "readable by others"');
    const c = runSelfTest({ records: [{ endpoint: '/x' }], srcMeta: { exists: true }, files: [tight, gone], verify: () => true });
    assert.deepEqual([c.failed, c.undetermined], [false, true]);
    assert.match(c.undeterminedWhy.join(' '), /1 个文件的权限读不出来/);
    assert.deepEqual([qFilePerms([tight]).ok, qFilePerms([]).ok], [true, false]);
    assert.match(qFilePerms([]).note, /无法判定/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// bounded read: the self-test samples a head rather than loading a whole large capture
test('readRecords honors a limit (bounded sampling for the self-test)', fixtureGate(), async () => {
  const capped = await readRecords(FIXTURE, { limit: 5 });
  assert.equal(capped.length, 5);
});
