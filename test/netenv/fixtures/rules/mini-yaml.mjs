// A YAML reader for the text-splice tests only (there is no YAML library in this project, by rule): block maps and lists the way serde_yaml writes them (a list at its key's own
// indent), `- key: value` items, plain / single / double-quoted scalars, and one-line flow values that are JSON (what the splice writes). It throws on anything else rather than guess.
// It is what lets the text path be compared with the object path (W58): parseYaml(spliced text) must equal spliceRuntime(parsed config).
export function parseYaml(text) {
  const lines = []
  for (const l of text.split(/\r?\n/)) if (l.trim() !== '' && !l.trim().startsWith('#')) lines.push({ indent: l.length - l.trimStart().length, text: l.trim() })
  let i = 0
  const isDash = (t) => t === '-' || t.startsWith('- ')
  const unq = (k) => (/^(["']).*\1$/.test(k) ? k.slice(1, -1) : k)
  function scalar(t) {
    if (t[0] === '"') return JSON.parse(/^"(?:[^"\\]|\\.)*"/.exec(t)[0])
    if (t[0] === "'") return /^'((?:[^']|'')*)'/.exec(t)[1].replace(/''/g, "'")
    t = t.replace(/\s+#.*$/, '')
    if (t[0] === '{' || t[0] === '[') return JSON.parse(t)
    if (t === 'true') return true
    if (t === 'false') return false
    if (t === 'null' || t === '~') return null
    if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t)
    return t
  }
  const block = (indent) => (isDash(lines[i].text) ? seq(indent) : map(indent))
  function seq(indent) {
    const out = []
    while (i < lines.length && lines[i].indent === indent && isDash(lines[i].text)) {
      const rest = lines[i].text === '-' ? '' : lines[i].text.slice(2)
      if (rest === '') { i++; out.push(i < lines.length && lines[i].indent > indent ? block(lines[i].indent) : null) } else if (/^(?:"[^"]+"|'[^']+'|[^\s"'{[][^:]*?):(?:\s|$)/.test(rest)) {
        lines[i] = { indent: indent + 2, text: rest } // a mapping that starts on the dash line: read it as if the dash were two spaces
        out.push(map(indent + 2))
      } else { out.push(scalar(rest)); i++ }
    }
    return out
  }
  function map(indent) {
    const out = {}
    while (i < lines.length && lines[i].indent === indent && !isDash(lines[i].text)) {
      const m = /^("[^"]+"|'[^']+'|[^\s"'#][^:]*?):(?:\s+(.*))?$/.exec(lines[i].text)
      if (!m) throw new Error(`mini-yaml: cannot read ${JSON.stringify(lines[i].text)}`)
      i++
      if (m[2] !== undefined && m[2] !== '') out[unq(m[1])] = scalar(m[2])
      else if (i < lines.length && (lines[i].indent > indent || (lines[i].indent === indent && isDash(lines[i].text)))) out[unq(m[1])] = block(lines[i].indent)
      else out[unq(m[1])] = null
    }
    return out
  }
  const result = lines.length ? block(lines[0].indent) : {}
  if (i < lines.length) throw new Error(`mini-yaml: stopped at ${JSON.stringify(lines[i].text)}`)
  return result
}
