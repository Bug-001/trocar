// web/src/ScreenOutlet.tsx — where a React screen is drawn inside #screen (1.2 §路由, D75②): its module loads on demand behind
// Suspense (the same 「Reading…」 line the legacy host shows), and a screen that throws while it loads or renders says why with the
// legacy screen-failed markup, never a blank area. The boundary resets when the screen changes.
import { Component, Suspense, type ComponentType, type ErrorInfo, type LazyExoticComponent, type ReactNode } from 'react'
import { screenErrorHtml } from '../legacy/shell/safemount.mjs'
import { READING } from '../legacy/labels/common.mjs'
import type { Route } from './LegacyScreen'

export type ScreenProps = { route: Route }
export type LazyScreen = LazyExoticComponent<ComponentType<ScreenProps>>

class ScreenBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null as string | null }
  static getDerivedStateFromError(e: unknown) { return { error: String((e as Error)?.message ?? e) } }
  componentDidCatch(e: unknown, info: ErrorInfo) { console.error('screen failed', e, info.componentStack) }
  render() {
    if (this.state.error == null) return this.props.children
    return <div style={{ display: 'contents' }} dangerouslySetInnerHTML={{ __html: screenErrorHtml(this.state.error) }} />
  }
}

export function ScreenOutlet({ screen: Screen, name, route }: { screen: LazyScreen, name: string, route: Route }) {
  return (
    <ScreenBoundary key={name}>
      <Suspense fallback={<div className="page"><p className="screenwait">{READING}</p></div>}>
        <Screen route={route} />
      </Suspense>
    </ScreenBoundary>
  )
}
