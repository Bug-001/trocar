// web/src/ui/useAfter.ts — useAfter(ms, on): true once `on` has held for ms, false again the moment it stops. For the words a slow read
// owes the reader (1.8 §载入): the wait restarts with every `on`, and a component that unmounts takes its wait with it.
import { useEffect, useState } from 'react'

export function useAfter(ms: number, on = true) {
  const [past, setPast] = useState(false)
  useEffect(() => {
    if (!on) return
    const t = setTimeout(() => setPast(true), ms)
    return () => { clearTimeout(t); setPast(false) }
  }, [ms, on])
  return on && past
}
