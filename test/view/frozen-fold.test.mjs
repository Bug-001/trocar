// test/view/frozen-fold.test.mjs — the fold never changes a parsed request body (RFC 3.5 #21, frozen-fold part).
//
// The cold fold memoizes per-block work (bytes, key text, hash key, resource ref) in WeakMaps keyed by the PARSED block object: a
// stitched context hands the same parsed items to every call of its chain, so each is worked out once. That is only sound while no code
// changes a parsed item after the fold first saw it (src/dissect/request-body.mjs: parsed bodies are read-only). Here every parsed request
// body is deep-frozen before the fold sees it: a write to one throws (ES modules are strict), and the answer must be the plain fold's,
// byte for byte. Request bodies are told apart from the other JSON the fold parses (record lines, replies, stream events) by their
// shape: a `model` with a `messages` or `input` beside it, and no record timestamp. Records and replies stay unfrozen, because the
// fold legitimately copies-and-changes envelopes (hydration, slimming), which is not what this contract is about. So does the body's
// own top-level object: the flat-lane fold writes the dissector's counts onto it (src/view/extract.mjs flatRequest), and no memo is
// keyed by it. What is frozen is everything under it: the messages, input items, tools, system and their blocks, the memo's keys.
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import { runQuery } from '../../src/query/named/index.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { bigSession } from '../query/big-session.mjs'

const freshFs = () => ({ ...fs })
const session = async (home, p) => JSON.stringify(await runQuery('session', p, { home, fs: freshFs() }))

const deepFreeze = (v) => {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) { Object.freeze(v); for (const k of Object.keys(v)) deepFreeze(v[k]) }
  return v
}
const isRequestBody = (v) => v && typeof v === 'object' && !Array.isArray(v) && 'model' in v && ('messages' in v || 'input' in v) && !('ts' in v)

async function frozen(fn) {
  const parse = JSON.parse
  let seen = 0
  JSON.parse = function (...a) { const v = parse.apply(this, a); if (isRequestBody(v)) { seen++; for (const k of Object.keys(v)) deepFreeze(v[k]) } return v }
  try { return [await fn(), seen] } finally { JSON.parse = parse }
}

for (const wire of ['http', 'threads', 'ws', 'chat']) for (const [subEvery, subLanes, late] of [[0, 1, 0], [2, 3, 4]]) {
  test(`a ${wire} session (subagent every ${subEvery || 'never'}, ${subLanes} side by side, late ${late}) folds the same over frozen request bodies`, async () => {
    const home = path.join(tmpDir('trocar-frozen-'), '.trocar')
    const s = bigSession({ home, wire, growth: 2_000, subEvery, subLanes, late, subLen: 10, seed: subEvery + subLanes + late })
    s.append(30)
    for (const p of [{ id: s.id }, { id: s.id, limit: '5' }]) {
      const plain = await session(home, p)
      const [cold, seen] = await frozen(() => session(home, p))
      assert.ok(seen > 0, 'the fold parsed request bodies, and they were frozen')
      assert.equal(cold, plain, 'the answer over frozen bodies is the plain one')
    }
  })
}
