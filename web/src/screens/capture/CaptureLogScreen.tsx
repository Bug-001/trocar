// screens/capture/CaptureLogScreen.tsx — 采集 · 采集记录 (1.9 §采集记录): the capture failures of the last 24 h, one row per failure
// group, newest first. It renders logModel (log-model.mjs) of the status document, filtered by `?h=`. A re-read never disturbs the reader
// (1.9 §页面结构): rows keyed by the group key, open state per group key (cleared when the filter changes), the answer held while a
// selection lies in the rows (useSelectionHold). Only a row's ▸ button opens or folds it; the rest of the line is selectable text.
import { Fragment, useCallback, useMemo, useState } from 'react'
import { Button, Disclosure, DisclosurePanel, Menu, MenuItem, MenuTrigger, Popover } from 'react-aria-components'
import { harnessName } from '../../../legacy/core/chips.mjs'
import { SCREEN_NAME } from '../../../legacy/labels/shell.mjs'
import { READING } from '../../../legacy/labels/common.mjs'
import { LOG } from '../../../legacy/labels/capture.mjs'
import { captureVerdict as verdictJs } from '../../../legacy/core/capture-verdict.mjs'
import { useStatusQuery } from '../../ui/poll'
import { useSelectionHold } from '../../ui/useSelectionHold'
import { PageHead } from '../../ui/PageHead'
import { TechDetails } from '../../ui/TechDetails'
import { CopyButton } from '../../ui/CopyButton'
import { HarnessIcon } from '../../ui/HarnessIcon'
import type { ScreenProps } from '../../ScreenOutlet'
import { logModel as logModelJs, agentsOf as agentsOfJs } from './log-model.mjs'
import { Parts, techPairs, type Pair } from './AgentRow'
import { Chev } from '../../ui/Chev'

type Row = { key: string, time: string, who: { id: string, name: string } | null, whoText: string, text: string, unknown: boolean,
  count: string, tech: Pair[], diag: string }
type Model = { state: 'reading' | 'unreadable' | 'ready', say: string[], partial: Pair[] | null, rows: Row[], none: string | null,
  manifest: Pair[], foot: { expected: string[], errors: Pair[] } | null }
const logModel = logModelJs as (doc: unknown, o: { filter: string | null }) => Model
const agentsOf = agentsOfJs as (doc: unknown) => string[]
const captureVerdict = verdictJs as (doc: unknown, o: { okAt: number | null, err: string | null }) => { state: string, text: string }

const valueText = (v: Pair['v']) => ('parts' in v ? v.parts.map((p) => ('mono' in p ? p.mono : p.text)).join('') : 'mono' in v ? v.mono : v.text)
const pairsText = (pairs: Pair[]) => pairs.map(({ k, v }) => `${k}: ${valueText(v)}`).join('\n')
const Value = ({ v }: { v: Pair['v'] }) => ('parts' in v ? <Parts parts={v.parts} /> : <Parts parts={[v]} />)
const Grid = ({ pairs }: { pairs: Pair[] }) => (
  <div className="tech">{pairs.map(({ k, v }, i) => <Fragment key={`${i}:${k}`}><span className="k">{k}</span><span className="v"><Value v={v} /></span></Fragment>)}</div>
)

function FilterMenu({ filter, agents }: { filter: string | null, agents: string[] }) {
  const items = [{ id: '', label: 'All agents', href: '#/capture/log' },
    ...agents.map((a) => ({ id: a, label: harnessName(a), href: `#/capture/log?h=${encodeURIComponent(a)}` }))]
  return (
    <MenuTrigger>
      <Button className="popbtn" aria-label="Filter by agent">{filter ? harnessName(filter) : 'All agents'} <span className="chev" aria-hidden="true">▾</span></Button>
      <Popover className="pop menu" placement="bottom end">
        <Menu aria-label="Filter by agent" items={items}>
          {(i) => <MenuItem id={i.id} href={i.href} textValue={i.label}>{i.label}</MenuItem>}
        </Menu>
      </Popover>
    </MenuTrigger>
  )
}

