// CM11 (spec 4.11 P8): the install-folder wrapper. The rendered dash wrapper is spawned for real in front of a stub "real program" that
// reports its argv, environment and stdin and exits with a fixed code; cases are generated over switch file × certificate variable × proxy
// variables × awkward argv, and the invariant is: argv, stdin, stdout and exit code identical to running the program directly, and only
// the variables the wrapper may set differ. The preconditions, the placement and the undo run on a tmpDir with injected ownership.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { tmpDir } from '../../../helpers/tmp.mjs'
import { newManifest } from '../../../../src/off/manifest.mjs'
import { sha256 } from '../../../../src/off/fsutil.mjs'
import { renderWrapper, shellEncode } from '../../../../src/collector/arch/darwin/wrapper.mjs'
import { renderTemplate } from '../../../../src/collector/core/proxymode/hooks/render.mjs'
import { checkWrapperTarget, placeWrapper, undoWrapper, checkWrapper, REAL_DIR, PACKAGE_MANAGER_TREES } from '../../../../src/collector/core/proxymode/hooks/wrapper.mjs'

const DASH = '/bin/dash'
const CERT_VAR = 'TOOL_EXTRA_CA'
const PROXY_ENV = ['https_proxy', 'HTTPS_PROXY', 'all_proxy']
const PROXY_NAMES = ['https_proxy', 'HTTPS_PROXY']
const DOOR = 'http://127.0.0.1:18100'
const STUB_EXIT = 37

function stubProgram(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `#!${process.execPath}\nconst c=[];process.stdin.on('data',(d)=>c.push(d)).on('end',()=>{process.stdout.write(JSON.stringify({argv:process.argv.slice(2),env:process.env,stdin:Buffer.concat(c).toString('base64')}));process.stderr.write('err-line');process.exit(${STUB_EXIT})})\n`, { mode: 0o755 })
}

test('CM11 render: the dash template has exactly the closed slots, and every value lands as one shell word', () => {
  const text = fs.readFileSync(new URL('../../../../src/collector/arch/darwin/wrapper.dash.tmpl', import.meta.url), 'utf8')
  assert.deepEqual([...new Set([...text.matchAll(/__ASIGHT_([A-Z_]+?)__/g)].map((m) => m[1]))].sort(), ['CA_FILE', 'CERT_VAR', 'PROXY_ENV', 'PROXY_NAMES', 'REAL', 'SWITCH'])
  assert.throws(() => renderTemplate(text, { REAL: '/x' }, shellEncode), /has no value/)
  assert.throws(() => renderTemplate('__ASIGHT_NOPE__', {}), /not a placeholder/)
  assert.throws(() => renderTemplate('x', { CERT_VAR: 'A;rm -rf ~' }), /environment variable name/)
  assert.throws(() => renderTemplate('x', { PROXY_NAMES: ['ok', '$(x)'] }), /environment variable name/)
  assert.equal(renderTemplate('a=__ASIGHT_DOOR__', { DOOR: 'q"\'$x' }), 'a="q\\"\'$x"', 'JSON-encoded by default')
})

