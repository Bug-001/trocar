import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { qNoLeak, runSelfTest } from '../../src/capture/selftest.mjs';
import { tmpDir } from '../helpers/tmp.mjs';
import { cliOnEmptyMachine } from '../helpers/board-world.mjs';

// THE ONE SECURITY RED LINE MUST BE ABLE TO GO RED.
//
// `trocar doctor` answers four questions about a capture, and exits non-zero on exactly one of them:
// ③ 凭据没漏. Every secret header in every record MUST read `<redacted>`. It is the only hard failure
// in the tool, which makes it the only check a user is entitled to trust without reading its output.
//
// It could not fail (confirmed by three independent verifiers). Two defects stacked:
//
//   1. D27 made `serveSource()` return an ARRAY of capture roots (the home plus the collector directory).
//      bin/trocar.mjs still did `fs.statSync(source)` on it, which throws ERR_INVALID_ARG_TYPE, which
//      the surrounding try/catch swallows into `{exists:false}` — so `records` stayed `[]` and nothing
//      was ever examined. On a DEFAULT install, with a real capture on disk, doctor read zero records.
//
//   2. `qNoLeak([])` returns ok:true. An empty scan has no un-redacted header in it, so the check
//      passes vacuously and prints 「✓ all secret headers redacted」. That is the invariant-4 failure
//      in its purest form: ABSENCE OF EVIDENCE rendered as EVIDENCE OF ABSENCE, on a security claim.
//
// Together: the user runs `trocar doctor`, sees ✓ 凭据没漏, gets exit 0, and their capture may be
// full of Authorization headers. The tool is not merely unhelpful here, it is actively reassuring.
//
// 2026-07-20, LATER THAT DAY — redaction was REMOVED (spec 4.1 §采集安全 patched in
// the same commit): headers are now stored verbatim, so "a credential is present" is the expected
// state and can no longer be the red line. Half of this file's original subject is therefore retired,
// and the assertions that pinned it are GONE rather than softened — keeping them as warnings would
// leave a test file asserting a contract the product no longer has.
//
// WHAT SURVIVES, because it is independent of which contract is in force and was the deeper defect:
//   • a scan that examined NOTHING must never certify anything (the vacuous-truth guard), and
//   • `trocar doctor` must actually RESOLVE its source — array roots (D27) and directories — instead
//     of silently reading zero records.
// The red line's new home (file permissions) is pinned in test/capture/verbatim-headers.test.mjs.

// `doctor` runs through runCli, as the bin calls it, in a child node on an empty machine (board-world.mjs): its status block asks no OS tool on any host (0.1 §3)
const doctorOn = (home) => { const c = cliOnEmptyMachine(home, ['doctor'], { TROCAR_SOURCE: '' }); return [c.args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: c.env }] };

// A capture holding a real un-redacted credential. If doctor reads ANY records at all, it must find it.
function leakySource() {
  return leakyRoot();
}
function leakyRoot() {
  const dir = tmpDir('trocar-leak-');
  const rec = {
    id: 'req_1', is_llm_call: true, endpoint: 'https://api.anthropic.com/v1/messages',
    ts_request: '2026-01-01T00:00:00.000Z',
    req_headers: {
      'anthropic-version': '2023-06-01',
      'x-claude-code-session-id': 'leak-sess',
      authorization: 'Bearer sk-ant-api03-THIS-IS-A-LEAK-not-redacted',
    },
    req_body: JSON.stringify({ model: 'm', system: [], tools: [], messages: [{ role: 'user', content: 'hi' }] }),
    resp: { status: 200, body: JSON.stringify({ type: 'message', content: [], usage: {} }) },
  };
  fs.writeFileSync(path.join(dir, 'capture.ndjson'), JSON.stringify(rec) + '\n');
  return dir;
}

test('qNoLeak MUST NOT pass when it examined nothing', () => {
  // The vacuous-truth defect, at the unit. "I checked 0 records and found 0 leaks" is not a pass.
  const empty = qNoLeak([]);
  assert.equal(empty.ok, false,
    'qNoLeak([]) reports ok — an empty scan certifies the capture as clean. A security check that '
    + 'cannot distinguish "verified clean" from "examined nothing" gives its strongest answer on its '
    + 'weakest evidence (invariant 4).');
  assert.match(String(empty.note || ''), /没有|未|no records|nothing|examined/i,
    'the note must SAY that nothing was examined, so the human reading four answers can see why');
});

