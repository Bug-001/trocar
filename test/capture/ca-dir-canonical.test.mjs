import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CA_DIR } from '../../src/capture/onboard.mjs';
import { caDir } from '../../src/paths.mjs';

// THE CA DIR MUST BE ONE PLACE, AND THAT PLACE IS D27's ~/.asight/ca.
//
// On 2026-07-21 the mitm broke every steered TLS handshake because a SECOND CA with the same
// subject name ("atrace local MITM CA") existed in a second directory. The seed of that was
// onboard's DEFAULT_CA_DIR pointing at the legacy ~/.atrace/ca while paths.caDir() (and D27) say
// the canonical home is ~/.asight/ca. Two directories → two same-named CAs → chain building picks
// the wrong one → RSA "block type is not 01".
//
// The invariant that keeps it from recurring: every CA consumer resolves the SAME directory. This
// pins DEFAULT_CA_DIR to the canonical one, so `atrace on` / onboard can never again mint a second
// CA in the legacy dir behind the mitm's back.

test('onboard DEFAULT_CA_DIR is the D27 canonical dir, not the legacy ~/.atrace/ca', () => {
  assert.ok(
    DEFAULT_CA_DIR.endsWith('/.asight/ca') || DEFAULT_CA_DIR === caDir(),
    `DEFAULT_CA_DIR is ${DEFAULT_CA_DIR} — a CA dir that disagrees with paths.caDir() lets a second `
    + 'same-named CA exist, which is exactly what broke every steered TLS handshake on 2026-07-21',
  );
  assert.ok(
    !DEFAULT_CA_DIR.endsWith('/.atrace/ca'),
    'DEFAULT_CA_DIR still points at the legacy ~/.atrace/ca — onboard would recreate the collision',
  );
});
