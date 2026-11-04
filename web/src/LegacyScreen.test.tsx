// web/src/LegacyScreen.test.tsx — the legacy screen host (1.2 §路由, D75②): a route whose screen another owner draws leaves the host
// element empty, also when it arrives while a legacy module is still loading (its 「Reading…」 page beside a React screen halved the
// React screen's width, 1.11 #25).
import { expect, test } from 'vitest'
import { createScreenHost, type Route } from './LegacyScreen'

const at = (screen: string) => ({ area: screen, screen, params: {} } as Route)

test('a route to another owner while a legacy module loads leaves the host empty, and the late module mounts nothing', async () => {
  const el = document.createElement('div')
  let release!: (m: unknown) => void
  const mounted: string[] = []
  const host = createScreenHost(el, {}, { overview: () => new Promise((r) => { release = r }) }, [])
  void host.show(at('overview'))
  expect(el.childElementCount).toBe(1) // its 「Reading…」 page
  await host.show(at('settings-storage'))
  expect(el.childElementCount).toBe(0)
  release({ mount: () => { mounted.push('overview'); return { update() {}, unmount() {} } } })
  await new Promise((r) => setTimeout(r, 0))
  expect(mounted).toEqual([])
  expect(el.childElementCount).toBe(0)
  host.dispose()
})