test('qNoLeak still passes on a genuinely clean capture', () => {
  // The fix must not be "always fail". A real, redacted record must still come back clean.
  const clean = qNoLeak([{
    req_headers: { authorization: '<redacted>', 'anthropic-version': '2023-06-01' },
    req_body: '{"model":"m"}',
  }]);
  assert.equal(clean.ok, true, `a properly redacted record must pass: ${clean.note}`);
});

test('qNoLeak counts credential-bearing records instead of failing on them', () => {
  // Retired contract, inverted deliberately: presence is by design now, but it MUST still be counted
  // and surfaced, or the user has no way to know what is in the file they are about to share.
  const r = qNoLeak([{ req_headers: { authorization: 'Bearer sk-ant-api03-oops' }, req_body: '{}' }]);
  assert.equal(r.ok, true, 'credentials present is no longer a failure');
  assert.equal(r.withCreds, 1, 'but it must be reported');
});

test('runSelfTest does not certify when nothing was examined: 无法判定 (exit 3), not ok and not a failure', () => {
  const res = runSelfTest({ records: [], srcMeta: { exists: true, bytes: 999 }, deps: [], verify: () => true });
  assert.equal(res.undetermined, true,
    'doctor exits 3 on `undetermined`. A source that EXISTS but yielded no records means the read failed — '
    + 'which is exactly the D27 array-source bug — and must not exit 0. (It used to exit 1 as a "hard fail", '
    + 'which said a problem was found when none was: R4 keeps 1 for a found problem and 3 for not knowing.)');
  assert.equal(res.failed, false);
  assert.equal(res.hardFail, false);
});

