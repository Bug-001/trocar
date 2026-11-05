// web/src/screens/replay/Overview.tsx — the sidebar's Overview tab (2.5): one row per chapter, and in an open chapter its tools, system
// prompt, prompts and sub-agents, each row a jump. Only the versions are read in the step move's commit: the model runs after
// useDeferredValue, in a memo on the deferred versions. The chapter and group state lives on the desk (s.partFlips, s.navOpen); a toggle
// redraws this tree alone. The rows are drawn from overview-model.mjs and carry data-ovjump: `<step>:<block | prompt | change>`, `agent:<lane>`.
import { memo, useDeferredValue, useEffect, useReducer, useRef, type PointerEvent, type ReactNode, type Ref } from 'react'
import { Button, Disclosure, DisclosurePanel } from 'react-aria-components'
import { fmtWhen, kf } from '../../../legacy/core/fmt.mjs'
import { icon } from '../../../legacy/core/icons.mjs'
import * as W from '../../../legacy/labels/replay.mjs'
import { anchorJump, fiJump, promptJump } from '../../../legacy/replay/jump.mjs'
import { jumpToBlockIndex } from '../../../legacy/replay/outline.mjs'
import { selectTick } from '../../../legacy/replay/rails.mjs'
import { Chev } from '../../ui/Chev'
import { Svg } from '../../ui/Svg'
import { overviewModel } from './overview-model.mjs'
import { useDeskVersion } from './useDesk'
import type { DeskState, DeskView } from './view'

type Kid = any // a row of overview-model.mjs
type Part = ReturnType<typeof overviewModel>['parts'][number] & Record<string, any>
type Ctx = { s: DeskState, redraw: () => void }

function toggle(set: Set<unknown>, k: unknown) { if (!set.delete(k)) set.add(k) }
// a label's title exists only while the label is cut off (2.5 §只做导航)
function tipIfCut(e: PointerEvent) {
  const t = (e.target as HTMLElement).closest<HTMLElement>('.ovlbl')
  if (t) t.title = t.scrollWidth > t.clientWidth ? t.textContent! : ''
}

const Row = ({ jump, go, label, current, children }: { jump: string, go: () => void, label: string, current?: boolean, children?: ReactNode }) =>
  <button type="button" className="ovrow" data-ovjump={jump} aria-current={current ? 'true' : undefined} onClick={go}>
    <span className="ovlbl">{label}</span>{children}
  </button>

const Count = ({ n }: { n: number | null }) => (n == null ? <span className="ovct" aria-busy="true" /> : <span className="ovct">{n}</span>)
const Mark = ({ glyph, name, tip }: { glyph: string, name: string, tip: string }) => <span className="ovmark" role="img" aria-label={name} title={tip}><Svg html={icon(glyph, 'ico12')} /></span>

function Group({ c, g, label, group, count, none, children }: { c: Ctx, g: string, label: string, group: { open: boolean, kids: Kid[] | null }, count?: ReactNode, none?: string, children: (k: Kid) => ReactNode }) {
  return <Disclosure className="ovgroup" isExpanded={group.open} onExpandedChange={() => { toggle(c.s.navOpen, 'ov:' + g); c.redraw() }}>
    <Button slot="trigger" className="ovgh"><Chev /><span className="ovlbl">{label}</span>{count}</Button>
    <DisclosurePanel>
      {!group.open ? null : group.kids === null ? <div className="ovbusy" aria-busy="true" /> : group.kids.length ? group.kids.map(children) : <div className="ovnone">{none}</div>}
    </DisclosurePanel>
  </Disclosure>
}

