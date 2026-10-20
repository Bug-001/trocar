// test/collector/harness/proxy-export.test.mjs — the `proxy` export of every harness file (RFC 1.6 §9.7, D37①, D43): how its agent reads a proxy, as data. `trocar status` draws each
// harness's path from it and `trocar doctor` takes its instructions from it, so a harness that adds a proxy behaviour adds it here and nowhere in core / cli (4.6 §结构, invariant 3).
// The Windows values come from a Windows test machine (L2 / L3: `measured.win32` is 'lab'); Linux and macOS are inferred from them until measured (claude-code on Linux was measured by V54).
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { loadHarnesses, proxyProblems } from '../../../src/collector/harness/index.mjs'

const HOME = '/home/u'
const all = await loadHarnesses()
const by = Object.fromEntries(all.map((d) => [d.name, d]))

test('every harness file has a proxy export of the 1.6 §9.7 shape, and the loader says what is wrong with one that does not', () => {
  assert.deepEqual(all.map((d) => d.name).sort(), ['claude-code', 'codex', 'deepseek-dsh', 'hermes', 'kimi-code', 'opencode', 'z-code'])
  for (const d of all) assert.deepEqual(proxyProblems(d.proxy), [], d.name)
  const good = by.codex.proxy
  const bad = [
    [undefined, /no proxy export/],
    [{ ...good, env: [] }, /env: not a list/],
    [{ ...good, files: [{ path: 'x', format: 'json', keys: [] }] }, /files\[0\]/],
    [{ ...good, systemProxy: { http: 'maybe', ws: false } }, /systemProxy\.http/],
    [{ ...good, unsupported: { socks5: 'ignored' } }, /unsupported\.socks5/],
    [{ ...good, branches: ['http'] }, /branches/],
    [{ ...good, measured: { win32: 'lab', linux: 'guess', darwin: 'inferred' } }, /measured\.linux/],
    [{ ...good, restart: { hint: '' } }, /restart/],
    [{ ...good, restart: { ...good.restart, managed: 'yes' } }, /restart.managed/],
  ]
  for (const [proxy, re] of bad) assert.match(proxyProblems(proxy).join('; '), re)
})

test('the values are the ones measured on a Windows test machine (the 1.6 §9.7 table): env, system proxy, SOCKS', () => {
  const row = (n) => { const p = by[n].proxy; return { env: p.env.includes('HTTPS_PROXY') || p.env.includes('ZCODE_HTTP_PROXY'), http: p.systemProxy.http, ws: p.systemProxy.ws, unsupported: p.unsupported, schemes: p.schemes, branches: p.branches } }
  assert.deepEqual(row('claude-code'), { env: true, http: false, ws: false, unsupported: { socks4: 'fails', socks5: 'fails', socks5h: 'fails' }, schemes: ['http', 'https'], branches: ['all'] })
  assert.deepEqual(row('codex'), { env: true, http: true, ws: false, unsupported: { socks4: 'silent-direct', socks5: 'silent-direct', socks5h: 'silent-direct' }, schemes: ['http', 'https'], branches: ['http', 'ws'] })
  assert.deepEqual(row('opencode'), { env: true, http: false, ws: false, unsupported: { socks4: 'fails', socks5: 'fails', socks5h: 'fails' }, schemes: ['http', 'https'], branches: ['all'] })
  assert.deepEqual(row('kimi-code'), { env: true, http: false, ws: false, unsupported: {}, schemes: ['http', 'https', 'socks4', 'socks5', 'socks5h'], branches: ['all'] })
  assert.deepEqual(row('deepseek-dsh'), { env: true, http: false, ws: false, unsupported: { socks4: 'silent-direct', socks5: 'silent-direct', socks5h: 'silent-direct' }, schemes: ['http', 'https'], branches: ['all'] })
  assert.deepEqual(row('hermes'), { env: true, http: true, ws: true, unsupported: {}, schemes: ['http', 'https', 'socks4', 'socks5', 'socks5h'], branches: ['all'] })
  assert.deepEqual(row('z-code'), { env: true, http: false, ws: false, unsupported: { socks4: 'fails', socks5: 'fails' }, schemes: ['http', 'https', 'socks5h'], branches: ['all'] })
  // Windows is measured for all of them; Linux for claude-code alone (V54, on a test machine: a real `claude -p` behind a CONNECT proxy named in its settings.json env); macOS for none
  for (const d of all) assert.deepEqual(d.proxy.measured, { win32: 'lab', linux: d.name === 'claude-code' ? 'lab' : 'inferred', darwin: 'inferred' }, `${d.name}: measured on Windows${d.name === 'claude-code' ? ' and Linux' : ''}, inferred elsewhere`)
})

test('the files a harness reads a proxy from resolve against HOME and its own config-dir variable', () => {
  const at = (n, env = {}) => by[n].proxy.files.map((f) => ({ path: f.path({ home: HOME, env }), format: f.format, keys: f.keys }))
  assert.deepEqual(at('claude-code'), [
    { path: path.join(HOME, '.claude', 'settings.json'), format: 'json', keys: [['env', 'HTTPS_PROXY'], ['env', 'HTTP_PROXY']] },
    { path: path.join(HOME, '.claude.json'), format: 'json', keys: [['env', 'HTTPS_PROXY'], ['env', 'HTTP_PROXY']] },
  ])
  assert.equal(at('claude-code', { CLAUDE_CONFIG_DIR: '/cfg' })[0].path, '/cfg/settings.json', 'CLAUDE_CONFIG_DIR moves both')
  assert.equal(at('claude-code', { CLAUDE_CONFIG_DIR: '/cfg' })[1].path, '/cfg/.claude.json')
  assert.deepEqual(at('codex'), [{ path: path.join(HOME, '.codex', '.env'), format: 'dotenv', keys: ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'HTTP_PROXY', 'http_proxy'] }])
  assert.equal(at('codex', { CODEX_HOME: '/c' })[0].path, '/c/.env')
  assert.equal(at('deepseek-dsh')[0].path, path.join(HOME, '.dsh', '.env'))
  assert.equal(at('deepseek-dsh', { DSH_HOME: '/d' })[0].path, '/d/.env')
  assert.equal(at('hermes')[0].path, path.join(HOME, '.hermes', '.env'))
  assert.equal(at('hermes', { HERMES_HOME: '/h' })[0].path, '/h/.env')
  assert.deepEqual(at('z-code'), [{ path: path.join(HOME, '.zcode', 'cli', 'config.json'), format: 'json', keys: [['network', 'httpProxy']] }])
  assert.deepEqual(at('opencode'), [], 'OpenCode reads its proxy from the environment only')
  assert.deepEqual(at('kimi-code'), [])
})

test('every harness says how to get a running agent to read a proxy again, and Z-Code names its own variable first', () => {
  for (const d of all) {
    assert.ok(d.proxy.restart.hint.length > 10 && d.proxy.restart.processes.length > 0, d.name)
    assert.ok(!/<[^>]+>/.test(d.proxy.restart.hint), `${d.name}: no <placeholder> in the hint`)
  }
  assert.equal(by['z-code'].proxy.env[0], 'ZCODE_HTTP_PROXY')
  assert.match(by.codex.proxy.restart.hint, /app-server/, 'Codex keeps the environment of its first TUI in a managed daemon')
})

test('restart.managed: only a harness whose settings live in a process its windows do not end says so (Codex\'s managed app-server); doctor then names that process by pid', () => {
  assert.deepEqual(all.filter((d) => d.proxy.restart.managed === true).map((d) => d.name), ['codex'])
  assert.match(by.codex.proxy.restart.processes, /^codex app-server --managed-daemon$/)
})
