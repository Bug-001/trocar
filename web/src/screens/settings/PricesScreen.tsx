// screens/settings/PricesScreen.tsx — 设置 · 价格 (1.11 §价格): what an estimate is priced with, and which models have no price.
// Read-only: only GETs (`pricing`, and `overview` with no `since`), read once per visit (§数据与刷新, §组件状态); there is no
// write-a-price endpoint and none is drawn (D14). The rows and the paste-ready template come from the pure helpers of
// web/legacy/settings/prices.mjs; a failed price read says so with Retry, its reason only in the folded details (1.5 K-29).
import { useState } from 'react'
import { Button } from 'react-aria-components'
import { useQuery } from '@tanstack/react-query'
import { api } from '../../../legacy/core/api.mjs'
import { SCREEN_NAME } from '../../../legacy/labels/shell.mjs'
import * as W from '../../../legacy/labels/settings.mjs'
import { priceRows as priceRowsJs, unpricedModels as unpricedJs, templateText } from '../../../legacy/settings/prices.mjs'
import { PageHead } from '../../ui/PageHead'
import { fmtWhen } from '../../../legacy/core/fmt.mjs'
import type { ScreenProps } from '../../ScreenOutlet'
import { TechDetails, type TechValue } from '../../ui/TechDetails'
import { CopyButton } from '../../ui/CopyButton'
import { failOf as failOfJs, flatText } from './storage-model.mjs'

type Answer = { ok: boolean, status?: number, data?: unknown, error?: string | null, at?: number }
type PriceRow = { id: string, input: unknown, output: unknown, write: unknown, read: unknown }
type Pricing = { source?: string, models?: unknown }
type Overview = { as_of?: string, usage?: { rows?: unknown } }
const priceRows = priceRowsJs as (doc: unknown) => PriceRow[] | null
const unpricedModels = unpricedJs as (rows: unknown[], table: unknown) => Array<{ model: string | null, sessions: number }>
const failOf = failOfJs as (what: string, r: unknown) => { line: string, pairs: Array<[string, string]> }

const TECH: Array<[string, string]> = [[W.COL_KEY, W.TECH_MATCH], [W.COL_WRITE, W.TECH_WRITE_ONE], ['price table', W.TECH_PRICING_PATH]]
const techOf = (pairs: Array<[string, string]>) => pairs.map(([k, v]): [string, TechValue] => [k, { text: v }])
// read on every entry (a cached answer is drawn first, then re-read), never on focus or reconnect, never retried by itself
const once = { refetchOnWindowFocus: false, refetchOnReconnect: false, retry: false } as const

// one read: a throw is a failed answer like any other (K-29)
async function read(name: string, signal: AbortSignal): Promise<Answer> {
  try { return { ...(await api.get(name, null, { signal }) as Answer), at: api.now() } } catch (e) { return { ok: false, error: String((e as Error)?.message ?? e) } }
}

function PriceTable({ rows }: { rows: PriceRow[] }) {
  return (
    <div className="hscroll"><table className="ptable">
      <thead><tr><th className="k">{W.COL_KEY}</th><th className="n">{W.COL_IN}</th><th className="n">{W.COL_OUT}</th><th className="n">{W.COL_WRITE}</th><th className="n">{W.COL_READ}</th></tr></thead>
      <tbody>{rows.map((r) => (
        <tr key={r.id}><td className="k mono">{r.id}</td><td className="n">{String(r.input)}</td><td className="n">{String(r.output)}</td><td className="n">{String(r.write)}</td><td className="n">{String(r.read)}</td></tr>
      ))}</tbody>
    </table></div>
  )
}

function Unpriced({ overview, rows, source }: { overview: Overview, rows: PriceRow[] | null, source: string | undefined }) {
  const table = rows && Object.fromEntries(rows.map((r) => [r.id, [r.input, r.output, r.write, r.read]]))
  const un = unpricedModels(overview.usage!.rows as unknown[], table)
  return (
    <div className="scard"><h2>{W.CARD_UNPRICED}</h2>
      {overview.as_of ? <p className="cap">{`${W.UNPRICED_AS_OF} ${fmtWhen(overview.as_of)}`}</p> : null}
      {un.length ? <>
        {un.map((m) => {
          const tmpl = m.model == null ? null : templateText(m.model, source)
          return (
            <div className="umodel" key={m.model ?? '*none*'}>
              <span className="um">{m.model == null ? W.UNPRICED_NO_MODEL : m.model}</span>
              <span className="cap">{W.UNPRICED_SESSIONS(m.sessions)}</span>
              {tmpl != null ? <div className="tmpl"><code className="well mono" tabIndex={0}>{tmpl}</code><CopyButton text={tmpl} label={W.COPY_TEMPLATE} row /></div> : null}
            </div>
          )
        })}
        <p className="cap hint">{W.TEMPLATE_HINT}</p>
      </> : <p className="cap">{W.UNPRICED_NONE}</p>}
    </div>
  )
}

export default function PricesScreen(_props: ScreenProps) {
  const pq = useQuery({ queryKey: ['pricing'], queryFn: ({ signal }) => read('pricing', signal), ...once })
  const oq = useQuery({ queryKey: ['overview', 'no-since'], queryFn: ({ signal }) => read('overview', signal), ...once })
  const p = pq.data, o = oq.data
  const [readAt, setReadAt] = useState<number | null>(null) // the last good pricing answer; a later failure keeps it
  if (p && p.ok && p.at != null && p.at !== readAt) setReadAt(p.at)

  const pricing = p && p.ok ? (p.data as Pricing | null) : null
  const fail = p && !p.ok ? failOf(W.PRICE_TABLE, p) : null
  const rows = priceRows(pricing)
  const overview = o && o.ok ? (o.data as Overview | null) : null
  return (
    <div className="page">
      <PageHead name={SCREEN_NAME['settings-prices']} readAt={readAt} />
      <div id="pmain">
        <div className="scard"><h2>{W.CARD_PRICE}</h2>
          <p className="cap">{W.PRICE_NOTE}</p>
          <p className="cap" data-note="read-only">{W.PRICE_READ_ONLY}</p>
          {pricing ? (pricing.source && pricing.source !== 'default'
            ? <p className="cap from mono">{W.PRICE_FROM(pricing.source)}</p> : <p className="cap from">{W.PRICE_DEFAULT}</p>) : null}
          {fail ? <>
            <p className="err">{fail.line} · <Button className="linkbtn" onPress={() => { void pq.refetch() }}>{W.RETRY}</Button></p>
            <TechDetails pairs={techOf(fail.pairs)} copy={flatText(fail.pairs)} />
          </> : p ? (rows ? <PriceTable rows={rows} /> : <p className="err">{W.PRICE_BAD_SHAPE}</p>) : null}
          <TechDetails pairs={techOf(TECH)} copy={flatText(TECH)} />
        </div>
        {overview && overview.usage && Array.isArray(overview.usage.rows)
          ? <Unpriced overview={overview} rows={rows} source={pricing ? pricing.source : undefined} /> : null}
      </div>
    </div>
  )
}
