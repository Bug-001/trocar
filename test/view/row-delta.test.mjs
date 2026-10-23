// test/view/row-delta.test.mjs — a call row records only its delta (RFC 4.3 §投影 `{c:{…}}`, D71②): its position attributes name
// only the positions its delta brings or changes against its base — a position at or after `k`, a patched position, or one whose
// materialised attribute differs from the base's (a null deletes it) — and are materialised along the base chain like its block ids.
//
// Generated sessions (test/query/big-session.mjs) on the two Claude Code wires: 'threads' (continuations stitched against their
// predecessor's row) and 'http' (each call against its lane's last); file reads and writes give tool_uses / results resource
// attributes, user text gives `query`, `cc` the tool definitions and cache markers.
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { readFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { tmpDir } from '../helpers/tmp.mjs'
import { bigSession } from '../query/big-session.mjs'
import { indexRows, sessionGroups } from '../../src/query/rows.mjs'
import { recordsAt } from '../../src/query/records.mjs'
import { openProjection, projectionFile } from '../../src/query/projection.mjs'
import { extractMembers } from '../../src/view/extract.mjs'
import { listOf } from '../../src/view/reduce.mjs'

const isRef = (v) => v && typeof v === 'object' && !Array.isArray(v) && typeof v.$s === 'string' && Object.keys(v).length === 1

for (const wire of ['threads', 'http']) {
  test(`a ${wire} call row's attrs name only the positions its delta brings or changes`, async () => {
    const home = path.join(tmpDir('trocar-row-delta-'), '.trocar')
    const s = bigSession({ home, wire, cc: 8, reads: 3, writes: 120, growth: 1_500, subEvery: 4, subLen: 20 })
    s.append(90)
    const errors = [], members = sessionGroups(await indexRows({ home, errors })).get(s.id)
    const recs = recordsAt({ home, rows: members, errors, remember: false })
    const byId = new Map(recs.map((r) => [String(r.id), r]))
    const r = extractMembers({ store: openProjection({ home, key: s.id }), members, recordsAt: (rows) => rows.map((m) => byId.get(String(m.id))), sessionId: s.id })
    assert.equal(r.done, r.total)

    const lines = readFileSync(projectionFile(home, s.id), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    const shared = new Map(lines.filter((o) => o.s).map((o) => [o.s.k, o.s.v]))
    const deref = (v) => (isRef(v) ? deref(shared.get(v.$s)) : v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).map(([k, w]) => [k, deref(w)])) : v)
    const store = openProjection({ home, key: s.id, write: false })
    let rows = 0, keys = 0
    for (const { c } of lines.filter((o) => o.c && o.c.base != null)) {
      const row = deref(c), me = listOf(store, row.rid), base = listOf(store, row.base), patched = new Set((row.patch || []).map((p) => p[0]))
      rows++
      for (const key of Object.keys(row.attrs || {})) {
        const i = Number(key)
        keys++
        assert.ok(i < me.bids.length, `${wire} ${row.rid}: attrs name position ${i} past its list`)
        assert.ok(i >= row.k || patched.has(i) || !isDeepStrictEqual(me.attrs[i] ?? null, base.attrs[i] ?? null),
          `${wire} ${row.rid}: position ${i} < k ${row.k} holds its base's attribute`)
      }
    }
    assert.ok(rows > 0 && keys > 0, `${wire}: rows with a base and attributes to check`)
  })
}