test('CM11 runtime: argv, stdin, stdout, exit code identical; only the allowed variables differ', { skip: !fs.existsSync(DASH) && 'no /bin/dash on this machine' }, () => {
  const d = tmpDir()
  const bin = path.join(d, 'my bin $x'), real = path.join(bin, REAL_DIR, "to'ol"), sw = path.join(d, 'switch dir', 'tool'), ca = path.join(d, 'ca "root".pem')
  stubProgram(real)
  const wrapper = path.join(bin, 'tool')
  fs.writeFileSync(wrapper, renderWrapper({ REAL: real, SWITCH: sw, CA_FILE: ca, CERT_VAR, PROXY_ENV, PROXY_NAMES }), { mode: 0o755 })
  const ARGVS = [[], ['a b', '', '"q"', "it's", '*', '$HOME', '`id`', '中文 ü', '-n', '--', '\\', 'x\ny'], ['acp']]
  const PROXIES = [{}, { all_proxy: 'socks5://u:1' }, { https_proxy: '', HTTPS_PROXY: 'http://up:3128', all_proxy: 'http://all:1' }, { https_proxy: DOOR, ASIGHT_PRIOR_PROXY: 'http://outer:9' }]
  let n = 0
  for (const on of [false, true]) for (const certSet of [false, true]) for (const prox of PROXIES) for (const argv of ARGVS) {
    if (on) { fs.mkdirSync(path.dirname(sw), { recursive: true }); fs.writeFileSync(sw, DOOR) } else fs.rmSync(sw, { force: true })
    const env = { PATH: '/usr/bin:/bin', PWD: d, HOME: d, LANG: 'en_US.UTF-8', OTHER: 'kept $x', ...prox, ...(certSet ? { [CERT_VAR]: '/user/own.pem' } : {}) }
    const input = Buffer.from(`stdin ${n} 中\n\0end`)
    const run = (file) => spawnSync(file, argv, { env, input, cwd: d })
    const direct = run(real), wrapped = run(wrapper)
    const label = JSON.stringify({ on, certSet, prox, argv })
    assert.equal(wrapped.status, STUB_EXIT, label)
    assert.equal(wrapped.stderr.toString(), direct.stderr.toString(), label)
    const a = JSON.parse(direct.stdout), b = JSON.parse(wrapped.stdout)
    assert.deepEqual(b.argv, a.argv, `${label}: argv`)
    assert.equal(b.stdin, a.stdin, `${label}: stdin`)
    const expect = { ...a.env }
    if (!certSet) expect[CERT_VAR] = ca
    if (on) {
      const first = PROXY_ENV.map((k) => env[k]).find((v) => v && v !== DOOR)
      const sawDoor = PROXY_ENV.some((k) => env[k] === DOOR)
      expect.ASIGHT_PRIOR_PROXY = first ?? (sawDoor && env.ASIGHT_PRIOR_PROXY ? env.ASIGHT_PRIOR_PROXY : 'none')
      for (const k of PROXY_NAMES) expect[k] = DOOR
    }
    assert.deepEqual(b.env, expect, `${label}: environment`)
    n++
  }
  assert.ok(n >= 48)
})

// ── preconditions ──
const MACHO = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 7, 0, 0, 1]), MACHO_BE = Buffer.from([0xfe, 0xed, 0xfa, 0xcf, 0, 0, 0, 7]), FAT = Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 2]), PE = Buffer.from('MZ\x90\0\x03\0', 'latin1')
const cert = { kind: 'wrapper', command: 'tool', binDir: { base: 'home', path: '.tool/bin' }, certVar: CERT_VAR, layout: 'native-binary' }

function setup({ content = MACHO, binRel = '.tool/bin', link = false, owns = () => true, exeSuffix = '' } = {}) {
  const home = tmpDir(), dir = path.join(home, binRel), file = path.join(dir, `tool${exeSuffix}`)
  fs.mkdirSync(dir, { recursive: true })
  if (link) { fs.writeFileSync(path.join(dir, 'target'), MACHO); fs.symlinkSync(path.join(dir, 'target'), file) } else if (content != null) fs.writeFileSync(file, content, { mode: 0o755 })
  const ctx = { os: 'darwin', home, env: {}, fs, owns, facts: { exeSuffix }, dir: path.join(home, '.asight'), manifest: newManifest(), harness: 'tool', switchFile: path.join(home, '.asight', 'switch', 'tool'), caFile: path.join(home, '.asight', 'root.pem'), proxyEnv: PROXY_ENV, proxyNames: PROXY_NAMES, now: () => new Date('2026-10-16T00:00:00Z') }
  return { ctx, file, dir, home, cert: { ...cert, binDir: { base: 'home', path: binRel } } }
}

test('CM11 preconditions: only one native program in a folder this user owns, outside package-manager trees, with the layout declared', () => {
  for (const [label, content] of [['Mach-O', MACHO], ['Mach-O big-endian', MACHO_BE], ['universal', FAT], ['PE', PE]]) {
    const s = setup({ content })
    assert.equal(checkWrapperTarget(s.ctx, s.cert).ok, true, label)
  }
  const s = setup({ content: PE, exeSuffix: '.exe' })
  assert.equal(checkWrapperTarget(s.ctx, s.cert).target.file, s.file, 'the suffix comes from the platform fact')
  const BAD = [
    ['script', { content: '#!/bin/sh\nexec node "$@"\n' }, /not one native program/],
    ['npm .cmd', { content: '@ECHO off\r\nnode "%~dp0\\tool.js" %*\r\n' }, /not one native program/],
    ['npm .ps1', { content: '#!/usr/bin/env pwsh\n$basedir=Split-Path\n' }, /not one native program/],
    ['sh launcher', { content: '#!/usr/bin/env node\nrequire("../lib")\n' }, /not one native program/],
    ['empty', { content: '' }, /not one native program/],
    ['a link', { link: true }, /link/],
    ['missing', { content: null }, /does not exist/],
    ['foreign owner', { owns: () => false }, /another user/],
    ['owner unknown', { owns: null }, /cannot be told/],
    ...PACKAGE_MANAGER_TREES.map((t) => [`tree ${t}`, { binRel: `x/${t}/bin` }, /package manager/]),
  ]
  for (const [label, opts, why] of BAD) {
    const b = setup(opts)
    const r = checkWrapperTarget(b.ctx, b.cert)
    assert.equal(r.code, 'not-users-file', label)
    assert.match(r.why, why, label)
  }
  const nl = setup()
  for (const layout of [undefined, 'npm', 'app-bundle']) assert.match(checkWrapperTarget(nl.ctx, { ...nl.cert, layout }).why, /layout/, `layout ${layout}`)
})

