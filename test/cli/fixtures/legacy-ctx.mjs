// test/cli/fixtures/legacy-ctx.mjs — what a test of the old capture on a platform without the new collector (RFC 1.6 §4) hands to `asight on | off | status | uninstall`: a sandbox HOME that holds
// what the old commands (`desktop on`, `monitor on`) leave on a Mac — the Clash Verge Script.js with asight's block and the runtime config with its route, the three LaunchAgents, the CC-CLI
// steer and its stash — a launchd that remembers what is loaded, a login environment, a keychain, and a Clash core that answers on a real unix socket and says what it is asked.
// Nothing here reaches the machine the tests run on (0.1 §3): every OS tool goes to the fake runner, HOME is a temp directory, the core is a socket in it.
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { tmpDir } from '../../helpers/tmp.mjs'
import { injectScript, DESKTOP_RULE, PROXY_NAME } from '../../../src/capture/desktop-steer.mjs'

export const NO_OP = '// Define main function (script entry)\nfunction main(config, profileName) { return config; }\n'
/** A custom global Script: stripping asight's block gives these bytes back exactly (D28). */
export const USER_MAIN = '// my rules\nfunction main(config, profileName) {\n  config.rules = config.rules || [];\n  config.rules.push("DOMAIN,example.com,DIRECT");\n  return config;\n}\n'
/** The runtime config after a Verge regen with the durable Script.js in place (serde_yaml block style: the route is there, unmarked). */
export const RT_REGEN = ['mixed-port: 7897', 'proxies:', '- name: atrace-mitm', '  type: http', '  server: 127.0.0.1', '  port: 9898', '- name: VPN', '  type: ss', 'rules:', `- ${DESKTOP_RULE}`, '- MATCH,VPN', ''].join('\n')
export const RT_CLEAN = RT_REGEN.replace('- name: atrace-mitm\n  type: http\n  server: 127.0.0.1\n  port: 9898\n', '').replace(`- ${DESKTOP_RULE}\n`, '')
export const CA_CN = 'atrace local MITM CA'
export const KEYCHAIN = (home) => path.join(home, 'Library', 'Keychains', 'login.keychain-db')
const LABELS = ['com.asight.mitm', 'com.asight.monitor', 'com.asight.env']

/** The plist text `launchctl` would be loaded from: the env primer carries the CA path it sets. */
export const plistText = (label, caPath) => `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>\n  <key>Label</key><string>${label}</string>\n  <key>ProgramArguments</key><array>\n${label === 'com.asight.env' ? `    <string>/bin/launchctl</string>\n    <string>setenv</string>\n    <string>NODE_EXTRA_CA_CERTS</string>\n    <string>${caPath}</string>` : '    <string>/usr/local/bin/node</string>\n    <string>/x/asight.mjs</string>\n    <string>mitm</string>'}\n  </array>\n</dict></plist>\n`

/**
 * A HOME the way the old commands leave a Mac. `block` / `runtime`: asight's route is in Script.js / in the runtime config; `agents`: which LaunchAgents are installed (and loaded); `steer`: the CC-CLI
 * steer with its stash (`displaced` is what it displaced); `userMain`: the user's own global Script under the block; `ca: false`: no CA yet (`on` generates it); `verge: false`: no Clash Verge at all.
 */
export function macHome({ block = true, runtime = true, agents = LABELS, steer = true, userMain = NO_OP, displaced = {}, ca = true, verge: withVerge = true } = {}) {
  const home = tmpDir('asight-legacy-platform-')
  const verge = path.join(home, 'Library', 'Application Support', 'io.github.clash-verge-rev.clash-verge-rev')
  const script = path.join(verge, 'profiles', 'Script.js'), runtimePath = path.join(verge, 'clash-verge.yaml')
  if (withVerge) {
    fs.mkdirSync(path.join(verge, 'profiles'), { recursive: true })
    fs.writeFileSync(script, block ? injectScript(userMain, 9898) : userMain)
    fs.writeFileSync(runtimePath, runtime ? RT_REGEN : RT_CLEAN)
  }
  const caPath = path.join(home, '.asight', 'ca', 'atrace-ca.crt')
  if (ca) { fs.mkdirSync(path.dirname(caPath), { recursive: true }); fs.writeFileSync(caPath, '-----BEGIN CERTIFICATE-----\nca\n-----END CERTIFICATE-----\n') }
  const la = path.join(home, 'Library', 'LaunchAgents'); fs.mkdirSync(la, { recursive: true })
  for (const label of agents) fs.writeFileSync(path.join(la, `${label}.plist`), plistText(label, caPath))
  const settings = path.join(home, '.claude', 'settings.json'), stash = path.join(home, '.atrace', 'steer-backup.json')
  fs.mkdirSync(path.dirname(settings), { recursive: true })
  if (steer) {
    fs.writeFileSync(settings, JSON.stringify({ model: 'x', env: { ...displaced, HTTPS_PROXY: 'http://127.0.0.1:9898', NO_PROXY: '127.0.0.1,localhost', KEEP: '1' } }, null, 2) + '\n')
    fs.mkdirSync(path.dirname(stash), { recursive: true }); fs.writeFileSync(stash, JSON.stringify({ settingsPath: null, env: displaced }, null, 2) + '\n')
  } else fs.writeFileSync(settings, '{"model":"x"}\n')
  return { home, verge, script, runtimePath, merge: path.join(verge, 'profiles', 'Merge.yaml'), caPath, la, plist: (label) => path.join(la, `${label}.plist`), settings, stash, keychain: KEYCHAIN(home), agents }
}