function LogRow({ row, open, onOpen }: { row: Row, open: boolean, onOpen: (open: boolean) => void }) {
  return (
    <Disclosure className="lr" data-key={row.key} data-unknown={row.unknown ? '1' : undefined} isExpanded={open} onExpandedChange={onOpen}>
      <span className="t">{row.time}</span>
      <span className="ag">{row.who ? <><HarnessIcon id={row.who.id} /><span className="chipname">{row.who.name}</span></> : <span className="c2">{row.whoText}</span>}</span>
      <span className="say">{row.text}</span>
      <span className="cnt">{`×${row.count}`}</span>
      <Button slot="trigger" className="lgo" data-lrow={`lx-${row.key}`} aria-label="Expand this row">
        <Chev />
      </Button>
      <DisclosurePanel className="lx">
        <TechDetails pairs={techPairs(row.tech)} copy={pairsText(row.tech)} />
        <div className="capcopy"><CopyButton text={row.diag} label="Copy diagnostics" row /></div>
      </DisclosurePanel>
    </Disclosure>
  )
}

// the page-bottom technical details: the by-design groups under one heading, then the read problems
function Foot({ foot }: { foot: NonNullable<Model['foot']> }) {
  return (
    <Disclosure className="disc">
      <Button slot="trigger" className="disc-t"><Chev /><b>Technical details</b></Button>
      <DisclosurePanel className="disc-b">
        {foot.expected.length ? <><h3 className="caplog-foot-h">{LOG.expectedTitle}</h3>
          <ul className="caplog-foot-l">{foot.expected.map((t, i) => <li key={i}>{t}</li>)}</ul></> : null}
        {foot.errors.length ? <Grid pairs={foot.errors} /> : null}
      </DisclosurePanel>
    </Disclosure>
  )
}

export default function CaptureLogScreen({ route }: ScreenProps) {
  const filter = (route.params as { h?: string }).h || null
  const status = useStatusQuery()
  const latest = useMemo(() => ({ doc: status.doc, okAt: status.okAt, err: status.err, errAt: status.errAt }), [status.doc, status.okAt, status.err, status.errAt])
  const { shown, ref, release } = useSelectionHold(latest)
  const model = useMemo(() => logModel(shown.doc, { filter }), [shown.doc, filter])
  // two missed reads → 「? not refreshed · as of T」 leads the say line (the capture page's rule, taken again at every answer)
  const stale = useMemo(() => { const v = captureVerdict(shown.doc, { okAt: shown.okAt, err: shown.err }); return v.state === 'stale' ? v.text : null }, [shown])
  const agents = useMemo(() => agentsOf(shown.doc), [shown.doc])

  // open state: the reader's choice per group key; a filter change starts over and shows the latest answer at once
  const [choice, setChoice] = useState<ReadonlyMap<string, boolean>>(() => new Map())
  const [shownFilter, setShownFilter] = useState(filter)
  if (shownFilter !== filter) { setShownFilter(filter); setChoice(new Map()); release() }
  const setOpen = useCallback((key: string, open: boolean) => setChoice((m) => new Map(m).set(key, open)), [])

  const say = (stale ? [stale, ...model.say] : model.say).map((s, i) => <Fragment key={i}>{i ? <span aria-hidden="true"> · </span> : null}{s}</Fragment>)
  return (
    <div className="page capage">
      <div id="cloghead"><PageHead name={SCREEN_NAME['capture-log']} readAt={shown.okAt} tools={<FilterMenu filter={filter} agents={agents} />} /></div>
      <div className="cap-main" id="clogmain" ref={ref}>
        {model.state === 'reading' ? <p className="caplog-none">{stale ?? READING}</p> : null}
        {model.state === 'unreadable' ? <><p className="caplog-none">{say}</p>{model.foot ? <Foot foot={model.foot} /> : null}</> : null}
        {model.state === 'ready' ? <>
          <div className="caplog-bar">
            <p className="caplog-say">{say}</p>
            {model.partial ? <TechDetails pairs={techPairs(model.partial)} copy={pairsText(model.partial)} /> : null}
          </div>
          <section className="crows" aria-label="Capture failures">
            {model.rows.length ? <>
              <div className="lr h"><span>Time</span><span>Agent</span><span className="say">What happened</span><span className="cnt">Count</span><span></span></div>
              {model.rows.map((r) => <LogRow key={r.key} row={r} open={choice.get(r.key) === true} onOpen={(o) => setOpen(r.key, o)} />)}
            </> : <p className="caplog-none">{model.none}</p>}
          </section>
          {model.manifest.map((m, i) => (
            <section key={i} className="cblock" aria-label={m.k}><p>{m.k} · <Value v={m.v} /></p></section>
          ))}
          {model.foot ? <Foot foot={model.foot} /> : null}
        </> : null}
      </div>
    </div>
  )
}
