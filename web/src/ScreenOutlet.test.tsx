// web/src/ScreenOutlet.test.tsx — a React screen's module (1.2 §路由 · #22, D64③): while it loads, the outlet reads 「Reading…」 and the
// screen is drawn as soon as the module is in; once the idle preload has loaded it, the screen is drawn in the very render that asks
// for it, with no 「Reading…」 frame; a module that fails to load says why. (React.lazy behind Suspense did neither of the first two:
// it suspended on every first render, and React held the fallback it had shown for 300 ms.)
import { useEffect } from 'react'
import { afterEach, expect, test, vi } from 'vitest'
import { act, cleanup, render, type RenderResult } from '@testing-library/react'
import { createRoot } from 'react-dom/client'
import { READING } from '../legacy/labels/common.mjs'
import { ScreenOutlet, lazyScreen, type ScreenProps } from './ScreenOutlet'
import type { Route } from './LegacyScreen'
import { useConfirm } from './ui/Confirm'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const route = { area: 'capture', screen: 'capture', params: {} } as Route
const router = {} as ScreenProps['router']
const Drawn = ({ route: r }: ScreenProps) => <p className="drawn">{r.screen}</p>
const held = () => { let release!: () => void; return { at: new Promise<void>((r) => { release = r }), release: () => release() } }

// outside act(): act() flushes React's work at once and would hide a held reveal. 50 ms is a few of React's tasks and far below the 300 ms
// a held fallback costs.
test('a screen reads 「Reading…」 while its module loads, and is drawn as soon as it is in', async () => {
  const h = held()
  const s = lazyScreen(async () => { await h.at; return { default: Drawn } })
  const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }, prev = env.IS_REACT_ACT_ENVIRONMENT
  env.IS_REACT_ACT_ENVIRONMENT = false
  const el = document.body.appendChild(document.createElement('div')), root = createRoot(el)
  const tick = (ms: number) => new Promise((r) => setTimeout(r, ms))
  try {
    root.render(<ScreenOutlet screen={s} name="capture" route={route} router={router} />)
    await tick(50)
    expect(el.textContent).toBe(READING)
    h.release()
    await s.load()
    await tick(50)
    expect(el.querySelector('.drawn')?.textContent).toBe('capture')
  } finally { root.unmount(); el.remove(); env.IS_REACT_ACT_ENVIRONMENT = prev }
})

test('a screen the preload has loaded is drawn in the render that asks for it', async () => {
  const s = lazyScreen(async () => ({ default: Drawn }))
  await s.load() // the idle preload
  const r = render(<ScreenOutlet screen={s} name="capture" route={route} router={router} />) // committed synchronously, as the shell's route change
  expect(r.container.querySelector('.drawn')?.textContent).toBe('capture')
  expect(r.container.textContent).not.toContain(READING)
})

test('a screen whose module fails to load says why, never a blank area', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const s = lazyScreen(async () => { throw new Error('chunk gone') })
  let r!: RenderResult
  await act(async () => { r = render(<ScreenOutlet screen={s} name="capture" route={route} router={router} />) })
  await act(async () => { await s.load().catch(() => {}) })
  expect(r.container.querySelector('.screenerr[role="alert"]')?.textContent).toContain('chunk gone')
})

// 1.2 §键盘「层随屏走」: a React screen's confirm belongs to its screen. The screen leaving (another screen, Back) with the question
// open answers it as Cancel, so nothing carrying `confirm` is sent, and leaves no dialog behind.
test('a confirm open on a React screen closes as Cancel when the screen goes', async () => {
  let answer: Promise<boolean> | undefined
  function Asking() {
    const ask = useConfirm()
    useEffect(() => { answer = ask({ q: 'Turn capture on?', confirmLabel: 'Turn on' }) }, [ask])
    return <p className="drawn">asking</p>
  }
  const a = lazyScreen(async () => ({ default: Asking })), b = lazyScreen(async () => ({ default: Drawn }))
  await a.load(); await b.load()
  const other = { area: 'overview', screen: 'overview', params: {} } as Route
  let r!: RenderResult
  await act(async () => { r = render(<ScreenOutlet screen={a} name="capture" route={route} router={router} />) })
  expect(document.querySelector('[data-confirm="ok"]')).not.toBeNull()
  await act(async () => { r.rerender(<ScreenOutlet screen={b} name="overview" route={other} router={router} />) })
  expect(document.querySelector('[data-confirm]')).toBeNull()
  expect(await answer).toBe(false)
})
