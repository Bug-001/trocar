// screens/library/LibraryScreen.tsx — the session library (1.8) · #/sessions: 「我要看哪一次运行?」 One row per run, one click into
// the replay desk. Every filter lives in the route's params (q h project window sort sel, 1.2 §路由): the route is the single source of
// truth, the controls write it through router.setParams (a filter is not a navigation: the hash is replaced). No statistic lives here
// (D24). A re-read never disturbs the reader: rows keyed by session (never the index), a scroll that follows the highlighted row's key,
// the answer held while a selection lies in the list (useSelectionHold), memoized rows that a poll changing nothing leaves alone.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { api } from '../../../legacy/core/api.mjs'
import { store } from '../../../legacy/core/store.mjs'
import { toast } from '../../../legacy/core/ui.mjs'
import { setScreenKeys } from '../../../legacy/core/keys.mjs'
import { SCREEN_NAME } from '../../../legacy/labels/shell.mjs'
import * as W from '../../../legacy/labels/library.mjs'
import { useSelectionHold } from '../../ui/useSelectionHold'
import { PageHead } from '../../ui/PageHead'
import type { ScreenProps } from '../../ScreenOutlet'
import type { Route } from '../../LegacyScreen'
import { parseFilters, flattenSessions, applyFilters, listEntries, selectedKey, sessionKey, filterSignature, scrollDecision, capShotMaker } from './model.mjs'
import { useSessions, type Session, type SessionsData } from './useSessions'
import { LibraryTools, TitleInfo, WindowSeg } from './LibraryTools'
import { Caption, FilteredState, LoadingState, NoSessionsState, ReadFailState, VRows, type Entry } from './LibraryParts'

type Shot = ReturnType<ReturnType<typeof capShotMaker>['read']> extends Promise<infer S> ? S : never
const STEP: Record<string, (i: number, n: number) => number> = {
  ArrowDown: (i) => i + 1, ArrowUp: (i) => i - 1, PageDown: (i) => i + 10, PageUp: (i) => i - 10, Home: () => 0, End: (_, n) => n - 1,
}

