// screens/traffic/TrafficScreen.tsx — 流量 (1.10 §流量表): every host an agent sent to in the window, grouped by agent, with the caption
// row (as of, coverage, the agent-source note, the agent / class menus) and the total. It renders tableModel (model.mjs) of ONE `traffic`
// answer. Reads (1.10 §组件与状态): `traffic` keyed by the window, read on mount and never polled; `sessions` through freshSessions()
// for the coverage note. Rows are keyed by agent + host, and the keyboard highlight is held as that key, so a re-read never moves it.
import { useEffect, useMemo, useState, type MouseEvent } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Button, Menu, MenuItem, MenuTrigger, Popover } from 'react-aria-components'
import { api, scoped } from '../../../legacy/core/api.mjs'
import { harnessName } from '../../../legacy/core/chips.mjs'
import { formatHash, parseHash } from '../../../legacy/core/router.mjs'
import { setScreenKeys } from '../../../legacy/core/keys.mjs'
import { mark } from '../../../legacy/core/ui.mjs'
import { freshSessions as freshSessionsJs } from '../../../legacy/library/logic.mjs'
import { SCREEN_NAME } from '../../../legacy/labels/shell.mjs'
import * as W from '../../../legacy/labels/traffic.mjs'
import { HarnessIcon } from '../../ui/HarnessIcon'
import type { ScreenProps } from '../../ScreenOutlet'
import { queryOf, sinceOf, tableModel as tableModelJs, coverOf as coverOfJs, filterLinks as filterLinksJs, windowLinks as windowLinksJs, failOf as failOfJs } from './model.mjs'
import { useBoardRouter } from './board-router'
import { TrafficHead, type Scope } from './TrafficHead'
import { InfoButton } from './InfoButton'
import { ReadFail, type Fail } from './ReadFail'

type Cell = { main: string, note: string }
type Row = { key: string, harness: string, hkey: string, first: boolean, inferred: boolean, host: string | null, href: string | null,
  firstText: string, firstTip: string | null, isNew: boolean, requests: number, sent: string, recv: Cell,
  classes: { shown: Array<{ word: string, n: number }>, more: boolean, all: string } }
type Model = { state: 'none' } | { state: 'table', flat: Row[], total: { requests: number, sent: Cell, recv: Cell, filtered: boolean },
  asOf: string | null, asOfText: string, sourceNote: boolean }
type Doc = { hosts?: Array<{ harness: string }>, error?: string } | null
type Answer = { ok: boolean, status?: number, data?: unknown, error?: string | null }
type Link = { id: string, label: string, href: string }
type Filters = { agents: Link[], classes: Link[], kept: string | null, chips: Array<{ label: string, href: string }>, note: string | null }
type Q = { window: string, h: string[], cls: string | null }
const tableModel = tableModelJs as (doc: Doc, o: Q & { now: number }) => Model
const coverOf = coverOfJs as (hosts: unknown, sessions: Answer | undefined) => string[]
const filterLinks = filterLinksJs as (o: Q & { agents: string[] }) => Filters
const windowLinks = windowLinksJs as (value: string, hrefOf: (w: string) => string) => Scope['options']
const failOf = failOfJs as (what: string, r: unknown) => Fail
const freshSessions = freshSessionsJs as (a: unknown, o: { alive: () => boolean }) => Promise<Answer>

// a failed read is a query error that carries the answer, so the last ok document of this window stays the query's data
class ReadError extends Error { constructor(readonly answer: Answer) { super(String(answer.error)) } }
const ONCE = { staleTime: Infinity, refetchOnMount: 'always', refetchOnWindowFocus: false, retry: false } as const
// the keyboard rule stops inside a control (1.2 §键盘): a menu, a popover, a button, a link, a field
const IN_CONTROL = '[role=menu],[role=dialog],.pop,button,a,input,select,textarea'

const Num = ({ c }: { c: Cell }) => <>{c.main}{c.note ? <> <span className="c2">{c.note}</span></> : null}</>
const Mark = ({ kind, tip, data }: { kind: string, tip: string, data?: string }) => <span data-mark={data} dangerouslySetInnerHTML={{ __html: mark(kind, tip) }} />

