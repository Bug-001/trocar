// web/src/ui/poll.ts — the board's polling on TanStack Query (1.5 K-29, 4.4 §live-poll). pollOptions(name) holds the rules every polled
// query takes: the period of 4.4's table (core/poll.mjs INTERVAL), no timer read while the tab is hidden, one read the moment it is
// visible again, no retry of its own, and after a failure the back-off (core/poll.mjs backoffMs). A query never has two reads in
// flight: an interval tick while one is out joins it. useStatusQuery() is the C.3 status document every capture screen reads.
import { useQuery } from '@tanstack/react-query'
import { INTERVAL, backoffMs } from '../../legacy/core/poll.mjs'
import { api } from '../../legacy/core/api.mjs'
import { store } from '../../legacy/core/store.mjs'
import { capHealthPatch } from '../../legacy/core/capture-verdict.mjs'

export type PollName = keyof typeof INTERVAL

export function pollOptions(name: PollName) {
  const base = INTERVAL[name]
  return {
    refetchInterval: (q: { state: { fetchFailureCount: number } }) => {
      const failures = q.state.fetchFailureCount
      return failures ? backoffMs(failures, base) : base
    },
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
    retry: false,
  } as const
}

// the status document. Each answer also goes into the app store through capHealthPatch, so the screens not yet ported read the same
// answer; a failure keeps the last good document (doc) and says why (err). An aborted read writes nothing. errAt is when the last
// failure came: it moves with every failed read, also when the reason stays the same, so a screen that keys its verdict on it
// re-judges 「? not refreshed」 at each answer (1.9 §页面结构).
export function useStatusQuery() {
  const q = useQuery({
    queryKey: ['status'],
    queryFn: async ({ signal }) => {
      let r
      try { r = await api.get('status', null, { signal }) } catch (e) { r = { ok: false, error: String((e as Error)?.message ?? e) } }
      if (signal.aborted) throw new Error('aborted')
      const patch = capHealthPatch(r, api.now())
      store.set(patch)
      if (patch.capHErr != null) throw new Error(patch.capHErr)
      return patch.capH
    },
    initialData: () => store.get().capH ?? undefined,
    initialDataUpdatedAt: () => store.get().capHOkAt ?? undefined,
    ...pollOptions('status'),
  })
  return { doc: q.data ?? null, okAt: q.dataUpdatedAt || null, err: q.error ? q.error.message : null, errAt: q.errorUpdatedAt || null, refetch: q.refetch }
}
