// screens/traffic/HostScreen.tsx — the host page (1.10 §host 页) · #/traffic/host/<agent>/<host>: what one agent sent to one host. The
// request list (`calls {harness, host}`, newest first, paged by `next` as the reader scrolls, virtualized and keyed by ref) and, for the
// selected row, its request detail (`calls {ref}`, 2.6 §C RequestView): a column beside the list at ≥ DETAIL_BREAK px, a drawer below.
// Reads (1.10 §组件与状态): one infinite query per window + class, read on mount and never polled; one query per ref; 「Show」 reads
// `calls {ref, reveal}` once per header. The route carries the selection (ref, replaced, not pushed); ↑ / ↓ move it, Esc drops it.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type MouseEvent } from 'react'
import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { useVirtualizer } from '@tanstack/react-virtual'
import { Button, Menu, MenuItem, MenuTrigger, Popover } from 'react-aria-components'
import { api } from '../../../legacy/core/api.mjs'
import { CLASS_IDS } from '../../../legacy/core/classes.mjs'
import { setScreenKeys } from '../../../legacy/core/keys.mjs'
import { revealHeader } from '../../../legacy/core/sensitive.mjs'
import * as W from '../../../legacy/labels/traffic.mjs'
import { HarnessIcon } from '../../ui/HarnessIcon'
import type { ScreenProps } from '../../ScreenOutlet'
import { queryOf, asOfText, routeHarness, windowLinks as windowLinksJs, failOf as failOfJs } from './model.mjs'
import { ROW_H, DETAIL_BREAK, callsParams as callsParamsJs, mergePages as mergePagesJs, hostHref as hostHrefJs, crumbsOf as crumbsOfJs, hostRowView as hostRowViewJs, emptyText } from './host-model.mjs'
import { detailModel as detailModelJs, requestView as requestViewJs } from './request-model.mjs'
import { useBoardRouter } from './board-router'
import { TrafficHead, type Crumb, type Scope } from './TrafficHead'
import { ReadFail, type Fail } from './ReadFail'
import { RequestView, type View } from './RequestView'

type Answer = { ok: boolean, status?: number, data?: { next?: string | null, error?: string | null } | null, error?: string | null }
type Rec = { ref: string, harness_inferred?: boolean }
type List = { state: 'none' } | { state: 'table', rows: Rec[], total: number, asOf: string | null, next: string | null }
type RowView = { ref: string, href: string, when: { text: string, iso: string | null }, endpoint: string, cls: string, sent: string, recv: string,
  retention: { kind: 'log', label: string, href: string } | { kind: 'legacy-meta', label: string, tip: string } | null, failed: boolean }
type Detail = { rec: unknown, error?: string | null }
// a list page that is not a records page fails the read (1.5 K-29): the pages already drawn stay, and `next` is only ever read off a good page
class ReadError extends Error { constructor(readonly answer: unknown) { super('read failed') } }
type Where = { harness: string, host: string, window: string, cls: string | null }
const callsParams = callsParamsJs as unknown as (o: Where & { after: string | null }) => Record<string, string>
const hostHref = hostHrefJs as unknown as (o: Where) => string
const mergePages = mergePagesJs as (docs: unknown[]) => List
const crumbsOf = crumbsOfJs as (o: { harness: string, host: string, window: string, cls: string | null }) => Array<Crumb & { harness?: string }>
const hostRowView = hostRowViewJs as (r: Rec, o: { harness: string, host: string, window: string, cls: string | null, now: number }) => RowView
const windowLinks = windowLinksJs as (value: string, hrefOf: (w: string) => string) => Scope['options']
const failOf = failOfJs as (what: string, r: unknown) => Fail
const detailModel = detailModelJs as (doc: unknown) => Detail
const requestView = requestViewJs as (m: Detail, o: { revealed: string | null }) => View