export default function LibraryScreen({ route, router }: ScreenProps) {
  const params = route.params as Record<string, string>
  const f = useMemo(() => parseFilters(params), [params])
  const set = router.setParams
  const q = useSessions()

  // the answer's time moves only when the data changed, so the rows (handed it as `now`) re-render only then
  const [stamp, setStamp] = useState<{ data?: SessionsData, at: number }>({ at: 0 })
  if (q.data !== stamp.data) setStamp({ data: q.data, at: q.dataUpdatedAt })
  // 数据读于 = the last answer without `stored` (a stored answer is older than the read that brought it)
  const [readAt, setReadAt] = useState<number | null>(null)
  if (q.data && !q.data.stored && q.dataUpdatedAt !== readAt) setReadAt(q.dataUpdatedAt)
  const err = q.error?.answer ?? null
  // the head's time is held with the rows it dates: a held answer keeps the time it was read at (1.2 §点击与选中文字 ③)
  const latest = useMemo(() => ({ data: stamp.data ?? null, err, at: stamp.at, readAt }), [stamp, err, readAt])
  const { shown, ref: holdRef } = useSelectionHold(latest)

  const now = shown.at
  const all = useMemo(() => flattenSessions(shown.data) as Session[], [shown.data])
  const rows = useMemo(() => applyFilters(all, f, now) as Session[], [all, f, now])
  const entries = useMemo(() => listEntries(rows, f.sort, now) as Entry[], [rows, f.sort, now])
  const sel = selectedKey(rows, f.sel) as string | null

  const open = useCallback((s: Session) => {
    router.setParams({ sel: sessionKey(s) }) // the way back lands on the same row
    router.go({ area: 'replay', screen: 'replay', project: s.project_slug, id: s.session_id, params: {} } as Route)
  }, [router])
  const clear = useCallback(() => set({ q: null, h: null, project: null, window: null }), [set])
  const retry = useCallback(() => { void q.refetch() }, [q])

  // the one-shot capture-health read: the 空态 and the filtered agent read it once, when they want it
  const [cap] = useState(() => capShotMaker(() => api.get('status'), () => api.now()))
  const [shot, setShot] = useState<Shot | null>(cap.settled)
  const wantsShot = !!shown.data && (!all.length || (!rows.length && f.h.length === 1))
  useEffect(() => { if (wantsShot) void cap.read().then(setShot) }, [wantsShot, cap])

  // a one-time line another screen may have left (1.8: a toast, never a banner): take it, so it shows once
  useEffect(() => {
    const notice = store.get().libraryNotice
    if (notice) { store.set({ libraryNotice: null }); toast(notice) }
  }, [])

  const listRef = useRef<HTMLDivElement | null>(null)
  const setList = useCallback((el: HTMLDivElement | null) => { listRef.current = el; holdRef(el) }, [holdRef])
  // eslint-disable-next-line react-hooks/incompatible-library -- VRows is not memoized: it reads the virtualizer on every render
  const v = useVirtualizer({
    count: entries.length, getScrollElement: () => listRef.current, overscan: 8, useFlushSync: false,
    estimateSize: (i) => (entries[i]?.g ? 28 : 50), getItemKey: (i) => entries[i]?.key ?? i,
  })

  // scroll: follows the highlighted row's KEY. A new list (first answer, Back) lands on it, a filter change starts at the top, a key
  // press brings the moved highlight into view (and focus with it, when focus was in the list); a poll leaves the scroll alone.
  const prev = useRef<{ sig: string | null, sel: string | null }>({ sig: null, sel: null })
  const fsig = filterSignature(f)
  const hasRows = !!shown.data && rows.length > 0
  useLayoutEffect(() => {
    const el = listRef.current
    if (!hasRows || !el) { prev.current = { sig: null, sel: null }; return }
    const selIndex = entries.findIndex((e) => e.s && e.key === sel)
    const d = scrollDecision({ prevSig: prev.current.sig, sig: fsig, selKey: sel, selIndex, prevSelKey: prev.current.sel })
    const moved = prev.current.sel !== sel
    prev.current = { sig: fsig, sel }
    if (d.kind === 'top') el.scrollTop = 0
    else if (d.kind === 'index') v.scrollToIndex(d.index!, { align: 'auto' })
    if (moved && el.contains(document.activeElement)) el.querySelector<HTMLElement>('.lrow.sel')?.focus({ preventScroll: true })
  }, [hasRows, entries, sel, fsig, v])

  // keys (1.8 §键盘): / search · Enter open · ↑ ↓ PageUp PageDown Home End move the highlight; read through a ref, set once
  const qRef = useRef<HTMLInputElement | null>(null)
  const keyState = useRef({ rows, sel, open })
  useLayoutEffect(() => { keyState.current = { rows, sel, open } })
  useLayoutEffect(() => {
    setScreenKeys((e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const { rows: rs, sel: cur, open: go } = keyState.current, t = e.target as HTMLElement | null
      if (e.key === '/') { e.preventDefault(); qRef.current?.focus(); return }
      const i = rs.findIndex((s) => sessionKey(s) === cur)
      if (e.key === 'Enter') { if (t && (t.tagName === 'BUTTON' || t.tagName === 'A')) return; e.preventDefault(); if (rs[i]) go(rs[i]); return }
      const step = STEP[e.key]
      if (!step || !rs.length) return
      e.preventDefault()
      set({ sel: sessionKey(rs[Math.max(0, Math.min(rs.length - 1, step(i, rs.length)))]) })
    })
    return () => setScreenKeys(null)
  }, [set])

  let body
  if (!shown.data && !shown.err) body = <LoadingState />
  else if (!shown.data) body = <ReadFailState err={shown.err!} onRetry={retry} />
  else if (!all.length) body = <NoSessionsState shot={shot} />
  else if (!rows.length) body = <FilteredState shot={shot} h={f.h} onClear={clear} />
  else body = <VRows v={v} entries={entries} sel={sel} now={now} onOpen={open} />

  return (
    <div className="page">
      <div id="libhead"><PageHead name={SCREEN_NAME.library} readAt={shown.readAt} tools={<WindowSeg value={f.window} set={set} />} /></div>
      <div className="lib">
        <LibraryTools f={f} all={all} set={set} onClear={clear} inputRef={qRef} />
        <Caption data={q.data ?? null} err={err} listAt={q.dataUpdatedAt} now={q.dataUpdatedAt} onRetry={retry} />
        <div className="libhead">
          <span className="lhs">{W.COL_SESSION}<TitleInfo /></span>
          <span className="ln">{W.COL_CALLS}</span><span className="lw">{W.COL_LAST}</span>
        </div>
        <div className="liblist" id="liblist" aria-label="Sessions" ref={setList}>{body}</div>
      </div>
    </div>
  )
}
