// test/query/raw-home.mjs — a ~/.trocar with raw/ segments in it, for the segment-index tests.
import fs from 'node:fs'
import path from 'node:path'
import { tmpDir } from '../helpers/tmp.mjs'
import { QUERIES } from '../../src/query/named/index.mjs'

/** The query names whose answer is on disk. `status` and `doctor` read the machine (the daemon, the process table, the
 *  trust store), so they are exercised with injected deps in test/cli/data-commands.test.mjs, never by a loop over a HOME. */
export const DATA_QUERIES = Object.keys(QUERIES).filter((n) => !['status', 'doctor'].includes(n))

/** One envelope line as the collector writes it (src/capture/envelope.mjs field names). */
export const envLine = (o = {}) => JSON.stringify({
  ts: o.ts ?? '2026-10-18T10:00:00.000Z',
  endpoint: o.path ?? '/v1/messages',
  method: 'POST',
  req_headers: { 'content-type': 'application/json', ...(o.sessionKey ? { 'x-session-id': o.sessionKey } : {}) },
  req_body: '{"model":"m"}',
  resp: { status: o.status ?? 200, kind: 'json' },
  id: o.id ?? 'req_00001',
  ts_request: o.ts ?? '2026-10-18T10:00:00.000Z',
  is_llm_call: o.is_llm ?? true,
  capture: 'transparent',
  host: o.host ?? 'api.anthropic.com',
  traffic_class: o.class ?? 'llm',
  ...('noWire' in o ? {} : { body_wire_bytes: { req: 'wireReq' in o ? o.wireReq : 10, resp: 'wireResp' in o ? o.wireResp : 20 } }),
  proc: { pid: 7, exe: '/x', agent: o.harness ?? 'claude-code' },
})

/**
 * The parameters §4.1 marks required, for a test that loops over every query name (`session --id`,
 * `block --ref`). One place, so a new required parameter is added once.
 */
export const requiredFor = (name, { segment = '20261018T100000Z', session = 'no-such-session' } = {}) =>
  ({ session: { id: session }, lane: { id: session, lane: `${segment}:1` }, block: { ref: `${segment}:1` } })[name] || {}

export function rawHome(prefix = 'trocar-t6-') {
  const home = tmpDir(prefix)
  fs.mkdirSync(path.join(home, 'raw'), { recursive: true, mode: 0o700 })
  return home
}

/** Appends `lines` (objects for envLine, or ready strings) to ~/.trocar/raw/<segment>.ndjson. */
export function writeSegment(home, segment, lines) {
  const f = path.join(home, 'raw', `${segment}.ndjson`)
  fs.appendFileSync(f, lines.map((l) => (typeof l === 'string' ? l : envLine(l))).join('\n') + '\n', { mode: 0o600 })
  return f
}

/** Every file under `dir`, relative path → bytes + mode, for a before/after snapshot. */
export function snapshot(dir, rel = '') {
  const out = {}
  for (const ent of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${ent.name}` : ent.name
    if (ent.isDirectory()) Object.assign(out, snapshot(dir, r))
    else { const st = fs.lstatSync(path.join(dir, r)); out[r] = `${st.size}:${(st.mode & 0o777).toString(8)}:${fs.readFileSync(path.join(dir, r)).toString('base64')}` }
  }
  return out
}
