// test/scripts/pack-board.test.mjs — 4.5 #6 (D75②③): the npm package carries the board's build and not its sources. Asks npm itself
// (`npm pack --dry-run --json`, the npm that runs `npm test`) what it would pack: every file under src/web/board/ is in it, nothing
// under web/, node_modules/ or test/ is.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tmpDir } from '../helpers/tmp.mjs'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const BUILT = path.join(ROOT, 'src', 'web', 'board')
const npm = process.env.npm_execpath
const skip = npm && /\.[cm]?js$/.test(npm) ? false : 'asks the npm that runs it (npm test sets npm_execpath)'

test('4.5 #6: the package has every built board file and no board source', { skip, timeout: 60_000 }, () => {
  const r = spawnSync(process.execPath, [npm, 'pack', '--dry-run', '--json', '--ignore-scripts'],
    { cwd: ROOT, encoding: 'utf8', env: { ...process.env, npm_config_cache: tmpDir('trocar-npmcache-'), NODE_DISABLE_COMPILE_CACHE: '1' } }) // npm's cli turns on Node's compile cache in the temp dir
  assert.equal(r.status, 0, r.stderr)
  const packed = new Set(JSON.parse(r.stdout)[0].files.map((f) => f.path))
  const built = fs.readdirSync(BUILT, { recursive: true, withFileTypes: true }).filter((e) => e.isFile())
    .map((e) => path.relative(ROOT, path.join(e.parentPath, e.name)).split(path.sep).join('/'))
  assert.ok(built.includes('src/web/board/index.html'), 'the build is committed')
  for (const f of built) assert.ok(packed.has(f), `${f} is packed`)
  assert.deepEqual([...packed].filter((p) => /^(web|node_modules|test)\//.test(p)), [], 'no board source, no dependency and no test is packed')
})
