// test/web/board-build.test.mjs — D75③ · 0.1 §2: the committed board build (src/web/board/) is what `web/` builds to. Rebuilds into a
// temp dir with the repo's own Vite config and compares the two trees file by file, byte by byte. On only with TROCAR_BUILD_CHECK=1
// (`npm run test:build`): it needs the devDependencies, which a plain `npm test` does not.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tmpDir } from '../helpers/tmp.mjs'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BUILT = path.join(ROOT, 'src', 'web', 'board')
const skip = process.env.TROCAR_BUILD_CHECK === '1' ? false : 'the build check runs under npm run test:build (TROCAR_BUILD_CHECK=1)'
const tree = (dir) => fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile())
  .map((e) => path.relative(dir, path.join(e.parentPath, e.name)).split(path.sep).join('/')).sort()

test('a rebuild of web/ equals the committed src/web/board/, file by file and byte by byte', { skip, timeout: 300_000 }, () => {
  const out = tmpDir('trocar-board-')
  const web = path.join(ROOT, 'web')
  const sources = tree(web)
  const vite = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js')
  assert.ok(fs.existsSync(vite), 'vite is installed (npm ci)')
  const r = spawnSync(process.execPath, [vite, 'build', '--configLoader', 'native', '--config', 'web/vite.config.mjs', '--outDir', out, '--emptyOutDir', '--logLevel', 'warn'],
    { cwd: ROOT, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr || r.stdout)
  const files = tree(BUILT)
  assert.deepEqual(tree(out), files, 'the same files')
  for (const f of files) assert.ok(fs.readFileSync(path.join(out, f)).equals(fs.readFileSync(path.join(BUILT, f))), `${f}: the same bytes`)
  const here = Buffer.from(ROOT.replace(/[\\/]+$/, ''))
  for (const f of files) assert.equal(fs.readFileSync(path.join(out, f)).includes(here), false, `${f} names the checkout's path`)
  assert.deepEqual(tree(web), sources, 'the build leaves nothing beside its config')
})
