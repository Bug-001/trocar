// test/web-v2/overview-model.test.mjs — RFC 2.5 验收 #1-#4: the sidebar Overview's model over generated sessions, read through the
// reference server's answers. Expected values come from the world (its head's chapter table, its lanes, its events) and the step's
// own block list; no words are asserted.
import test from 'node:test'
import assert from 'node:assert/strict'
import { overviewModel } from '../../web/src/screens/replay/overview-model.mjs'
import { outlineEntries } from '../../web/legacy/replay/outline.mjs'
import { hasChangeLine } from '../../web/legacy/replay/analysis.mjs'
import { anchorLane, buildLanes } from '../../web/legacy/replay/lanes.mjs'
import { applySession, createDesk, stepOf } from '../../web/legacy/replay/model.mjs'
import { deskFrom, readLane, world } from './desk-world.mjs'

const SEEDS = Array.from({ length: 14 }, (_, i) => i + 1)
const OPTS = { calls: 48, compact: 0.35 }

const stateOf = (desk, playhead = 0) => {
  const lanes = buildLanes(desk)
  return { desk, lanes, anchor: anchorLane(lanes), playhead, navOpen: new Set() }
}
// the answers as a session of this seed gives them; `edit(name, answer)` is the wire of a session with other facts on it
const answers = (w, edit) => { const get = w.get(); return edit ? async (n, p) => edit(n, await get(n, p)) : get }
async function session(seed, { opts = OPTS, edit } = {}) {
  const w = world(seed, opts), desk = await deskFrom(answers(w, edit), 'S'), { head } = w.files()
  desk.head = edit ? edit('head', head) : head
  return { w, desk, head: desk.head, s: stateOf(desk), rids: w.laneRidsAt().get(desk.head.axis) || [] }
}
// every generated session with more than one chapter
async function* multi(o) {
  for (const seed of SEEDS) { const x = await session(seed, o); if (x.head.chapters.length > 1) yield x }
}
const holder = (chapters, g) => chapters.findIndex((c) => g >= c.s0 && g < c.s1)
const openAll = (s, chapters) => { s.partFlips = new Set(chapters.filter((c) => holder(chapters, s.anchor.no(s.playhead)) !== chapters.indexOf(c)).map((c) => c.k)) }
const flatAt = (s, at) => stepOf(s.desk, s.anchor.calls[at].rid).flat

test('2.5 #1: one part per chapter with its span; the part holding the playhead is current and open; a flip survives step moves; one chapter is single', async () => {
  let n = 0
  for await (const { s, head: { chapters } } of multi()) {
    n++
    const other = chapters[1].k
    s.partFlips = new Set([other])
    for (let i = 0; i < s.anchor.calls.length; i++) {
      s.playhead = i
      const m = overviewModel(s), here = holder(chapters, s.anchor.no(i))
      assert.equal(m.single, false)
      assert.equal(m.parts.length, chapters.length)
      m.parts.forEach((p, j) => {
        assert.deepEqual([p.k, p.a, p.b, p.ts0, p.inferred], [chapters[j].k, chapters[j].s0, chapters[j].s1, chapters[j].ts0, chapters[j].inferred])
        assert.equal(p.current, j === here)
        assert.equal(p.open, p.k === other ? !p.current : p.current)
      })
    }
    assert.deepEqual([...s.partFlips], [other])
  }
  assert.ok(n > 3, 'the seeds reach sessions of several chapters')
  const { s } = await session(1, { opts: { calls: 30, compact: 0 } })
  const m = overviewModel(s)
  assert.equal(m.single, true)
  assert.equal(m.parts.length, 1)
  assert.ok(m.parts[0].open)
})

