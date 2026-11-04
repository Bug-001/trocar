// screens/traffic/RequestView.tsx — the request detail (2.6 §C, the markup of legacy traffic/request-view.mjs): the request line, the class,
// the domains, each side's headers and body with that side's own marks, the wire sizes and the technical details. It renders
// request-model.mjs requestView() only. Its open state (the technical details, a selection in a body) lives here, so the host page
// never keys it on the answer: a re-read (「Show」 on one credential header) redraws the values in place.
import { Button } from 'react-aria-components'
import * as W from '../../../legacy/labels/traffic.mjs'
import { CopyButton } from '../../ui/CopyButton'
import { TechDetails, type TechValue } from '../../ui/TechDetails'

type Mark = { text: string, sub?: string }
type HeaderRow = { name: string, state: 'plain' | 'open' | 'masked' | 'old', value: string | null }
type Headers = { rows: HeaderRow[], masked: boolean, copy: string } | null
type Body = { marks: Mark[], kind: 'pre' | 'hex' | 'note', text: string, fold: string, copy: string, head?: string }
export type View = { ref: string | null, unshaped: true } | {
  ref: string | null, unshaped?: undefined,
  line: { method: string, endpoint: string, status: string },
  meta: { cls: string, logOnly: boolean },
  callMarks: string[],
  host: { differs: boolean, connected: string | null, requested: string | null } | null,
  req: { headers: Headers, body: Body }, resp: { headers: Headers, body: Body },
  wire: { sent: string, received: string },
  tech: Array<[string, TechValue]>,
}

const NO_HEADERS = 'This record has no headers recorded'

function HeaderTable({ side, title, h, onReveal }: { side: string, title: string, h: Headers, onReveal: (name: string) => void }) {
  return (
    <section className="rqd-sec" data-side={`${side}-headers`}>
      <div className="rqd-sh"><b>{title}</b>{h ? <CopyButton text={h.copy} /> : null}</div>
      {!h ? <p className="rqd-none">{NO_HEADERS}</p> : <>
        <div className="kvt">{h.rows.map((r, i) => [
          <span key={`k${i}`} className="k" title={r.name}>{r.name}</span>,
          r.state === 'old' ? <span key={`v${i}`} className="v"><span className="c2">{W.MASK_NOTE_OLD}</span></span>
            : r.state === 'masked' ? <span key={`v${i}`} className="v">
              <span className="mask-dots" aria-hidden="true">••••••</span> <span className="c2">{W.MASKED}</span>{' '}
              <Button className="lnk" onPress={() => onReveal(r.name)}>{W.REVEAL}</Button>
            </span>
              : <span key={`v${i}`} className="v mono">{r.value}</span>,
        ])}</div>
        {h.masked ? <p className="rqd-masknote">{W.MASK_NOTE}</p> : null}
      </>}
    </section>
  )
}

function BodySec({ side, title, b }: { side: string, title: string, b: Body }) {
  return (
    <section className="rqd-sec" data-side={`${side}-body`}>
      <div className="rqd-sh"><b>{title}</b><span className="spacer"></span>
        {b.fold ? <span className="c2 rqd-fold">{b.fold}</span> : null}
        {b.copy ? <CopyButton text={b.copy} /> : null}
      </div>
      {b.marks.map((m, i) => <p key={i} className="rqd-mark">{m.text}{m.sub ? <> <span className="c2">{m.sub}</span></> : null}</p>)}
      {b.kind === 'note' ? <p className="rqd-kind">{b.text}</p> : <>
        {b.head ? <p className="rqd-kind">{b.head}</p> : null}
        <pre className={b.kind === 'hex' ? 'rqd-pre hex' : 'rqd-pre'}>{b.text}</pre>
      </>}
    </section>
  )
}

export function RequestView({ view, onReveal }: { view: View, onReveal: (name: string) => void }) {
  if (view.unshaped) return <div className="rqd" data-ref={view.ref ?? ''}><p className="rqd-none">{W.UNKNOWN_KIND}</p></div>
  const { line, meta, host, wire } = view
  return (
    <div className="rqd" data-ref={view.ref ?? ''}>
      <p className="rqd-line">{line.method} <span className="mono rqd-endpoint">{line.endpoint}</span> <span className="c2">· {line.status}</span></p>
      <p className="rqd-meta">{meta.cls}{meta.logOnly ? ` · ${W.RETENTION_MARK.log.label}` : ''}</p>
      {view.callMarks.length ? <div className="rqd-callmarks">{view.callMarks.map((m, i) => <p key={i} className="rqd-mark">{m}</p>)}</div> : null}
      <div className="rqd-host">{!host ? <p className="rqd-none">{W.NO_HOST}</p> : <>
        {host.differs ? <p className="rqd-hostdiff">{W.HOST_DIFFERS}</p> : null}
        <p>{W.CONNECTED_HOST} <span className="mono">{host.connected ?? '—'}</span></p>
        {host.differs ? <p>{W.REQUESTED_HOST} <span className="mono">{host.requested ?? '—'}</span></p> : null}
      </>}</div>
      <HeaderTable side="req" title={W.REQ_HEADERS} h={view.req.headers} onReveal={onReveal} />
      <BodySec side="req" title={W.REQ_BODY} b={view.req.body} />
      <HeaderTable side="resp" title={W.RESP_HEADERS} h={view.resp.headers} onReveal={onReveal} />
      <BodySec side="resp" title={W.RESP_BODY} b={view.resp.body} />
      <p className="rqd-wire">{`${W.WIRE_SIZE} · ${W.REQ_BODY} ${wire.sent} · ${W.RESP_BODY} ${wire.received}`}</p>
      <TechDetails pairs={view.tech} copy={view.tech.map(([k, v]) => `${k}: ${'text' in v ? v.text : ''}`).join('\n')} />
    </div>
  )
}
