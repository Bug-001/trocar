// test/helpers/session-doc.mjs — records as the collector writes them, put in one raw segment of a fresh ~/.trocar, and read back
// through the named queries every path answers with (runQuery: index → extraction → reduction → document, RFC 3.5 §会话读).
// A record keeps every field it gives; only the envelope fields it leaves out are filled, as src/capture/envelope.mjs writes them.
import fs from 'node:fs'
import path from 'node:path'
import { tmpDir } from './tmp.mjs'
import { runQuery } from '../../src/query/named/index.mjs'

export const SEGMENT = '20261102T100000Z'

/** homeWith(records) → a ~/.trocar whose raw/<SEGMENT>.ndjson holds `records`, one per line, in the order given. */
export function homeWith(records) {
  const home = path.join(tmpDir('trocar-sdoc-'), '.trocar')
  fs.mkdirSync(path.join(home, 'raw'), { recursive: true })
  const line = (r, i) => JSON.stringify({ ts: r.ts_request, method: 'POST', capture: 'transparent', is_llm_call: true, traffic_class: 'llm',
    proc: { pid: 1, exe: '/x/claude', agent: 'claude-code' }, ...r, id: r.id ?? `r_${i}` })
  fs.writeFileSync(path.join(home, 'raw', `${SEGMENT}.ndjson`), records.map(line).join('\n') + '\n')
  return home
}

/** query(home, name, params) → the named document, as the local path answers it. */
export const query = (home, name, params = {}) => runQuery(name, params, { home, fs })

/** sessionDoc(records, id) → the `session` document of session `id` over `records`. */
export const sessionDoc = (records, id) => query(homeWith(records), 'session', { id })
