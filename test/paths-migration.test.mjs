import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { asightHome, legacyHome, captureOut, mitmOut, serveSource, caDir } from '../src/paths.mjs';

// D27 (spec/01-asight-rfc/00-overview.md, 2026-07-20): the product's on-disk home is ~/.asight/.
//
// Everything else about this product already says "asight" — the CLI, every ASIGHT_* env var, the
// LaunchAgent com.asight.monitor, the README title. Only the filesystem still said "atrace", the v0
// prototype's name, which left README's four-row table stating the CA-removal SAFETY GUARANTEE in
// atrace terms one row below an asight-named LaunchAgent, with nothing anywhere explaining that
// these are the same product.
//
// The rename is cheap. NOT ORPHANING THE USER'S CAPTURES WHILE DOING IT is the whole problem, and
// it is why these tests exist. Three specific ways a path rename goes wrong here:
//
//   1. SILENTLY. The board's dir loader is non-recursive by design and its statSync is try/caught
//      (src/server.mjs:122-128), so pointing at the wrong directory yields FEWER SESSIONS, never an
//      error. A green suite and a healthy-looking board prove nothing; only reading the old location
//      does. Hence: the legacy root stays readable, asserted here, forever.
//   2. BY REGENERATING THE CA. The capture CA in the user's login keychain is identified by its
//      subject name, not its path. Move the directory and it keeps working; fail to FIND the moved
//      directory and the code helpfully mints a second root, asks the user to trust it, and leaves
//      the first one installed and unremovable (`off --remove-ca` looks in the new place).
//   3. BY LOSING WHAT IS OUTSIDE THE DIRECTORY. One capture in the live layout is a symlink whose
//      target sits outside the dir; a move that does not recreate it orphans that harness, and a
//      DANGLING symlink is worse — readRecords throws and the whole board 500s.
//
// These pin the contract. The actual data move is a one-time operation, verified separately by
// counting sessions before and after — not by this file.

test('D27: the product home is ~/.asight, and every default lives under it', () => {
  assert.equal(asightHome(), path.join(os.homedir(), '.asight'));
  // caDir() is deliberately excluded from this loop: on a machine that already has a CA it returns
  // the EXISTING one wherever it sits, which is the whole point of the test below about not minting
  // a second root. Its fresh-machine default is asserted there, on a clean temp home — asserting it
  // here would make this test pass or fail on whether the developer happens to be onboarded.
  for (const [name, p] of [['capture', captureOut()], ['mitm', mitmOut()]]) {
    assert.ok(p.startsWith(asightHome() + path.sep), `${name} default (${p}) is outside the product home`);
  }
});

test('D27: the legacy home is still named, so nothing has to guess where history lives', () => {
  assert.equal(legacyHome(), path.join(os.homedir(), '.atrace', 'asight'),
    'the v0-era capture root must stay addressable — it is where an un-migrated user\'s raw bytes are');
});

test('capture and mitm still write DISTINCT files (D20: one file per physical source)', () => {
  assert.notEqual(captureOut(), mitmOut(),
    'two capture sources appending to one file would interleave two harnesses into one stream');
});

test('serve reads the directory the capture writers write into (the first-run dead end)', () => {
  const roots = [].concat(serveSource());
  assert.ok(roots.includes(path.dirname(captureOut())), 'asight capture must write where asight serve looks');
  assert.ok(roots.includes(path.dirname(mitmOut())), 'asight mitm must write where asight serve looks');
});

// The one that would have caught a silent history loss.
test('serve covers the LEGACY root too, so a rename never orphans existing captures', () => {
  const roots = [].concat(serveSource({ legacyExists: true }));
  assert.ok(roots.includes(legacyHome()),
    'a user who captured 3 GB under ~/.atrace/asight and then upgrades must still see those sessions. '
    + 'The loader fails soft — a missed root shows as fewer sessions, not an error — so this is the '
    + 'only place the guarantee can be enforced (D27 constraint ①, invariant 2)');
});

test('the legacy root is NOT offered when it does not exist (no phantom source)', () => {
  const roots = [].concat(serveSource({ legacyExists: false }));
  assert.ok(!roots.includes(legacyHome()),
    'listing a non-existent root would make the loader throw "capture source unreadable" on a clean '
    + 'machine — broken must not look broken when it is merely absent');
});

// The CA is the one artifact where "not found" causes an ACTIVE harm rather than a gap.
test('an already-onboarded machine keeps its existing CA instead of minting a second root', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-ca-'));
  const legacy = path.join(dir, 'legacy-ca');
  fs.mkdirSync(legacy);
  fs.writeFileSync(path.join(legacy, 'atrace-ca.crt'), 'x');
  assert.equal(caDir({ home: path.join(dir, 'new-home'), legacyCa: legacy }), legacy,
    'when a CA already exists at the legacy path, that is the CA to use: the root in the user\'s '
    + 'keychain is THAT one. Generating a fresh one leaves the trusted root installed but unfindable '
    + '(so `off --remove-ca` cannot remove it) and prompts the user to trust a SECOND MITM root');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a fresh machine puts the CA in the new home', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-ca-'));
  assert.equal(caDir({ home: path.join(dir, 'h'), legacyCa: path.join(dir, 'absent') }), path.join(dir, 'h', 'ca'));
  fs.rmSync(dir, { recursive: true, force: true });
});
