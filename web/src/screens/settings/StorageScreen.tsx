// screens/settings/StorageScreen.tsx — 设置 · 存储 (1.11): 「how much disk does trocar use, how fast does it grow, what is stored per
// class?」 It renders storageModel (storage-model.mjs) of the C.5 `classes` and `segments` documents and the control plane's answer.
// Reads (§组件状态, D75①): each once on entry, no polling, no re-read on window focus, no automatic retry; a failed read says so with a
// Retry (1.5 K-29) and the last good document stays drawn. A level change plans first and writes only after a yes (4.4, core/control.mjs
// planConfirm), then re-reads: the level shown is always the server's. Re-reads never disturb the reader: rows keyed by class, the order
// held across a change's re-read (so the control just used keeps focus), disclosures keep their state, a window switch is a re-render.
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Button } from 'react-aria-components'
import { api } from '../../../legacy/core/api.mjs'
import { planConfirm } from '../../../legacy/core/control.mjs'
import { SCREEN_NAME } from '../../../legacy/labels/shell.mjs'
import * as W from '../../../legacy/labels/settings.mjs'
import { PageHead } from '../../ui/PageHead'
import { TechDetails } from '../../ui/TechDetails'
import { useConfirm } from '../../ui/Confirm'
import type { ScreenProps } from '../../ScreenOutlet'
import { holdOrder as holdJs } from '../capture/model.mjs'
import { failOf as failJs, flatText, receiptOf as receiptJs, storageModel as modelJs, winOf as winJs } from './storage-model.mjs'
import { DiskCard, techOf, type DiskModel, type Pairs } from './DiskCard'
import { ClassesCard, type CardModel, type Receipt } from './ClassesCard'

type Answer = { ok?: boolean, status?: number, data?: unknown, error?: unknown } | null | undefined
type Out = { outcome: string, status: number, error?: unknown }
const storageModel = modelJs as (docs: { classes: unknown, segments: unknown, segmentsFail: unknown }, window: string,
  o: { control: unknown, hl: string | null, now: number }) => { disk: DiskModel, card: CardModel }
const failOf = failJs as (what: string, r: unknown) => { line: string, pairs: Pairs }
const receiptOf = receiptJs as (out: Out, keep: string) => Receipt | null
const winOf = winJs as (params: unknown) => string
const holdOrder = holdJs as (prev: string[], rule: string[], hold: boolean) => string[]
const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i])
const once = { refetchOnWindowFocus: false, retry: false } as const
const failed = (e: unknown): Answer => ({ ok: false, status: 0, data: null, error: String((e as Error)?.message ?? e) })

