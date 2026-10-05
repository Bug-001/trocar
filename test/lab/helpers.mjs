// helpers.mjs — client side of the mock-upstream tests. node --test also loads this file as a test
// file (it lives under test/); it only exports functions, so that is a no-op.
import http from 'node:http'
import https from 'node:https'
import { createHash } from 'node:crypto'

export const sha12 = (s) => createHash('sha256').update(s).digest('hex').slice(0, 12)

// One request through node's own HTTP client, which doubles as a check that our framing is sound.
// Resolves with the decoded body and the body chunks as the client saw them.
export function request(base, path, body, { method = body == null ? 'GET' : 'POST', headers = {}, agent, ca } = {}) {
  const u = new URL(path, base)
  const mod = u.protocol === 'https:' ? https : http
  return new Promise((resolve, reject) => {
    const req = mod.request(u, { method, agent, ca, headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), chunks, reused: req.reusedSocket }))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end(body ?? undefined)
  })
}

export const admin = async (up, method, path, body) =>
  JSON.parse((await request(up.adminUrl, path, body == null ? null : JSON.stringify(body), { method })).body)

export function parseSse(text) {
  return text.split(/\n\n/).filter((b) => b.trim()).map((block) => {
    const ev = { event: null, data: '' }
    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) ev.event = line.slice(7)
      else if (line.startsWith('data: ')) ev.data += line.slice(6)
    }
    return ev
  })
}

export async function waitFor(fn, ms = 2000) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 10))) {
    const v = await fn()
    if (v) return v
  }
  throw new Error('waitFor: timed out')
}
