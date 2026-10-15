// policy.test.mjs — the Windows policy reader, the persistent environment (plan P6) and the platform facts (RFC 4.11 OS backends), over
// an injected runner that answers `reg.exe query` with fixture text in reg.exe's own layout. reg.exe is never run.
import test from 'node:test'
import assert from 'node:assert/strict'
import { policyReader, persistentEnv, parseRegQuery, platformFacts, dirsOf, ENV_KEYS } from '../../../../src/collector/arch/win32/policy.mjs'

const CLAUDE = 'HKCU\\SOFTWARE\\Policies\\Claude'
/** reg.exe's answer for a key: a blank line, the key, the value lines, a blank line. */
const regText = (key, rows) => `\r\n${key}\r\n${rows.map(([n, k, v]) => `    ${n}    ${k}    ${v}`).join('\r\n')}\r\n\r\n`
const NOT_FOUND = { status: 1, stdout: '', stderr: 'ERROR: The system was unable to find the specified registry key or value.' }
/** A runner holding a registry: { <full key>: [[name, kind, data], …] }; logs every argv. */
function regRunner(reg) {
  const calls = []
  const run = (file, args) => {
    calls.push([file, ...args])
    const rows = reg[args[1]]
    if (!rows) return NOT_FOUND
    const v = args.indexOf('/v')
    const pick = v < 0 ? rows : rows.filter(([n]) => n.toLowerCase() === args[v + 1].toLowerCase())
    return pick.length ? { status: 0, stdout: regText(args[1].replace(/^HKCU/, 'HKEY_CURRENT_USER').replace(/^HKLM/, 'HKEY_LOCAL_MACHINE'), pick), stderr: '' } : NOT_FOUND
  }
  return { run, calls }
}

test('parseRegQuery: reg.exe\'s value lines, a DWORD as a number, names with spaces, a multi-string as a list, an empty string', () => {
  const text = regText('HKEY_CURRENT_USER\\Environment', [['Path', 'REG_EXPAND_SZ', '%USERPROFILE%\\bin;C:\\x'], ['NO_PROXY', 'REG_SZ', 'localhost,.corp'], ['Some Name', 'REG_DWORD', '0x1'], ['M', 'REG_MULTI_SZ', 'a\\0b'], ['Q', 'REG_QWORD', '0x10']])
    + '    EMPTY    REG_SZ    \r\n'
  assert.deepEqual(parseRegQuery(text), {
    Path: { kind: 'REG_EXPAND_SZ', value: '%USERPROFILE%\\bin;C:\\x' }, NO_PROXY: { kind: 'REG_SZ', value: 'localhost,.corp' }, 'Some Name': { kind: 'REG_DWORD', value: 1 },
    M: { kind: 'REG_MULTI_SZ', value: ['a', 'b'] }, Q: { kind: 'REG_QWORD', value: 16 }, EMPTY: { kind: 'REG_SZ', value: '' },
  })
  assert.deepEqual(parseRegQuery('HKEY_CURRENT_USER\\Environment\r\n'), {})
})

test('policy read: argv is reg.exe query <declared key> /v <declared value>; set, absent, a failing read', () => {
  const { run, calls } = regRunner({ [CLAUDE]: [['egressProxyUrl', 'REG_SZ', 'http://proxy.corp:8080']] })
  const read = policyReader({ run })
  assert.deepEqual(read({ key: CLAUDE, value: 'egressProxyUrl' }), { set: true, value: 'http://proxy.corp:8080', where: CLAUDE })
  assert.deepEqual(read({ key: CLAUDE, value: 'other' }), { set: false })
  assert.deepEqual(read({ key: 'HKCU\\SOFTWARE\\Policies\\Nobody', value: 'x' }), { set: false })
  assert.deepEqual(calls[0], ['reg.exe', 'query', CLAUDE, '/v', 'egressProxyUrl'])
  const broken = policyReader({ run: () => ({ status: 5, stdout: '', stderr: 'ERROR: Access is denied.' }) })({ key: CLAUDE, value: 'egressProxyUrl' })
  assert.match(broken.error, /exit 5: ERROR: Access is denied/)
})

test('policy read: only a declared policy value is read — outside Software\\Policies, a bad hive or a value name that is not plain is refused without a run', () => {
  const { run, calls } = regRunner({})
  const read = policyReader({ run })
  for (const q of [{ key: 'HKCU\\Environment', value: 'Path' }, { key: 'HKCU\\SOFTWARE\\Policies\\..\\Microsoft', value: 'x' }, { key: 'HKCR\\SOFTWARE\\Policies\\X', value: 'x' }, { key: CLAUDE, value: 'a/b' }, { key: CLAUDE }, {}]) {
    assert.ok(read(q).error, JSON.stringify(q))
  }
  assert.equal(calls.length, 0)
  assert.deepEqual(read({ key: 'HKEY_LOCAL_MACHINE\\SOFTWARE\\Policies\\Claude', value: 'v' }), { set: false }, 'the long hive name is the same hive')
  assert.deepEqual(calls[0].slice(0, 3), ['reg.exe', 'query', 'HKLM\\SOFTWARE\\Policies\\Claude'])
})

test('persistentEnv: HKCU\\Environment, then the machine\'s; the user\'s wins for the same name; names compare case-insensitively', () => {
  const [user, machine] = ENV_KEYS
  const { run, calls } = regRunner({ [user]: [['no_proxy', 'REG_SZ', 'user.corp'], ['Path', 'REG_EXPAND_SZ', 'u']], [machine]: [['NO_PROXY', 'REG_SZ', 'machine.corp'], ['HTTPS_PROXY', 'REG_SZ', 'http://m:1']] })
  assert.deepEqual(persistentEnv(['NO_PROXY', 'HTTPS_PROXY', 'ALL_PROXY'], { run }), { NO_PROXY: 'user.corp', HTTPS_PROXY: 'http://m:1' })
  assert.deepEqual(calls.map((c) => c.slice(0, 3)), [['reg.exe', 'query', user], ['reg.exe', 'query', machine]])
  assert.deepEqual(persistentEnv(['NO_PROXY'], { run: regRunner({ [machine]: [['NO_PROXY', 'REG_SZ', 'm']] }).run }), { NO_PROXY: 'm' }, 'no user key: the machine\'s')
  assert.deepEqual(persistentEnv([], { run: () => { throw new Error('not asked') } }), {})
})

test('platform facts and dirs: case-insensitive names, a case-folded path key, the registry\'s persistent environment; APPDATA / LOCALAPPDATA', () => {
  const f = platformFacts({ run: regRunner({ [ENV_KEYS[0]]: [['NO_PROXY', 'REG_SZ', 'x']] }).run })
  assert.equal(f.envCaseInsensitive, true)
  assert.equal(f.pathKey('C:\\Users\\Al\\.Codex\\Config.toml'), f.pathKey('c:\\users\\al\\.codex\\config.TOML'))
  assert.deepEqual(f.persistentEnv(['no_proxy']), { no_proxy: 'x' })
  assert.deepEqual(dirsOf('C:\\Users\\al', { APPDATA: 'D:\\R', LOCALAPPDATA: 'D:\\L' }), { appSupport: 'D:\\R', localAppData: 'D:\\L' })
  assert.deepEqual(dirsOf('C:\\Users\\al', {}), { appSupport: 'C:\\Users\\al\\AppData\\Roaming', localAppData: 'C:\\Users\\al\\AppData\\Local' })
})
