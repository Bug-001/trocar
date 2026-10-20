// render.mjs — fill a hook template (4.11 P8 wrapper, P9 plugin templates). A template names its slots as __TROCAR_<NAME>__; the set of
// names is closed (PLACEHOLDERS), and every slot in a template must get a value: an unknown slot, a missing value or a value for a name
// outside the set throws, so a template and its renderer cannot drift apart silently. Values are JSON-encoded by default (a JS or C#
// string literal); a template in another language passes its own `encode` (the dash wrapper: single-quoted shell words). The names that
// land in code as environment variable names are checked to be plain identifiers, so no value can smuggle code into a template.

const PLACEHOLDERS = Object.freeze({
  DOOR: 'string', // the door URL (opencode-plugin: baked at `on`)
  SWITCH: 'string', // the absolute path of this harness's switch file (wrapper, cordis-plugin: baked at install)
  CA_FILE: 'string', // the absolute path of the trocar root PEM
  CERT_VAR: 'name', // the certificate variable a wrapper sets when it is unset
  REAL: 'string', // the real program a wrapper runs
  PROXY_ENV: 'names', // the agent's proxy names, in its own precedence order (TROCAR_PRIOR_PROXY is the first set one)
  PROXY_NAMES: 'names', // the proxy names a hook points at the door
  NO_PROXY_ENV: 'names', // the agent's bypass-list names
})

const SLOT = /__TROCAR_([A-Z][A-Z_]*?)__/g
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

function check(name, value) {
  const kind = PLACEHOLDERS[name]
  const bad = (what) => { throw new Error(`template value ${name}: ${what}`) }
  if (kind === 'string' && typeof value !== 'string') bad('expected a string')
  if (kind === 'name' && !(typeof value === 'string' && NAME.test(value))) bad('expected an environment variable name')
  if (kind === 'names' && !(Array.isArray(value) && value.every((v) => typeof v === 'string' && NAME.test(v)))) bad('expected a list of environment variable names')
}

/** Fill every __TROCAR_<NAME>__ slot of `text` with encode(values[NAME]). Throws on an unknown slot, a missing value or an unknown name. */
export function renderTemplate(text, values, encode = JSON.stringify) {
  for (const [name, value] of Object.entries(values)) {
    if (!(name in PLACEHOLDERS)) throw new Error(`template value ${name}: not a placeholder (${Object.keys(PLACEHOLDERS).join(', ')})`)
    check(name, value)
  }
  return text.replace(SLOT, (_, name) => {
    if (!(name in PLACEHOLDERS)) throw new Error(`template slot __TROCAR_${name}__ is not a placeholder`)
    if (values[name] === undefined) throw new Error(`template slot __TROCAR_${name}__ has no value`)
    return encode(values[name])
  })
}
