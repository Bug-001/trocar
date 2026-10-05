// test/helpers/fixture.mjs — one place that decides what happens when the real captured fixture
// is not on disk.
//
// `test/fixtures/cc-session-real.ndjson` is a REAL captured Claude Code session. It cannot ship: it
// carries 806 absolute paths under the author's home directory, plus whatever else a real session
// contains. `.gitignore`'s blanket `**/*.ndjson` keeps it out of the repo, correctly.
//
// The consequence was that `npm test` on a FRESH CLONE failed ~40 tests. For a contributor that is
// indistinguishable from "this project is broken", and it destroys the value of the suite as a
// signal. Failing is also simply the wrong verdict: nothing IS broken — the input is absent.
//
// So: skip, loudly and specifically. A skipped test states what is missing and how to get it. What
// we must never do is silently pass, which would turn a fresh clone green while testing nothing —
// the fake-coverage failure mode this audit spent its whole budget hunting.
//
// The maintainer, who has the fixture, sees zero behaviour change: every test runs as before.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES_DIR = path.join(HERE, '..', 'fixtures');
export const CC_SESSION_REAL = path.join(FIXTURES_DIR, 'cc-session-real.ndjson');

export const hasFixture = (p = CC_SESSION_REAL) => existsSync(p);

/**
 * Options for node:test that skip the test when the capture fixture is absent.
 *   test('…', fixtureGate(), (t) => { … })
 * Returns `{}` when the fixture exists, so behaviour is unchanged for anyone who has it.
 */
export function fixtureGate(p = CC_SESSION_REAL) {
  if (hasFixture(p)) return {};
  return {
    skip: `requires ${path.relative(path.join(HERE, '..', '..'), p)}, a REAL captured session that is `
      + 'gitignored (it contains absolute home paths and live conversation content, so it cannot be '
      + 'published). Capture your own with `asight monitor on`, or run `npm run demo` to see the '
      + 'product against the synthetic sample.',
  };
}
