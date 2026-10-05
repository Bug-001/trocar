// Regression: a fresh clone (no private `cc-session-real.ndjson`) reported 36 FAILURES, because nine
// test files read the real capture without going through fixtureGate(). Those files now all route
// through it, so the gate's contract is what keeps a fresh clone honest. Pin it:
//   absent input  → `{ skip: <reason naming the file> }`  — the test shows as SKIP, never as a pass;
//   present input → `{}`                                  — the maintainer's run is unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixtureGate, hasFixture, CC_SESSION_REAL, FIXTURES_DIR } from './fixture.mjs';

const THIS_FILE = fileURLToPath(import.meta.url);

test('fixtureGate: an absent fixture yields a skip whose reason names the missing file', () => {
  const missing = path.join(FIXTURES_DIR, `no-such-capture-${process.pid}-${Date.now()}.ndjson`);
  assert.equal(existsSync(missing), false, 'precondition: the probe path really is absent');
  assert.equal(hasFixture(missing), false);
  const opts = fixtureGate(missing);
  assert.deepEqual(Object.keys(opts), ['skip'], 'only `skip` — a gate that also set e.g. `todo` would still run the body');
  assert.equal(typeof opts.skip, 'string', '`skip: true` would hide WHY; the reason must be spelled out');
  assert.ok(opts.skip.length > 0, 'an empty string is falsy — node:test would run (and fail) the test');
  assert.ok(opts.skip.includes(`test/fixtures/${path.basename(missing)}`),
    `the reason must name the missing file repo-relative, got: ${opts.skip}`);
});

test('fixtureGate: a present fixture yields {} (behaviour unchanged), and the default is the real capture', () => {
  assert.equal(hasFixture(THIS_FILE), true);
  assert.deepEqual(fixtureGate(THIS_FILE), {}, 'an existing input must not skip anything');
  // every gated file calls fixtureGate() with no argument — that default MUST be the private capture
  assert.equal(path.relative(path.join(FIXTURES_DIR, '..', '..'), CC_SESSION_REAL),
    path.join('test', 'fixtures', 'cc-session-real.ndjson'));
  assert.equal('skip' in fixtureGate(), !existsSync(CC_SESSION_REAL),
    'the no-arg gate must follow whether the real capture is on disk, not a hard-coded verdict');
});
