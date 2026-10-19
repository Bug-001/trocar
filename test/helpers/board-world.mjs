// test/helpers/board-world.mjs — the OS fakes `asight on` / `off` need when the board's query worker runs them (POST /control/harness, 4.4 §控制面),
// built as test/helpers/model-world.mjs and test/collector/model-daemon-e2e.test.mjs give them to the CLI: the login entry install registered (its
// start a no-op: the test's daemon is already up), no OS tool, an empty process table. The worker imports a module whose default export is these
// deps (src/query/worker.mjs argv[3]); depsFile writes that module for one world. Exports only.
import fs from 'node:fs'
import path from 'node:path'
import { tmpDir } from './tmp.mjs'
import { loadHarnesses } from '../../src/collector/harness/index.mjs'

/** → the deps of `on` / `off` / `status` for a world `{ platform, home, env, dirs }`. */
export async function boardDeps({ platform, home, env, dirs }) {
  const harnesses = await loadHarnesses()
  const unit = {
    path: path.join(home, 'asight-unit'), text: () => '# stands for the LaunchAgent / scheduled task', links: [],
    enable: () => ({ code: 0 }), start: () => ({ code: 0 }), startNow: () => ({ code: 0 }), reload: () => {},
    registered: () => ({ state: 'present' }), // the login entry install registered (1.6 §3.3)
  }
  return {
    platform, env, harnesses, backends: { dirs }, parts: { os: platform, harnesses, arch: { unit: { userUnit: () => unit } } },
    getuid: () => 501, exec: () => ({ status: 0, stdout: '', stderr: '' }), sleep: (ms) => new Promise((res) => setTimeout(res, Math.min(ms, 25))),
    procs: async () => [], alive: () => false, identity: () => ({ start_time: '111', boot_id: 'boot-1' }),
    lingerRead: async () => ({ state: null }), netFactsDeps: async () => ({ harnesses, archFacts: null }),
  }
}

/** → the path of a deps module for the worker, for a modelWorld `w` on `platform`. */
export function depsFile(w, platform) {
  const file = path.join(tmpDir('asight-board-deps-'), 'deps.mjs')
  const world = { platform, home: w.home, env: w.env, dirs: w.ctx.dirs }
  fs.writeFileSync(file, `import { boardDeps } from ${JSON.stringify(import.meta.url)}\nexport default await boardDeps(${JSON.stringify(world)})\n`)
  return file
}
