import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildEnvelope } from '../../src/capture/envelope.mjs';
import { qNoLeak } from '../../src/capture/selftest.mjs';

// HEADERS ARE STORED VERBATIM. THE FILE THAT HOLDS THEM IS NOT WORLD-READABLE.
//
// Until 2026-07-20 the capture ran a redaction firewall: Authorization / x-api-key / Cookie /
// Proxy-Authorization were rewritten to `<redacted>` before the envelope was written, and
// `trocar doctor`'s one hard failure was "a secret header is not redacted".
//
// It was removed, and the reasoning holds up on this product's own terms: trocar exists to show
// what REALLY went over the wire, and `<redacted>` is a mutation of exactly those bytes. Redaction
// made the capture non-verbatim at precisely the layer whose thesis is byte-fidelity, and it bought
// little for a single-user, loopback-only, local instrument.
//
// BUT THE RISK DID NOT VANISH, IT MOVED. The bytes on disk now contain live credentials, so the
// property that matters is no longer "the secret isn't there" — it is "nobody but the owner can read
// the file that holds it". At the time of the change the capture files were 0644 and ~/.trocar was
// 0755, i.e. world-readable, which was harmless under redaction and is not harmless now.
//
// So doctor's red line moved rather than being deleted: ③ used to assert credentials are ABSENT; it
// now asserts they are UNREADABLE BY OTHERS. That is one stat() instead of a rewriting firewall —
// less machinery, and it is the check that actually protects the user under the new design.

test('the envelope stores request headers exactly as they arrived', () => {
  const headers = {
    'authorization': 'Bearer sk-ant-api03-REAL-TOKEN-VALUE',
    'x-api-key': 'sk-ant-key-material',
    'cookie': 'session=abc123',
    'anthropic-version': '2023-06-01',
  };
  const env = buildEnvelope({
    id: 'req_1', endpoint: 'https://api.anthropic.com/v1/messages', method: 'POST',
    reqHeaders: headers, reqBody: '{"model":"m","messages":[]}',
    resp: { status: 200, body: '{}' }, capture: 'mitm',
  });

  assert.equal(env.req_headers.authorization, headers.authorization,
    'the Authorization header must be stored verbatim — a rewritten header is not what went over the '
    + 'wire, and this product exists to show what did');
  assert.equal(env.req_headers['x-api-key'], headers['x-api-key'], 'x-api-key must be verbatim');
  assert.equal(env.req_headers.cookie, headers.cookie, 'cookie must be verbatim');
  assert.equal(env.req_headers['anthropic-version'], '2023-06-01', 'ordinary headers unchanged');

  // Nothing anywhere may still be rewriting to the old sentinel.
  assert.doesNotMatch(JSON.stringify(env.req_headers), /<redacted>/,
    'a `<redacted>` sentinel survives somewhere in the header map — redaction is meant to be gone, '
    + 'and a half-removed firewall is worse than either state: some captures verbatim, some not, '
    + 'with nothing saying which (invariant 4)');
});

test('auth_mode is still labelled — it is derived, and now it is derived from real headers', () => {
  const oauth = buildEnvelope({
    id: 'r', endpoint: 'https://api.anthropic.com/v1/messages', method: 'POST',
    reqHeaders: { authorization: 'Bearer sk-ant-x' }, reqBody: '{}', resp: { status: 200, body: '{}' }, capture: 'mitm',
  });
  assert.equal(oauth.auth_mode, 'oauth');
  const key = buildEnvelope({
    id: 'r', endpoint: 'https://api.anthropic.com/v1/messages', method: 'POST',
    reqHeaders: { 'x-api-key': 'sk-ant-y' }, reqBody: '{}', resp: { status: 200, body: '{}' }, capture: 'mitm',
  });
  assert.equal(key.auth_mode, 'api-key');
});

test('doctor no longer fails merely because a credential is present', () => {
  // Under the old contract this was the hard failure. Under the new one it is the expected state, and
  // reporting it as a breach would make the red line cry wolf on every single run — which is how a
  // security check stops being read at all.
  const res = qNoLeak([{
    req_headers: { authorization: 'Bearer sk-ant-api03-real' },
    req_body: '{"model":"m"}',
  }]);
  assert.equal(res.ok, true,
    'credentials in the capture are now by design; ③ must not hard-fail on their presence');
  assert.match(String(res.note || ''), /逐字|verbatim|by design|设计/,
    'the note must SAY that credentials are stored verbatim on purpose, so a reader is not left to '
    + 'guess whether the firewall broke (invariant 4)');
});

test('doctor STILL refuses to certify a scan that examined nothing', () => {
  // The vacuous-truth guard from the earlier fix must survive this change.
  assert.equal(qNoLeak([]).ok, false, 'an empty scan must never be a pass');
});

// ── the red line's new home ──────────────────────────────────────────────────────────────────────

import { qFilePerms } from '../../src/capture/selftest.mjs';

test('a capture file readable by others is a HARD failure', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trocar-perm-'));
  try {
    const f = path.join(dir, 'capture.ndjson');
    fs.writeFileSync(f, '{}\n');
    fs.chmodSync(f, 0o644);                       // the mode the real capture actually had
    const bad = qFilePerms([f]);
    assert.equal(bad.ok, false,
      'a 0644 capture file holds live API keys readable by every account on the machine. Under the '
      + 'old redaction contract this was harmless; it is the whole risk now.');
    assert.match(String(bad.note || ''), /0644|world|group|其他|权限/i, 'the note must name the offending mode');

    fs.chmodSync(f, 0o600);
    assert.equal(qFilePerms([f]).ok, true, '0600 must pass');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('qFilePerms does not certify an empty file list', () => {
  // Same vacuous-truth trap the credential check fell into. Do not repeat it in its replacement.
  assert.equal(qFilePerms([]).ok, false,
    'checking zero files must not report "permissions fine" — that is the exact shape of the bug this '
    + 'red line was moved away from');
});
