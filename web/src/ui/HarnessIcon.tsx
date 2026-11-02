// web/src/ui/HarnessIcon.tsx — an agent's icon box (1.2 §agent chip): a known harness's icon, loaded once per id through the same
// whitelist as the legacy boxes (core/chips.mjs harnessIconSvg); an id no harness answers to draws the unknown glyph. No data-hicon:
// the legacy filler never touches this box.
import { useQuery } from '@tanstack/react-query'
import { harnessIconSvg, harnessKey, isKnownHarness, UNKNOWN_ICON } from '../../legacy/core/chips.mjs'

export function HarnessIcon({ id }: { id: string | null | undefined }) {
  const known = isKnownHarness(id)
  const key = known ? harnessKey(id) : '?'
  const { data } = useQuery({ queryKey: ['harness-icon', key], queryFn: () => harnessIconSvg(key), staleTime: Infinity, enabled: known })
  return <span className={known ? 'hicon' : 'hicon hicon-unknown'} aria-hidden="true" dangerouslySetInnerHTML={{ __html: known ? data ?? '' : UNKNOWN_ICON }} />
}
