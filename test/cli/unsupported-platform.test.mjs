// test/cli/unsupported-platform.test.mjs — 1.6 V14 at the CLI: on a platform with no collector (one loadArch does not know), `on` and
// `daemon` say 「not supported yet」 and exit 1, having written nothing; `off` runs as usual and says there is nothing to turn off (R1), exit 0.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpDir } from '../helpers/tmp.mjs'
import { runOnCli } from '../../src/cli/on.mjs'
import { runDaemonCli } from '../../src/cli/daemon.mjs'
import { runOffCli } from '../../src/off/main.mjs'

const ioOf = () => { const out = [], err = []; return { out, err, io: { out: (s) => out.push(s), err: (s) => err.push(s), stdin: null, stdout: { isTTY: false }, stderr: { isTTY: false } } } }
const tree = (d) => fs.readdirSync(d, { recursive: true }).sort()

for (const platform of ['freebsd', 'sunos', 'aix']) {
  test(`V14: on ${platform}, on and daemon say not supported yet and exit 1, writing nothing; off says nothing is installed and exits 0`, async () => {
    const home = tmpDir('asight-v14-'), env = { HOME: home }
    // a daemon must never really start here (the host may be capturing): an injected start that fails the test if it is reached
    const deps = { getuid: () => 501, startDaemon: async () => { throw new Error('the daemon was started on a platform with no collector') }, proc: { on() {}, stdin: null } }
    for (const [name, run] of [['on', () => runOnCli([], { io: o.io, env, home, platform, deps })], ['daemon', () => runDaemonCli([], { io: o.io, env, home, platform, deps })]]) {
      var o = ioOf()
      assert.equal(await run(), 1, `${name}: ${o.err.join('\n')}`)
      assert.match(o.err.join("\n"), /not supported yet/, `${name}: err=${o.err.join("\n")} out=${o.out.join("\n")}`)
      assert.deepEqual(tree(home), [], `${name} wrote nothing`)
    }
    o = ioOf()
    assert.equal(await runOffCli(['--json'], { io: o.io, env, home, platform, deps }), 0, o.err.join('\n'))
    assert.equal(JSON.parse(o.out.join('')).nothing_installed, true)
  })
}
