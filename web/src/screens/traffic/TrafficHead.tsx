// screens/traffic/TrafficHead.tsx — the page head of the traffic pages (1.2 §页头, the markup of legacy shell/pagehead.mjs): the screen's
// name or a breadcrumb, the scope control (a segmented group of links), 「Data read at HH:MM:SS」. Nothing else belongs to the head.
import { Fragment, type ReactNode } from 'react'
import { READ_AT } from '../../../legacy/shell/pagehead.mjs'
import { fmtTime } from '../../../legacy/core/fmt.mjs'

export type Crumb = { label: string, href?: string, node?: ReactNode }
export type Scope = { label: string, options: Array<{ value: string, label: string, href: string, on: boolean }> }

export function TrafficHead({ name, crumbs, scope, readAt }: { name?: string, crumbs?: Crumb[], scope?: Scope, readAt: number | null }) {
  const title = crumbs && crumbs.length
    ? <nav className="crumbs" aria-label="Breadcrumb">{crumbs.map((c, i) => {
      const last = i === crumbs.length - 1, body = c.node ?? c.label
      return <Fragment key={i}>
        {i ? <span className="sep" aria-hidden="true">›</span> : null}
        {last || !c.href ? <span aria-current={last ? 'page' : undefined}>{body}</span> : <a href={c.href}>{body}</a>}
      </Fragment>
    })}</nav>
    : <h1 className="pagename">{name}</h1>
  const seg = scope && scope.options.length > 1
    ? <nav className="seg" role="group" aria-label={scope.label}>{scope.options.map((o) => (
      <a key={o.value} href={o.href} className={o.on ? 'on' : undefined} aria-current={o.on ? 'true' : undefined}>{o.label}</a>
    ))}</nav>
    : null
  const read = readAt != null ? <span className="readat">{`${READ_AT} ${fmtTime(readAt)}`}</span> : null
  return <header className="pagehead">{title}{seg || read ? <span className="tools">{seg}{read}</span> : null}</header>
}
