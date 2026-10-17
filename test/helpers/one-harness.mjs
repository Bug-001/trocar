// one-harness.mjs — `off`'s judge as one answer, for tests: the production harnessesOf (src/off/signature.mjs) that off's holder steps use,
// narrowed to a single harness or null (none, or two that both claim the process). Kept out of src: no product code needs one answer.
import { harnessesOf } from '../../src/off/signature.mjs'

export const matchHarness = (liveness, facts) => { const hit = harnessesOf(liveness, facts); return hit.length === 1 ? hit[0] : null }