const ONCE = { staleTime: Infinity, refetchOnMount: 'always', refetchOnWindowFocus: false, retry: false } as const
// the keyboard rule stops inside a control (1.2 §键盘); the row links themselves are where ↑ / ↓ start
const IN_CONTROL = '[role=menu],[role=dialog],.pop,button,input,select,textarea,a.rmark'

// the detail's placement follows the media query; no matchMedia at all is the static column
const MEDIA = `(min-width: ${DETAIL_BREAK}px)`
const mql = () => (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(MEDIA) : null)
const subscribeMedia = (fn: () => void) => { const m = mql(); m?.addEventListener?.('change', fn); return () => m?.removeEventListener?.('change', fn) }
const modeNow = () => (mql()?.matches === false ? 'drawer' : 'column')

function ClassMenu({ items }: { items: Array<{ id: string, label: string, href: string }> }) {
  return (
    <MenuTrigger>
      <Button className="popbtn" aria-label={W.FILTER_CLASS}>{W.FILTER_CLASS} <span className="chev" aria-hidden="true">▾</span></Button>
      <Popover className="pop menu" placement="bottom end">
        <Menu aria-label={W.FILTER_CLASS} items={items}>{(i) => <MenuItem id={i.id} href={i.href} textValue={i.label}>{i.label}</MenuItem>}</Menu>
      </Popover>
    </MenuTrigger>
  )
}

