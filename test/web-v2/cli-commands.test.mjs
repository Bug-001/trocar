// test/web-v2/cli-commands.test.mjs — 1.9 验收 #6 / #15: a command the board prints is one the CLI runs. Every `asight …`
// string in labels/** names an entry of 1.6's command table (src/cli/commands.mjs COMMANDS) and uses only the arguments
// and flags that entry's usage lines list. Commands live only in labels/capture.mjs COMMANDS (the one reviewed home); no
// other label string is an asight command.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { COMMANDS as BOARD } from '../../src/web/v2/labels/capture.mjs'
import { COMMANDS as CLI } from '../../src/cli/commands.mjs'

const LABELS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'web', 'v2', 'labels')
const ASIGHT = /^(?:sudo )?asight (\S+)(.*)$/

// does one board command fit one usage line? tokens after the name: a <placeholder> fills a <…> or [<…>…] slot, a
// word must appear literally (a subcommand, or one of an a|b choice), a --flag must be listed in the line
function fits(cmd, line) {
  const [, name, rest] = ASIGHT.exec(cmd)
  const m = ASIGHT.exec(line)
  if (!m || m[1] !== name || cmd.startsWith('sudo ') !== line.startsWith('sudo ')) return false
  const slots = m[2].match(/<[^>]+>|--[\w-]+|[\w-]+(?:\|[\w-]+)*/g) || []
  let i = 0
  for (const t of rest.trim().split(/\s+/).filter(Boolean)) {
    if (t.startsWith('--')) { if (!slots.includes(t)) return false; continue }
    while (i < slots.length && slots[i].startsWith('--')) i++
    const s = slots[i++]
    if (s == null) return false
    if (t.startsWith('<') ? !s.startsWith('<') : !(s.startsWith('<') || s.split('|').includes(t))) return false
  }
  return true
}

test('the matcher is not vacuous: an unknown command, an unlisted flag or argument does not fit', () => {
  assert.ok(fits('asight on <id>', 'asight on [<harness>...] [--yes]'))
  assert.ok(!fits('asight on <id> --purge', 'asight on [<harness>...] [--yes]'))
  assert.ok(!fits('asight install <id>', 'asight install [--yes]'))
  assert.ok(!fits('asight etl', 'asight on [<harness>...]'))
  assert.ok(!fits('asight setup-helper', 'sudo asight setup-helper'))
})

test('every asight command the board carries is a 1.6 command used with its own arguments', () => {
  const lines = CLI.flatMap((c) => c.usage.split('\n'))
  const bad = Object.values(BOARD).filter((cmd) => ASIGHT.test(cmd) && !lines.some((l) => fits(cmd, l)))
  assert.deepEqual(bad, [])
  assert.ok(Object.values(BOARD).some((cmd) => ASIGHT.test(cmd)))
})

test('no label file outside COMMANDS carries an asight command string', () => {
  const allowed = new Set(Object.values(BOARD))
  const bad = []
  for (const f of fs.readdirSync(LABELS).filter((f) => f.endsWith('.mjs'))) {
    const src = fs.readFileSync(path.join(LABELS, f), 'utf8')
    for (const m of src.matchAll(/(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/g)) {
      if (/^(?:sudo )?asight [a-z]/.test(m[2]) && !allowed.has(m[2])) bad.push(`labels/${f}: "${m[2]}"`)
    }
  }
  assert.deepEqual(bad, [])
})