test('CM11 place: the program moves to .asight-real by rename, the wrapper is recorded with both hashes; again = intact; Smart App Control = skipped', () => {
  const s = setup()
  const realIno = fs.statSync(s.file).ino
  const r = placeWrapper(s.ctx, s.cert, { renderWrapper })
  assert.equal(r.result, 'placed')
  const real = path.join(s.dir, REAL_DIR, 'tool')
  assert.equal(fs.statSync(real).ino, realIno, 'a rename, not a copy')
  assert.deepEqual([r.record.role, r.record.phase, r.record.real, r.record.real_sha256, r.record.sha256], ['wrapper', 'install', real, sha256(MACHO), sha256(fs.readFileSync(s.file))])
  assert.match(fs.readFileSync(s.file, 'utf8'), /^#!\/bin\/dash\n/)
  assert.ok(fs.statSync(s.file).mode & 0o100, 'the wrapper is executable')
  assert.equal(placeWrapper(s.ctx, s.cert, { renderWrapper }).result, 'intact')
  assert.equal(checkWrapper(s.ctx, r.record), null)
  const sac = setup()
  assert.deepEqual([placeWrapper(sac.ctx, sac.cert, { renderWrapper, sacOn: true }).code, fs.readFileSync(sac.file).equals(MACHO)], ['smart-app-control', true])
  const bad = setup({ content: '#!/bin/sh\n' })
  assert.equal(placeWrapper(bad.ctx, bad.cert, { renderWrapper }).code, 'not-users-file')
  const compiled = setup({ content: PE, exeSuffix: '.exe' })
  const seen = []
  const c = placeWrapper(compiled.ctx, compiled.cert, { renderWrapper: (v) => JSON.stringify(v), compile: (src) => { seen.push(JSON.parse(src)); return PE } })
  assert.deepEqual([c.result, seen[0].REAL, fs.readFileSync(compiled.file).equals(PE)], ['placed', path.join(compiled.dir, REAL_DIR, 'tool.exe'), true], 'compile turns the rendered source into the stub')
  const failing = setup()
  assert.throws(() => placeWrapper(failing.ctx, failing.cert, { renderWrapper: () => { throw new Error('template') } }), /template/)
  assert.ok(fs.readFileSync(failing.file).equals(MACHO), 'a render failure moves nothing')
})

test('CM11 undo and status: restore while the wrapper is still asight\'s; after the installer overwrote it, only .asight-real goes', () => {
  const kept = setup()
  const a = placeWrapper(kept.ctx, kept.cert, { renderWrapper }).record
  assert.equal(undoWrapper(kept.ctx, a).result, 'restored')
  assert.ok(fs.readFileSync(kept.file).equals(MACHO))
  assert.equal(fs.existsSync(path.join(kept.dir, REAL_DIR)), false)

  const over = setup()
  const b = placeWrapper(over.ctx, over.cert, { renderWrapper }).record
  const NEW = Buffer.concat([MACHO, Buffer.from('v2')])
  fs.writeFileSync(over.file, NEW) // the official installer, run again
  assert.deepEqual([checkWrapper(over.ctx, b).reason, checkWrapper(over.ctx, b).command], ['entry-changed', 'asight install'])
  assert.equal(undoWrapper(over.ctx, b).result, 'removed')
  assert.ok(fs.readFileSync(over.file).equals(NEW), 'the update stays')
  assert.equal(fs.existsSync(path.join(over.dir, REAL_DIR)), false)

  const again = placeWrapper(over.ctx, over.cert, { renderWrapper })
  assert.equal(again.result, 'placed', 'install again wraps the updated program')
  assert.equal(again.record.real_sha256, sha256(NEW))
  fs.rmSync(over.file)
  assert.equal(checkWrapper(over.ctx, again.record).reason, 'entry-missing')
})
