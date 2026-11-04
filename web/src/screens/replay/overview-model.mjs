// web/src/screens/replay/overview-model.mjs — the sidebar Overview's model (2.5): one part per chapter, and for an open part what it holds.
// `at` is the step a part reads: the playhead in the current part, the first step in another, null while that step is not in the lane.
// A group's `kids` is null while the rows cannot be known yet; `partial` says the rows are there but their count is not final.
import { outlineEntries } from '../../../legacy/replay/outline.mjs'
import { nearestByTs, stepRef } from '../../../legacy/replay/lanes.mjs'
import { laneEvents } from '../../../legacy/replay/model.mjs'
import { chapterAt, chapterHere } from '../../../legacy/replay/timeline.mjs'
import * as W from '../../../legacy/labels/replay.mjs'

const OPEN_BY_DEFAULT = new Set(['prompts', 'agents'])
const groupOpen = (s, g) => OPEN_BY_DEFAULT.has(g) !== s.navOpen.has('ov:' + g)

// the sub-agent lanes per chapter index. A lane goes to the chapter of the main step nearest its first call, so it needs that first row
// here; `partial` while one of them is not, because it could still join any chapter
const AGENTS = new WeakMap()
function agentsOf(s, chs) {
  const table = s.desk.head?.chapters, memo = AGENTS.get(s.lanes)
  if (memo && memo.table === table) return memo
  const a = s.anchor, by = new Map()
  let partial = false
  for (const l of s.lanes) {
    if (l.kind !== 'subagent') continue
    const first = s.desk.rows.get(l.first)
    if (!first) { partial = true; continue }
    const j = chapterAt(chs, a.no ? a.no(nearestByTs(a, first.ts)) : 0)
    by.set(j, [...(by.get(j) || []), { id: l.id, label: l.task || W.laneWord(l.kind), calls: l.count }])
  }
  const out = { table, by, partial }
  AGENTS.set(s.lanes, out)
  return out
}

// are all of the chapter's steps here, with their events? Older pages land after the tail, so a count before that would be half of one
function wholeChapter(s, c, pos) {
  const lo = pos(c.s0), hi = pos(c.s1), held = s.desk.held.get(s.anchor.id)
  return !!held && hi - lo === c.s1 - c.s0 && s.anchor.calls.slice(lo, hi).every((x) => held.steps.has(x.rid))
}

const stepNo = (s, rid) => { const r = stepRef(s.lanes, rid); return r && r.step ? r.n : null }

// the lane's user events inside the chapter; a line without such events falls back on the query blocks of the step the chapter reads
function promptsOf({ s, users, pos }, c, current, asks) {
  if (!users.length) return { kids: asks && asks.map(({ label, guess, jump }) => ({ label, guess, jump })), partial: false }
  const kids = users.filter((u) => u.g >= c.s0 && u.g < c.s1).map(({ e, i }) => ({ label: e.preview ?? '', n: stepNo(s, e.rid), rid: e.rid, i, current: false }))
  if (current) { const here = kids.findLast((r) => r.i <= s.playhead); if (here) here.current = true }
  const whole = wholeChapter(s, c, pos)
  return { kids: kids.length || whole ? kids : null, partial: !whole }
}

function partItems(x, c, j, at, current) {
  const { s, agents } = x, e = at == null ? null : outlineEntries(s, at)
  const kids = (key) => { const g = e && e.groups.find((y) => y.key === key); return !g ? null : g.kids === '' ? [] : g.kids }
  return {
    off: e && e.off, change: !!e && e.changeLine,
    tools: { open: groupOpen(s, 'tools'), kids: kids('tools') },
    sys: { open: groupOpen(s, 'sys'), kids: kids('sys') },
    prompts: { open: groupOpen(s, 'prompts'), ...promptsOf(x, c, current, kids('msg')) },
    agents: { open: groupOpen(s, 'agents'), kids: agents.by.get(j) || [], partial: agents.partial },
  }
}

export function overviewModel(s) {
  const a = s.anchor
  if (!a || !a.calls.length) return { single: true, parts: [] }
  const { chs, g, pos } = chapterHere(s), now = chapterAt(chs, g), single = chs.length === 1
  const users = laneEvents(s.desk, a.id).flatMap((e) => {
    const i = e.type === 'user' ? a.ridLocal.get(e.rid) : null
    return i == null ? [] : [{ e, i, g: a.no(i) }]
  })
  const x = { s, pos, users, agents: agentsOf(s, chs) }
  return { single, parts: chs.map((c, j) => {
    const k = c.k ?? j, current = j === now, open = single || current !== !!s.partFlips?.has(k), at = current ? s.playhead : a.ridLocal.get(c.rid0) ?? null
    const part = { k, name: W.partName(k, c.inferred), a: c.s0, b: c.s1, ts0: c.ts0, inferred: c.inferred, current, open, at }
    return open ? { ...part, ...partItems(x, c, j, at, current) } : part
  }) }
}