export default function StorageScreen({ route }: ScreenProps) {
  const params = route.params as { window?: string, class?: string }
  const win = winOf(params), hl = params.class || null
  const ask = useConfirm()
  const cq = useQuery({ queryKey: ['classes'], queryFn: ({ signal }) => api.get('classes', null, { signal }) as Promise<Answer>, ...once })
  const sq = useQuery({ queryKey: ['segments'], queryFn: ({ signal }) => api.get('segments', null, { signal }) as Promise<Answer>, ...once })
  const control = useQuery({ queryKey: ['control-status'], queryFn: ({ signal }) => api.controlStatus({ signal }) as Promise<Answer>, staleTime: Infinity, retry: false })
  const ctl = control.data ?? (control.error ? failed(control.error) : null)
  const seg = sq.data ?? (sq.error ? failed(sq.error) : null)

  // each classes answer, taken once (adjusted while rendering, so the frame that shows it has it): the last good one is kept, the
  // latest failure is said; `answers` counts them, so a change's receipt knows which read ends it
  const stamp = Math.max(cq.dataUpdatedAt, cq.errorUpdatedAt)
  const [seen, setSeen] = useState({ stamp: 0, answers: 0, good: null as { doc: unknown, at: number } | null, fail: null as Answer })
  if (stamp && stamp !== seen.stamp) {
    const a = cq.data && cq.errorUpdatedAt <= cq.dataUpdatedAt ? cq.data : failed(cq.error)
    setSeen({ stamp, answers: seen.answers + 1, good: a && a.ok ? { doc: a.data, at: api.now() } : seen.good, fail: a && a.ok ? null : a })
  }
  const answersRef = useRef(0)
  useEffect(() => { answersRef.current = seen.answers }, [seen.answers])

  // a level change: busy per class from the press itself (a second press while one is out sends nothing); the receipt stays until the
  // classes read after the one the change caused (§组件状态)
  const busyRef = useRef(new Set<string>())
  const [busy, setBusy] = useState<ReadonlySet<string>>(() => new Set())
  const [receipts, setReceipts] = useState<ReadonlyMap<string, { rc: Receipt, born: number }>>(() => new Map())
  const { refetch: refetchClasses } = cq, { refetch: refetchControl } = control
  const change = useCallback(async (cls: string, keep: string) => {
    if (busyRef.current.has(cls) || !(keep in W.KEEP_NAME)) return
    busyRef.current.add(cls)
    setBusy(new Set(busyRef.current))
    setReceipts((m) => { const n = new Map(m); n.delete(cls); return n })
    const confirmLog = keep === 'log' && (W.ASK_LOG as Record<string, string>)[cls]
    const yes = confirmLog
      ? ({ stale }: { stale: boolean }) => ask({ q: W.ASK_LOG_TITLE, impact: stale ? W.RCPT_STALE : '', lines: [confirmLog], confirmLabel: W.ASK_LOG_OK, cancelLabel: W.CANCEL })
      : async () => true // the press itself is the operator's yes to this one-class plan (1.11 §改级别)
    let out: Out
    try { out = await planConfirm({ api, verb: 'classes', body: { kind: 'set', class: cls, keep }, ask: yes }) as Out }
    catch (err) { out = { outcome: 'failed', status: 0, error: String((err as Error)?.message ?? err) } }
    busyRef.current.delete(cls)
    setBusy(new Set(busyRef.current))
    const rc = receiptOf(out, keep)
    if (rc) setReceipts((m) => new Map(m).set(cls, { rc, born: answersRef.current }))
    if (out.status === 404 || out.status === 405) void refetchControl()
    if (out.status === 403) return // the K-30 latch (1.5): nothing more is sent
    if (out.outcome !== 'cancelled') void refetchClasses()
  }, [ask, refetchClasses, refetchControl])
  const shownReceipts = new Map([...receipts].filter(([, v]) => seen.answers <= v.born + 1).map(([k, v]) => [k, v.rc]))

  const model = seen.good
    ? storageModel({ classes: seen.good.doc, segments: seg && seg.ok ? seg.data : null, segmentsFail: seg && !seg.ok ? seg : null },
      win, { control: ctl, hl, now: api.now() })
    : null

  // the order: the rule's at the first answer and at each window switch; held across any other re-read
  const ruleIds = model ? model.card.rows.map((r) => r.key) : []
  const [order, setOrder] = useState<{ win: string, ids: string[] }>({ win, ids: [] })
  const next = !order.ids.length || order.win !== win ? ruleIds : holdOrder(order.ids, ruleIds, true)
  if (model && (order.win !== win || !sameList(next, order.ids))) setOrder({ win, ids: next })

  // ?class= : that row scrolls into view once per value
  const main = useRef<HTMLDivElement>(null)
  const landed = useRef<string | null>(null)
  useLayoutEffect(() => {
    if (!hl || !model || landed.current === hl) return
    landed.current = hl
    const row = main.current?.querySelector<HTMLElement>('tr[data-hl="true"]')
    try { row?.scrollIntoView({ block: 'nearest' }) } catch { /* no options */ }
  })

  const scopeHref = (w: string) => `#/settings/storage?${new URLSearchParams({ window: w, ...(hl ? { class: hl } : {}) })}`
  const tools = (
    <nav className="seg" role="group" aria-label="window">
      {W.WINDOWS.map((o) => <a key={o.value} href={scopeHref(o.value)} {...(o.value === win ? { className: 'on', 'aria-current': 'true' as const } : {})}>{o.label}</a>)}
    </nav>
  )
  const fail = seen.fail ? failOf(W.THIS_PAGE, seen.fail) : null
  return (
    <div className="page">
      <div id="shead"><PageHead name={SCREEN_NAME['settings-storage']} readAt={seen.good?.at ?? null} tools={tools} /></div>
      <div id="smain" ref={main}>
        {fail ? <div className="scard"><p className="err">{fail.line} · <Button className="linkbtn" onPress={() => void cq.refetch()}>{W.RETRY}</Button></p>
          <TechDetails pairs={techOf(fail.pairs)} copy={flatText(fail.pairs)} /></div> : null}
        {model ? <>
          <DiskCard disk={model.disk} onRetry={() => void sq.refetch()} />
          <ClassesCard card={model.card} order={next} busy={busy} receipts={shownReceipts} onChange={(c, k) => void change(c, k)} />
        </> : null}
      </div>
    </div>
  )
}
