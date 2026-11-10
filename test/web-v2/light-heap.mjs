// test/web-v2/light-heap.mjs — for scripts/deploy-check.mjs: imported by the board face's deps module (test/web-v2/real-face.mjs), so inside the light query worker
// it reports each new peak of the used heap on IPC (`{heapPeakMb}`). Sampled between turns of the event loop: a synchronous read is seen as it ends. Elsewhere it does nothing.
import v8 from 'node:v8'

if (process.argv[4] === 'light') {
  let peak = 0
  setInterval(() => {
    const mb = Math.ceil(v8.getHeapStatistics().used_heap_size / 1048576)
    if (mb > peak && process.connected) { peak = mb; process.send({ heapPeakMb: mb }) }
  }, 50).unref()
}
