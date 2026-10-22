// args.mjs — the option parsing of the command line (RFC 1.6 §1, §2): which options a command takes is declared in its table entry
// (src/cli/commands.mjs `options: [['--port <port>', 'one line of help'], …]`), so nothing is guessed from the shape of an argument —
// `--port 9801 file` used to hand `9801` back as the file — and an option nobody declared is a usage error instead of silence.
//   optionsOf(cmd)          → Map '--name' → { name, value: 'port' | null, help }
//   parseArgs(cmd, argv)    → { positionals, flags, error }. `flags` is keyed by the option's name without the dashes
//                             (`--dry-run` → `flags['dry-run']`); a declared value is a string, a plain option is `true`.
//                             `error` is `{ code: 'usage', message, usage }` or null; `cmd.openOptions` (query, whose parameters belong
//                             to the query, not to the CLI) keeps every option it is given instead of refusing it, and reads a negative
//                             number (`--limit -1`) as a value, since no option is named that; an open option given more than
//                             once is the list of its values, in order (1.6 §4.1 参数: the query core says whether it takes one).
const DECL = /^(--[a-z][a-z-]*)(?:[ =]<([a-z-]+)>)?$/
const key = (name) => name.replace(/^--?/, '')
/** `-1`, `-0.5`: a value an open option is given, not an option name. */
const negativeNumber = (arg) => /^-\d+(\.\d+)?$/.test(arg)

/** The declared options of a table entry, in the order the entry lists them. */
export function optionsOf(cmd) {
  const out = new Map()
  for (const [decl, help] of cmd.options || []) {
    const m = DECL.exec(decl)
    if (!m) throw new RangeError(`${cmd.name}: not an option declaration: ${decl}`)
    out.set(m[1], { name: m[1], value: m[2] || null, help })
  }
  return out
}

/** `argv` (what follows the command's name) by the command's own declaration → { positionals, flags, error }. */
export function parseArgs(cmd, argv) {
  const options = optionsOf(cmd)
  const positionals = [], flags = {}
  const fail = (message) => ({ positionals: [], flags: {}, error: { code: 'usage', message: `trocar ${cmd.name}: ${message}`, usage: cmd.usage } })
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('-') || arg === '-' || (cmd.openOptions && negativeNumber(arg))) { positionals.push(arg); continue }
    const eq = arg.indexOf('=')
    const name = eq > 0 ? arg.slice(0, eq) : arg
    const inline = eq > 0 ? arg.slice(eq + 1) : null
    const opt = options.get(name)
    if (!opt) {
      if (!cmd.openOptions) return fail(`unknown option '${name}'`)
      const v = inline !== null ? inline : (argv[i + 1] !== undefined && (!argv[i + 1].startsWith('-') || negativeNumber(argv[i + 1])) ? argv[++i] : true)
      flags[key(name)] = Object.hasOwn(flags, key(name)) ? [].concat(flags[key(name)], v) : v // given again → a list, in order (1.6 §4.1)
      continue
    }
    if (!opt.value) {
      if (inline !== null) return fail(`option '${name}' takes no value`)
      flags[key(name)] = true
      continue
    }
    const value = inline !== null ? inline : argv[++i]
    if (value === undefined) return fail(`option '${name}' needs a value`)
    flags[key(name)] = value
  }
  return { positionals, flags, error: null }
}
