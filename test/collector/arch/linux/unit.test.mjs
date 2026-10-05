// test/collector/arch/linux/unit.test.mjs — the per-user systemd unit text and its wants/ cleanup (4.6 §安装清单与卸载).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { unitText, unitPath, removeWantsLinks, systemctl, UNIT_NAME } from '../../../../src/collector/arch/linux/unit.mjs'

test('unit: absolute quoted ExecStart, restart on failure, no capability-stripping directives', () => {
  const t = unitText({ node: '/usr/bin/node', script: '/opt/my "asight"/bin/asight.mjs' })
  assert.match(t, /^ExecStart="\/usr\/bin\/node" "\/opt\/my \\"asight\\"\/bin\/asight\.mjs" collector start$/m)
  assert.match(t, /^Restart=on-failure$/m)
  assert.match(t, /^WantedBy=default\.target$/m)
  assert.doesNotMatch(t, /NoNewPrivileges|CapabilityBoundingSet/)
})

test('unit: wants/ symlinks left behind are removed; systemctl runs as --user and says why it failed', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-unit-'))
  try {
    const wants = path.join(path.dirname(unitPath(home)), 'default.target.wants'); fs.mkdirSync(wants, { recursive: true })
    fs.symlinkSync(unitPath(home), path.join(wants, UNIT_NAME))
    assert.deepEqual(removeWantsLinks(home), [path.join(wants, UNIT_NAME)])
    assert.ok(!fs.existsSync(wants), 'the wants dir it emptied goes too')
    const seen = []
    systemctl(['enable', '--now', UNIT_NAME], { run: (cmd, args) => { seen.push([cmd, ...args]); return { status: 0 } } })
    assert.deepEqual(seen, [['systemctl', '--user', 'enable', '--now', UNIT_NAME]])
    assert.deepEqual(systemctl(['enable'], { run: () => ({ status: null, error: new Error('spawn systemctl ENOENT') }) }), { code: null, out: '', err: 'spawn systemctl ENOENT' })
  } finally { fs.rmSync(home, { recursive: true, force: true }) }
})