function FilterMenu({ label, items }: { label: string, items: Link[] }) {
  return (
    <MenuTrigger>
      <Button className="popbtn" aria-label={label}>{label} <span className="chev" aria-hidden="true">▾</span></Button>
      <Popover className="pop menu" placement="bottom end">
        <Menu aria-label={label} items={items}>{(i) => <MenuItem id={i.id} href={i.href} textValue={i.label}>{i.label}</MenuItem>}</Menu>
      </Popover>
    </MenuTrigger>
  )
}

function TrafficRow({ row, hi, onOpen }: { row: Row, hi: boolean, onOpen: (e: MouseEvent<HTMLAnchorElement>, href: string) => void }) {
  const inner = <>
    <span className="gut"></span>
    <span className="nm">
      {row.first ? <><HarnessIcon id={row.harness} /><span className="nmname">{harnessName(row.harness)}</span></> : null}
      {row.inferred ? <> <Mark kind="inf" tip={W.AGENT_AGENT_TIP} data="inferred" /></> : null}
    </span>
    <span className="cell-host">{row.host ? <span className="host mono" title={row.host}>{row.host}</span> : <span className="host nohost">{W.NO_HOST}</span>}</span>
    <span className="cell-first" title={row.firstTip ?? undefined}>
      {row.firstText}{row.isNew ? <> <span className="newmark" data-mark="new">{W.NEW} <Mark kind="inf" tip={W.NEW_TIP} /></span></> : null}
    </span>
    <span className="cell num">{row.requests}</span>
    <span className="cell num">{row.sent}</span>
    <span className="cell num"><Num c={row.recv} /></span>
    <span className="cell classes" title={row.classes.all}>
      {row.classes.shown.map((c, i) => <span key={i}>{i ? <span className="sep-dot" aria-hidden="true"> · </span> : null}{`${c.word} ${c.n}`}</span>)}
      {row.classes.more ? <span className="more-classes"> …</span> : null}
    </span>
  </>
  const cls = `trow${hi ? ' hi' : ''}`
  return row.href
    ? <a className={cls} href={row.href} data-href={row.href} data-h={row.hkey} onClick={(e) => onOpen(e, row.href!)}>{inner}</a>
    : <div className={`${cls} nolink`} data-h={row.hkey}>{inner}</div>
}

