// screens/settings/DiskCard.tsx — the 磁盘 card (1.11 §磁盘): what trocar uses on disk, the estimated growth per day, the capture files
// that did not fully read (a link that opens 「the files on disk」 and scrolls to it), and those files' technical details. A failed
// `segments` read is said here with a Retry, never read as zero problems (D38). The files section is a controlled disclosure with
// TechDetails' markup, so the link can open it; it keeps the reader's open or closed state across re-reads (§组件状态).
import { Fragment, useLayoutEffect, useRef, useState } from 'react'
import { Button, Disclosure, DisclosurePanel } from 'react-aria-components'
import { bytes, fmtStamp } from '../../../legacy/core/fmt.mjs'
import * as W from '../../../legacy/labels/settings.mjs'
import { CopyButton } from '../../ui/CopyButton'
import { TechDetails } from '../../ui/TechDetails'
import { flatText } from './storage-model.mjs'
import { Chev, GoChev } from '../../ui/Chev'

export type Pairs = Array<[string, string]>
export type DiskModel = {
  total: number | null, perDay: number | null, asOf: string | null, bad: number,
  segFail: { line: string, pairs: Pairs } | null, slow: boolean, files: Pairs,
}

export const techOf = (pairs: Pairs) => pairs.map(([k, v]) => [k, { text: v }] as [string, { text: string }])

export function DiskCard({ disk, onRetry }: { disk: DiskModel, onRetry: () => void }) {
  const [open, setOpen] = useState(false)
  const [jumps, setJumps] = useState(0)
  const files = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (!jumps) return
    try { files.current?.scrollIntoView({ block: 'nearest' }) } catch { /* no options */ }
  }, [jumps])
  return (
    <div className="scard">
      <h2>{W.CARD_DISK}</h2>
      {disk.total != null ? <p className="dline"><b>{W.DISK_TOTAL}</b> <span className="num">{bytes(disk.total)}</span></p> : null}
      <p className="dline"><b>{W.DISK_PER_DAY}</b> <span className="num">{disk.perDay != null ? `≈ ${bytes(disk.perDay)}` : '—'}</span>
        {disk.asOf ? <span className="cap">{`${W.AS_OF} ${fmtStamp(disk.asOf)}`}</span> : null}</p>
      {disk.segFail
        ? <><p className="dline bad">{disk.segFail.line} · <Button className="linkbtn" onPress={onRetry}>{W.RETRY}</Button></p>
          <TechDetails pairs={techOf(disk.segFail.pairs)} copy={flatText(disk.segFail.pairs)} /></>
        : disk.bad > 0
          ? <p className="dline bad"><a className="jumpfiles" href="#" onClick={(e) => { e.preventDefault(); setOpen(true); setJumps((n) => n + 1) }}>
            {`${W.BAD_FILES(disk.bad)} · ${W.BAD_FILES_SHOW}`} <GoChev /></a></p>
          : null}
      {disk.slow ? <p className="cap" data-note="slow">{W.SLOW_NOTE}</p> : null}
      <p className="dline"><a href={W.CAPTURE_PAGE_HREF}>{W.CAPTURE_PAGE_LINE} ›</a></p>
      <Disclosure className="disc" ref={files} isExpanded={open} onExpandedChange={setOpen}>
        <Button slot="trigger" className="disc-t"><Chev /><b>Technical details</b></Button>
        <DisclosurePanel className="disc-b">
          <div className="tech">{disk.files.map(([k, v], i) => (
            <Fragment key={`${i}:${k}`}><span className="k">{k}</span><span className="v">{v}</span></Fragment>
          ))}</div>
          <CopyButton text={flatText(disk.files)} />
        </DisclosurePanel>
      </Disclosure>
    </div>
  )
}
