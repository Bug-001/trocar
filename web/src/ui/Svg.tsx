// ui/Svg.tsx — an svg string (core/icons.mjs) as an <svg> element of its own, so the markup has no wrapper around it.
import { useMemo } from 'react'

export function Svg({ html }: { html: string }) {
  const { props, inner } = useMemo(() => {
    const t = document.createElement('template'); t.innerHTML = html
    const s = t.content.firstElementChild!
    const camel = (n: string) => (n === 'class' ? 'className' : /^(aria|data)-/.test(n) ? n : n.replace(/-(\w)/g, (_, c: string) => c.toUpperCase()))
    return { props: Object.fromEntries([...s.attributes].map((a) => [camel(a.name), a.value])), inner: s.innerHTML }
  }, [html])
  return <svg {...props} dangerouslySetInnerHTML={{ __html: inner }} />
}
