// test/netenv/no-hop-product-names.test.mjs — D49 ③④, invariant 6, the dynamic half of no-product-names.test.mjs: a local proxy's program file is
// its product's name, so it reaches no output. Every topology row's listeners get generated program names; the outputs drawn from them (status's
// `--json` topology and its text, doctor's findings, the chain `on` prints and records) must not carry any of them, and still name the hop by its port.
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildTopology, renderCompact, renderDetail } from '../../src/netenv/topology.mjs'
import { fitCompact } from '../../src/netenv/topology-text.mjs'
import { diagnose, renderFindings } from '../../src/netenv/findings.mjs'
import { adoptedRecord } from '../../src/netenv/adopt.mjs'
import { ROWS } from './fixtures/rows.mjs'
import { ROWS as ROWS_WIN32 } from './fixtures/rows-win32.mjs'

// program names shaped like a proxy product's core: a word, a dash, a role; posix and Windows paths, with and without `.exe`
const NAMES = ['qorvex', 'zantum', 'pelyra', 'xivoss'].flatMap((w, i) => [`${w}-core`, `${w}${i}-meta`, `${w.toUpperCase()}Service`])
const exeOf = (name, i) => (i % 2 ? `C:\\Program Files\\${name}\\${name}.exe` : `/opt/${name}/bin/${name}`)

const outputs = (F) => {
  const topo = buildTopology(F)
  const texts = [JSON.stringify(topo)]
  for (const [h, t] of Object.entries(topo)) {
    texts.push(...renderCompact(t), fitCompact(t, 40), ...renderDetail(t), adoptedRecord({ facts: F, topology: topo, h, now: 0 }).chain)
  }
  const found = diagnose({ facts: F, topology: topo, user: 'alice' })
  texts.push(JSON.stringify(found), ...renderFindings(found))
  return texts.join('\n')
}

test('no output names a local proxy hop after its program: status (text and --json topology), doctor findings, on\'s chain', () => {
  let named = 0
  for (const row of [...ROWS, ...ROWS_WIN32]) {
    if (!(row.facts.listeners || []).some((l) => l.exe)) continue
    NAMES.forEach((name, i) => {
      const F = { ...row.facts, listeners: row.facts.listeners.map((l) => (l.exe ? { ...l, exe: exeOf(name, i) } : l)) }
      const out = outputs(F)
      assert.ok(!out.toLowerCase().includes(name.toLowerCase()), `row ${row.n}: ${name} is printed:\n${out}`)
      const proxyPorts = Object.values(buildTopology(F)).flatMap((t) => t.nodes.filter((n) => n.kind === 'proxy' && n.pid).map((n) => n.port))
      for (const port of proxyPorts) { assert.ok(out.includes(`:${port}`), `row ${row.n}: the hop is still said, by its port`); named++ }
    })
  }
  assert.ok(named > 0, 'some row drew a hop owned by a readable process')
})
