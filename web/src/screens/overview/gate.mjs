// screens/overview/gate.mjs — the overview's slow reads share n sockets (1.7 §读取与刷新: the browser's six per origin keep room for
// status and sessions; TanStack Query has no per-group concurrency limit). createGate(n).run(signal, fn) → fn's promise: at most n fns
// in flight, the rest wait first in, first out. An abort while waiting takes the entry out of the line and rejects; an abort while
// running gives the slot back at once, as the browser gives back the socket, and fn's own promise still settles the call.
export function createGate(n) {
  let free = n
  const line = []
  const next = () => { const job = line.shift(); if (job) job(); else free++ }
  return {
    run(signal, fn) {
      return new Promise((resolve, reject) => {
        const aborted = () => signal.reason ?? new DOMException('aborted', 'AbortError')
        if (signal?.aborted) { reject(aborted()); return }
        const start = () => {
          signal?.removeEventListener('abort', leave)
          let held = true
          const give = () => { if (!held) return; held = false; signal?.removeEventListener('abort', give); next() }
          signal?.addEventListener('abort', give, { once: true })
          Promise.resolve().then(fn).then(resolve, reject).finally(give)
        }
        const leave = () => { const i = line.indexOf(start); if (i >= 0) line.splice(i, 1); reject(aborted()) }
        if (free > 0) { free--; start(); return }
        line.push(start)
        signal?.addEventListener('abort', leave, { once: true })
      })
    },
  }
}
