// web/src/ScreenOutlet.tsx — where a React screen is drawn inside #screen (1.2 §路由, D75②): its module loads on demand (the same
// 「Reading…」 line the legacy host shows while it does), and a screen that throws while it loads or renders says why with the legacy
// screen-failed markup, never a blank area. The boundary resets when the screen changes.
import { Component, useEffect, useState, type ComponentType, type ErrorInfo, type ReactNode } from 'react'
import { screenErrorHtml } from '../legacy/shell/safemount.mjs'
import { READING } from '../legacy/labels/common.mjs'
import type { Route } from './LegacyScreen'
import type { createBoardRouter } from './router'
import { ConfirmProvider } from './ui/Confirm'

// router: the board's facade (setParams replaces the hash, go navigates); a screen writes its state through it, never location
export type ScreenProps = { route: Route, router: ReturnType<typeof createBoardRouter>['legacy'] }
export type LazyScreen<P extends object = ScreenProps> = { load(): Promise<unknown>, Screen: ComponentType<P> }

// lazyScreen(importer) → { load, Screen }: the module is loaded once, by the idle preload or the first render, whichever comes first.
// A screen whose module is in is drawn in the render that asks for it; one still loading reads 「Reading…」 until it is in, and not a
// moment longer. Not React.lazy behind Suspense: lazy suspends on its first render even with the module in, and React holds a
// fallback it has shown for 300 ms before revealing what replaced it, so every first visit, and every cold open, cost 300 ms.
// A screen's props are ScreenProps; the new desk's host (screens/replay/DeskHost.tsx) is loaded the same way with its own.
export function lazyScreen<P extends object = ScreenProps>(importer: () => Promise<{ default: ComponentType<P> }>): LazyScreen<P> {
  let Loaded: ComponentType<P> | undefined, pending: Promise<unknown> | undefined
  const load = () => (pending ??= importer().then((m) => { Loaded = m.default }))
  function Screen(props: P) {
    const [, loaded] = useState(false)
    const [failed, setFailed] = useState<{ e: unknown } | null>(null)
    useEffect(() => { if (!Loaded) load().then(() => loaded(true), (e: unknown) => setFailed({ e })) }, [])
    if (failed) throw failed.e // to the screen's boundary: it says why
    return Loaded ? <Loaded {...props} /> : <div className="page"><p className="screenwait">{READING}</p></div>
  }
  return { load, Screen }
}

// what a screen that throws while it loads or renders leaves in the content area (also the new desk's host, main.tsx)
export class ScreenBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null }
  static getDerivedStateFromError(e: unknown) { return { error: String((e as Error)?.message ?? e) } }
  componentDidCatch(e: unknown, info: ErrorInfo) { console.error('screen failed', e, info.componentStack) }
  render() {
    if (this.state.error == null) return this.props.children
    return <div style={{ display: 'contents' }} dangerouslySetInnerHTML={{ __html: screenErrorHtml(this.state.error) }} />
  }
}

// the confirm provider is the screen's own: a question it asked goes with it (1.2 §键盘「层随屏走」)
export function ScreenOutlet({ screen: { Screen }, name, route, router }: { screen: LazyScreen, name: string } & ScreenProps) {
  return <ScreenBoundary key={name}><ConfirmProvider><Screen route={route} router={router} /></ConfirmProvider></ScreenBoundary>
}
