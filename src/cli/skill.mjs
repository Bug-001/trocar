// skill.mjs — `trocar skill [<name>] [--json]` (RFC 1.6 §5.6, D80): the agent skills that ship with this trocar, listed or printed byte for byte.
// It reads skills/<name>/SKILL.md in the package and nothing else: no file is written, ~/.trocar is not needed, and it runs on a machine that never
// ran `install`. A name is only ever matched against the list, so what is typed never becomes a path.
import fs from 'node:fs'
import { EXIT } from './schema.mjs'
import { printJson, errorDoc } from './json.mjs'
import { columns, wrap, WIDTH } from './text.mjs'
import { COMMAND_INDENT } from '../off/receipt.mjs'
import { SCHEMA_VERSION } from '../off/schema.mjs'

const SKILLS = new URL('../../skills/', import.meta.url)
const START_WITH = 'trocar-debug'

/** The `name:` or `description:` line between the two `---` of a skill's front matter. */
const field = (text, key) => new RegExp(`^${key}: *(.*)$`, 'm').exec(/^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? '')?.[1] ?? ''

/** Every skill of the package, by name: [{ name, description, bytes, text }]. */
function skills() {
  return fs.readdirSync(SKILLS).sort().map((dir) => {
    const bytes = fs.readFileSync(new URL(`${dir}/SKILL.md`, SKILLS))
    const text = bytes.toString('utf8')
    return { name: field(text, 'name'), description: field(text, 'description'), bytes, text }
  })
}

/** → the exit code. */
export async function run(argv, { io, args, json }) {
  const usage = (message) => {
    if (json) printJson(io, errorDoc('skill', 'usage', message))
    else for (const line of wrap(message)) io.err(line)
    return EXIT.usage
  }
  const [wanted, ...extra] = args.positionals
  if (extra.length) return usage('trocar skill: one skill at a time. Run: trocar skill')
  const all = skills()
  const head = { schema: SCHEMA_VERSION, command: 'skill', ok: true }
  if (wanted === undefined) {
    if (json) { printJson(io, { ...head, skills: all.map(({ name, description }) => ({ name, description })) }); return EXIT.ok }
    io.out(`${all.length} skills ship with this trocar, for your agent to read.`)
    io.out('')
    for (const line of columns(all.map((s) => [s.name, s.description.split(/(?<=\.)\s/)[0]]), { width: WIDTH })) io.out(line)
    io.out('')
    io.out('Print one in full:')
    io.out(`${COMMAND_INDENT}trocar skill ${START_WITH}`)
    return EXIT.ok
  }
  const skill = all.find((s) => s.name === wanted)
  if (!skill) return usage(`trocar skill: no skill named '${wanted}'. Run: trocar skill`)
  if (json) printJson(io, { ...head, name: skill.name, description: skill.description, text: skill.text })
  else io.stdout.write(skill.bytes)
  return EXIT.ok
}
