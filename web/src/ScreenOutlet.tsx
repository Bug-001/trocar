// web/src/ScreenOutlet.tsx — where a React screen is drawn inside #screen (1.2 §路由, D75②): its module loads on demand (the same
// 「Reading…」 line the legacy host shows while it does), and a screen that throws while it loads or renders says why with the legacy
// screen-failed markup, never a blank area. The boundary resets when the screen changes.
import { Component, useEffect, useState, type ComponentType, type ErrorInfo, type ReactNode } from 'react'
import { screenErrorHtml } from '../legacy/shell/safemount.mjs'
import { READING } from '../legacy/labels/common.mjs'
import type { Route } from './LegacyScreen'
import { ConfirmProvider } from './ui/Confirm'

export type ScreenProps = { route: Route }
export type LazyScreen = { load(): Promise<unknown>, Screen: ComponentType<ScreenProps> }

// lazyScreen(importer) → { load, Screen }: the module is loaded once, by the idle preload or the first render, whichever comes first.
// A screen whose module is in is drawn in the render that asks for it; one still loading reads 「Reading…」 until it is in, and not a
// moment longer. Not React.lazy behind Suspense: lazy suspends on its first render even with the module in, and React holds a
// fallback it has shown for 300 ms before revealing what replaced it, so every first visit, and every cold open, cost 300 ms.
export function lazyScreen(importer: () => Promise<{ default: ComponentType<ScreenProps> }>): LazyScreen {
  let Loaded: ComponentType<ScreenProps> | undefined, pending: Promise<unknown> | undefined
  const load = () => (pending ??= importer().then((m) => { Loaded = m.default }))
  function Screen(props: ScreenProps) {
    const [, loaded] = useState(false)
    const [failed, setFailed] = useState<{ e: unknown } | null>(null)
    useEffect(() => { if (!Loaded) load().then(() => loaded(true), (e: unknown) => setFailed({ e })) }, [])
    if (failed) throw failed.e // to the screen's boundary: it says why
    return Loaded ? <Loaded {...props} /> : <div className="page"><p className="screenwait">{READING}</p></div>
  }
  return { load, Screen }
}

class ScreenBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null }
  static getDerivedStateFromError(e: unknown) { return { error: String((e as Error)?.message ?? e) } }
  componentDidCatch(e: unknown, info: ErrorInfo) { console.error('screen failed', e, info.componentStack) }
  render() {
    if (this.state.error == null) return this.props.children
    return <div style={{ display: 'contents' }} dangerouslySetInnerHTML={{ __html: screenErrorHtml(this.state.error) }} />
  }
}

// the confirm provider is the screen's own: a question it asked goes with it (1.2 §键盘「层随屏走」)
export function ScreenOutlet({ screen: { Screen }, name, route }: { screen: LazyScreen, name: string, route: Route }) {
  return <ScreenBoundary key={name}><ConfirmProvider><Screen route={route} /></ConfirmProvider></ScreenBoundary>
}
