// web/src/ui/CopyButton.tsx — the copy button (1.5 §数据规则): copies `text`, then says Copied (or Copy failed) for a moment. It copies
// itself, so it carries no data-copy (core/dom.mjs installCopy serves only the legacy markup).
import { useEffect, useRef, useState } from 'react'
import { Button } from 'react-aria-components'
import { writeClipboard, COPY_FLASH } from '../../legacy/core/dom.mjs'

export function CopyButton({ text, label = 'Copy' }: { text: string, label?: string }) {
  const [flash, setFlash] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const copy = async () => {
    const ok = await writeClipboard(text)
    setFlash(ok ? COPY_FLASH.ok : COPY_FLASH.failed)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setFlash(null), COPY_FLASH.ms)
  }
  return <Button className="copybtn" onPress={copy}>{flash ?? label}</Button>
}
