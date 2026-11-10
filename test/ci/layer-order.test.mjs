// 0.1 §2 依赖方向: identity / model → query → server.mjs → src/cli/, no layer importing one above it. src/control/ is run by
// the query worker, so it ranks with query. The reverse edges the design has are data here; any other one goes red.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

// every relative `.mjs` string in a file, so a computed `import(a ? '…' : '…')` is caught too
const SPEC = /['"](\.\.?\/[^'"]+\.mjs)['"]/g
const rank = (p) => p.startsWith('src/cli/') ? 3 : p === 'src/server.mjs' ? 2 : /^src\/(query|control)\//.test(p) ? 1 : /^src\/(model|identity)\//.test(p) ? 0 : null
// query and control may use these cli modules: the one schema version and receipt, the status / doctor documents (3.5
// §采集健康), and the verbs the board's control role runs (3.5 §谁执行它「控制角色」)
const ALLOWED = new Set(['src/cli/schema.mjs', 'src/cli/status.mjs', 'src/cli/doctor.mjs', 'src/cli/classes.mjs', 'src/cli/on.mjs', 'src/cli/install.mjs'])
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.mjs') ? [path.join(d, e.name)] : []))

test('0.1 §2: no layer imports one above it, but for the cli modules query and control are meant to use', () => {
  const files = [...['src/model', 'src/identity', 'src/query', 'src/control'].flatMap(walk), 'src/server.mjs']
  const up = []
  for (const f of files) for (const [, s] of fs.readFileSync(f, 'utf8').matchAll(SPEC)) {
    const t = path.posix.normalize(path.posix.join(path.posix.dirname(f), s))
    if (rank(t) != null && rank(t) > rank(f) && !(rank(f) === 1 && ALLOWED.has(t))) up.push(`${f} → ${t}`)
  }
  assert.ok(files.length > 30, `the scan sees the layers (${files.length} files)`)
  assert.deepEqual(up, [])
})
