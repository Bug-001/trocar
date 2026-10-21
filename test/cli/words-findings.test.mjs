// test/cli/words-findings.test.mjs — 1.6 V103 / 1.9: every finding code `doctor` and the board can show has a status sentence in the shared
// catalog (src/cli/words.mjs statusReason), and that sentence passes the D58 check. The codes come from the finding catalogue itself, so a new
// code without a clause turns this red.
import test from 'node:test'
import assert from 'node:assert/strict'
import { FINDING_CODES } from '../../src/netenv/findings.mjs'
import { statusReason } from '../../src/cli/words.mjs'
import { assertEnglish } from '../helpers/english.mjs'

test('V103 every FINDING_CODES code has a statusReason clause whose text is non-empty English', () => {
  assert.ok(FINDING_CODES.length > 0)
  for (const code of FINDING_CODES) {
    const r = statusReason(code, { harness: 'codex' })
    assert.ok(r, `${code}: no clause`)
    // desired-off is not a reason anything is wrong: statusReason's contract gives it '' so an agent that is off has a blank NOTE (the
    // board's capture-page test exempts it the same way)
    if (code !== 'desired-off') assert.ok(typeof r.text === 'string' && r.text.trim(), `${code}: empty text`)
    // a clause is a sentence its renderer wraps (the status table's NOTE column, the board), so the column rule is the printed line's
    assertEnglish(r.text, code, { width: false })
    for (const f of ['fix', 'command']) if (r[f] != null) assertEnglish(r[f], `${code}.${f}`, { width: false })
  }
})
