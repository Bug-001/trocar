// test/helpers/mock-upstream.mjs — a loopback HTTP upstream for the installer tests: fixed bodies by path, Range answered with 206,
// and per-path faults. Every request is recorded, so a test can say "nothing was asked" or "the second source got a Range".
//
//   const up = await mockUpstream({ '/r1/pkg/latest': { body: json }, '/n1/v1/a.tgz': { body: bytes, cut: 1000 } })
//   up.base  // http://127.0.0.1:<port>
//   up.requests  // [{ path, range }]
//
// A route is { body: Buffer|string, cut? }: `cut` sends that many bytes of a full-length 200 and then drops the connection.
// An unknown path answers 404.
import http from 'node:http'

export async function mockUpstream(routes) {
  const requests = []
  const server = http.createServer((req, res) => {
    const range = req.headers.range || null
    requests.push({ path: req.url, range })
    const r = routes[req.url]
    if (!r) { res.writeHead(404).end(); return }
    const body = Buffer.from(r.body)
    const from = Number(/^bytes=(\d+)-$/.exec(range || '')?.[1] ?? 0)
    if (from > 0 && !r.cut) {
      res.writeHead(206, { 'content-length': body.length - from, 'content-range': `bytes ${from}-${body.length - 1}/${body.length}` })
      res.end(body.subarray(from))
      return
    }
    res.writeHead(200, { 'content-length': body.length })
    if (r.cut) res.write(body.subarray(0, r.cut), () => res.destroy())
    else res.end(body)
  })
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok))
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((ok) => { server.closeAllConnections(); server.close(() => ok()) }),
  }
}
