// web/src/ui/CopyButton.tsx — the copy button (1.5 §数据规则): copies `text`, then says Copied (or Copy failed) for a moment. It copies
// itself, so it carries no data-copy (core/dom.mjs installCopy serves only the legacy markup).
import { useEffect, useRef, useState } from 'react'
import { Button } from 'react-aria-components'
import { writeClipboard, COPY_FLASH } from '../../legacy/core/dom.mjs'

// `row`: the copy is an action of the whole row (Copy diagnostics, Copy template), drawn as the kit's button (.copybtn.act, base.css);
// otherwise it is the small copy beside the bytes it copies
export function CopyButton({ text, label = 'Copy', row = false }: { text: string, label?: string, row?: boolean }) {
  const [flash, setFlash] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const copy = async () => {
    const ok = await writeClipboard(text)
    setFlash(ok ? COPY_FLASH.ok : COPY_FLASH.failed)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setFlash(null), COPY_FLASH.ms)
  }
  return <Button className={row ? 'copybtn act' : 'copybtn'} onPress={copy}>{flash ?? label}</Button>
}
