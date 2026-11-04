// replay/loader.mjs — the replay desk's loader (2.3 §读与画 加载器): every read of the desk but the poll's own `session --since`
// runs here. Pure, no DOM, no timers: a read that ends starts the next one waiting at once, never on the poll's beat.
//
// createLoader({max}) → {run(pri, fn), clear()}
//   · run(pri, fn): fn(signal) → a promise; run's promise settles as fn's does. A smaller `pri` runs first, an equal one in the order
//     asked; at most `max` fns run at a time. The desk's classes: 0 `block`; 1 the playhead's missing lane, a lane the reader asked
//     for, a lane the poll's delta touched; 2 the anchor lane's ledger chain; 3 the two older-page chains (`session --before`, the
//     anchor lane's `lane --to`); 4 the other held lanes' older pages
//   · clear(): the running fns' signals abort, the waiting ones reject with an AbortError and never run
export function createLoader({ max = 3 } = {}) {
  let queue = [], seq = 0
  const running = new Set()
  function pump() {
    while (running.size < max && queue.length) {
      const j = queue.shift(), ac = new AbortController()
      running.add(ac)
      new Promise((ok) => ok(j.fn(ac.signal))).then(j.ok, j.no).finally(() => { running.delete(ac); pump() })
    }
  }
  return {
    run(pri, fn) {
      return new Promise((ok, no) => {
        const j = { pri, n: seq++, fn, ok, no }, i = queue.findIndex((x) => x.pri > pri)
        if (i < 0) queue.push(j); else queue.splice(i, 0, j)
        pump()
      })
    },
    clear() {
      const q = queue
      queue = []
      for (const j of q) j.no(new DOMException('the desk was closed', 'AbortError'))
      for (const ac of running) ac.abort()
    },
  }
}
