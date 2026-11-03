// web/src/shell/Sidebar.tsx — the left sidebar: navigation only (1.2 §侧栏). Five areas, each with its fixed glyph, and the pages of
// 采集 and 设置. No status text, no counts, no colour that encodes state, no lamp, no badge, no news, nothing at the bottom: its text is
// the fixed label list of labels/shell.mjs in every capture state; the only dynamic things are which item is current and whether the
// sidebar is the 52px rail. Labels, sub-pages and fly-outs are all in the DOM either way; css shows one of them (the fly-out, names and
// sub-page links only, is the rail's only way to a sub-page).
// Links are React Aria links under its RouterProvider: a plain click navigates through ctx.router, a modified click (new tab, new
// window) is the browser's own. Hrefs are paths without '#'; React Router's useHref writes them as '#/…'.
import { useLayoutEffect, useMemo, useState, type ReactNode } from 'react'
import { useHref } from 'react-router'
import { Button, Link, RouterProvider } from 'react-aria-components'
import { areaOf, railByDefault, sessionsTabTarget } from '../../legacy/shell/sidebar.mjs'
import { icon, BRAND } from '../../legacy/core/icons.mjs'
import { BRAND as BRAND_TEXT, NAV, NAV_LABEL, RAIL_LABELS } from '../../legacy/labels/shell.mjs'
import type { Route } from '../LegacyScreen'
import { Svg } from '../ui/Svg'

declare module '@react-types/shared' {
  interface RouterConfig { routerOptions: { sessions?: boolean } }
}

type Facade = { current(): Route, go(r: Route, o?: { replace?: boolean }): void, parseHash(h: string): Route }
type Store = { get(): { libraryHash: string } }
type Item = { id: string, label: string, href: string, ic?: string, sub?: Item[] }

// the per-viewer collapse choice: localStorage in try/catch, unreadable storage = no choice (the defaults apply)
const SIDE_KEY = 'trocar.v2.sidebar'
const readPref = () => { try { const v = localStorage.getItem(SIDE_KEY); return v === '1' || v === '0' ? v : null } catch { return null } }
const writePref = (v: string) => { try { localStorage.setItem(SIDE_KEY, v) } catch { /* forget it */ } }

const path = (href: string) => href.replace(/^#/, '')
const here = (on: boolean) => (on ? { 'aria-current': 'page' as const } : {})

export function Sidebar({ route, router, store }: { route: Route, router: Facade, store: Store }) {
  const [pref, setPref] = useState(readPref)
  const rail = pref === '1' ? true : pref === '0' ? false : railByDefault(route)
  useLayoutEffect(() => { document.getElementById('app')?.classList.toggle('rail', rail) }, [rail]) // css keys the rail on #app.rail

  // the 会话 item returns to the library as it was left, and does nothing on the library itself (a click must not wipe its filters)
  // A followed link lets go of the focus, as the browser does when a page changes: a focused item would keep its fly-out open over the
  // content (css shows it on :focus-within).
  const navigate = (to: string, opts?: { sessions?: boolean }) => {
    const f = document.activeElement
    if (f instanceof HTMLElement && f.closest('#sidebar')) f.blur()
    if (!opts?.sessions) { router.go(router.parseHash('#' + to)); return }
    const next = sessionsTabTarget(router.current(), store.get().libraryHash)
    if (next) router.go(next)
  }
  const area = areaOf(route), screen = route.screen
  const link = (i: Item, cls: string, children: ReactNode, cur: boolean) => (
    <Link className={cls} href={path(i.href)} data-id={i.id} routerOptions={i.id === 'library' ? { sessions: true } : undefined} {...here(cur)}>{children}</Link>
  )
  const item = (i: Item) => (
    <li key={i.id} className={'item' + (i.id === area ? ' open' : '')}>
      {link(i, 'hit', <><span className="ico" dangerouslySetInnerHTML={{ __html: icon(i.ic) }} /><span className="lbl">{i.label}</span></>, i.id === screen && !i.sub)}
      {i.sub && <ul className="sub">{i.sub.map((s) => <li key={s.href}>{link(s, 'sub' + (s.id === screen ? ' on' : ''), s.label, s.id === screen)}</li>)}</ul>}
      <div className="fly" hidden><span className="fh">{i.label}</span>
        {i.sub && <div className="fsub">{i.sub.map((s) => <Link key={s.href} className="" href={path(s.href)} {...here(s.id === screen)}>{s.label}</Link>)}</div>}
      </div>
    </li>
  )
  return (
    <RouterProvider navigate={navigate} useHref={useHref}>
      <div className="brandrow">
        <Link className="brand" href="/overview"><Svg html={BRAND} /><b>{BRAND_TEXT}</b></Link>
        <Button className="iconbtn" data-rail="toggle" aria-label={rail ? RAIL_LABELS.out : RAIL_LABELS.in} aria-expanded={!rail}
          onPress={() => { const v = rail ? '0' : '1'; writePref(v); setPref(v) }}><Svg html={icon(rail ? 'rail-out' : 'rail-in')} /></Button>
      </div>
      <nav aria-label={NAV_LABEL}><ul className="nav">{(NAV as Item[]).map(item)}</ul></nav>
    </RouterProvider>
  )
}