export default function TrafficScreen({ route }: ScreenProps) {
  const router = useBoardRouter()
  const q = queryOf(route.params) as Q
  const traffic = useQuery({
    queryKey: ['traffic', q.window],
    queryFn: async ({ signal }) => {
      const r = await api.get('traffic', { since: sinceOf(q.window), limit: 500 }, { signal }) as Answer
      if (!r.ok) throw new ReadError(r)
      return (r.data ?? null) as Doc
    },
    ...ONCE,
  })
  const sessions = useQuery({
    queryKey: ['sessions', 'fresh'],
    queryFn: ({ signal }) => freshSessions(scoped(api, signal), { alive: () => !signal.aborted }),
    ...ONCE,
  })
  const doc = traffic.data
  const hkeys = q.h.join(',')
  const model = useMemo(() => (doc === undefined ? null : tableModel(doc, { window: q.window, h: q.h, cls: q.cls, now: api.now() })),
    [doc, q.window, hkeys, q.cls]) // eslint-disable-line react-hooks/exhaustive-deps -- q.h is read through its joined value
  const flat = model && model.state === 'table' ? model.flat : null

  // the highlight is a row key: a re-read that reorders or redraws the rows leaves it on the same host
  const [hi, setHi] = useState<string | null>(null)
  useEffect(() => {
    setScreenKeys((e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.key === 'Escape' || !flat || !flat.length) return
      if ((e.target as Element | null)?.closest?.(IN_CONTROL)) return
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const cur = flat.findIndex((r) => r.key === hi)
        const next = e.key === 'ArrowDown' ? Math.min(flat.length - 1, cur + 1) : Math.max(0, cur - 1)
        setHi(flat[next].key)
      } else if (e.key === 'Enter') {
        const row = flat.find((r) => r.key === hi)
        if (row && row.href) { e.preventDefault(); router.go(parseHash(row.href)) }
      }
    })
    return () => setScreenKeys(null)
  }, [flat, hi, router])

  // a plain left click opens the host page here (the row is already a link); a modified click is the browser's to follow
  const onOpen = (e: MouseEvent<HTMLAnchorElement>, href: string) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button) return
    e.preventDefault()
    router.go(parseHash(href))
  }

  const scope: Scope = {
    label: 'window',
    options: windowLinks(q.window, (w) => formatHash({ screen: 'traffic', params: { window: w, ...(q.h.length ? { h: hkeys } : {}), ...(q.cls ? { class: q.cls } : {}) } })),
  }
  const readAt = doc !== undefined ? traffic.dataUpdatedAt : null
  const retry = () => { void traffic.refetch() }

  let body
  if (model === null) {
    body = traffic.error instanceof ReadError && !traffic.isFetching
      ? <ReadFail fail={failOf(W.TRAFFIC, traffic.error.answer)} onRetry={retry} />
      : <div className="tstate">{W.LOADING}</div>
  } else if (model.state === 'none') {
    body = <ReadFail fail={failOf(W.TRAFFIC, { status: null, error: doc && doc.error })} onRetry={retry} />
  } else {
    const hosts = doc && doc.hosts
    const cover = coverOf(hosts, sessions.data)
    const caption = <>
      {model.asOfText ? <time className="cap-item" dateTime={model.asOf ?? undefined}>{`${W.AS_OF} ${model.asOfText}`}</time> : null}
      {cover.length ? <span className="cap-item">{W.COVERS_PREFIX}{cover.map((id) => (
        <span key={id} className="cap-agent" data-h={id}><HarnessIcon id={id} />{harnessName(id)}</span>
      ))}</span> : null}
      {model.sourceNote ? <span className="cap-item" data-note="agent-source">{W.AGENT_SOURCE_NOTE}</span> : null}
    </>
    if (!model.flat.length) {
      body = <>
        <div className="tstate" data-empty="" data-class={q.cls ?? undefined}>{q.cls ? W.EMPTY_WINDOW_CLASS(W.classWord(q.cls)) : W.EMPTY_WINDOW}</div>
        <div className="tcap">{caption}</div>
      </>
    } else {
      const fl = filterLinks({ ...q, agents: (hosts ?? []).map((r) => r.harness) })
      const t = model.total
      body = <>
        <div className="tcap">
          {caption}
          <div className="tfilters">
            <FilterMenu label={W.FILTER_AGENT} items={fl.agents} />
            <FilterMenu label={W.FILTER_CLASS} items={fl.kept ? [...fl.classes, { id: '*kept', label: W.WHAT_IS_KEPT, href: fl.kept }] : fl.classes} />
            {fl.chips.map((c) => <a key={c.href} className="fchip" href={c.href} title="Remove this filter">{c.label} <span className="x" aria-hidden="true">×</span></a>)}
            {fl.note ? <span className="cap-item cap-note">{fl.note}</span> : null}
          </div>
        </div>
        <div className="trow thead">
          <span className="gut"></span><span className="nm">{W.COL.agent}</span>
          <span className="cell-host">{W.COL.host}</span><span className="cell-first">{W.COL.first}</span>
          <span className="cell num">{W.COL.requests}</span>
          <span className="cell num">{W.COL.sent}<InfoButton label="What sent counts" title={W.COL.sent} body={W.BYTES_TIP} /></span>
          <span className="cell num">{W.COL.recv}<InfoButton label="What received counts" title={W.COL.recv} body={W.BYTES_TIP} /></span>
          <span className="cell classes">{W.COL.classes}</span>
        </div>
        {model.flat.map((r) => <TrafficRow key={r.key} row={r} hi={r.key === hi} onOpen={onOpen} />)}
        <div className="trow ttotal">
          <span className="gut"></span><span className="nm"></span>
          <span className="cell-host">{W.COL.total}{t.filtered ? <> <span className="c2">{W.ONLY_THESE}</span></> : null}</span><span className="cell-first"></span>
          <span className="cell num">{t.requests}</span><span className="cell num"><Num c={t.sent} /></span>
          <span className="cell num"><Num c={t.recv} /></span><span className="cell"></span>
        </div>
      </>
    }
  }
  return <div className="page traf"><TrafficHead name={SCREEN_NAME.traffic} scope={scope} readAt={readAt} />{body}</div>
}
