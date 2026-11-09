// web/src/screens/replay/useSplit.ts — one boundary's remembered layout (1.2 §回放台布局): written only when the reader moved it, removed on
// a reset, read back only when it is a table of numbers. Not the library's useDefaultLayout: its storage throws in a private window,
// it parses what it reads unchecked, and it owns the key, which a double-click has to delete.
import { useCallback, useRef, useState } from 'react'
import type { Layout } from 'react-resizable-panels'

function read(key: string): Layout | undefined {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(key) ?? 'null')
    return v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every(Number.isFinite) ? v as Layout : undefined
  } catch { return undefined }
}

export function useSplit(key: string) {
  const [defaultLayout] = useState(() => read(key))
  const held = useRef(defaultLayout != null) // the size is the reader's: survives storage that cannot be written
  const keep = useCallback((layout: Layout) => {
    held.current = true
    try { localStorage.setItem(key, JSON.stringify(layout)) } catch { /* a convenience */ }
  }, [key])
  const onLayoutChanged = useCallback((layout: Layout, m: { isUserInteraction: boolean }) => { if (m.isUserInteraction) keep(layout) }, [keep])
  const forget = useCallback(() => {
    held.current = false
    try { localStorage.removeItem(key) } catch { /* a convenience */ }
  }, [key])
  return { defaultLayout, onLayoutChanged, forget, keep, held: useCallback(() => held.current, []) }
}
