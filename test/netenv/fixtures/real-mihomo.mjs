// real-mihomo.mjs — a REAL mihomo for the contract tests (W57): test/netenv/mihomo-contract.test.mjs (the engine, the probe, the generators' text) and mihomo-adapter-contract.test.mjs (the controller client
// and the Verge adapter). Runs when ASIGHT_MIHOMO_BIN points at a mihomo binary; otherwise the tests skip with the reason below. Dev Mac: the Verge-bundled
// `/Applications/Clash Verge.app/Contents/MacOS/verge-mihomo`, read-only (never Verge's data directory, never the running Verge, never the system proxy). The run: a scratch home (tmpDir, or the one the caller
// made), loopback ports chosen free at start, no tun, no dns section, no geodata download (the config points the geox URLs at the discard port), a clean environment (no proxy variables: the machine running the test has
// NO_PROXY set), and the process killed in t.after.
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { tmpDir } from '../../helpers/tmp.mjs'

export const BIN = process.env.ASIGHT_MIHOMO_BIN
export const gate = BIN ? {} : { skip: 'set ASIGHT_MIHOMO_BIN to a mihomo binary to run the real-mihomo contract (4.8 W57); a Verge-bundled verge-mihomo may be used read-only' }

export const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) }) })
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Start the binary on `configText` (or `config`, JSON being YAML) in `home` as `configName`; `ctl(method, path, body)` is a raw call with the controller's own secret, `logs` the process's output. */
export async function startMihomo(t, { config, configText, files = {}, secret, controller, home = tmpDir('asight-mihomo-'), configName = 'config.yaml' }) {
  fs.writeFileSync(path.join(home, configName), configText ?? JSON.stringify(config)) // JSON is YAML
  fs.mkdirSync(path.join(home, 'asight'), { recursive: true })
  for (const [rel, text] of Object.entries(files)) fs.writeFileSync(path.join(home, rel), text) // any other file a test wants beside the config
  const proc = spawn(BIN, ['-d', home, '-f', path.join(home, configName)], { env: { PATH: '/usr/bin:/bin', HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] })
  const killIt = () => { try { proc.kill('SIGKILL') } catch { /* gone */ } }
  process.once('exit', killIt)
  t.after(() => { killIt(); process.removeListener('exit', killIt) })
  const logs = []
  for (const st of [proc.stdout, proc.stderr]) st.on('data', (d) => { for (const l of String(d).split('\n')) if (l.trim()) logs.push(l) })
  const ctl = (method, p, body) => new Promise((res, rej) => {
    const r = http.request({ host: '127.0.0.1', port: controller, method, path: p, agent: false, headers: { authorization: `Bearer ${secret}`, ...(body ? { 'content-type': 'application/json' } : {}) } }, (rs) => {
      let b = ''; rs.on('data', (d) => { b += d }); rs.on('end', () => res({ status: rs.statusCode, body: b, json: () => JSON.parse(b) }))
    })
    r.on('error', rej); r.setTimeout(8000, () => r.destroy(new Error('controller timeout'))); if (body) r.write(JSON.stringify(body)); r.end()
  })
  for (let i = 0; i < 100; i++) { try { if ((await ctl('GET', '/version')).status === 200) break } catch { /* not up yet */ } await sleep(50) }
  const v = await ctl('GET', '/version')
  assert.equal(v.status, 200, `mihomo did not come up: ${logs.slice(-3).join(' | ')}`)
  return { ctl, logs, home, version: v.json().version }
}