test('runCli in a child node: doctor hard-fails on a world-readable capture (the red line\'s new home)', () => {
  // Replaces two tests that asserted "finds an un-redacted credential and exits non-zero". Those
  // would now pass for the WRONG REASON — their fixtures were 0644, so ④b would trip regardless of
  // any credential — which is exactly the kind of accidentally-green assertion this suite keeps
  // finding. Assert the real thing directly.
  const dir = tmpDir('trocar-leak-home-');
  const home = path.join(dir, '.trocar');
  fs.mkdirSync(home, { recursive: true });
  fs.copyFileSync(path.join(leakyRoot(), 'capture.ndjson'), path.join(home, 'capture.ndjson'));
  try {
    fs.chmodSync(path.join(home, 'capture.ndjson'), 0o644);
    let status = 0, out = '';
    try {
      // the default source of this sandbox HOME (D27): no option of its own, runCli in a child node on stand-in deps
      out = execFileSync(process.execPath, ...doctorOn(dir));
    } catch (e) { status = e.status; out = String(e.stdout || '') + String(e.stderr || ''); }
    assert.notEqual(status, 0,
      `doctor exited 0 on a world-readable capture holding live credentials.\n--- output ---\n${out}`);
    assert.match(out, /0644[^\n]*can be read by someone else/, `doctor did not name the permission problem.\n${out}`);

    // …and passes once the file is owner-only, credentials and all.
    fs.chmodSync(path.join(home, 'capture.ndjson'), 0o600);
    const ok = execFileSync(process.execPath, ...doctorOn(dir));
    assert.match(ok, /^trocar doctor: no problems\.$/m, 'a 0600 capture must pass, credentials and all');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('runCli in a child node: a bare doctor on a CLEAN multi-root capture examines records and passes', () => {
  // This is the assertion that isolates the source-resolution fix, and it took a failed mutation to
  // find. Reverting the array handling does NOT make the leak tests green-to-red, because the
  // vacuous-scan guard added above turns *any* read failure into a loud hard-fail — good
  // defence-in-depth, but it masks WHICH defect is present. So pin the other direction: on a healthy
  // multi-root capture, doctor must actually READ something and exit 0. A doctor that cannot resolve
  // an array source reads zero records, hard-fails, and fails this test.
  const home = tmpDir('trocar-home-ok-');
  try {
    const newHome = path.join(home, '.trocar');
    const legacy = path.join(home, '.trocar', 'collector'); // the second default root (D60 ②: older locations are not read)
    fs.mkdirSync(newHome, { recursive: true });
    fs.mkdirSync(legacy, { recursive: true });
    const clean = {
      id: 'req_1', is_llm_call: true, endpoint: 'https://api.anthropic.com/v1/messages',
      ts_request: '2026-01-01T00:00:00.000Z',
      req_headers: { 'anthropic-version': '2023-06-01', authorization: '<redacted>', 'x-claude-code-session-id': 's1' },
      req_body: JSON.stringify({ model: 'm', system: [], tools: [], messages: [{ role: 'user', content: 'hi' }] }),
      resp: { status: 200, body: JSON.stringify({ type: 'message', content: [], usage: { input_tokens: 1, output_tokens: 1 } }) },
    };
    fs.writeFileSync(path.join(legacy, 'capture.ndjson'), JSON.stringify(clean) + '\n');
    fs.writeFileSync(path.join(newHome, 'capture.ndjson'), '');
    // owner-only, or ④b hard-fails and this test stops measuring source RESOLUTION (its subject)
    fs.chmodSync(path.join(legacy, 'capture.ndjson'), 0o600);
    fs.chmodSync(path.join(newHome, 'capture.ndjson'), 0o600);

    let status = 0, out = '';
    try {
      out = execFileSync(process.execPath, ...doctorOn(home));
    } catch (e) { status = e.status; out = String(e.stdout || '') + String(e.stderr || ''); }

    assert.equal(status, 0,
      `doctor hard-failed on a CLEAN capture. Almost certainly it read zero records — which is the `
      + `array-source defect, now surfacing loudly instead of silently.\n--- output ---\n${out}`);
    // exit 0 IS the assertion that the record was read: a capture file that yields no record at all
    // is 「cannot judge」 (exit 3, §3.7), which is how the array-source defect would surface now.
    assert.doesNotMatch(out, /Could not judge/, `doctor could not read the multi-root source that holds one record.\n${out}`);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('runCli in a child node: a BARE `trocar doctor` reads the D27 multi-root default', () => {
  // THE ACTUAL REGRESSION, exercised the way it actually happened: no --source at all, so the source
  // is whatever serveSource() returns — an ARRAY of the home and the collector directory. That array went
  // straight into fs.statSync(), which throws ERR_INVALID_ARG_TYPE on a non-path, and the catch
  // turned it into "no source", i.e. zero records, i.e. a vacuous ✓.
  //
  // Driven through a fake HOME so both roots genuinely exist and serveSource() genuinely returns two
  // of them. An earlier version of this test passed `--source a --source b`, which does NOT
  // reproduce it — `flag()` returns a single value, so that path never built an array and the test
  // stayed green with the fix reverted. Found by mutation.
  const home = tmpDir('trocar-home-');
  try {
    const newHome = path.join(home, '.trocar');
    const legacy = path.join(home, '.trocar', 'collector'); // the second default root (D60 ②: older locations are not read)
    fs.mkdirSync(newHome, { recursive: true });
    fs.mkdirSync(legacy, { recursive: true });
    fs.writeFileSync(path.join(newHome, 'capture.ndjson'), '');
    // the leak lives in the LEGACY root — so a doctor that only ever looks at one root also fails
    fs.copyFileSync(path.join(leakySource(), 'capture.ndjson'), path.join(legacy, 'capture.ndjson'));
    fs.chmodSync(path.join(legacy, 'capture.ndjson'), 0o600);
    fs.chmodSync(path.join(newHome, 'capture.ndjson'), 0o600);

    let status = 0, out = '';
    try {
      out = execFileSync(process.execPath, ...doctorOn(home));
    } catch (e) { status = e.status; out = String(e.stdout || '') + String(e.stderr || ''); }
    // Subject is SOURCE RESOLUTION, not credentials: a bare doctor must find the legacy root and
    // read the record in it. Before the fix it statSync'd an array, read zero records, and said ✓.
    assert.equal(status, 0, `bare doctor hard-failed on a healthy multi-root capture.\n${out}`);
    assert.doesNotMatch(out, /Could not judge/,
      `bare doctor did not read the record sitting in the legacy root — the D27 array-source defect (a file that yields no record exits 3).\n${out}`);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
