// web/src/ui/HarnessIcon.tsx — an agent's icon box (1.2 §agent chip): a known harness's icon file as an <img> in a fixed 16px box (the
// same box core/chips.mjs harnessIcon draws); an id no harness answers to draws the unknown glyph.
import { harnessIconUrl, harnessKey, isKnownHarness, UNKNOWN_ICON } from '../../legacy/core/chips.mjs'

export function HarnessIcon({ id }: { id: string | null | undefined }) {
  if (!isKnownHarness(id)) return <span className="hicon hicon-unknown" data-hicon="?" aria-hidden="true" dangerouslySetInnerHTML={{ __html: UNKNOWN_ICON }} />
  return <span className="hicon" data-hicon={harnessKey(id)} aria-hidden="true"><img src={harnessIconUrl(id) ?? undefined} alt="" width={16} height={16} decoding="async" /></span>
}
