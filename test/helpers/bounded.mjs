// test/helpers/bounded.mjs — waits that can only fail loudly.
//
// `node --test` puts no deadline on a promise a test is parked on, and `--test-force-exit` fires only once every test AND
// every hook has finished. So ONE await on an event that never comes — a TLS client that trusted a leaf it was to refuse,
// a proxy that never answered, a flow still open under an `after` hook that waits for it — parks the file and its process
// for ever: a `node --test test/capture/legacy-failures.test.mjs` ran for 4.5 h and three proxy-preludes runs for 5+ h
// that way, each a hang instead of a failure. A wait in a test therefore has a bound, and the bound fails the test with
// what it was waiting for.
import { once } from 'node:events'

/**
 * within(promise, ms, what, onTimeout?) → the promise's value, or a rejection `${what}: no answer within ${ms} ms`.
 * `onTimeout` runs first (destroy the socket the wait was on, so what holds it open lets go). The timer is cleared on
 * either outcome, so a settled wait leaves nothing behind.
 */
export function within(promise, ms, what, onTimeout) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { if (onTimeout) onTimeout() } catch { /* the wait is already lost; say so below */ }
      reject(new Error(`${what}: no answer within ${ms} ms`))
    }, ms)
    promise.then((v) => { clearTimeout(timer); resolve(v) }, (e) => { clearTimeout(timer); reject(e) })
  })
}

/** `events.once` with a bound; on timeout the emitter is destroyed when it can be (a socket). */
export function onceWithin(emitter, name, ms = 5000) {
  return within(once(emitter, name), ms, `waiting for '${name}'`, () => { if (typeof emitter.destroy === 'function') emitter.destroy() })
}

/**
 * closeWithin(closable, ms = 5000, what?) → `closable.close()`, or a rejection that says what it was waiting for.
 * `engine.close()` waits for every flow still in flight and never destroys one (4.6 §开关): a test that failed with a
 * client socket still open parks on it for ever, and when the close is in an `after` hook (a test-level `timeout` does
 * not cover a hook) the whole file with it. In a hook, close what the flows run to (the mock upstream, a stand-in
 * proxy) first, so their sockets go and the flows end; the bound is for what is left.
 */
export function closeWithin(closable, ms = 5000, what = 'engine.close() (a flow or a client socket is still open)') {
  return within(Promise.resolve().then(() => closable.close()), ms, what)
}
