// V126 (RFC 1.6 §1.5): the login entry starts the daemon with the account's own home, so `install` and `uninstall` run with a different
// HOME are refused before anything is read or written — exit 2, error.code home-mismatch, both directories named, the sandbox HOME as it
// was, no OS tool run. The account's home is injected (`deps.accountHome`); the same home as this run's installs as before.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { runInstallCli } from '../../src/cli/install.mjs'
import { runUninstallCli } from '../../src/cli/uninstall.mjs'
import { ERROR_CODES } from '../../src/cli/json.mjs'
import { modelWorld } from '../helpers/model-world.mjs'
import { renderWrapper } from '../../src/collector/arch/darwin/wrapper.mjs'
import { installedHome } from '../off/fixtures/off-ctx.mjs'
import { tmpDir } from '../helpers/tmp.mjs'

const fakeIo = () => {
  const out = [], err = []
  return { out: (s) => out.push(s), err: (s) => err.push(s), stdin: { isTTY: false }, stdout: { isTTY: false }, stderr: {}, json: () => JSON.parse(out.join('\n')) }
}
/** every path under `root` with its bytes (a directory as null) */
const tree = (root) => {
  const all = {}
  const walk = (d) => { for (const n of fs.readdirSync(d)) { const p = path.join(d, n), st = fs.lstatSync(p); if (st.isDirectory()) { all[p] = null; walk(p) } else all[p] = st.isFile() ? fs.readFileSync(p).toString('base64') : 'other' } }
  walk(root)
  return all
}
const refused = (io, exit, home, account, label) => {
  assert.equal(exit, 2, label)
  const doc = io.json()
  assert.equal(doc.ok, false, label)
  assert.equal(doc.error.code, 'home-mismatch', label)
  assert.ok(ERROR_CODES.includes(doc.error.code), label)
  assert.ok(doc.error.message.includes(home) && doc.error.message.includes(account), `${label}: the message names both homes: ${doc.error.message}`)
}

for (const platform of ['darwin', 'win32', 'linux']) {
  test(`V126 ${platform}: install with a HOME that is not the account's home is refused before anything is written (--yes and --dry-run)`, async () => {
    const w = await modelWorld({ os: platform === 'linux' ? 'darwin' : platform, commands: ['codex'] })
    const account = tmpDir('trocar-account-')
    for (const argv of [['--yes', '--json'], ['--dry-run', '--json']]) {
      const before = tree(w.home), calls = []
      const io = fakeIo()
      const exit = await runInstallCli(argv, { io, env: w.env, home: w.home, platform, deps: { getuid: () => 501, accountHome: () => account, exec: (f, a) => { calls.push([f, ...a]); return { status: 0, stdout: '', stderr: '' } } } })
      refused(io, exit, w.home, account, `${platform} ${argv[0]}`)
      assert.deepEqual(tree(w.home), before, 'HOME byte for byte as it was')
      assert.deepEqual(calls, [], 'no OS tool was run')
    }
  })
}

test('V126: the account\'s home equal to this run\'s installs as before', async () => {
  const w = await modelWorld({ commands: ['codex'] })
  const io = fakeIo()
  const run = () => ({ status: 0, stdout: '', stderr: '' })
  const deps = { getuid: () => 501, accountHome: () => w.home, exec: run, unit: null, backends: { custody: w.custody, rootStore: w.store, installHelper: null, wrapperKit: { renderWrapper }, facts: { exeSuffix: '' }, dirs: w.ctx.dirs }, harnesses: w.harnesses, which: w.ctx.which, owns: w.owns }
  const exit = await runInstallCli(['--yes', '--json'], { io, env: w.env, home: w.home, platform: 'darwin', deps })
  assert.equal(exit, 0, JSON.stringify(io.json()))
  assert.ok(fs.existsSync(path.join(w.home, '.trocar', 'collector', 'install-manifest.json')))
})

test('V126: uninstall with a HOME that is not the account\'s home is refused before anything is touched', async () => {
  const s = await installedHome({ names: ['codex'] })
  await s.off()
  const account = tmpDir('trocar-account-')
  const before = tree(s.home), calls = s.sys.exec.calls.length
  const io = fakeIo()
  const exit = await runUninstallCli(['--yes', '--json'], { io, env: s.sh.env, home: s.home, platform: 'linux', deps: s.offDeps({ getuid: () => 1000, accountHome: () => account }) })
  refused(io, exit, s.home, account, 'uninstall')
  assert.deepEqual(tree(s.home), before, 'HOME byte for byte as it was')
  assert.equal(s.sys.exec.calls.length, calls, 'no OS tool was run')
})