function Items({ c, p }: { c: Ctx, p: Part }) {
  const { s } = c
  // a jump out of a part the reader opened lands in it: it stays open as the current part, not closed by the flip that opened it
  const into = (step: number, jump: object) => { s.partFlips?.delete(p.k); s.jumpTo(step, jump) }
  const block = (fi: number) => (p.current ? jumpToBlockIndex(s, fi) : into(p.at, fiJump(fi)))
  const change = () => (p.current ? s.queueJump(anchorJump('cachebrk')) : into(p.at, anchorJump('cachebrk')))
  const agent = (id: string) => { if (!p.current) s.partFlips?.delete(p.k); selectTick(s, s.lanes.find((l: { id: string }) => l.id === id), 0) }
  const { prompts, agents } = p
  return <>
    {p.off ? <div className="ovnone">{p.off.why}</div> : <>
      <Group c={c} g="tools" label={W.GRP_TOOLS} group={p.tools} none={W.NO_TOOLS}>
        {(k) => <Row key={k.jump} jump={`${p.at}:${k.jump}`} go={() => block(k.jump)} label={k.label}>{k.mcp ? <span className="ovx">{W.MCP_WORD}</span> : null}</Row>}
      </Group>
      <Group c={c} g="sys" label={W.GRP_SYS} group={p.sys} none={W.NO_SYS}>
        {(k) => <Row key={k.jump} jump={`${p.at}:${k.jump}`} go={() => block(k.jump)} label={k.label}>
          {k.ccMark ? <Mark glyph="flag" name={W.CACHE_MARK} tip={W.CACHE_MARK_TIP} /> : null}
          {k.volatile ? <Mark glyph="cycle" name={W.VOLATILE_MARK} tip={W.VOLATILE_MARK_TIP} /> : null}
          {k.chars != null ? <span className="ovx">{`${kf(k.chars)} ${W.CHARS_WORD}`}</span> : null}
        </Row>}
      </Group>
    </>}
    <Group c={c} g="prompts" label={W.GRP_ASK} group={prompts} none={W.NO_PROMPTS_HERE} count={<Count n={prompts.kids && !prompts.partial ? prompts.kids.length : null} />}>
      {(k) => (k.rid != null
        ? <Row key={`${k.rid}:${k.i}`} jump={`${k.i}:prompt`} go={() => into(k.i, promptJump())} label={k.label} current={k.current}>{k.n != null ? <span className="ovx">{W.rowStep(k.n)}</span> : null}</Row>
        : <Row key={k.jump} jump={`${p.at}:${k.jump}`} go={() => block(k.jump)} label={k.label}>{k.guess ? <span className="ovx" title={W.QUERY_GUESS_TIP}>{W.GUESS}</span> : null}</Row>)}
    </Group>
    {agents.kids.length || agents.partial ? <Group c={c} g="agents" label={W.GRP_AGENTS} group={agents} count={<Count n={agents.partial ? null : agents.kids.length} />}>
      {(k) => <Row key={k.id} jump={`agent:${k.id}`} go={() => agent(k.id)} label={k.label}><span className="ovx">{W.agentCalls(k.calls)}</span></Row>}
    </Group> : null}
    {p.change ? <Row jump={`${p.at}:change`} go={change} label={W.JUMP_TO_CHANGE} /> : null}
  </>
}

function PartRow({ c, p, here }: { c: Ctx, p: Part, here: Ref<HTMLButtonElement> | undefined }) {
  const flip = () => { toggle(c.s.partFlips ??= new Set(), p.k); c.redraw() }
  return <Disclosure className="ovpart" isExpanded={p.open} onExpandedChange={flip}>
    <Button slot="trigger" ref={here} className="ovph" aria-current={p.current ? 'true' : undefined}>
      <Chev /><span className="ovlbl">{p.name}</span><span className="ovx">{`${p.a + 1 === p.b ? p.b : `${p.a + 1}–${p.b}`}${p.ts0 ? ` · ${fmtWhen(p.ts0)}` : ''}`}</span>
    </Button>
    <DisclosurePanel className="ovbody">{p.open ? <Items c={c} p={p} /> : null}</DisclosurePanel>
  </Disclosure>
}

// nav, step: the deferred versions this tree is drawn for
const Tree = memo(function Tree({ desk }: { desk: DeskView, nav: number, step: number }) {
  const [, redraw] = useReducer((n: number) => n + 1, 0)
  const here = useRef<HTMLButtonElement>(null)
  const { single, parts } = overviewModel(desk.s), c = { s: desk.s, redraw }
  const current = parts.find((p: Part) => p.current)?.k
  useEffect(() => { here.current?.scrollIntoView({ block: 'nearest' }) }, [current])
  return <div className="ovw" onPointerOver={tipIfCut}>
    {single ? (parts[0] ? <Items c={c} p={parts[0]} /> : null) : parts.map((p: Part) => <PartRow key={p.k} c={c} p={p} here={p.current ? here : undefined} />)}
  </div>
})

export function Overview({ desk }: { desk: DeskView }) {
  const nav = useDeferredValue(useDeskVersion(desk, 'nav')), step = useDeferredValue(useDeskVersion(desk, 'step'))
  return <Tree desk={desk} nav={nav} step={step} />
}
