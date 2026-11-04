// screens/capture/CaptureScreen.tsx — 采集 · agent (1.9): the page a person opens to learn whether every agent of theirs is being
// recorded, and when one is not, why and what to do. It renders pageModel (model.mjs) of the status document: the capture service row,
// one row per agent, the empty-table foot and the machine-wide changes block. Reads (D75①): the status poll (useStatusQuery), the 24 h
// overview document for the last-capture column, the control plane's answer once (and again after a 405). A re-read never disturbs
// the reader (1.9 §页面结构): open state per stable row id, the order frozen while a row is open (holdOrder), the answer held while a
// selection lies in the rows (useSelectionHold), stable keys. ?h= lands on that row, opened and scrolled into view once.
import { useCallback, useLayoutEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../../legacy/core/api.mjs'
import { harnessName } from '../../../legacy/core/chips.mjs'
import { toast } from '../../../legacy/core/ui.mjs'
import { captureVerdict as verdictJs } from '../../../legacy/core/capture-verdict.mjs'
import { SCREEN_NAME } from '../../../legacy/labels/shell.mjs'
import { pollOptions, useStatusQuery } from '../../ui/poll'
import { useSelectionHold } from '../../ui/useSelectionHold'
import { PageHead } from '../../ui/PageHead'
import type { ScreenProps } from '../../ScreenOutlet'
import { pageModel as pageModelJs, holdOrder } from './model.mjs'
import { AgentRow, type AgentRowModel } from './AgentRow'
import { ServiceRow, type ServiceModel } from './ServiceRow'
import { ChangesBlock, type ChangesModel } from './ChangesBlock'

type Model = { service: ServiceModel, rows: AgentRowModel[], foot: string | null, changes: ChangesModel | null }
type Answer = { ok?: boolean, data?: unknown } | null | undefined
const SERVICE = '*service', CHANGES = '*changes' // the open-state ids of the two rows that are no agent's
// the JS models' parameter types are inferred from their defaults (null); the screen hands them the answers as they came
const captureVerdict = verdictJs as (doc: unknown, o: { okAt: number | null, err: string | null }) => unknown
const pageModel = pageModelJs as (doc: unknown, verdict: unknown, o: { ov: unknown, control: unknown }) => unknown
const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i])

export default function CaptureScreen({ route }: ScreenProps) {
  const status = useStatusQuery()
  const ovq = useQuery({
    queryKey: ['overview', '24h'],
    queryFn: ({ signal }) => api.get('overview', { since: '24h' }, { signal }) as Promise<Answer>,
    ...pollOptions('other'),
  })
  const control = useQuery({ queryKey: ['control-status'], queryFn: ({ signal }) => api.controlStatus({ signal }) as Promise<Answer>, staleTime: Infinity, retry: false })
  const ov = ovq.data && ovq.data.ok ? ovq.data.data ?? null : null
  const ctl = useMemo(() => control.data ?? (control.error ? { ok: false, error: String(control.error.message) } : null), [control.data, control.error])
  // errAt: every failed read is an answer, so the verdict (and its clock) is taken again even when the reason repeats
  const latest = useMemo(() => ({ doc: status.doc, okAt: status.okAt, err: status.err, errAt: status.errAt, ov, control: ctl }),
    [status.doc, status.okAt, status.err, status.errAt, ov, ctl])
  const { shown, ref, release } = useSelectionHold(latest)

  const model = useMemo(() => {
    const verdict = captureVerdict(shown.doc, { okAt: shown.okAt, err: shown.err })
    return pageModel(shown.doc, verdict, { ov: shown.ov, control: shown.control }) as Model
  }, [shown])

  // open state: the reader's choice per stable id, else the row's default
  const [choice, setChoice] = useState<ReadonlyMap<string, boolean>>(() => new Map())
  const openOf = (id: string, def: boolean) => (choice.has(id) ? choice.get(id)! : def)
  const setOpen = useCallback((id: string, open: boolean) => setChoice((m) => new Map(m).set(id, open)), [])

  // the order: the rule's, frozen while any row is open (adjusted while rendering, so the frame that shows the answer has its order)
  const ruleIds = model.rows.map((r) => r.id)
  const anyOpen = openOf(SERVICE, false) || model.rows.some((r) => openOf(r.id, r.defaultOpen))
  const [order, setOrder] = useState<string[]>([])
  const next = holdOrder(order, ruleIds, anyOpen) as string[]
  if (!sameList(next, order)) setOrder(next)
  const byId = new Map(model.rows.map((r) => [r.id, r]))

  // a switch round ends: the control plane is re-read after a 405 (the daemon lost it), the status always; the latest answer shows now
  const onDone = useCallback((out: unknown) => {
    if (out && (out as { status?: number }).status === 405) void control.refetch()
    void status.refetch()
    release()
  }, [control, status, release])

  // ?h= : once per value, after the first answer: its row opens and scrolls into view once; no row → a toast once
  const h = (route.params as { h?: string }).h || null
  const [landing, setLanding] = useState<{ h: string, found: boolean } | null>(null)
  if (h && status.doc != null && landing?.h !== h) { // adjusted while rendering: the frame that shows the answer has the row open
    const found = byId.has(h)
    setLanding({ h, found })
    if (found) { setOpen(h, true); release() }
  }
  useLayoutEffect(() => {
    if (!landing) return
    if (!landing.found) { toast(`${harnessName(landing.h)} is not on the capture page now`); return }
    const row = [...document.querySelectorAll<HTMLElement>('#capmain .crow')].find((e) => e.dataset.h === landing.h)
    try { row?.scrollIntoView({ block: 'center' }) } catch { /* no options */ }
  }, [landing])

  return (
    <div className="page capage">
      <div id="caphead"><PageHead name={SCREEN_NAME.capture} readAt={shown.okAt} /></div>
      <div className="cap-main" id="capmain" ref={ref}>
        <section className="crows" aria-label="agent">
          <ServiceRow svc={model.service} open={openOf(SERVICE, false)} onOpen={(o) => setOpen(SERVICE, o)} />
          {next.map((id) => byId.get(id)).filter((r) => r != null).map((r) => (
            <AgentRow key={r.id} row={r} open={openOf(r.id, r.defaultOpen)} onOpen={(o) => setOpen(r.id, o)} onDone={onDone} />
          ))}
        </section>
        {model.foot ? <p className="capfoot">{model.foot}</p> : null}
        {model.changes ? <ChangesBlock ch={model.changes} open={openOf(CHANGES, model.changes.open)} onOpen={(o) => setOpen(CHANGES, o)} /> : null}
      </div>
    </div>
  )
}
