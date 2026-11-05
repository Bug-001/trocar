// test/cli/node-floor.test.mjs — RFC 1.6 §1.3 / §3.8: on a Node older than package.json's `engines` floor every command prints one line
// naming the Node it needs and the one it runs on, and exits 2 having touched nothing. Before, such a Node failed to link src/ (a built-in
// export it does not have) and printed a SyntaxError stack. The older Node is this one with process.versions.node rewritten first.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tmpDir } from '../helpers/tmp.mjs'

const BIN = fileURLToPath(new URL('../../bin/trocar.mjs', import.meta.url))
const floor = /\d+\.\d+/.exec(JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).engines.node)[0]
const [major, minor] = floor.split('.').map(Number)
const run = (version, args) => {
  const home = tmpDir('node-floor-')
  const r = spawnSync(process.execPath, ['--import', `data:text/javascript,Object.defineProperty(process.versions,'node',{value:'${version}'})`, BIN, ...args],
    { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home } })
  return { ...r, home }
}

// help and --version only: before the fix the command really runs, and these touch no OS tool
for (const args of [['help'], ['--version']]) {
  test(`trocar ${args.join(' ')} on a Node below the floor: exit 2, one line with both versions, nothing written`, () => {
    const older = `${major - 2}.11.0`
    const r = run(older, args)
    assert.equal(r.status, 2, r.stderr)
    assert.equal(r.stdout, '')
    const lines = r.stderr.trim().split('\n')
    assert.equal(lines.length, 1, r.stderr)
    assert.ok(lines[0].includes(older) && lines[0].includes(floor), lines[0])
    assert.deepEqual(fs.readdirSync(r.home), [], 'nothing in HOME')
  })
}

test('trocar --version at the floor itself runs as usual', () => {
  const r = run(`${floor}.0`, ['--version'])
  assert.equal(r.status, 0, r.stderr)
})

test('the floor is a major and a minor: the minor below it exits 2 however high its patch, and a later major runs whatever its minor', () => {
  assert.equal(run(`${major}.${minor - 1}.99`, ['--version']).status, 2)
  const r = run(`${major + 1}.0.0`, ['--version'])
  assert.equal(r.status, 0, r.stderr)
})
