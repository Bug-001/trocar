// test/web-v2/replay-packs.test.mjs — the desk fed by pack and tail files (RFC 3.5 §会话读 `lane --pack` / `lane --tail`):
// files loaded in any order give the desk of the session at mark. The reference session is desk-world's (late rows before a
// lane's tip, relanes, gone rows, compactions; `talk` for lists up to 1,400 bids); the renderer below writes its files by the
// spec's line rules (it is the format, not product code): pack n = the members at write positions [P·n, P·(n+1)), main = the
// main lane's, rest = the others; `parent` = the previous step of its lane in the same file; defs once per file before the
// first step using them; a file's `l` lines = the heads of lanes that changed while it was open, as they were when it sealed
// (the tail: appended at each change). The tail is appended mark by mark: a changed row / step / record is written again, a
// rid that stops being a call of the part gets `g`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createDesk, listOf, indexOf, ridAt } from '../../src/web/v2/replay/model.mjs'
import { parseLines, applyFile } from '../../src/web/v2/replay/packs.mjs'

const fx = JSON.parse(fs.readFileSync(new URL('../fixtures/session-read-contract.json', import.meta.url), 'utf8'))
const text = (lines) => lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
const J = JSON.stringify

test('A16 (3.5 契约样例): the lane_pack and lane_tail samples land their rows and steps in the desk', () => {
  const desk = createDesk()
  for (const [name, file] of [['lane_pack', { kind: 'pack', n: 0, part: 'main' }], ['lane_tail', { kind: 'tail', part: 'main' }]]) {
    assert.equal(applyFile(desk, file, parseLines(text(fx[name]))), true, name)
  }
  const lines = [...fx.lane_pack, ...fx.lane_tail], gone = new Set(lines.filter((l) => l.g).map((l) => l.g))
  for (const { c } of lines.filter((l) => l.c && !gone.has(l.c.rid))) assert.deepEqual(desk.rows.get(c.rid), c)
  for (const rid of gone) assert.equal(desk.rows.has(rid), false, rid)
  for (const { s } of lines.filter((l) => l.s)) {
    const list = listOf(desk, s.rid)
    assert.ok(list?.length, s.rid)
    for (const b of list) assert.ok(desk.defs.has(b), `${s.rid} ${b}`)
    assert.equal(indexOf(desk, s.lane, s.rid), s.i)
    assert.equal(ridAt(desk, s.lane, s.i), s.rid)
  }
  assert.deepEqual(desk.lanes.get(fx.lane_tail[1].l.lane), fx.lane_tail[1].l)
})

test('A16 parseLines: a read cut at any byte takes whole lines only, and `used` is where the next read starts', () => {
  const lines = [{ schema: 2, tail: { n: 0 } }, { c: { rid: 'a', preview: 'naïve → ok' } }, { g: 'a' }]
  const bytes = new TextEncoder().encode(text(lines))
  const ends = [], enc = new TextEncoder()
  for (let i = 0, at = 0; i < lines.length; i++) ends.push(at += enc.encode(J(lines[i]) + '\n').length)
  for (let k = 0; k <= bytes.length; k++) {
    const p = parseLines(bytes.subarray(0, k)), whole = ends.filter((e) => e <= k).length
    assert.equal(p.used, whole ? ends[whole - 1] : 0, `cut ${k}`)
    assert.deepEqual([p.head, ...p.lines].filter(Boolean), lines.slice(0, whole), `cut ${k}`)
    const rest = parseLines(bytes.subarray(p.used), { head: false })
    assert.deepEqual([...[p.head].filter(Boolean), ...p.lines, ...rest.lines], lines, `cut ${k} then the rest`)
  }
})
