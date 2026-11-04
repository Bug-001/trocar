// screens/overview/OverviewScreen.tsx — 总览 (1.7): the first screen, answering at one glance whether capture is healthy, whether there is
// anything to handle and what the agents cost. Reads (1.7 §组件状态, D75①): status through useStatusQuery; sessions, and the five slow
// reads through a two-slot gate, one query each with pollOptions; the stats keyed by window, the last window's numbers kept dim until
// the new one answers; the control plane only on first use. A failed read counts for the back-off and the last good answer stays.
// The cards draw model.mjs's card models of one bundle of answers, held while the reader's selection lies in the grid
// (useSelectionHold) and let go at once on a window change, a Retry, or the end of a switch round.
import { useCallback, useEffect, useMemo } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { api, scoped } from '../../../legacy/core/api.mjs'
import { freshSessions as freshJs } from '../../../legacy/library/logic.mjs'
import { SCREEN_NAME } from '../../../legacy/labels/shell.mjs'
import { pollOptions, useStatusQuery } from '../../ui/poll'
import { useSelectionHold } from '../../ui/useSelectionHold'
import { PageHead } from '../../ui/PageHead'
import type { ScreenProps } from '../../ScreenOutlet'
import { createGate } from './gate.mjs'
import { parseWindow, firstUse, windowTabs, capCard, itemsCard, statsCard, recentCard, startCard, agentRows } from './model.mjs'
import { AgentsCard, CapCard, ItemsCard, RecentCard, StartCard, StatsCard, type AgentRowM, type RecentModel, type Retry, type StatsModel } from './Cards'

type Answer = { ok?: boolean, data?: unknown, status?: number, error?: string } | null | undefined
type Slot = { data: unknown, ok: boolean | null, err: unknown }
type Q = { data: unknown, error: Error | null, isError: boolean, dataUpdatedAt: number }
// the JS default (alive = () => true) types the option as returning true; the screen ties it to the query's signal
const freshSessions = freshJs as (api: unknown, o: { alive: () => boolean }) => Promise<Answer>

const gate = createGate(2) // the five slow reads share two sockets (1.7 §读取与刷新)
// an answer that is not ok is thrown, carrying the answer: the back-off counts it and the query keeps its last data
const must = (r: Answer) => {
  if (r && r.ok) return r.data ?? null
  throw Object.assign(new Error(String(r?.error ?? 'no answer')), { answer: r ?? null })
}
const slow = (name: string, params: Record<string, unknown> | null, key: unknown[]) => ({
  queryKey: ['ov', name, ...key],
  queryFn: ({ signal }: { signal: AbortSignal }) => gate.run(signal, () => api.get(name, params, { signal })).then((r: Answer) => must(r)),
  ...pollOptions('other'),
})
const slot = (q: Q): Slot => ({
  data: q.data ?? null,
  ok: q.isError ? false : q.data != null ? true : null,
  err: q.error ? (q.error as Error & { answer?: unknown }).answer ?? q.error.message : null,
})

