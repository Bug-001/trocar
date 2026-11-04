// test/ci/skill-refs.test.mjs — what the shipped skills tell an agent to open or run exists (spec 1.12 AN27). A skill is read by an agent
// that takes it at its word, so a dead path or a verb the CLI does not have costs a whole wrong turn. Options are not checked (1.12).
// Only what a reader would type counts, as in test/readme-truth.test.mjs: fenced blocks and inline code spans.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { COMMANDS } from '../../src/cli/commands.mjs'
import { QUERY_NAMES } from '../../src/query/client.mjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const SKILLS = path.join(ROOT, 'skills')
const VERBS = new Set(COMMANDS.map((c) => c.name)), NAMES = new Set(QUERY_NAMES)
const PATH = /^(?:scripts|docs|test|spec|samples|web|src)\//

/** A path as a span writes it → the part that must exist: up to a placeholder or a glob, without a `:line` or `#anchor`. */
const pathPart = (word) => word.replace(/[<*].*$/, '').replace(/[:#].*$/, '')

function problemsIn(text) {
  const fenced = [...text.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((m) => m[1])
  const spans = [...text.replace(/```[a-z]*\n[\s\S]*?```/g, '').matchAll(/`([^`\n]+)`/g)].map((m) => m[1])
  const code = [...fenced, ...spans].join('\n')
  const words = code.split(/[\s"'()]+/).filter((w) => PATH.test(w))
  return [
    ...words.filter((w) => !fs.existsSync(path.join(ROOT, pathPart(w)))).map((w) => `no such path: ${w}`),
    // `[ \t]`, not `\s`: the spans are newline-joined. A verb starts with a letter, so `Bug-001/trocar --title` is no command.
    ...[...code.matchAll(/\btrocar[ \t]+([a-z][a-z-]*)/g)].map((m) => m[1]).filter((v) => !VERBS.has(v)).map((v) => `no such command: ${v}`),
    ...[...code.matchAll(/\btrocar[ \t]+query[ \t]+([a-z][a-z-]*)/g)].map((m) => m[1]).filter((n) => !NAMES.has(n)).map((n) => `no such query: ${n}`),
  ]
}

test('AN27: every path, command and query name a skill names exists', () => {
  const files = fs.readdirSync(SKILLS).map((d) => path.join(SKILLS, d, 'SKILL.md'))
  assert.ok(files.length > 0, 'skills/ holds the skills')
  const problems = files.flatMap((f) => problemsIn(fs.readFileSync(f, 'utf8')).map((p) => `${path.relative(ROOT, f)}: ${p}`))
  assert.deepEqual(problems, [])
})
