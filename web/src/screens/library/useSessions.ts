// screens/library/useSessions.ts — the library's one read (1.8 §数据与刷新, 4.4 §live-poll): the `sessions` list through loadSessions,
// on TanStack Query ['sessions']. Period: 4.4's `sessions` while the answer is fresh, `session` while it is the stored answer (a fresh
// one follows soon, 4.4 §存下的答案), the back-off after a failure; no timer read while the tab is hidden, one read the moment it is
// visible again, no retry of its own. A failed read throws a ReadFail that keeps the answer {status, error}, so the page says the cause
// class and keeps the reason in 技术细节 (K-29); the last list stays in `data`.
import { useQuery } from '@tanstack/react-query'
import { INTERVAL } from '../../../legacy/core/poll.mjs'
import { pollOptions } from '../../ui/poll'
import { api, scoped } from '../../../legacy/core/api.mjs'
import { loadSessions } from '../../../legacy/library/logic.mjs'

export type Session = Record<string, unknown> & { session_id: string, project_slug: string }
export type SessionsData = { sessions: Session[], errors: Array<Record<string, unknown>>, as_of: string | null, stored: string | null }
export type Failed = { ok: false, status?: number, error?: string }

export class ReadFail extends Error {
  answer: Failed
  constructor(answer: Failed) { super(String(answer.error || `HTTP ${answer.status}`)); this.answer = answer }
}

export function useSessions() {
  return useQuery<SessionsData, ReadFail>({
    queryKey: ['sessions'],
    queryFn: async ({ signal }) => {
      let r: { ok: boolean, data?: SessionsData } & Partial<Failed>
      try { r = await loadSessions(scoped(api, signal)) } catch (e) { r = { ok: false, error: String((e as Error)?.message ?? e) } }
      if (!r || !r.ok) throw new ReadFail((r || { ok: false, error: 'no answer' }) as Failed)
      return r.data!
    },
    ...pollOptions('sessions', { period: (s) => ((s.data as SessionsData | undefined)?.stored ? INTERVAL.session : INTERVAL.sessions) }),
  })
}
