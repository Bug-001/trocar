// test/collector/arch/linux/helper-sweep.test.mjs — a setup-helper killed between copy and rename leaves a staged
// (possibly capped) copy in the helper dir; the next setup-helper and setup-helper --remove delete exactly those and
// report them (D38: never left behind silently). No root: sweepStaged over a temp dir.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sweepStaged, uninstallHelper } from '../../../../src/collector/arch/linux/install.mjs'
import { tmpDir } from '../../../helpers/tmp.mjs'

test('sweepStaged removes only staged helper copies, keeps the current one, and reports what it removed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trocar-hs-'))
  try {
    for (const n of ['.trocar-redirector.new.67915', '.trocar-redirector.new.12', 'trocar-redirector', '.trocar-redirector.new.x', 'notes']) fs.writeFileSync(path.join(dir, n), 'x')
    assert.deepEqual(sweepStaged(dir, '.trocar-redirector.new.12').sort(), [path.join(dir, '.trocar-redirector.new.67915')], 'what it removed, as the paths in the dir it swept (the report needs no rebuilding)')
    assert.deepEqual(fs.readdirSync(dir).sort(), ['.trocar-redirector.new.12', '.trocar-redirector.new.x', 'notes', 'trocar-redirector'], 'the helper itself and anything not ours stay')
    assert.deepEqual(sweepStaged(dir), [path.join(dir, '.trocar-redirector.new.12')])
    assert.deepEqual(sweepStaged(path.join(dir, 'gone')), [], 'no helper dir: nothing to do')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('uninstallHelper (the real one, root check and runner stubbed) removes the helper and returns the staged copies it swept in `swept`, which --remove lists (D38)', () => {
  const dir = tmpDir('trocar-hs-rm-')
  const bin = path.join(dir, 'trocar-redirector'), staged = path.join(dir, '.trocar-redirector.new.67915')
  for (const f of [bin, staged]) fs.writeFileSync(f, 'x')
  const r = uninstallHelper({ helperDir: dir, helperBin: bin, root: () => {}, exec: (cmd) => ({ code: cmd === 'getent' ? 0 : 1, out: '', err: '' }) }) // getent: an account table with no other account
  assert.deepEqual([r.swept, r.warnings, fs.existsSync(dir)], [[staged], [], false])
})

// 1.6 §5.3: --remove first asks every account the account table gives (but root and the sudo user) whether an install record is there — by existence only —
// and removes nothing while one is, or while a home cannot be looked into. `exec` answers getent; `fsys` stands in for the other homes.
test('setup-helper --remove refuses while another account has an install record or a home it cannot read, and removes nothing (1.6 §5.3)', async () => {
  const { runSetupHelper } = await import('../../../../src/collector/cli.mjs')
  const { DEFAULTS } = await import('../../../../src/collector/arch/linux/install.mjs')
  const MANIFEST = path.join('.trocar', 'collector', 'install-manifest.json')
  const row = (name, uid, home) => `${name}:x:${uid}:${uid}::${home}:/bin/sh`
  const remove = async ({ passwd, homes = {}, getent = true }) => {
    const dir = tmpDir('trocar-hs-acct-'), bin = path.join(dir, 'trocar-redirector'); fs.writeFileSync(bin, 'x')
    const read = []
    const fsys = { ...fs, readFileSync: (p, ...a) => (p === '/etc/passwd' ? passwd.join('\n') : fs.readFileSync(p, ...a)),
      statSync: (p, ...a) => { for (const [h, code] of Object.entries(homes)) if (p === path.join(h, MANIFEST)) { read.push(p); if (code === 'there') return {}; throw Object.assign(new Error(code), { code }) } return fs.statSync(p, ...a) } }
    const exec = (cmd) => (cmd === 'getent' && getent ? { code: 0, out: passwd.join('\n'), err: '' } : { code: getent ? 1 : null, out: '', err: 'no getent' })
    const o = [], e = []
    const arch = { install: { DEFAULTS: { ...DEFAULTS, helperBin: bin }, uninstallHelper: () => uninstallHelper({ helperDir: dir, helperBin: bin, root: () => {}, exec, fsys, env: { SUDO_UID: '1000' } }) } }
    const code = await runSetupHelper(['--remove'], { arch, out: (s) => o.push(s), err: (s) => e.push(s) })
    return { code, there: fs.existsSync(bin), lines: [...o, ...e].join('\n').split('\n'), read }
  }
  const self = row('me', 1000, '/home/me'), rootRow = row('root', 0, '/root')
  // (a) only the sudo user (and root, and an account with a relative home) → removed
  let r = await remove({ passwd: [rootRow, self, row('odd', 1002, 'relative/home')], homes: { '/root': 'there', '/home/me': 'there', 'relative/home': 'there' } })
  assert.deepEqual([r.code, r.there, r.read], [0, false, []], 'root, the sudo user and a home that is not absolute are not asked')
  // (b) another account with an install record → refused, nothing removed, that home named
  r = await remove({ passwd: [rootRow, self, row('bo', 1001, '/home/bo'), row('cy', 1003, '/home/cy')], homes: { '/home/bo': 'there', '/home/cy': 'ENOENT' } })
  assert.deepEqual([r.code, r.there], [1, true])
  assert.ok(r.lines.includes('  /home/bo') && !r.lines.some((l) => l.includes('/home/cy')), r.lines.join('\n'))
  // (c) a home that cannot be looked into counts as in use, and is said as unread; getent that cannot run falls back to /etc/passwd
  r = await remove({ passwd: [self, row('nfs', 1004, '/net/nfs')], homes: { '/net/nfs': 'EACCES' }, getent: false })
  assert.deepEqual([r.code, r.there], [1, true])
  assert.ok(r.lines.some((l) => l.startsWith('  /net/nfs') && l.includes('EACCES')), r.lines.join('\n'))
})
