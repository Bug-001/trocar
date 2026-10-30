// test/collector/arch/linux/unit.test.mjs — the per-user systemd unit text and its wants/ cleanup (4.6 §安装清单与卸载).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { unitText, unitPath, wantsLink, removeWantsLinks, systemctl, userUnit, UNIT_NAME } from '../../../../src/collector/arch/linux/unit.mjs'
import { commandNamed } from '../../../../src/cli/commands.mjs'

test('unit: absolute quoted ExecStart, restart on failure, no capability-stripping directives', () => {
  const t = unitText({ node: '/usr/bin/node', script: '/opt/my "trocar"/bin/trocar.mjs' })
  assert.match(t, /^ExecStart="\/usr\/bin\/node" "\/opt\/my \\"trocar\\"\/bin\/trocar\.mjs" daemon$/m)
  assert.match(t, /^Restart=on-failure$/m)
  assert.match(t, /^WantedBy=default\.target$/m)
  assert.doesNotMatch(t, /NoNewPrivileges|CapabilityBoundingSet/)
  assert.doesNotMatch(t, /^Environment=/m, 'nothing to carry, no Environment line')
})

test('unit: ExecStart runs a command of the table that refuses root (trocar daemon, 1.6 §2)', () => {
  const words = (text) => (/^ExecStart=(.*)$/m.exec(text)[1].match(/"(?:[^"\\]|\\.)*"|\S+/g) || []).map((w) => w.replace(/^"|"$/g, ''))
  const [, , ...argv] = words(unitText({ node: '/usr/bin/node', script: '/opt/trocar/bin/trocar.mjs' }))
  assert.deepEqual(argv, ['daemon'])
  assert.ok(commandNamed(argv[0]) && commandNamed(argv[0]).mutates, 'the unit runs a command that is in the table, and it is one the daemon user runs, not root')
})

test('unit: the daemon\'s own environment as quoted Environment= lines; % and $ cannot expand into something else (review 3 #1)', () => {
  const t = unitText({ node: '/opt/n$v/node', script: '/s/trocar.mjs', env: { NODE_EXTRA_CA_CERTS: '/corp/"ca" 100%.pem' } })
  assert.match(t, /^\[Service\]\nType=simple\nEnvironment="NODE_EXTRA_CA_CERTS=\/corp\/\\"ca\\" 100%%\.pem"\nExecStart=/m, 'in [Service], before ExecStart')
  assert.match(t, /^ExecStart="\/opt\/n\$\$v\/node" "\/s\/trocar\.mjs" daemon$/m)
  assert.equal(wantsLink('/h'), '/h/.config/systemd/user/default.target.wants/trocar-collector.service')
})

test('unit: wants/ symlinks left behind are removed; systemctl runs as --user and says why it failed', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'trocar-unit-'))
  try {
    const wants = path.join(path.dirname(unitPath(home)), 'default.target.wants'); fs.mkdirSync(wants, { recursive: true })
    fs.symlinkSync(unitPath(home), path.join(wants, UNIT_NAME))
    assert.deepEqual(removeWantsLinks(home), [path.join(wants, UNIT_NAME)])
    assert.ok(!fs.existsSync(wants), 'the wants dir it emptied goes too')
    if (process.getuid() !== 0) { // a link in a dir the user cannot write: reported, never swallowed (review 4 #9)
      fs.mkdirSync(wants); fs.symlinkSync(unitPath(home), path.join(wants, UNIT_NAME)); fs.chmodSync(wants, 0o555)
      const errs = []
      assert.deepEqual(removeWantsLinks(home, { onError: (p, e) => errs.push([p, e.code]) }), [])
      fs.chmodSync(wants, 0o755)
      assert.deepEqual(errs, [[path.join(wants, UNIT_NAME), 'EACCES']])
    }
    const seen = []
    systemctl(['enable', '--now', UNIT_NAME], { run: (cmd, args) => { seen.push([cmd, ...args]); return { status: 0 } } })
    assert.deepEqual(seen, [['systemctl', '--user', 'enable', '--now', UNIT_NAME]])
    assert.deepEqual(systemctl(['enable'], { run: () => ({ status: null, error: new Error('spawn systemctl ENOENT') }) }), { code: null, out: '', err: 'spawn systemctl ENOENT' })
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
})

// D61 / 1.6 §3.3: `registered()` is the question `on` asks before it writes. The answers are systemctl 255's on Ubuntu 24.04 (measured 2026-10-30):
// a manager that knows the unit prints its state; with no systemd --user to ask it prints no state, exits 1 and says why on stderr — which is "could not be read", not "not registered".
test('unit: registered() reads is-enabled — enabled, not-found, switched off, and a systemctl that could not ask any manager', () => {
  const answering = (status, stdout, stderr = '') => userUnit({ home: '/home/ada', node: '/usr/bin/node', script: '/opt/trocar/bin/trocar.mjs', run: () => ({ status, stdout, stderr }) }).registered()
  assert.equal(answering(0, 'enabled\n').state, 'present')
  assert.equal(answering(4, 'not-found\n').state, 'absent')
  for (const off of ['disabled', 'masked', 'linked']) assert.equal(answering(1, `${off}\n`).state, 'disabled', `${off}: the file is there, the entry is off`)
  assert.equal(answering(0, 'enabled-runtime\n').state, 'disabled', 'enabled only until the next boot: not the login entry')
  const noBus = answering(1, '', 'Failed to connect to bus: No such file or directory\n')
  assert.equal(noBus.state, 'unknown', 'no manager answered: nothing was asked')
  assert.match(noBus.err, /Failed to connect to bus/, 'with systemctl\'s own reason')
  assert.equal(userUnit({ home: '/home/ada', node: '/usr/bin/node', script: '/x', run: () => ({ status: null, error: new Error('spawn systemctl ENOENT') }) }).registered().state, 'unknown')
})