test('2.5 #2: tools and system rows are the read step\'s, the current part reads the playhead and another its first step, and every jump is a block of that step', async () => {
  for await (const { s, head: { chapters } } of multi()) {
    for (const i of [0, s.anchor.calls.length >> 1, s.anchor.calls.length - 1]) {
      s.playhead = i
      openAll(s, chapters)
      overviewModel(s).parts.forEach((p, j) => {
        assert.equal(p.at, p.current ? i : s.anchor.ridLocal.get(chapters[j].rid0))
        const [tools, sys] = outlineEntries(s, p.at).groups, flat = flatAt(s, p.at)
        assert.deepEqual(p.tools.kids, tools.kids)
        assert.deepEqual(p.sys.kids, sys.kids)
        for (const r of p.tools.kids) assert.equal(flat[r.jump].sec, 'tools')
        for (const r of p.sys.kids) assert.equal(flat[r.jump].sec, 'system')
      })
    }
  }
})

test('2.5 #2: prompt rows are the main lane\'s user events inside the part, numbered by their step; the last one at or before the playhead is current', async () => {
  let rows = 0
  for await (const { w, s, head, rids } of multi()) {
    const users = w.eventsAt(head.axis).filter((e) => e.type === 'user').map((e) => ({ ...e, g: rids.indexOf(e.rid) }))
    for (const i of [0, s.anchor.calls.length >> 1, s.anchor.calls.length - 1]) {
      s.playhead = i
      openAll(s, head.chapters)
      const parts = overviewModel(s).parts
      parts.forEach((p, j) => {
        const want = users.filter((e) => e.g >= head.chapters[j].s0 && e.g < head.chapters[j].s1)
        assert.deepEqual(p.prompts.kids.map((r) => [r.rid, r.n, r.i]), want.map((e) => [e.rid, e.g + 1, e.g]))
        rows += want.length
      })
      const seen = users.filter((e) => e.g <= i && holder(head.chapters, e.g) === holder(head.chapters, i)).at(-1)
      assert.deepEqual(parts.flatMap((p) => p.prompts.kids.filter((r) => r.current).map((r) => r.rid)), seen ? [seen.rid] : [])
    }
  }
  assert.ok(rows > 0)
})

test('2.5 #2: on a line with no user events the prompt rows are the read step\'s query blocks, with no step number', async () => {
  const noUsers = (name, a) => (name === 'lane' ? { ...a, events: a.events.filter((e) => e.type !== 'user') } : a)
  let rows = 0
  for await (const { s, head: { chapters } } of multi({ edit: noUsers })) {
    openAll(s, chapters)
    for (const p of overviewModel(s).parts) {
      const flat = flatAt(s, p.at)
      for (const r of p.prompts.kids) { assert.equal(flat[r.jump].sec, 'messages'); assert.equal(r.n, undefined); rows++ }
    }
  }
  assert.ok(rows > 0)
})

test('2.5 Edge cases: with no main lane there is one part, and a prompt row has no step number', async () => {
  const noMain = (name, a) => (name === 'session' ? { ...a, lanes: a.lanes.map((l) => (l.kind === 'main' ? { ...l, kind: 'monitor' } : l)) } : name === 'head' ? { ...a, axis: null, chapters: [] } : a)
  let rows = 0
  for (const seed of SEEDS) {
    const { s } = await session(seed, { edit: noMain })
    const m = overviewModel(s)
    assert.equal(m.single, true)
    for (const r of m.parts[0].prompts.kids) { assert.equal(r.n, null); rows++ }
  }
  assert.ok(rows > 0)
})

test('2.5 #2: each sub-agent lane is in exactly one part, the one holding the main step nearest its first call', async () => {
  let lanes = 0
  for await (const { desk, s, head: { chapters } } of multi()) {
    openAll(s, chapters)
    const m = overviewModel(s), mainTs = s.anchor.calls.map((c) => Date.parse(c.ts))
    for (const l of s.lanes.filter((x) => x.kind === 'subagent')) {
      const t = Date.parse(desk.rows.get(l.first).ts), d = mainTs.map((x) => Math.abs(x - t)), at = d.indexOf(Math.min(...d))
      const homes = m.parts.flatMap((p, j) => p.agents.kids.filter((r) => r.id === l.id).map((r) => [j, r.calls]))
      assert.deepEqual(homes, [[holder(chapters, s.anchor.no(at)), l.count]])
      lanes++
    }
    assert.equal(m.parts.some((p) => p.agents.partial), false)
  }
  assert.ok(lanes > 0)
})