export default function HostScreen({ route }: ScreenProps) {
  const router = useBoardRouter()
  const harness = routeHarness(route.harness) as string, host = String(route.host ?? '')
  const q = queryOf(route.params) as { window: string, cls: string | null }
  const ref: string | null = route.params.ref || null
  const mode = useSyncExternalStore(subscribeMedia, modeNow, () => 'column')

  const list = useInfiniteQuery({
    queryKey: ['calls-host', harness, host, q.window, q.cls],
    queryFn: async ({ pageParam, signal }) => {
      const r = await api.get('calls', callsParams({ harness, host, cls: q.cls, window: q.window, after: pageParam }), { signal }) as Answer
      if (!r.ok || !Array.isArray((r.data as { records?: unknown } | null | undefined)?.records)) throw new ReadError(r.ok ? { status: null, error: r.data?.error } : r)
      return r
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last: Answer) => last.data?.next ?? undefined,
    ...ONCE,
  })
  const pages = list.data?.pages
  const merged = useMemo(() => (pages ? mergePages(pages.map((p) => p.data)) : null), [pages])
  const rows = useMemo(() => (merged && merged.state === 'table' ? merged.rows : []), [merged])

  // the list scrolls inside .tlist, under the caption and the column head: the virtual rows start at the list's own top
  const scrollRef = useRef<HTMLDivElement>(null), listRef = useRef<HTMLDivElement>(null)
  const [margin, setMargin] = useState(0)
  // eslint-disable-next-line react-hooks/incompatible-library -- the virtualizer re-measures on every render by design; nothing memoizes it
  const virt = useVirtualizer({
    count: rows.length, getScrollElement: () => scrollRef.current, estimateSize: () => ROW_H,
    getItemKey: (i) => rows[i].ref, overscan: 8, scrollMargin: margin,
  })
  useLayoutEffect(() => {
    const s = scrollRef.current, l = listRef.current
    if (s && l) setMargin(l.getBoundingClientRect().top - s.getBoundingClientRect().top + s.scrollTop)
  }, [rows.length > 0]) // eslint-disable-line react-hooks/exhaustive-deps -- the list's top moves only when the table appears
  const items = virt.getVirtualItems()
  const lastIndex = items.length ? items[items.length - 1].index : -1
  const { hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage } = list
  // a failed next page waits for its Retry: reading it again on every scroll would loop on a server that stays down
  useEffect(() => {
    if (lastIndex >= 0 && lastIndex >= rows.length - 6 && hasNextPage && !isFetchingNextPage && !isFetchNextPageError) void fetchNextPage()
  }, [lastIndex, rows.length, hasNextPage, isFetchingNextPage, isFetchNextPageError, fetchNextPage])

  // the detail: the base read, and at most one revealed header for this ref
  const base = useQuery({ queryKey: ['calls-ref', ref], queryFn: ({ signal }) => api.get('calls', { ref }, { signal }) as Promise<Answer>, enabled: !!ref, ...ONCE })
  // 「Show」 holds for the ref it was pressed on: any move of the selection masks it again, and nothing keeps the value once it is not shown
  const [revealed, setRevealed] = useState<{ ref: string, name: string } | null>(null)
  if (revealed && revealed.ref !== ref) setRevealed(null)
  const name = revealed && revealed.ref === ref ? revealed.name : null
  const reveal = useQuery({
    queryKey: ['calls-ref', ref, 'show', name],
    queryFn: ({ signal }) => revealHeader(api, ref, name, { signal }) as Promise<Answer>,
    enabled: !!ref && !!name, ...ONCE, gcTime: 0,
  })

  useEffect(() => {
    setScreenKeys((e: KeyboardEvent) => {
      if (e.key === 'Escape') { if (ref) { e.preventDefault(); router.setParams({ ref: null }) } return }
      if (e.metaKey || e.ctrlKey || e.altKey || !rows.length) return
      if ((e.target as Element | null)?.closest?.(IN_CONTROL)) return
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
      e.preventDefault()
      const i = rows.findIndex((r) => r.ref === ref)
      const next = e.key === 'ArrowDown' ? Math.min(rows.length - 1, i + 1) : Math.max(0, i - 1)
      if (rows[next].ref !== ref) { router.setParams({ ref: rows[next].ref }); virt.scrollToIndex(next) }
    })
    return () => setScreenKeys(null)
  }, [rows, ref, router, virt])

  // a plain left click selects here (the route's ref is replaced); a modified click is the browser's to follow
  const onSelect = (e: MouseEvent<HTMLAnchorElement>, at: string) => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button) return
    e.preventDefault()
    router.setParams({ ref: at })
  }

  const scope: Scope = { label: 'window', options: windowLinks(q.window, (w) => hostHref({ harness, host, window: w, cls: q.cls })) }
  const crumbs = crumbsOf({ harness, host, window: q.window, cls: q.cls })
    .map((c) => (c.harness ? { ...c, node: <><HarnessIcon id={c.harness} />{c.label}</> } : c))
  const readAt = pages ? list.dataUpdatedAt : null

  let body
  if (!merged || merged.state === 'none') {
    body = list.error instanceof ReadError && !list.isFetching
      ? <ReadFail fail={failOf(W.TRAFFIC, list.error.answer)} onRetry={() => { void list.refetch() }} />
      : <div className="tstate">{W.LOADING}</div>
  } else if (!rows.length) body = <div className="tstate" data-empty="" data-class={q.cls ?? undefined}>{emptyText(q.cls)}</div>
  else {
    const asOf = asOfText(merged.asOf)
    const kept = (cls: string | null) => hostHref({ harness, host, window: q.window, cls })
    const now = api.now()
    body = <>
      <div className="tcap">
        {asOf ? <time className="cap-item" dateTime={merged.asOf ?? undefined}>{`${W.AS_OF} ${asOf}`}</time> : null}
        <span className="cap-item">{W.TOTAL_N(merged.total)}</span>
        {!rows.some((r) => 'harness_inferred' in r) ? <span className="cap-item" data-note="agent-source">{W.AGENT_SOURCE_NOTE}</span> : null}
        <div className="tfilters">
          <ClassMenu items={CLASS_IDS.map((id: string) => ({ id, label: W.classWord(id), href: kept(id) }))} />
          {q.cls ? <>
            <a className="fchip" href={kept(null)} title="Remove this filter">{`${W.FILTER_CLASS}:${W.classWord(q.cls)}`} <span className="x" aria-hidden="true">×</span></a>
            <span className="cap-item cap-note">{W.CLASS_FILTER_NOTE(W.classWord(q.cls))}</span>
          </> : null}
        </div>
      </div>
      <div className="hhead" aria-hidden="true">
        <span className="cell">time</span><span className="cell-endpoint">endpoint</span><span className="cell class">class</span>
        <span className="cell num">{W.COL.sent}</span><span className="cell num">{W.COL.recv}</span><span className="cell marks"></span><span className="cell go"></span>
      </div>
      <div className="hlist" id="hlist" role="list" aria-label="Requests" ref={listRef} style={{ position: 'relative', height: virt.getTotalSize() }}>
        {items.map((it) => {
          const v = hostRowView(rows[it.index], { harness, host, window: q.window, cls: q.cls, now }), sel = v.ref === ref
          return (
            <div key={it.key} className="vrow" role="listitem" style={{ position: 'absolute', left: 0, right: 0, top: it.start - margin, height: ROW_H }}>
              <div className={sel ? 'hrow sel' : 'hrow'}>
                <a className="hmain" href={v.href} aria-current={sel ? 'true' : undefined} onClick={(e) => onSelect(e, v.ref)}>
                  <span className="tcell" title={v.when.iso ?? undefined}>{v.when.text}</span>
                  <span className="cell-endpoint mono" title={v.endpoint}>{v.endpoint}</span>
                  <span className="cell class">{v.cls}</span>
                  <span className="cell num">{v.sent}</span>
                  <span className="cell num">{v.recv}</span>
                </a>
                <span className="cell marks">
                  {v.retention?.kind === 'log' ? <a className="rmark" data-mark="log" href={v.retention.href} title="See what this class keeps in the storage settings">{`${v.retention.label} ›`}</a> : null}
                  {v.retention?.kind === 'legacy-meta' ? <span className="rmark" data-mark="legacy-meta" title={v.retention.tip}>{v.retention.label}</span> : null}
                  {v.failed ? <span className="rmark fail" data-mark="failed" title="The exact status is in the request details">{W.FAILED}</span> : null}
                </span>
              </div>
            </div>
          )
        })}
      </div>
      {isFetchNextPageError && list.error instanceof ReadError
        ? <ReadFail fail={failOf(W.TRAFFIC, list.error.answer)} onRetry={() => { void fetchNextPage() }} />
        : null}
    </>
  }

  let detail = null
  if (!ref) detail = mode === 'column' ? <div className="d-empty">{W.PICK_ONE}</div> : null
  else if (!base.data) detail = <div className="d-empty">{W.LOADING}</div>
  else {
    const r = base.data, m = r.ok ? detailModel(r.data) : null
    const rm = reveal.data && reveal.data.ok ? detailModel(reveal.data.data) : null
    detail = <>
      <div className="d-head"><Button className="iconbtn dclose" aria-label={W.CLOSE_DETAIL} onPress={() => router.setParams({ ref: null })}>×</Button></div>
      {m && m.rec
        ? <RequestView view={rm && rm.rec ? requestView(rm, { revealed: name }) : requestView(m, { revealed: null })} onReveal={(n) => setRevealed({ ref, name: n })} />
        : <ReadFail cls="d-err" fail={failOf(W.THIS_REQUEST, { status: r.ok ? null : r.status, error: (m && m.error) || r.error })} onRetry={() => { void base.refetch() }} />}
    </>
  }

  return (
    <div className={`thost ${mode}`}>
      <TrafficHead crumbs={crumbs} scope={scope} readAt={readAt} />
      <div className="tbody">
        <div className="tlist" ref={scrollRef}>{body}</div>
        <aside className={ref ? 'hdetail open' : 'hdetail'} id="hdetail" aria-label="Request details">{detail}</aside>
      </div>
    </div>
  )
}
