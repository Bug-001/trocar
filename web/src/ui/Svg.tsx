// ui/Svg.tsx — an svg string (core/icons.mjs) as an <svg> element of its own, so the markup has no wrapper around it. Each string is
// parsed once per page: the icons are a small fixed set, and a window row mounts one on every step.
type Parsed = { props: Record<string, string>, inner: string }
const parsed = new Map<string, Parsed>()
function parse(html: string): Parsed {
  const t = document.createElement('template'); t.innerHTML = html
  const s = t.content.firstElementChild!
  const camel = (n: string) => (n === 'class' ? 'className' : /^(aria|data)-/.test(n) ? n : n.replace(/-(\w)/g, (_, c: string) => c.toUpperCase()))
  return { props: Object.fromEntries([...s.attributes].map((a) => [camel(a.name), a.value])), inner: s.innerHTML }
}

export function Svg({ html }: { html: string }) {
  let p = parsed.get(html)
  if (!p) parsed.set(html, p = parse(html))
  return <svg {...p.props} dangerouslySetInnerHTML={{ __html: p.inner }} />
}