test('2.5 #3: a part has the change row iff the step it reads draws the change line', async () => {
  const breaks = (name, a) => (name === 'session' ? { ...a, calls: a.calls.map((c, i) => (i % 2 && !c.cacheBreak ? { ...c, cacheBreak: { cause: i % 4 === 1 ? 'content-changed' : 'append', idx: 0 } } : c)) } : a)
  const seen = new Set()
  for await (const { s, head: { chapters } } of multi({ edit: breaks })) {
    for (let i = 0; i < s.anchor.calls.length; i += 3) {
      s.playhead = i
      openAll(s, chapters)
      for (const p of overviewModel(s).parts) {
        const want = hasChangeLine(s.anchor.calls[p.at], flatAt(s, p.at))
        assert.equal(p.change, want)
        seen.add(want)
      }
    }
  }
  assert.deepEqual([...seen].sort(), [false, true])
})

test('2.5 #4: a step whose lane is not held has null kids and no count, also for a first step that is not read yet', async () => {
  let unread = 0
  for (const seed of SEEDS) {
    const w = world(seed, { ...OPTS, spage: 8 }), { head } = w.files(), desk = createDesk()
    applySession(desk, await w.get()('session', { id: 'S' }))
    desk.head = head
    const s = stateOf(desk, 0)
    if (!s.anchor) continue
    s.playhead = s.anchor.calls.length - 1
    openAll(s, head.chapters)
    for (const p of overviewModel(s).parts) {
      assert.deepEqual([p.tools.kids, p.sys.kids, p.prompts.kids], [null, null, null])
      if (p.at === null) unread++
    }
  }
  assert.ok(unread > 0, 'some chapter starts lie before the rows read so far')
})

test('2.5 #4: an unparsed step and a step with no request give a reason and no rows', async () => {
  for (const fact of [{ unparsed: true }, { rec: null }]) {
    const off = (name, a) => (name === 'session' ? { ...a, calls: a.calls.map((c) => ({ ...c, ...fact })) } : a)
    for await (const { s, head: { chapters } } of multi({ edit: off })) {
      openAll(s, chapters)
      for (const p of overviewModel(s).parts) {
        assert.ok(p.off)
        assert.deepEqual([p.tools.kids, p.sys.kids], [[], []])
        assert.equal(p.change, false)
      }
    }
  }
})

test('2.5 #4: a count that waits for rows is marked partial, and the mark goes when they land', async () => {
  let agents = 0, prompts = 0
  for (const seed of SEEDS) {
    const w = world(seed, { ...OPTS, spage: 8 }), { head } = w.files(), desk = createDesk(), get = w.get()
    applySession(desk, await get('session', { id: 'S' }))
    desk.head = head
    const key = head.axis
    if (key == null || !desk.lanes.has(key)) continue
    await readLane(get, 'S', desk, { lane: key }) // the main lane's steps, while the session's older rows are not here
    const s = stateOf(desk, 0)
    if (!s.anchor?.calls.length) continue
    s.playhead = s.anchor.calls.length - 1
    openAll(s, head.chapters)
    const m = overviewModel(s), waiting = s.lanes.some((l) => l.kind === 'subagent' && !desk.rows.has(l.first))
    assert.deepEqual([...new Set(m.parts.map((p) => p.agents.partial))], [waiting])
    if (waiting) agents++
    if (m.parts.some((p) => p.prompts.partial)) prompts++
    const whole = await session(seed)
    openAll(whole.s, whole.head.chapters)
    for (const p of overviewModel(whole.s).parts) assert.deepEqual([p.agents.partial, p.prompts.partial], [false, false])
  }
  assert.ok(agents > 0 && prompts > 0)
})
