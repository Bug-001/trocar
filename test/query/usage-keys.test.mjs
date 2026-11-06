// test/query/usage-keys.test.mjs — 3.1 「未映射字段 MUST 可见」 for usage: the canonical mapping keeps six roles, and every other key a reply's
// usage carries (a vendor's own counter, a relay's addition) is still in the lane answer, verbatim, in the step's `detail.norm.usage`.
// The key is added to the stored reply of each call before the first read, as an unknown vendor would send it, on each wire.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpDir } from '../helpers/tmp.mjs'
import { bigSession } from './big-session.mjs'
import { runQuery } from '../../src/query/named/index.mjs'

const KEY = 'vendor_probe_tokens'
for (const wire of ['http', 'chat', 'ws']) {
  test(`${wire}: a usage key no mapping knows is in every step's detail.norm.usage, with its value`, async () => {
    const home = path.join(tmpDir('trocar-usagekeys-'), '.trocar')
    const s = bigSession({ home, wire, growth: 400, subEvery: 0 })
    s.append(6)
    // every usage object of every stored reply (JSON or the text of an SSE stream) gains the key
    const text = fs.readFileSync(s.file, 'utf8')
    const added = text.replace(/\\?"usage\\?":\s*\{/g, (m) => `${m}${m.startsWith('\\') ? `\\"${KEY}\\":7,` : `"${KEY}":7,`}`)
    assert.notEqual(added, text, 'the fixture has usage objects to extend')
    fs.writeFileSync(s.file, added)
    const doc = await runQuery('session', { id: s.id }, { home, fs })
    const main = doc.lanes.find((l) => l.kind === 'main')
    const lane = await runQuery('lane', { id: s.id, lane: main.lane }, { home, fs })
    const steps = (lane.steps || []).filter((st) => st.detail && st.detail.norm && st.detail.norm.usage && Object.keys(st.detail.norm.usage).length)
    assert.ok(steps.length > 0, 'the lane answer has steps with usage')
    for (const st of steps) assert.equal(st.detail.norm.usage[KEY], 7, `${st.rid}: the unmapped key is in the answer`)
  })
}
