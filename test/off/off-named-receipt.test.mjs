// test/off/off-named-receipt.test.mjs — `trocar off <one harness>` while other harnesses are installed but not on (1.6 §1.1: a receipt holds each
// fact once; §1.4: off names what it was asked to turn off). Claude Code, DeepSeek dsh and Z-Code are installed, only Claude Code is on, and its
// `on` wrote its proxy keys (the descriptor's own proxy files and keys) into one file that was there and one it created. The text receipt names
// each of those files once, the flows/ result line names only the harness that was asked, and the receipt's still_on (what the daemon
// goes on serving) is empty. Nothing here reaches the machine: a sandbox HOME,
// a fake daemon and a recording runner (off-ctx.mjs).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { loadHarnesses } from '../../src/collector/harness/index.mjs'
import { applyJsonKey, readManifest } from '../../src/collector/core/trust/journal.mjs'
import { formatOffReceipt } from '../../src/off/receipt.mjs'
import { installedHome, flowEvents } from './fixtures/off-ctx.mjs'

const NAMES = ['claude-code', 'deepseek-dsh', 'z-code']

test('off of one harness among three installed: each file it undid is said once, and the result line and the harnesses still on name only what is so', async () => {
  const all = await loadHarnesses()
  const s = await installedHome({ names: ['claude-code'] })
  await s.install({ harnesses: all.filter((d) => NAMES.includes(d.name)) })
  const cc = all.find((d) => d.name === 'claude-code')
  const files = cc.proxy.files.map((f) => f.path({ home: s.home, env: s.sh.env }))
  const existed = files.map((f) => fs.existsSync(f))
  assert.ok(existed.includes(true) && existed.includes(false), 'one proxy file is there before on, one is not (the seven-homes layout)')
  const m = readManifest(s.dir)
  cc.proxy.files.forEach((f, i) => { for (const keys of f.keys) applyJsonKey({ dir: s.dir, manifest: m, harness: 'claude-code', phase: 'on', home: s.home, file: files[i], keys, value: 'http://127.0.0.1:47012' }) })
  assert.deepEqual(Object.entries(s.state().harnesses).filter(([, e]) => e.desired === 'on').map(([id]) => id), ['claude-code'])

  const { receipt, exit } = await s.off({ ids: ['claude-code'] })
  assert.equal(exit, 0, JSON.stringify(receipt.problems))
  const text = formatOffReceipt(receipt, { home: s.home })
  for (const f of files) {
    const shown = f.replace(s.home, '~')
    const lines = text.split('\n').filter((l) => l.includes(shown))
    assert.equal(lines.length, 1, `${shown} is said once:\n${text}`)
  }
  const result = flowEvents(s.dir).filter((e) => e.where === 'off' && e.kind === 'result')
  assert.equal(result.length, 1)
  for (const id of NAMES.filter((n) => n !== 'claude-code')) assert.ok(!result[0].reason.includes(id), `the result line names only claude-code: ${result[0].reason}`)
  assert.ok(result[0].reason.includes('claude-code'), result[0].reason)
  assert.deepEqual(receipt.harnesses.map((h) => h.harness), ['claude-code'])
  assert.deepEqual(receipt.still_on, [], 'no other harness is on, so the daemon serves none after this off')
})