/**
 * launchd, the login environment and the keychain as one fake runner (`run` has the shape of spawnSync's answer). Every call is recorded in `calls` (and in `order`, shared with the Clash core, when given).
 * `list <label>` is 0 for a loaded label (with a PID when it has one) and 113 otherwise; `unload <plist>` takes the label out (after `onUnload(label)`, which a test hangs the MITM's SIGTERM on); `getenv` answers
 * `env`; `security find-certificate` is 0 while `keychain` is true and 44 after the delete.
 */
export function fakeMac({ loaded = LABELS, pids = { 'com.asight.mitm': 4242 }, env = {}, keychain = true, onUnload = () => {}, order = [], failUnload = [] } = {}) {
  const calls = []
  const state = { loaded: new Set(loaded), env: { ...env }, keychain }
  const run = (file, args) => {
    const cmd = [file, ...args].join(' ')
    calls.push(cmd); order.push(cmd)
    const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' })
    if (file === 'launchctl') {
      const [sub, a] = args
      if (sub === 'list') return state.loaded.has(a) ? ok(`{\n\t"Label" = "${a}";\n${pids[a] ? `\t"PID" = ${pids[a]};\n` : ''}};`) : { status: 113, stdout: '', stderr: `Could not find service "${a}" in domain for port` }
      if (sub === 'unload') {
        const label = path.basename(a, '.plist')
        if (failUnload.includes(label)) return { status: 5, stdout: '', stderr: 'Unload failed: 5: Input/output error' }
        onUnload(label); state.loaded.delete(label); return ok()
      }
      if (sub === 'remove') { state.loaded.delete(a); return ok() }
      if (sub === 'getenv') return ok(state.env[a] || '')
      if (sub === 'unsetenv') { delete state.env[a]; return ok() }
      if (sub === 'load') { state.loaded.add(path.basename(a, '.plist')); return ok() }
      if (sub === 'setenv') { state.env[a] = args[2]; return ok() }
    }
    if (file === 'security') {
      if (args[0] === 'find-certificate') return state.keychain ? ok('keychain: ...') : { status: 44, stdout: '', stderr: 'The specified item could not be found in the keychain.' }
      if (args[0] === 'delete-certificate') { if (!state.keychain) return { status: 44, stdout: '', stderr: 'could not be found' }; state.keychain = false; return ok() }
      if (args[0] === 'add-certificates') { state.keychain = true; return ok() }
    }
    return { status: 1, stdout: '', stderr: `fakeMac: no answer for ${cmd}` }
  }
  return { run, calls, state, has: (re) => calls.some((c) => re.test(c)), mutating: () => calls.filter((c) => /^launchctl (unload|unsetenv|remove|load|setenv)|^security (delete|add)/.test(c)) }
}

/** The Clash core on a real unix socket in a temp dir (the way test/capture/desktop-steer.test.mjs has it): GET /version, GET /proxies, PUT /configs {payload}; `live` follows the last payload. `onRequest`
 *  is awaited before each answer (a test looks at the world at that instant); `breakProxies` makes its proxy list unreadable (the reload is accepted, the read-back is not). */
export async function fakeCore({ live = true, onRequest = null, order = [], rejectAll = null, breakProxies = false } = {}) {
  const dir = tmpDir('asight-core-')
  const sock = path.join(dir, 'm.sock')
  const state = { live, puts: [], gets: [] }
  const send = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(obj ? JSON.stringify(obj) : '') }
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => (b += c))
    req.on('end', async () => {
      if (req.method === 'GET' && req.url === '/version') return send(res, 200, { meta: true, version: 'v1.19.31' })
      const tag = `${req.method} ${req.url.split('?')[0]}`
      order.push(tag)
      if (onRequest) await onRequest(tag, req)
      if (req.method === 'GET' && req.url === '/proxies') { state.gets.push(tag); if (breakProxies) { res.writeHead(200); return res.end('<html>not json</html>') } return send(res, 200, { proxies: state.live ? { [PROXY_NAME]: { type: 'Http' } } : {} }) }
      if (req.method === 'PUT' && req.url.startsWith('/configs')) {
        const body = JSON.parse(b); state.puts.push(body)
        if (rejectAll) return send(res, 400, { message: rejectAll })
        state.live = (body.payload.match(/name: '?atrace-mitm'?[,}\s]/g) || []).length > 0
        return send(res, 204)
      }
      send(res, 404, { message: 'no route' })
    })
  })
  await new Promise((r) => srv.listen(sock, r))
  return { sock, state, close: () => new Promise((r) => srv.close(() => r())) }
}

/** A clock that does not wait: `sleep(ms)` moves `ms()` on and lets the I/O of the process run for a moment; `at(ms, fn)` runs `fn` the first time the clock reaches that many ms from now. */
export function fakeClock(start = 1_000_000) {
  let t = start
  const hooks = []
  return {
    ms: () => t,
    sleep: async (n) => { t += n; for (const h of hooks) if (!h.done && t >= start + h.at) { h.done = true; await h.fn() } await new Promise((r) => setTimeout(r, 3)) },
    at: (ms, fn) => hooks.push({ at: ms, fn, done: false }),
    elapsed: () => t - start,
  }
}

/** The runner of `openssl` that `generateCa` takes: writes a stub file where `-out` says, answers 0 (a real RSA-3072 key takes seconds, and this test is about what `on` does with the files). */
export const fakeOpenssl = (file, args) => { const i = args.indexOf('-out'); if (i >= 0) fs.writeFileSync(args[i + 1], `stub ${file} ${args[0]}\n`); return { status: 0 } }

export const readEvents = (home) => { try { return fs.readFileSync(path.join(home, '.asight', 'logs', 'mitm-events.ndjson'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) } catch { return [] } }
export { LABELS }
