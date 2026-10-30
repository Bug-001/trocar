// test/collector/arch/linux/build.test.mjs — the helper's build picks a bpftool that reads this kernel's BTF (4.6 §Linux 机制): the first
// candidate whose raw dump succeeds, so a wrapper that refuses this kernel (Ubuntu's /usr/sbin/bpftool on a kernel it has no linux-tools
// package for) is passed over for a build that works. Real make on a copy of the Makefile; the candidates are stubs in the temp dir and the
// kernel's BTF is a file there too.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tmpDir } from '../../../helpers/tmp.mjs'

const MAKEFILE = fileURLToPath(new URL('../../../../src/collector/arch/linux/Makefile', import.meta.url))
const hasMake = spawnSync('make', ['--version'], { stdio: 'ignore' }).status === 0

/** A bpftool stub for `btf dump file <f> format raw|c`: `refuses` fails every dump (the wrapper); otherwise the raw dump succeeds and the
 *  C dump prints a comment with `name`, then fails when `dumpFails`. */
function stub(dir, name, { refuses = false, dumpFails = false } = {}) {
  fs.mkdirSync(dir, { recursive: true })
  const p = path.join(dir, 'bpftool')
  const c = dumpFails ? `echo '/* ${name} */'; exit 1` : `echo '/* ${name} */'`
  fs.writeFileSync(p, `#!/bin/sh\n${refuses ? 'exit 1' : `case "$6" in raw) exit 0;; c) ${c}; exit 0;; esac\nexit 1`}\n`, { mode: 0o755 })
  return p
}

function build(candidates, { btf = true } = {}) {
  const dir = tmpDir('trocar-linux-build-')
  fs.mkdirSync(path.join(dir, 'bpf'))
  const btfFile = path.join(dir, 'vmlinux.btf')
  if (btf) fs.writeFileSync(btfFile, 'btf')
  fs.copyFileSync(MAKEFILE, path.join(dir, 'Makefile'))
  const env = { ...process.env }
  delete env.BPFTOOL // an operator's BPFTOOL wins over the search
  const r = spawnSync('make', ['-s', '-C', dir, `BPFTOOL_TRY=${candidates.join(' ')}`, `BTF=${btfFile}`, 'bpf/vmlinux.h'], { encoding: 'utf8', env })
  const out = path.join(dir, 'bpf', 'vmlinux.h')
  return { code: r.status, stderr: r.stderr, header: fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : null }
}

test('build: the first bpftool that reads this kernel\'s BTF is the one used; a refusing wrapper before it is passed over', { skip: !hasMake && 'no make here' }, () => {
  const t = tmpDir('trocar-bpftool-')
  const r = build([stub(path.join(t, 'wrapper'), 'wrapper', { refuses: true }), stub(path.join(t, 'tools'), 'tools')])
  assert.equal(r.code, 0, r.stderr)
  assert.equal(r.header.trim(), '/* tools */')
})

test('build: with no bpftool that reads the BTF, the build stops naming bpftool and writes no header', { skip: !hasMake && 'no make here' }, () => {
  const t = tmpDir('trocar-bpftool-')
  const r = build([stub(path.join(t, 'wrapper'), 'wrapper', { refuses: true })])
  assert.notEqual(r.code, 0)
  assert.match(r.stderr, /bpftool/)
  assert.equal(r.header, null)
})

test('build: a kernel without BTF stops the build naming BTF, before any bpftool is asked', { skip: !hasMake && 'no make here' }, () => {
  const t = tmpDir('trocar-bpftool-')
  const r = build([stub(path.join(t, 'tools'), 'tools')], { btf: false })
  assert.notEqual(r.code, 0)
  assert.match(r.stderr, /BTF/)
  assert.equal(r.header, null)
})

test('build: a dump that fails half way leaves no header, so the next make tries again instead of compiling a broken one', { skip: !hasMake && 'no make here' }, () => {
  const t = tmpDir('trocar-bpftool-')
  const r = build([stub(path.join(t, 'tools'), 'tools', { dumpFails: true })])
  assert.notEqual(r.code, 0)
  assert.equal(r.header, null)
})
