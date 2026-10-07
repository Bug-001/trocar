// verge-world.mjs — a sandbox Clash Verge for the adapter tests (RFC 4.7; plan Task 6): Verge's data directory (verge.yaml, config.yaml, the runtime clash-verge.yaml, profiles.yaml, profiles/Script.js) in a
// temp directory, a fake core (fixtures/fake-core.mjs), an adapter pointed at it, and the fact a test flips (Verge running). The adapter reads three of those files; profiles.yaml and Script.js are in the directory
// because Verge has them (N10: the whole directory must come out byte for byte as it went in). Every secret-looking value in it (the controller secret, the subscription's address, a node, a group and a domain the
// user has) is a made-up one the tests scan for: none of them may leave the adapter (N1 N9).
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { tmpDir } from '../../helpers/tmp.mjs'
import { startFakeCore } from './fake-core.mjs'
import { createController } from '../../../src/netenv/mihomo/controller.mjs'
import { createVergeAdapter, VERGE_DIR_NAME } from '../../../src/netenv/adapters/clash-verge-rev.mjs'
import { runtimeText } from './rules/runtime.mjs'

export const SECRET = 's3cr3t' // the controller's secret
export const SUB_URL = 'https://sub.example/xyz?token=abc'
export const NODE = 'node-hk-01'
export const USER_GROUP = 'Home Group'
export const USER_DOMAIN = 'internal.corp.example'
export const USER_PROVIDER = 'corp-private-rules'
export const LEAKS = [SECRET, SUB_URL, 'sub.example', NODE, USER_GROUP, USER_DOMAIN, USER_PROVIDER, 'My Subscription', '0123456789abcdef'] // none of these may be in anything asight keeps, prints or logs

export const VERGE_YAML = (over = '') => `language: zh\ntheme_mode: dark\nenable_tun_mode: false\nenable_system_proxy: true\nenable_service_mode: false\nverge_mixed_port: 7897\n${over}`
export const CONFIG_YAML = `mixed-port: 7897\nallow-lan: false\nexternal-controller-pipe: \\\\.\\pipe\\verge-mihomo-0123456789abcdef\nsecret: ${SECRET}\n`
export const PROFILES_YAML = `current: Rabc123xyz\nchain:\n- Script\nvalid: []\nitems:\n- uid: Rabc123xyz\n  type: remote\n  name: My Subscription\n  file: Rabc123xyz.yaml\n  url: ${SUB_URL}\n  extra:\n    upload: 0\n- uid: Script\n  type: script\n  file: Script.js\n`
export const SCRIPT_JS = '// Define main function (script entry)\n\nfunction main(config, profileName) {\n  return config;\n}\n'

/** The runtime Verge writes, with the user's own things in it: a controller pipe and secret, a node and group and domain rule, a process rule for codex.exe. */
export const userRuntime = (extraRules = []) => `external-controller-pipe: \\\\.\\pipe\\verge-mihomo-0123456789abcdef\nsecret: ${SECRET}\n${runtimeText()
  .replace('https://example.invalid/ads.txt', SUB_URL).replace('- name: node-a', `- name: ${NODE}`).replace('- name: Manual', `- name: ${USER_GROUP}`)
  .replace('- DOMAIN-SUFFIX,example.com,Proxy', `- DOMAIN-SUFFIX,${USER_DOMAIN},${USER_GROUP}\n- PROCESS-NAME,codex.exe,${USER_GROUP}\n${extraRules.map((r) => `- ${r}`).join('\n')}${extraRules.length ? '\n' : ''}- DOMAIN-SUFFIX,example.com,Proxy`)}`

export const sha = (file) => (fs.existsSync(file) ? crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null)

/** Every file under `dir` → sha256, to compare before and after (the zero-write and the byte-for-byte assertions). */
export function snapshot(dir) {
  const out = {}
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out[path.relative(dir, p)] = sha(p) } }
  if (fs.existsSync(dir)) walk(dir)
  return out
}

/**
 * startWorld(t, { script, runtime, verge, core, adapter, files }) → { sandbox, home, core, adapter, state, file(name), asightHome }
 * `core` is the fake core's options (mode, tun, mixedPort, ...), `adapter` the adapter's (fs, helper, makeClient, ...), `files` more files of Verge's directory.
 */
export async function startWorld(t, { script = SCRIPT_JS, runtime = userRuntime(), verge = VERGE_YAML(), core: coreOpts = {}, adapter: adapterOpts = {}, files = {} } = {}) {
  const sandbox = tmpDir('asight-world-')
  const home = path.join(sandbox, 'AppData', 'Roaming', VERGE_DIR_NAME)
  fs.mkdirSync(path.join(home, 'profiles'), { recursive: true })
  const put = (rel, text) => fs.writeFileSync(path.join(home, rel), text)
  put('verge.yaml', verge); put('config.yaml', CONFIG_YAML); put('clash-verge.yaml', runtime); put('profiles.yaml', PROFILES_YAML)
  if (script !== null) put(path.join('profiles', 'Script.js'), script)
  for (const [rel, text] of Object.entries(files)) put(rel, text)
  const core = await startFakeCore(t, coreOpts)
  const state = { running: true }
  const adapter = createVergeAdapter({ home, controller: createController({ endpoint: core.endpoint }), running: () => state.running, ...adapterOpts })
  return { sandbox, home, core, adapter, state, file: (rel) => path.join(home, rel), asightHome: path.join(sandbox, '.asight') }
}
