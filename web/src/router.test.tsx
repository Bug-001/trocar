// web/src/router.test.tsx — the ctx.router facade over React Router's hash router keeps the legacy window wrapper's URL-writer
// semantics (1.2 §路由): a burst of replace writes is current at once and the URL ends on the last; a push first lands the pending
// replace on the entry it leaves; Back drops the pending replace and pagehide lands it; a throwing history never throws out of go.
// A real hash router in jsdom; only the timers are fake.
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createBoardRouter } from './router'
import { WRITE_GAP_MS } from '../legacy/core/router.mjs'

type Board = ReturnType<typeof createBoardRouter>
let board: Board | null = null
const open = () => (board = createBoardRouter(null)).legacy
const settle = () => vi.advanceTimersByTimeAsync(0) // the router's writes land in microtasks; this yields a real task to drain them

// [kind, the hash after the call] of every history write from now on
function recordWrites() {
  const calls: [string, string][] = []
  for (const kind of ['replaceState', 'pushState'] as const) {
    const orig = history[kind].bind(history)
    vi.spyOn(history, kind).mockImplementation((...a: Parameters<History['pushState']>) => { orig(...a); calls.push([kind === 'replaceState' ? 'replace' : 'push', location.hash]) })
  }
  return calls
}

beforeEach(() => {
  history.replaceState(null, '', '#/')
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }) // the writer's clock stays real, as in the legacy tests: a write
  // right after another waits for the (fake) timer
})
afterEach(() => {
  board?.dispose(); board = null
  vi.useRealTimers(); vi.restoreAllMocks()
})

test('router: current() and subscribers see each value of a burst of replace-writes at once; the URL ends on the last', async () => {
  const router = open(), seen: (string | undefined)[] = []
  router.onRoute((r) => seen.push(r.params.step))
  router.go({ area: 'replay', screen: 'replay', project: 'p', id: 'i', params: {} }, { replace: true })
  for (let k = 1; k <= 40; k++) {
    router.setParams({ step: String(k) }) // setParams merges onto the PENDING route, not the stale hash
    expect(router.current().params.step).toBe(String(k)); expect(seen[seen.length - 1]).toBe(String(k))
  }
  await vi.advanceTimersByTimeAsync(WRITE_GAP_MS); await settle()
  expect(location.hash).toBe('#/replay/p/i?step=40'); expect(router.current().params.step).toBe('40')
})

test('router: a lone replace write is in the URL in the same task', () => {
  const router = open()
  router.setParams({ step: '3' }) // the first write: nothing was written within the gap, so it is not deferred
  expect(location.hash).toBe('#/overview?step=3')
})

test('router: a navigation (push) first lands the pending replace on the entry it leaves, then pushes', async () => {
  const router = open()
  router.go({ area: 'sessions', screen: 'library', params: {} }, { replace: true }); await vi.advanceTimersByTimeAsync(500)
  const calls = recordWrites()
  router.setParams({ sel: 'p::s1' }) // pending: the last write was just now
  router.go({ area: 'replay', screen: 'replay', project: 'p', id: 's1', params: {} }) // the user opens the row
  await settle()
  expect(calls).toEqual([['replace', '#/sessions?sel=p%3A%3As1'], ['push', '#/replay/p/s1']])
  calls.length = 0; await vi.advanceTimersByTimeAsync(500); expect(calls).toEqual([]) // the flushed write does not run a second time
})

test('router: Back / Forward cancels a pending replace (it belongs to the entry the reader left); leaving the page flushes it', async () => {
  const router = open()
  router.go({ area: 'capture', screen: 'capture', params: {} }); await settle()
  router.go({ area: 'sessions', screen: 'library', params: {} }); await vi.advanceTimersByTimeAsync(500)
  router.setParams({ h: 'cc' }); router.setParams({ q: 'x' }) // the second is pending
  await settle()
  const calls = recordWrites()
  history.back() // the browser moves to the entry before
  await vi.waitFor(async () => { await settle(); expect(router.current().screen).toBe('capture') })
  await vi.advanceTimersByTimeAsync(500); await settle()
  expect(calls).toEqual([]) // a stale replace must not overwrite the entry Back landed on
  expect(location.hash).toBe('#/capture')
  router.setParams({ h: 'cc' }); router.setParams({ h: 'kimi' }) // the second is pending
  window.dispatchEvent(new Event('pagehide')); await settle()
  expect(calls.map(([, h]) => h).at(-1)).toBe('#/capture?h=kimi') // the last value lands even when the page goes away first
})

test('router: a replaceState / pushState that throws (a rate-limited Safari) never throws out of go, and the route still changes', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  const router = open(), seen: string[] = []
  router.onRoute((r) => seen.push(r.screen))
  router.go({ area: 'sessions', screen: 'library', params: {} }, { replace: true }); await vi.advanceTimersByTimeAsync(500)
  const refuse = () => { throw new DOMException('too many calls', 'SecurityError') }
  vi.spyOn(history, 'replaceState').mockImplementation(refuse)
  router.setParams({ q: 'a' }); await vi.advanceTimersByTimeAsync(500)
  vi.spyOn(history, 'pushState').mockImplementation(refuse)
  expect(() => router.go({ area: 'traffic', screen: 'traffic', params: {} })).not.toThrow()
  await settle()
  expect(seen.at(-1)).toBe('traffic') // subscribers were told
  expect(location.hash).toBe('#/traffic') // the URL still follows (the fallback assigns the hash)
  expect(router.current().screen).toBe('traffic')
})

test('router: a subscriber that moves the route while it is told leaves every subscriber on the newer route, none told the older one after it', () => {
  const router = open(), later: (string | undefined)[] = []
  const desk = { area: 'replay', screen: 'replay', project: 'p', id: 'i', params: {} }
  router.onRoute((r) => { if (r.params.step == null) router.setParams({ step: '3' }) }) // a screen naming the step it shows as it is told
  router.onRoute((r) => later.push(r.params.step))
  router.go(desk)
  expect(router.current().params.step).toBe('3')
  expect(later).toEqual(['3'])
})