export default function OverviewScreen({ route }: ScreenProps) {
  const w = parseWindow((route.params as { window?: string }).window)
  const status = useStatusQuery()
  const sessions = useQuery({
    queryKey: ['ov', 'sessions'],
    queryFn: async ({ signal }) => must(await freshSessions(scoped(api, signal), { alive: () => !signal.aborted })),
    ...pollOptions('sessions'),
  })
  const classes = useQuery(slow('classes', null, []))
  const pricing = useQuery(slow('pricing', null, []))
  const segments = useQuery(slow('segments', null, []))
  const traffic = useQuery(slow('traffic', { since: '24h' }, ['24h']))
  const stats = useQuery({ ...slow('overview', { since: w === 'all' ? null : w }, [w]), placeholderData: keepPreviousData })

  // first use is judged on the live answers, so the control plane is asked even while a selection holds the cards
  const first = firstUse({ sessions: slot(sessions) }) as boolean
  const control = useQuery({
    queryKey: ['control-status'], queryFn: ({ signal }) => api.controlStatus({ signal }) as Promise<Answer>,
    staleTime: Infinity, retry: false, enabled: first,
  })
  const ctl = useMemo(() => control.data ?? (control.error ? { ok: false, error: String(control.error.message) } : null), [control.data, control.error])

  const latest = useMemo(() => {
    const caph = { data: status.doc, okAt: status.okAt, err: status.err, ok: status.err ? false : status.doc != null ? true : null }
    const readAt = Math.max(status.okAt ?? 0, ...[sessions, classes, pricing, segments, traffic, stats].map((q) => q.dataUpdatedAt || 0)) || null
    return {
      w, readAt, caph, control: ctl, sessions: slot(sessions), classes: slot(classes), pricing: slot(pricing), segments: slot(segments),
      traffic: slot(traffic), stats: { ...slot(stats), other: stats.isPlaceholderData },
    }
  }, [w, status.doc, status.okAt, status.err, status.errAt, ctl, // eslint-disable-line react-hooks/exhaustive-deps -- every query field the bundle reads, and errAt: a repeated failure is a new answer
    sessions.data, sessions.error, sessions.dataUpdatedAt, sessions.errorUpdatedAt, classes.data, classes.error, classes.dataUpdatedAt, classes.errorUpdatedAt,
    pricing.data, pricing.error, pricing.dataUpdatedAt, pricing.errorUpdatedAt, segments.data, segments.error, segments.dataUpdatedAt, segments.errorUpdatedAt,
    traffic.data, traffic.error, traffic.dataUpdatedAt, traffic.errorUpdatedAt, stats.data, stats.error, stats.dataUpdatedAt, stats.errorUpdatedAt, stats.isPlaceholderData])
  const { shown, ref, release } = useSelectionHold(latest)

  const view = useMemo(() => {
    const now = api.now()
    const isFirst = firstUse(shown) as boolean
    return isFirst
      ? { first: true as const, cap: capCard(shown.caph, now), agents: agentRows(shown) as AgentRowM[], start: startCard(shown) }
      : { first: false as const, cap: capCard(shown.caph, now), items: itemsCard(shown, now), stats: statsCard(shown, now) as StatsModel, recent: recentCard(shown, now) as RecentModel }
  }, [shown])

  useEffect(() => { release() }, [w, release]) // a window change is the reader's own: the latest answer shows now (1.2 ③)

  const onRetry: Retry = useCallback((group) => {
    const qs = group === 'health' ? [status] : group === 'sessions' ? [sessions] : [classes, pricing, stats, segments, traffic]
    for (const q of qs) void q.refetch()
    release()
  }, [status, sessions, classes, pricing, stats, segments, traffic, release])

  // a switch round ends: the control plane is re-read after a 405 (the daemon lost it), the status always; the latest answer shows now
  const onDone = useCallback((out: unknown) => {
    if (out && (out as { status?: number }).status === 405) void control.refetch()
    void status.refetch()
    release()
  }, [control, status, release])

  const tools = (
    <nav className="seg" role="group" aria-label="Stats window">
      {windowTabs(w).map((t) => <a key={t.value} href={t.href} className={t.on ? 'on' : undefined} aria-current={t.on ? 'true' : undefined}>{t.label}</a>)}
    </nav>
  )
  return (
    <div className="page">
      <div id="ovhead"><PageHead name={SCREEN_NAME.overview} readAt={shown.readAt} tools={tools} /></div>
      <div className={view.first ? 'ovgrid first' : 'ovgrid'} id="ovgrid" ref={ref}>
        <div id="ovcap"><CapCard m={view.cap} /></div>
        <div id="ovitems">{view.first ? null : <ItemsCard m={view.items} />}</div>
        <div id="ovagents">{view.first ? <AgentsCard rows={view.agents} onDone={onDone} /> : null}</div>
        <div id="ovstats" className="span">{view.first ? null : <StatsCard m={view.stats} onRetry={onRetry} />}</div>
        <div id="ovrecent" className="span">{view.first ? <StartCard m={view.start} /> : <RecentCard m={view.recent} onRetry={onRetry} />}</div>
      </div>
    </div>
  )
}
